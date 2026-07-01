// ---------------------------------------------------------------------------
// 导入 / 导出：
//   导出  encrypted  —— 整库密文备份（自带 KDF 参数，设备间迁移最安全）
//         json       —— 明文 JSON（带警告，便于互通/手改）
//         csv        —— 明文 CSV
//   导入  encrypted / json / csv / chrome-csv / bitwarden-csv /
//         1password-csv / google-authenticator(otpauth-migration:// 迁移码)
//   注：csv / bitwarden / 1password 均会带入 TOTP(本扩展 CSV 的 totp 列、
//       Bitwarden 的 login_totp、1Password 的 otpauth 列)。
// ---------------------------------------------------------------------------
import {
  createEncryptedVault,
  decryptVaultData,
  emptyVaultData,
  unwrapDEK,
} from './vault-core';
import {
  newAccount,
  newEnvironment,
  newLink,
  newProject,
  uid,
} from './vault-ops';
import { parseMigrationUri } from './otp-migration';
import type {
  Account,
  DashboardConfig,
  DashWidget,
  EncryptedVault,
  Environment,
  ExportMode,
  ImportFormat,
  ImportMode,
  PlatformLink,
  Project,
  VaultData,
} from './types';

const BACKUP_TAG = 'project-env-manager';

// --------------------------- 导出 ---------------------------

export interface ExportResult {
  filename: string;
  mime: string;
  content: string;
}

export async function buildExport(
  data: VaultData,
  mode: ExportMode,
  password?: string,
): Promise<ExportResult> {
  if (mode === 'encrypted') {
    if (!password) throw new Error('加密导出需要设置一个备份密码');
    const { encrypted } = await createEncryptedVault(data, password);
    const payload = { format: `${BACKUP_TAG}.encrypted`, ...encrypted };
    return {
      filename: backupName('backup', 'json'),
      mime: 'application/json',
      content: JSON.stringify(payload, null, 2),
    };
  }
  if (mode === 'json') {
    const payload = {
      format: `${BACKUP_TAG}.plain`,
      exportedAt: Date.now(),
      data,
    };
    return {
      filename: backupName('export', 'json'),
      mime: 'application/json',
      content: JSON.stringify(payload, null, 2),
    };
  }
  return {
    filename: backupName('export', 'csv'),
    mime: 'text/csv',
    content: toCsv(data),
  };
}

// --------------------------- 导入 ---------------------------

export async function parseImport(
  format: ImportFormat,
  content: string,
  password?: string,
): Promise<VaultData> {
  switch (format) {
    case 'encrypted': {
      if (!password) throw new Error('请输入备份密码才能导入加密备份');
      let obj: EncryptedVault & { format?: string };
      try {
        obj = JSON.parse(content) as EncryptedVault & { format?: string };
      } catch {
        throw new Error('加密备份文件不是有效 JSON，请确认选择的是本扩展导出的加密备份');
      }
      if (obj.format && obj.format !== `${BACKUP_TAG}.encrypted`) {
        throw new Error('该文件不是本扩展的加密备份，请确认导入类型选择正确');
      }
      try {
        const dek = await unwrapDEK(obj, password);
        return normalize(await decryptVaultData(obj, dek));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith('KDF 参数异常')) throw e;
        throw new Error('备份密码不正确，或该加密备份文件已损坏/不匹配');
      }
    }
    case 'json': {
      const obj = JSON.parse(content) as { data?: VaultData } | VaultData;
      const data = (obj as { data?: VaultData }).data ?? (obj as VaultData);
      if (!data || !Array.isArray((data as VaultData).projects)) {
        throw new Error('JSON 格式不正确：缺少 projects 字段');
      }
      return normalize(data as VaultData);
    }
    case 'csv':
      return fromOwnCsv(content);
    case 'chrome-csv':
      return fromChromeCsv(content);
    case 'bitwarden-csv':
      return fromBitwardenCsv(content);
    case '1password-csv':
      return from1PasswordCsv(content);
    case 'google-authenticator':
      return fromGoogleAuthenticator(content);
  }
}

// --------------------------- 合并 ---------------------------

export interface MergeResult {
  data: VaultData;
  imported: number;
}

export function mergeVaults(
  base: VaultData,
  incoming: VaultData,
  mode: ImportMode,
): MergeResult {
  if (mode === 'replace') {
    const data: VaultData = {
      ...incoming,
      settings: incoming.settings ?? base.settings,
      tombstones: incoming.tombstones ?? [],
    };
    return { data, imported: countAccounts(incoming) };
  }

  const data = structuredClone(base);
  const ids: ImportIdMap = { projects: new Map(), docs: new Map() };
  let imported = 0;
  const lc = (s: string) => s.trim().toLowerCase();

  for (const inProj of incoming.projects) {
    let proj = data.projects.find((p) => lc(p.name) === lc(inProj.name));
    if (!proj) {
      proj = reidProject(inProj, ids);
      data.projects.push(proj);
      imported += countAccountsInProject(inProj);
      continue;
    }
    ids.projects.set(inProj.id, proj.id);
    mergeProjectExtras(proj, inProj, ids);
    for (const inEnv of inProj.environments) {
      let env = proj.environments.find(
        (e) => e.kind === inEnv.kind && lc(e.name) === lc(inEnv.name),
      );
      if (!env) {
        env = reidEnv(inEnv);
        proj.environments.push(env);
        imported += inEnv.links.reduce((n, l) => n + l.accounts.length, 0);
        continue;
      }
      for (const inLink of inEnv.links) {
        let link = env.links.find(
          (l) => lc(l.name) === lc(inLink.name) && lc(l.url) === lc(inLink.url),
        );
        if (!link) {
          link = reidLink(inLink);
          env.links.push(link);
          imported += inLink.accounts.length;
          continue;
        }
        for (const inAcc of inLink.accounts) {
          const dup = link.accounts.some(
            (a) =>
              lc(a.username) === lc(inAcc.username) &&
              lc(a.label) === lc(inAcc.label),
          );
          if (!dup) {
            link.accounts.push({ ...inAcc, id: uid() });
            imported += 1;
          }
        }
      }
    }
  }
  mergeDashboardSettings(data, incoming, ids);
  return { data, imported };
}

// --------------------------- CSV ---------------------------

const OWN_CSV_HEADER = [
  'project',
  'environment',
  'env_kind',
  'link',
  'url',
  'account_label',
  'username',
  'password',
  'totp',
  'note',
];

function toCsv(data: VaultData): string {
  const rows: string[][] = [OWN_CSV_HEADER];
  for (const p of data.projects) {
    for (const e of p.environments) {
      for (const l of e.links) {
        if (l.accounts.length === 0) {
          rows.push([p.name, e.name, e.kind, l.name, l.url, '', '', '', '', l.note ?? '']);
        }
        for (const a of l.accounts) {
          rows.push([
            p.name,
            e.name,
            e.kind,
            l.name,
            l.url,
            a.label,
            a.username,
            a.password,
            a.totp ?? '',
            a.note ?? '',
          ]);
        }
      }
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function fromOwnCsv(content: string): VaultData {
  const { header, rows } = parseCsv(content);
  const idx = columnIndexer(header);
  const builder = new VaultBuilder();
  for (const row of rows) {
    builder.add({
      project: row[idx('project')] ?? '导入',
      environment: row[idx('environment')] ?? '默认',
      envKind: (row[idx('env_kind')] as Environment['kind']) || 'other',
      link: row[idx('link')] ?? row[idx('url')] ?? '链接',
      url: row[idx('url')] ?? '',
      label: row[idx('account_label')] ?? '',
      username: row[idx('username')] ?? '',
      password: row[idx('password')] ?? '',
      totp: row[idx('totp')] ?? '',
      note: row[idx('note')] ?? '',
    });
  }
  return builder.build();
}

/** Chrome 密码导出 CSV：name,url,username,password,note */
function fromChromeCsv(content: string): VaultData {
  const { header, rows } = parseCsv(content);
  const idx = columnIndexer(header);
  const builder = new VaultBuilder();
  for (const row of rows) {
    const url = row[idx('url')] ?? '';
    builder.add({
      project: '导入 (Chrome)',
      environment: '默认',
      envKind: 'other',
      link: row[idx('name')] || hostOf(url) || '链接',
      url,
      label: '',
      username: row[idx('username')] ?? '',
      password: row[idx('password')] ?? '',
      totp: row[idx('totp')] ?? '',
      note: row[idx('note')] ?? '',
    });
  }
  return builder.build();
}

/** Bitwarden CSV：folder,favorite,type,name,notes,...,login_uri,login_username,login_password,login_totp,... */
function fromBitwardenCsv(content: string): VaultData {
  const { header, rows } = parseCsv(content);
  const idx = columnIndexer(header);
  const builder = new VaultBuilder();
  for (const row of rows) {
    const type = (row[idx('type')] ?? 'login').toLowerCase();
    if (type && type !== 'login') continue;
    const url = row[idx('login_uri')] ?? '';
    builder.add({
      project: '导入 (Bitwarden)',
      environment: row[idx('folder')] || '默认',
      envKind: 'other',
      link: row[idx('name')] || hostOf(url) || '链接',
      url,
      label: '',
      username: row[idx('login_username')] ?? '',
      password: row[idx('login_password')] ?? '',
      totp: row[idx('login_totp')] ?? '',
      note: row[idx('notes')] ?? '',
    });
  }
  return builder.build();
}

/**
 * 1Password CSV：列名各版本略有差异,常见为
 * title,url,username,password,otpauth,favorite,archived,tags,notes。
 * 这里对 url / otp / note 做多名兜底匹配。otpauth 列即 otpauth:// URI,原样存入。
 */
function from1PasswordCsv(content: string): VaultData {
  const { header, rows } = parseCsv(content);
  const idx = columnIndexer(header);
  const pick = (row: string[], ...names: string[]): string => {
    for (const n of names) {
      const i = idx(n);
      if (i >= 0 && row[i]) return row[i]!;
    }
    return '';
  };
  const builder = new VaultBuilder();
  for (const row of rows) {
    const url = pick(row, 'url', 'website', 'login_uri');
    builder.add({
      project: '导入 (1Password)',
      environment: '默认',
      envKind: 'other',
      link: pick(row, 'title', 'name') || hostOf(url) || '链接',
      url,
      label: '',
      username: pick(row, 'username', 'login_username'),
      password: pick(row, 'password', 'login_password'),
      totp: pick(row, 'otpauth', 'otp', 'one-time password', 'totp'),
      note: pick(row, 'notes', 'note'),
    });
  }
  return builder.build();
}

/** Google Authenticator 导出：otpauth-migration:// 迁移码(可由其导出二维码解出)。 */
function fromGoogleAuthenticator(content: string): VaultData {
  const otps = parseMigrationUri(content.trim());
  const builder = new VaultBuilder();
  for (const otp of otps) {
    builder.add({
      project: '导入 (Google Authenticator)',
      environment: '默认',
      envKind: 'other',
      link: otp.issuer || otp.name || 'TOTP',
      url: '',
      label: otp.name,
      username: otp.name,
      password: '',
      totp: otp.otpauth,
      note: '',
    });
  }
  return builder.build();
}

// --------------------------- 内部工具 ---------------------------

interface FlatRow {
  project: string;
  environment: string;
  envKind: Environment['kind'];
  link: string;
  url: string;
  label: string;
  username: string;
  password: string;
  totp: string;
  note: string;
}

/** 把摊平的行重新组装成项目/环境/链接/账号树。 */
class VaultBuilder {
  private data: VaultData = emptyVaultData();

  add(r: FlatRow): void {
    const proj = this.upsertProject(r.project);
    const env = this.upsertEnv(proj, r.environment, r.envKind);
    const link = this.upsertLink(env, r.link, r.url);
    if (r.username || r.password || r.label || r.totp) {
      link.accounts.push(
        newAccount({
          label: r.label,
          username: r.username,
          password: r.password,
          totp: r.totp || undefined,
          note: r.note || undefined,
        }),
      );
    } else if (r.note && !link.note) {
      link.note = r.note;
    }
  }

  build(): VaultData {
    return this.data;
  }

  private upsertProject(name: string): Project {
    const key = name.trim() || '导入';
    let p = this.data.projects.find((x) => x.name === key);
    if (!p) {
      p = newProject({ name: key });
      this.data.projects.push(p);
    }
    return p;
  }

  private upsertEnv(
    proj: Project,
    name: string,
    kind: Environment['kind'],
  ): Environment {
    const key = name.trim() || '默认';
    let e = proj.environments.find((x) => x.name === key);
    if (!e) {
      e = newEnvironment({ name: key, kind });
      proj.environments.push(e);
    }
    return e;
  }

  private upsertLink(env: Environment, name: string, url: string): PlatformLink {
    let l = env.links.find((x) => x.name === name && x.url === url);
    if (!l) {
      l = newLink({ name: name.trim() || '链接', url });
      env.links.push(l);
    }
    return l;
  }
}

function csvCell(v: string): string {
  if (v === '') return '';
  const safe = /^[\s]*[=+\-@]/.test(v) ? "'" + v : v;
  if (/[",\r\n]/.test(safe)) return '"' + safe.replace(/"/g, '""') + '"';
  return safe;
}

/** 解析 CSV，返回表头(小写)与数据行。支持引号、转义双引号、换行。 */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const all: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // 去 BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x !== '')) all.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some((x) => x !== '')) all.push(row);
  }
  const header = (all.shift() ?? []).map((h) => h.trim().toLowerCase());
  return { header, rows: all };
}

function columnIndexer(header: string[]) {
  return (name: string): number => header.indexOf(name.toLowerCase());
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function normalize(data: VaultData): VaultData {
  const out = emptyVaultData();
  out.version = data.version ?? out.version;
  out.settings = data.settings ?? out.settings;
  out.tombstones = data.tombstones ?? out.tombstones;
  out.projects = (data.projects ?? []).map(normalizeProject);
  return out;
}

function normalizeProject(p: Project): Project {
  const base = newProject({
    ...p,
    docs: (p.docs ?? []).map((d) => ({
      id: d.id || uid(),
      title: d.title ?? '未命名文档',
      content: d.content ?? '',
      updatedAt: d.updatedAt ?? Date.now(),
    })),
    memos: (p.memos ?? []).map((m) => {
      const t = Date.now();
      return {
        id: m.id || uid(),
        text: m.text ?? '',
        done: m.done ?? false,
        urgent: m.urgent,
        dueAt: m.dueAt,
        createdAt: m.createdAt ?? t,
        updatedAt: m.updatedAt ?? t,
      };
    }),
    environments: (p.environments ?? []).map(normalizeEnv),
  });
  return {
    ...base,
    id: p.id || base.id,
    createdAt: p.createdAt ?? base.createdAt,
    updatedAt: p.updatedAt ?? base.updatedAt,
  };
}

function normalizeEnv(e: Environment): Environment {
  const base = newEnvironment({
    ...e,
    links: (e.links ?? []).map(normalizeLink),
  });
  return { ...base, id: e.id || base.id };
}

function normalizeLink(l: PlatformLink): PlatformLink {
  const base = newLink({
    ...l,
    accounts: (l.accounts ?? []).map(normalizeAccount),
  });
  return { ...base, id: l.id || base.id };
}

function normalizeAccount(a: Account): Account {
  const base = newAccount(a);
  return {
    ...base,
    id: a.id || base.id,
    createdAt: a.createdAt ?? base.createdAt,
    updatedAt: a.updatedAt ?? base.updatedAt,
  };
}

interface ImportIdMap {
  projects: Map<string, string>;
  docs: Map<string, string>;
}

function mergeProjectExtras(target: Project, source: Project, ids: ImportIdMap): void {
  if (source.docs?.length) {
    const docs = target.docs ?? (target.docs = []);
    for (const doc of source.docs) {
      const existing = docs.find((d) => d.id === doc.id);
      if (existing) {
        ids.docs.set(doc.id, existing.id);
        if (doc.updatedAt > existing.updatedAt) Object.assign(existing, doc);
      } else {
        docs.push(structuredClone(doc));
        ids.docs.set(doc.id, doc.id);
      }
    }
  }

  if (source.memos?.length) {
    const memos = target.memos ?? (target.memos = []);
    for (const memo of source.memos) {
      const existing = memos.find((m) => m.id === memo.id);
      if (existing) {
        if (memo.updatedAt > existing.updatedAt) Object.assign(existing, memo);
      } else {
        memos.push(structuredClone(memo));
      }
    }
  }
}

function mergeDashboardSettings(data: VaultData, incoming: VaultData, ids: ImportIdMap): void {
  const dashboard = incoming.settings?.dashboard;
  if (!dashboard) return;

  const nextDashboard = remapDashboard(dashboard, ids);
  data.settings = {
    ...data.settings,
    dashboard: nextDashboard,
  };

  if (dashboardHasWidget(nextDashboard, 'weather') && 'weatherEnabled' in incoming.settings) {
    data.settings.weatherEnabled = incoming.settings.weatherEnabled;
  }
  if (dashboardHasWidget(nextDashboard, 'cnb') && incoming.settings.cnb !== undefined) {
    data.settings.cnb = structuredClone(incoming.settings.cnb);
  }
}

function remapDashboard(dashboard: DashboardConfig, ids: ImportIdMap): DashboardConfig {
  const mapWidgets = (widgets: DashWidget[] | undefined): DashWidget[] | undefined =>
    widgets?.map((widget) => remapWidget(widget, ids));

  return {
    ...structuredClone(dashboard),
    widgets: mapWidgets(dashboard.widgets),
    boards: dashboard.boards?.map((board) => ({
      ...structuredClone(board),
      widgets: mapWidgets(board.widgets) ?? [],
    })),
  };
}

function remapWidget(widget: DashWidget, ids: ImportIdMap): DashWidget {
  if (!widget.config) return structuredClone(widget);
  const config = { ...widget.config };
  if (config.projectId) config.projectId = ids.projects.get(config.projectId) ?? config.projectId;
  if (config.docId) config.docId = ids.docs.get(config.docId) ?? config.docId;
  return { ...structuredClone(widget), config };
}

function dashboardHasWidget(dashboard: DashboardConfig, type: DashWidget['type']): boolean {
  const legacy = dashboard.widgets ?? [];
  const boards = dashboard.boards ?? [];
  return legacy.some((w) => w.type === type) || boards.some((b) => b.widgets.some((w) => w.type === type));
}

function reidProject(p: Project, ids: ImportIdMap): Project {
  const next = {
    ...p,
    id: uid(),
    docs: p.docs?.map((d) => structuredClone(d)),
    memos: p.memos?.map((m) => structuredClone(m)),
    environments: p.environments.map(reidEnv),
  };
  ids.projects.set(p.id, next.id);
  for (const doc of next.docs ?? []) ids.docs.set(doc.id, doc.id);
  return next;
}
function reidEnv(e: Environment): Environment {
  return { ...e, id: uid(), links: e.links.map(reidLink) };
}
function reidLink(l: PlatformLink): PlatformLink {
  return { ...l, id: uid(), accounts: l.accounts.map((a) => ({ ...a, id: uid() })) };
}

function countAccounts(d: VaultData): number {
  return d.projects.reduce((n, p) => n + countAccountsInProject(p), 0);
}
function countAccountsInProject(p: Project): number {
  return p.environments.reduce(
    (n, e) => n + e.links.reduce((m, l) => m + l.accounts.length, 0),
    0,
  );
}

function backupName(kind: string, ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${BACKUP_TAG}-${kind}-${stamp}.${ext}`;
}

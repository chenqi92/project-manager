// ---------------------------------------------------------------------------
// 导入 / 导出：
//   导出  encrypted  —— 整库密文备份（自带 KDF 参数，设备间迁移最安全）
//         json       —— 明文 JSON（带警告，便于互通/手改）
//         csv        —— 明文 CSV
//   导入  encrypted / json / csv / chrome-csv / bitwarden-csv
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
import type {
  Account,
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
      if (!password) throw new Error('需要备份密码才能解密该文件');
      const obj = JSON.parse(content) as EncryptedVault & { format?: string };
      const dek = await unwrapDEK(obj, password);
      return normalize(await decryptVaultData(obj, dek));
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
      ...base,
      projects: incoming.projects.map(reidProject),
    };
    return { data, imported: countAccounts(incoming) };
  }

  const data = structuredClone(base);
  let imported = 0;
  const lc = (s: string) => s.trim().toLowerCase();

  for (const inProj of incoming.projects) {
    let proj = data.projects.find((p) => lc(p.name) === lc(inProj.name));
    if (!proj) {
      proj = reidProject(inProj);
      data.projects.push(proj);
      imported += countAccountsInProject(inProj);
      continue;
    }
    for (const inEnv of inProj.environments) {
      let env = proj.environments.find((e) => lc(e.name) === lc(inEnv.name));
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
  'note',
];

function toCsv(data: VaultData): string {
  const rows: string[][] = [OWN_CSV_HEADER];
  for (const p of data.projects) {
    for (const e of p.environments) {
      for (const l of e.links) {
        if (l.accounts.length === 0) {
          rows.push([p.name, e.name, e.kind, l.name, l.url, '', '', '', l.note ?? '']);
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
      note: row[idx('note')] ?? '',
    });
  }
  return builder.build();
}

/** Bitwarden CSV：folder,favorite,type,name,notes,...,login_uri,login_username,login_password,... */
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
      note: row[idx('notes')] ?? '',
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
  note: string;
}

/** 把摊平的行重新组装成项目/环境/链接/账号树。 */
class VaultBuilder {
  private data: VaultData = emptyVaultData();

  add(r: FlatRow): void {
    const proj = this.upsertProject(r.project);
    const env = this.upsertEnv(proj, r.environment, r.envKind);
    const link = this.upsertLink(env, r.link, r.url);
    if (r.username || r.password || r.label) {
      link.accounts.push(
        newAccount({
          label: r.label,
          username: r.username,
          password: r.password,
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
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
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
  out.settings = data.settings ?? out.settings;
  out.projects = (data.projects ?? []).map((p) =>
    newProject({
      ...p,
      environments: (p.environments ?? []).map((e) =>
        newEnvironment({
          ...e,
          links: (e.links ?? []).map((l) =>
            newLink({
              ...l,
              accounts: (l.accounts ?? []).map((a) => newAccount(a as Account)),
            }),
          ),
        }),
      ),
    }),
  );
  return out;
}

function reidProject(p: Project): Project {
  return { ...p, id: uid(), environments: p.environments.map(reidEnv) };
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

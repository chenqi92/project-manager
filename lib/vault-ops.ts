// ---------------------------------------------------------------------------
// 保险箱数据的纯增删改工具：工厂函数 + 不可变更新辅助。
// ---------------------------------------------------------------------------
import type {
  Account,
  Environment,
  GitRepo,
  MemoItem,
  PlatformLink,
  Project,
  ProjectDoc,
  VaultData,
} from './types';
import { ensureVaultWorkspaces } from './workspace';

export function uid(): string {
  return crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}

export function newAccount(p: Partial<Account> = {}): Account {
  const t = now();
  return {
    id: uid(),
    label: p.label ?? '',
    username: p.username ?? '',
    password: p.password ?? '',
    note: p.note,
    totp: p.totp,
    customFields: p.customFields,
    createdAt: p.createdAt ?? t,
    updatedAt: t,
  };
}

export function newLink(p: Partial<PlatformLink> = {}): PlatformLink {
  return {
    id: uid(),
    name: p.name ?? '',
    envKind: p.envKind,
    envName: p.envName,
    url: p.url ?? '',
    urls: p.urls,
    matchMode: p.matchMode,
    gitRepos: p.gitRepos,
    note: p.note,
    customFields: p.customFields,
    accounts: p.accounts ?? [],
    updatedAt: p.updatedAt ?? now(),
  };
}

export function newGitRepo(p: Partial<GitRepo> = {}): GitRepo {
  return {
    id: uid(),
    url: p.url ?? '',
    branch: p.branch,
    label: p.label,
  };
}

export function newDoc(p: Partial<ProjectDoc> = {}): ProjectDoc {
  return {
    id: uid(),
    title: p.title ?? '未命名文档',
    content: p.content ?? '',
    updatedAt: p.updatedAt ?? now(),
  };
}

export function newMemo(p: Partial<MemoItem> = {}): MemoItem {
  const t = now();
  return {
    id: uid(),
    text: p.text ?? '',
    done: p.done ?? false,
    urgent: p.urgent,
    dueAt: p.dueAt,
    createdAt: p.createdAt ?? t,
    updatedAt: t,
  };
}

function shellArg(v: string): string {
  const oneLine = v.replace(/[\0\r\n\t]/g, ' ');
  return `'${oneLine.replace(/'/g, `'\\''`)}'`;
}

/** 克隆命令：有分支时带 -b；所有用户字段均 shell-quote，避免复制后粘贴执行注入。 */
export function gitCloneCommand(repo: GitRepo): string {
  return repo.branch
    ? `git clone -b ${shellArg(repo.branch)} -- ${shellArg(repo.url)}`
    : `git clone -- ${shellArg(repo.url)}`;
}

/** 一个链接的全部网址（主 + 额外）。 */
export function linkUrls(link: PlatformLink): string[] {
  return [link.url, ...(link.urls ?? [])].map((u) => u.trim()).filter(Boolean);
}

export function newEnvironment(p: Partial<Environment> = {}): Environment {
  return {
    id: uid(),
    name: p.name ?? '',
    kind: p.kind ?? 'other',
    note: p.note,
    gitRepos: p.gitRepos,
    links: p.links ?? [],
    updatedAt: p.updatedAt ?? now(),
  };
}

export function newProject(p: Partial<Project> = {}): Project {
  const t = now();
  return {
    id: uid(),
    name: p.name ?? '',
    color: p.color,
    favorite: p.favorite ?? false,
    tags: p.tags ?? [],
    note: p.note,
    docs: p.docs ?? [],
    memos: p.memos ?? [],
    environments: p.environments ?? [],
    createdAt: p.createdAt ?? t,
    updatedAt: t,
  };
}

/** 深拷贝后在回调中修改 draft，返回新对象（不污染 React state）。 */
export function produce<T>(value: T, recipe: (draft: T) => void): T {
  const draft = structuredClone(value);
  recipe(draft);
  return draft;
}

/** 记录一条删除墓碑（用于同步合并时防止已删项被复活）。 */
export function addTombstone(data: VaultData, id: string): void {
  data.tombstones = data.tombstones ?? [];
  data.tombstones.push({ id, deletedAt: now() });
}

const DEFAULT_ENV_NAME = '默认';

export const ENV_KIND_LABELS: Record<Environment['kind'], string> = {
  dev: '开发',
  test: '测试',
  staging: '预发',
  prod: '生产',
  other: '其它',
};

export const ENV_KIND_COLORS: Record<Environment['kind'], string> = {
  dev: 'bg-sky-100 text-sky-700',
  test: 'bg-amber-100 text-amber-700',
  staging: 'bg-violet-100 text-violet-700',
  prod: 'bg-rose-100 text-rose-700',
  other: 'bg-gray-100 text-gray-600',
};

function cleanEnvName(name: string | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim();
}

export function envTagName(kind: Environment['kind'], name: string | undefined): string {
  const normalized = cleanEnvName(name);
  return !normalized || normalized === DEFAULT_ENV_NAME ? ENV_KIND_LABELS[kind] : normalized;
}

function normalizeEnvName(kind: Environment['kind'], name: string | undefined): string {
  return envTagName(kind, name);
}

function envKey(env: Environment): string {
  return `${env.kind}\0${normalizeEnvName(env.kind, env.name).toLowerCase()}`;
}

function mergeText(a: string | undefined, b: string | undefined): string | undefined {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (!left) return right || undefined;
  if (!right || left === right) return left;
  return `${left}\n\n${right}`;
}

function mergeGitRepos(a: GitRepo[] | undefined, b: GitRepo[] | undefined): GitRepo[] | undefined {
  const out: GitRepo[] = [];
  const seen = new Set<string>();
  for (const repo of [...(a ?? []), ...(b ?? [])]) {
    const key = [
      repo.url.trim().toLowerCase(),
      (repo.branch ?? '').trim().toLowerCase(),
      (repo.label ?? '').trim().toLowerCase(),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out.length > 0 ? out : undefined;
}

function mergeAccountsById(target: PlatformLink, source: PlatformLink): boolean {
  let changed = false;
  const byId = new Map(target.accounts.map((a) => [a.id, a]));
  for (const account of source.accounts) {
    const existing = byId.get(account.id);
    if (!existing) {
      target.accounts.push(account);
      changed = true;
      continue;
    }
    if (account.updatedAt > existing.updatedAt) {
      Object.assign(existing, account);
      changed = true;
    }
  }
  return changed;
}

function mergeLinksById(target: Environment, source: Environment): boolean {
  let changed = false;
  const byId = new Map(target.links.map((l) => [l.id, l]));
  for (const link of source.links) {
    const existing = byId.get(link.id);
    if (!existing) {
      target.links.push(link);
      changed = true;
      continue;
    }
    if (link.updatedAt > existing.updatedAt) {
      Object.assign(existing, { ...link, accounts: existing.accounts });
      changed = true;
    }
    if (mergeAccountsById(existing, link)) changed = true;
    existing.updatedAt = Math.max(existing.updatedAt, link.updatedAt);
  }
  return changed;
}

function upsertTombstone(data: VaultData, id: string, deletedAt: number): void {
  data.tombstones = data.tombstones ?? [];
  const existing = data.tombstones.find((t) => t.id === id);
  if (existing) existing.deletedAt = Math.max(existing.deletedAt, deletedAt);
  else data.tombstones.push({ id, deletedAt });
}

/**
 * 业务层规范化：同一项目内「环境类型 + 环境名」相同的环境应视为同一环境。
 * 同步合并仍按 id 收敛；这里补上用户语义层的归并，避免多设备/导入后出现两个“生产 / 默认”。
 */
export function normalizeVaultData(data: VaultData, timestamp: number = now()): boolean {
  let changed = false;
  changed = ensureVaultWorkspaces(data, timestamp) || changed;

  const seenProjectArrays = new Set<Project[]>();
  for (const ws of data.workspaces ?? []) {
    if (seenProjectArrays.has(ws.projects)) continue;
    seenProjectArrays.add(ws.projects);
    changed = normalizeProjects(ws.projects, data, timestamp) || changed;
  }
  if (!seenProjectArrays.has(data.projects)) {
    changed = normalizeProjects(data.projects, data, timestamp) || changed;
  }
  changed = ensureVaultWorkspaces(data, timestamp) || changed;

  return changed;
}

function normalizeProjects(projects: Project[], data: VaultData, timestamp: number): boolean {
  let changed = false;

  for (const project of projects) {
    const kept: Environment[] = [];
    const byKey = new Map<string, Environment>();

    for (const env of project.environments) {
      const name = normalizeEnvName(env.kind, env.name);
      if (env.name !== name) {
        env.name = name;
        env.updatedAt = Math.max(env.updatedAt, timestamp);
        changed = true;
      }

      for (const link of env.links) {
        const linkEnvKind = link.envKind || env.kind;
        const linkEnvName = normalizeEnvName(linkEnvKind, link.envName || env.name);
        if (link.envName !== linkEnvName || link.envKind !== linkEnvKind) {
          link.envName = linkEnvName;
          link.envKind = linkEnvKind;
          link.updatedAt = Math.max(link.updatedAt, timestamp);
          changed = true;
        }
      }

      const key = envKey(env);
      const target = byKey.get(key);
      if (!target) {
        byKey.set(key, env);
        kept.push(env);
        continue;
      }

      target.note = mergeText(target.note, env.note);
      target.gitRepos = mergeGitRepos(target.gitRepos, env.gitRepos);
      if (mergeLinksById(target, env)) changed = true;
      target.updatedAt = Math.max(target.updatedAt, env.updatedAt, timestamp);
      upsertTombstone(data, env.id, Math.max(timestamp, env.updatedAt));
      changed = true;
    }

    if (kept.length !== project.environments.length) {
      project.environments = kept;
      project.updatedAt = Math.max(project.updatedAt, timestamp);
      changed = true;
    }
  }

  return changed;
}

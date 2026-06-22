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
    createdAt: p.createdAt ?? t,
    updatedAt: t,
  };
}

export function newLink(p: Partial<PlatformLink> = {}): PlatformLink {
  return {
    id: uid(),
    name: p.name ?? '',
    url: p.url ?? '',
    urls: p.urls,
    gitRepos: p.gitRepos,
    note: p.note,
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

/** 克隆命令：有分支时带 -b。 */
export function gitCloneCommand(repo: GitRepo): string {
  return repo.branch ? `git clone -b ${repo.branch} ${repo.url}` : `git clone ${repo.url}`;
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

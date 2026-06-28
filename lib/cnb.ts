// ---------------------------------------------------------------------------
// CNB（cnb.cool）代码托管平台只读集成。
// 通过官方 OpenAPI（https://api.cnb.cool，Bearer 访问令牌）拉取组织下的仓库，
// 按仓库的完整 path（org/子组织/项目/仓库）还原为「子组织 → 项目 → 仓库」层级，
// 替代官网那份按时间平铺、难以归类的「最近更新」列表。
//
// 仅在用户配置了访问令牌、且授权了 api.cnb.cool 域名后才联网（host 权限授权后
// 扩展页 fetch 不受 CORS 限制）。令牌随保险箱一起加密存储，见 VaultSettings.cnb。
// ---------------------------------------------------------------------------
import { browser } from 'wxt/browser';

export const CNB_API_BASE = 'https://api.cnb.cool';
/** 仓库网页/克隆地址的站点根（与 API 域名不同）。 */
export const CNB_WEB_BASE = 'https://cnb.cool';

/** 一个仓库（dto.Repos4User 的精简映射）。 */
export interface CnbRepo {
  id: string;
  /** 仓库名（path 的最后一段） */
  name: string;
  /** 完整路径，如 njly2013/Shuibao/shiyanshishuizhibaozhang/backservice */
  path: string;
  description?: string;
  /** 主语言 */
  language?: string;
  /** 网页地址 */
  webUrl?: string;
  /** 可见性：private / public / secret（原样字符串） */
  visibility?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  /** 最近代码更新时间（epoch ms） */
  lastUpdatedAt?: number;
}

/** 顶层组织（dto.OrganizationAccess 的精简映射）。 */
export interface CnbGroup {
  /** 组织 slug / 路径 */
  path: string;
  name: string;
  description?: string;
  /** 该组织下全部层级的仓库总数 */
  repoCount?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toMs(v: any): number | undefined {
  if (!v) return undefined;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : undefined;
}

/** 把 CNB 的 dto.Repos4User 形状（OpenAPI 返回，或网站 __NEXT_DATA__ 的 groupRepoList）映射为 CnbRepo。 */
export function mapCnbRepo(r: any): CnbRepo {
  const path = String(r?.path ?? r?.slug ?? '');
  return {
    id: String(r?.id ?? path),
    name: String(r?.name ?? path.split('/').pop() ?? ''),
    path,
    description: r?.description ? String(r.description) : undefined,
    language: r?.language ? String(r.language) : undefined,
    webUrl: r?.web_url ? String(r.web_url) : path ? `${CNB_WEB_BASE}/${path}` : undefined,
    visibility: r?.visibility_level != null ? String(r.visibility_level).toLowerCase() : undefined,
    stars: typeof r?.star_count === 'number' ? r.star_count : undefined,
    forks: typeof r?.fork_count === 'number' ? r.fork_count : undefined,
    openIssues: typeof r?.open_issue_count === 'number' ? r.open_issue_count : undefined,
    lastUpdatedAt: toMs(r?.last_updated_at ?? r?.updated_at),
  };
}

function mapGroup(g: any): CnbGroup {
  const path = String(g?.path ?? g?.slug ?? '');
  return {
    path,
    name: String(g?.name ?? path),
    description: g?.description ? String(g.description) : undefined,
    repoCount:
      typeof g?.all_sub_repo_count === 'number'
        ? g.all_sub_repo_count
        : typeof g?.sub_repo_count === 'number'
          ? g.sub_repo_count
          : undefined,
  };
}

async function cnbGet(token: string, path: string, base = CNB_API_BASE): Promise<any> {
  const r = await fetch(base.replace(/\/$/, '') + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 401) throw new Error('访问令牌无效或已过期（401）');
  if (r.status === 403) throw new Error('该令牌无权访问此资源（403）');
  if (r.status === 404) throw new Error('组织不存在或不可见（404）');
  if (!r.ok) throw new Error('CNB 请求失败（HTTP ' + r.status + '）');
  return r.json();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 拉取当前令牌可见的顶层组织（用于设置里勾选要展示的组织）。 */
export async function fetchCnbGroups(token: string, base?: string): Promise<CnbGroup[]> {
  const out: CnbGroup[] = [];
  for (let page = 1; page <= 20; page++) {
    const arr = await cnbGet(token, `/user/groups?page=${page}&page_size=50`, base);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const g of arr) out.push(mapGroup(g));
    if (arr.length < 50) break;
  }
  return out;
}

/**
 * 拉取某组织下的全部仓库（descendant=all 递归含所有子组织），自动翻页。
 * order_by=last_updated_at + desc：最近更新在前。
 */
export async function fetchOrgRepos(token: string, slug: string, base?: string): Promise<CnbRepo[]> {
  const out: CnbRepo[] = [];
  const enc = slug.split('/').map(encodeURIComponent).join('/');
  for (let page = 1; page <= 200; page++) {
    const q = `descendant=all&order_by=last_updated_at&desc=true&page=${page}&page_size=100`;
    const arr = await cnbGet(token, `/${enc}/-/repos?${q}`, base);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const r of arr) out.push(mapCnbRepo(r));
    if (arr.length < 100) break;
  }
  return out;
}

// --- 缓存（storage.local，按组织 slug）------------------------------------
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟
const cacheKey = (slug: string) => `cnb:repos:${slug}`;

interface RepoCache {
  at: number;
  repos: CnbRepo[];
}

/** 取某组织仓库：默认走缓存（TTL 10 分钟），force 时强制刷新并回写缓存。 */
export async function loadOrgRepos(
  token: string,
  slug: string,
  opts?: { force?: boolean; base?: string; ttlMs?: number },
): Promise<{ repos: CnbRepo[]; cachedAt?: number; fromCache: boolean }> {
  const key = cacheKey(slug);
  const ttl = opts?.ttlMs ?? CACHE_TTL;
  if (!opts?.force) {
    try {
      const got = await browser.storage.local.get(key);
      const c = got[key] as RepoCache | undefined;
      if (c && Array.isArray(c.repos) && Date.now() - c.at < ttl) {
        return { repos: c.repos, cachedAt: c.at, fromCache: true };
      }
    } catch {
      /* 缓存读失败：照常联网 */
    }
  }
  const repos = await fetchOrgRepos(token, slug, opts?.base);
  const at = Date.now();
  await browser.storage.local.set({ [key]: { at, repos } satisfies RepoCache }).catch(() => {});
  return { repos, cachedAt: at, fromCache: false };
}

/** 清掉某组织（或全部）的仓库缓存。 */
export async function clearRepoCache(slug?: string): Promise<void> {
  try {
    if (slug) {
      await browser.storage.local.remove(cacheKey(slug));
      return;
    }
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('cnb:repos:'));
    if (keys.length) await browser.storage.local.remove(keys);
  } catch {
    /* ignore */
  }
}

// --- 仓库树：子组织 → 项目 → 仓库 ----------------------------------------
export interface RepoProjectNode {
  /** 项目的完整父路径，如 njly2013/Shuibao/shiyanshishuizhibaozhang */
  key: string;
  /** 项目名（仓库的直接上级目录段；仅 org/repo 直属时为占位名） */
  name: string;
  repos: CnbRepo[];
}

export interface RepoGroupNode {
  /** 子组织段，如 Shuibao / BasicSoftware（org 直属仓库归到 __root__） */
  key: string;
  name: string;
  projects: RepoProjectNode[];
  repoCount: number;
}

const ROOT_PROJECT = '（直属仓库）';

/**
 * 把一个组织的扁平仓库列表组织成「子组织 → 项目 → 仓库」三层。
 * path 形如 org/子组织/项目/仓库；不足四段时：
 *   - org/子组织/仓库 → 项目归为「直属仓库」
 *   - org/仓库        → 子组织归为根（__root__），项目为「直属仓库」
 */
export function buildRepoTree(orgSlug: string, repos: CnbRepo[]): RepoGroupNode[] {
  const groups = new Map<string, Map<string, RepoProjectNode>>();
  for (const repo of repos) {
    const segs = repo.path.split('/').filter(Boolean);
    const subOrg = segs.length >= 3 ? segs[1]! : '__root__';
    const projectKey = segs.length >= 2 ? segs.slice(0, -1).join('/') : orgSlug;
    const projectName = segs.length >= 4 ? segs[segs.length - 2]! : ROOT_PROJECT;
    let projects = groups.get(subOrg);
    if (!projects) groups.set(subOrg, (projects = new Map()));
    let proj = projects.get(projectKey);
    if (!proj) projects.set(projectKey, (proj = { key: projectKey, name: projectName, repos: [] }));
    proj.repos.push(repo);
  }
  const sortRepos = (a: CnbRepo, b: CnbRepo) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0);
  const out: RepoGroupNode[] = [];
  for (const [key, projects] of groups) {
    const projList = [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
    let count = 0;
    for (const p of projList) {
      p.repos.sort(sortRepos);
      count += p.repos.length;
    }
    out.push({
      key,
      name: key === '__root__' ? '（直属仓库）' : key,
      projects: projList,
      repoCount: count,
    });
  }
  // 直属仓库分组排到最后，其余按仓库数倒序。
  return out.sort((a, b) => {
    if (a.key === '__root__') return 1;
    if (b.key === '__root__') return -1;
    return b.repoCount - a.repoCount;
  });
}

/** 仓库的 https clone 地址。 */
export function cnbCloneUrl(repo: CnbRepo): string {
  return `${CNB_WEB_BASE}/${repo.path}.git`;
}

/** clone 命令（默认分支）。 */
export function cnbCloneCommand(repo: CnbRepo): string {
  return `git clone ${cnbCloneUrl(repo)}`;
}

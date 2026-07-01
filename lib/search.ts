// ---------------------------------------------------------------------------
// 把保险箱摊平成「账号级」记录，用于全局搜索与「当前站点匹配」。
// ---------------------------------------------------------------------------
import { originsMatch } from './autofill';
import type { Account, Environment, PlatformLink, Project, VaultData } from './types';
import { linkUrls } from './vault-ops';

export interface FlatEntry {
  projectId: string;
  projectName: string;
  envId: string;
  envName: string;
  envKind: string;
  linkId: string;
  linkName: string;
  url: string;
  accountId: string;
  accountLabel: string;
  username: string;
  /** 注意：明文密码也在内存里，仅供已解锁的扩展 UI 使用 */
  password: string;
  totp?: string;
  updatedAt: number;
  note?: string;
  customText?: string;
}

function customFieldText(...groups: Array<PlatformLink['customFields'] | Account['customFields']>): string {
  return groups
    .flatMap((fields) => fields ?? [])
    .flatMap((f) => [f.label, f.value])
    .filter(Boolean)
    .join(' ');
}

function buildEntry(
  p: Project,
  e: Environment,
  l: PlatformLink,
  a: Account,
  url: string,
): FlatEntry {
  return {
    projectId: p.id,
    projectName: p.name,
    envId: e.id,
    envName: l.envName || e.name,
    envKind: l.envKind || e.kind,
    linkId: l.id,
    linkName: l.name,
    url,
    accountId: a.id,
    accountLabel: a.label,
    username: a.username,
    password: a.password,
    totp: a.totp,
    updatedAt: a.updatedAt,
    note: a.note ?? l.note,
    customText: customFieldText(l.customFields, a.customFields),
  };
}

export function flatten(data: VaultData): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const p of data.projects)
    for (const e of p.environments)
      for (const l of e.links)
        // 主网址为空时回退到「更多网址」的首个，保证多网址链接也能被「打开并登录」。
        for (const a of l.accounts)
          out.push(buildEntry(p, e, l, a, l.url || linkUrls(l)[0] || ''));
  return out;
}

export function search(data: VaultData, query: string): FlatEntry[] {
  const q = query.trim().toLowerCase();
  const all = flatten(data);
  if (!q) return all;
  const terms = q.split(/\s+/);
  return all.filter((e) => {
    const hay = [
      e.projectName,
      e.envName,
      e.linkName,
      e.url,
      e.accountLabel,
      e.username,
      e.note ?? '',
      e.customText ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** 当前标签页 URL 精确匹配到的账号（用于 popup 一键填充）；匹配链接的任一网址。 */
export function matchForUrl(data: VaultData, pageUrl: string): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const p of data.projects)
    for (const e of p.environments)
      for (const l of e.links) {
        const matched = linkUrls(l).find((u) => originsMatch(u, pageUrl));
        if (!matched) continue;
        for (const a of l.accounts) out.push(buildEntry(p, e, l, a, matched));
      }
  return out;
}

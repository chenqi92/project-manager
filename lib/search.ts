// ---------------------------------------------------------------------------
// 把金库摊平成「账号级」记录，用于全局搜索与「当前站点匹配」。
// ---------------------------------------------------------------------------
import { originsMatch } from './autofill';
import type { VaultData } from './types';

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
}

export function flatten(data: VaultData): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const p of data.projects) {
    for (const e of p.environments) {
      for (const l of e.links) {
        for (const a of l.accounts) {
          out.push({
            projectId: p.id,
            projectName: p.name,
            envId: e.id,
            envName: e.name,
            envKind: e.kind,
            linkId: l.id,
            linkName: l.name,
            url: l.url,
            accountId: a.id,
            accountLabel: a.label,
            username: a.username,
            password: a.password,
            totp: a.totp,
            updatedAt: a.updatedAt,
            note: a.note ?? l.note,
          });
        }
      }
    }
  }
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
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** 当前标签页 URL 精确匹配到的账号（用于 popup 一键填充）。 */
export function matchForUrl(data: VaultData, pageUrl: string): FlatEntry[] {
  return flatten(data).filter((e) => e.url && originsMatch(e.url, pageUrl));
}

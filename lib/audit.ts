// ---------------------------------------------------------------------------
// 本地密码健康审计：弱密码 / 重复使用 / 长期未更新。全在本地，不外传。
// ---------------------------------------------------------------------------
import { flatten, type FlatEntry } from './search';
import type { VaultData } from './types';

export type IssueKind = 'weak' | 'reused' | 'old';

export interface AuditIssue {
  entry: FlatEntry;
  kinds: IssueKind[];
}

export interface AuditReport {
  issues: AuditIssue[];
  total: number;
  weak: number;
  reused: number;
  old: number;
}

const OLD_MS = 180 * 24 * 60 * 60 * 1000; // 半年

function isWeak(pw: string): boolean {
  if (pw.length < 10) return true;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  return classes < 3;
}

export function audit(data: VaultData, nowMs: number = Date.now()): AuditReport {
  const all = flatten(data).filter((e) => e.password);

  // 找出被多个账号复用的密码。
  const byPassword = new Map<string, FlatEntry[]>();
  for (const e of all) {
    const list = byPassword.get(e.password) ?? [];
    list.push(e);
    byPassword.set(e.password, list);
  }
  const reusedIds = new Set<string>();
  for (const list of byPassword.values()) {
    if (list.length > 1) list.forEach((e) => reusedIds.add(e.accountId));
  }

  const issues: AuditIssue[] = [];
  let weak = 0;
  let reused = 0;
  let old = 0;
  for (const e of all) {
    const kinds: IssueKind[] = [];
    if (isWeak(e.password)) {
      kinds.push('weak');
      weak++;
    }
    if (reusedIds.has(e.accountId)) {
      kinds.push('reused');
      reused++;
    }
    if (nowMs - e.updatedAt > OLD_MS) {
      kinds.push('old');
      old++;
    }
    if (kinds.length) issues.push({ entry: e, kinds });
  }

  return { issues, total: all.length, weak, reused, old };
}

export const ISSUE_LABELS: Record<IssueKind, string> = {
  weak: '弱密码',
  reused: '重复使用',
  old: '超半年未改',
};

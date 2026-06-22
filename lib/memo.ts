// ---------------------------------------------------------------------------
// 备忘聚合与截止时间工具（纯函数，便于测试）。
// ---------------------------------------------------------------------------
import type { MemoItem, Project } from './types';

export interface FlatMemo extends MemoItem {
  projectId: string;
  projectName: string;
}

export function flatMemos(projects: Project[]): FlatMemo[] {
  const out: FlatMemo[] = [];
  for (const p of projects)
    for (const m of p.memos ?? []) out.push({ ...m, projectId: p.id, projectName: p.name });
  return out;
}

/** 截止日期与“今天”的整天差：负=逾期，0=今天，1=明天…（按本地日历日计算）。 */
export function dueDaysFrom(dueAt: number, nowMs: number): number {
  const d1 = new Date(dueAt);
  d1.setHours(0, 0, 0, 0);
  const d2 = new Date(nowMs);
  d2.setHours(0, 0, 0, 0);
  return Math.round((d1.getTime() - d2.getTime()) / 86_400_000);
}

export function dueLabel(dueAt: number, nowMs: number): string {
  const d = dueDaysFrom(dueAt, nowMs);
  if (d < 0) return `逾期 ${-d} 天`;
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  if (d <= 6) return `${d} 天后`;
  const dt = new Date(dueAt);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

export type DueState = 'none' | 'overdue' | 'soon' | 'later';

export function dueState(memo: MemoItem, nowMs: number): DueState {
  if (memo.done || !memo.dueAt) return 'none';
  const d = dueDaysFrom(memo.dueAt, nowMs);
  if (d < 0) return 'overdue';
  if (d <= 2) return 'soon';
  return 'later';
}

/** 是否要抖动标红提醒：未完成且（紧急或逾期）。 */
export function isAlarming(memo: MemoItem, nowMs: number): boolean {
  if (memo.done) return false;
  return !!memo.urgent || dueState(memo, nowMs) === 'overdue';
}

/** 排序：未完成在前；再按截止时间升序（无截止的排后）；最后按创建时间。 */
export function sortMemos<T extends MemoItem>(memos: T[]): T[] {
  return [...memos].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.dueAt ?? Infinity;
    const bd = b.dueAt ?? Infinity;
    if (ad !== bd) return ad - bd;
    return a.createdAt - b.createdAt;
  });
}

/** date input 的 yyyy-mm-dd <-> epoch ms（取当天 00:00 本地） */
export function dateInputValue(dueAt: number | undefined): string {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateInput(value: string): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d).getTime();
}

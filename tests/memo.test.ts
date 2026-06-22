// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  dateInputValue,
  dueDaysFrom,
  dueLabel,
  dueState,
  isAlarming,
  parseDateInput,
  sortMemos,
} from '../lib/memo';
import { newMemo } from '../lib/vault-ops';

const today = new Date(2026, 5, 22, 8, 0).getTime(); // 本地 2026-06-22 08:00

describe('memo due helpers', () => {
  it('dueDaysFrom 按本地日历日', () => {
    expect(dueDaysFrom(new Date(2026, 5, 22, 23, 0).getTime(), today)).toBe(0);
    expect(dueDaysFrom(new Date(2026, 5, 23, 1, 0).getTime(), today)).toBe(1);
    expect(dueDaysFrom(new Date(2026, 5, 20, 1, 0).getTime(), today)).toBe(-2);
  });

  it('dueLabel', () => {
    expect(dueLabel(new Date(2026, 5, 22).getTime(), today)).toBe('今天');
    expect(dueLabel(new Date(2026, 5, 23).getTime(), today)).toBe('明天');
    expect(dueLabel(new Date(2026, 5, 25).getTime(), today)).toBe('3 天后');
    expect(dueLabel(new Date(2026, 5, 20).getTime(), today)).toBe('逾期 2 天');
  });

  it('dueState 与 isAlarming', () => {
    const overdue = newMemo({ text: 'a', dueAt: new Date(2026, 5, 21).getTime() });
    const soon = newMemo({ text: 'b', dueAt: new Date(2026, 5, 23).getTime() });
    const later = newMemo({ text: 'c', dueAt: new Date(2026, 5, 30).getTime() });
    expect(dueState(overdue, today)).toBe('overdue');
    expect(dueState(soon, today)).toBe('soon');
    expect(dueState(later, today)).toBe('later');
    expect(isAlarming(overdue, today)).toBe(true);
    expect(isAlarming({ ...overdue, done: true }, today)).toBe(false);
    expect(isAlarming(newMemo({ text: 'u', urgent: true }), today)).toBe(true);
  });

  it('sortMemos：未完成在前，按截止升序，无截止靠后，已完成最后', () => {
    const out = sortMemos([
      newMemo({ text: 'done', done: true }),
      newMemo({ text: 'noDue' }),
      newMemo({ text: 'late', dueAt: new Date(2026, 5, 30).getTime() }),
      newMemo({ text: 'soon', dueAt: new Date(2026, 5, 23).getTime() }),
    ]);
    expect(out.map((m) => m.text)).toEqual(['soon', 'late', 'noDue', 'done']);
  });

  it('date input 往返', () => {
    const ts = parseDateInput('2026-06-22');
    expect(dateInputValue(ts)).toBe('2026-06-22');
    expect(parseDateInput('')).toBeUndefined();
    expect(dateInputValue(undefined)).toBe('');
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BACKUP_REMIND_AFTER_MS, shouldRemindBackup } from '../lib/backup';

const NOW = 1_700_000_000_000;
const base = { syncEnabled: false, projectCount: 3, lastBackupAt: undefined, snoozeUntil: undefined };

describe('shouldRemindBackup', () => {
  it('从未备份且已有数据时提醒', () => {
    expect(shouldRemindBackup(base, NOW)).toBe(true);
  });

  it('开启同步时不提醒（已有云端副本）', () => {
    expect(shouldRemindBackup({ ...base, syncEnabled: true }, NOW)).toBe(false);
  });

  it('还没有项目时不提醒', () => {
    expect(shouldRemindBackup({ ...base, projectCount: 0 }, NOW)).toBe(false);
  });

  it('最近备份过则不提醒', () => {
    expect(shouldRemindBackup({ ...base, lastBackupAt: NOW - 1000 }, NOW)).toBe(false);
  });

  it('距上次备份超过阈值则提醒', () => {
    const stale = NOW - BACKUP_REMIND_AFTER_MS - 1;
    expect(shouldRemindBackup({ ...base, lastBackupAt: stale }, NOW)).toBe(true);
  });

  it('处于「稍后」静默期内不提醒', () => {
    expect(shouldRemindBackup({ ...base, snoozeUntil: NOW + 1000 }, NOW)).toBe(false);
  });

  it('静默期已过则恢复提醒', () => {
    expect(shouldRemindBackup({ ...base, snoozeUntil: NOW - 1000 }, NOW)).toBe(true);
  });
});

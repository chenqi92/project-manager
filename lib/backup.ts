// ---------------------------------------------------------------------------
// 备份提醒的纯逻辑：与 UI 无关，便于单测。
// 数据默认只存本机（chrome.storage.local），卸载即被 Chrome 清空。开启同步或导出
// 加密备份才有「后路」；本模块决定何时提醒用户久未备份。
// ---------------------------------------------------------------------------

// 久未备份的提醒阈值；「稍后再说」后的静默时长。
export const BACKUP_REMIND_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
export const BACKUP_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 是否该提醒用户备份。仅在「没开同步 + 已有数据 + 距上次备份过久 + 未在静默期」时提醒。
 * 开了同步即视为已有云端副本，不再提醒。
 */
export function shouldRemindBackup(
  opts: {
    syncEnabled: boolean;
    projectCount: number;
    lastBackupAt?: number;
    snoozeUntil?: number;
  },
  now: number,
): boolean {
  if (opts.syncEnabled) return false;
  if (opts.projectCount === 0) return false;
  if (now < (opts.snoozeUntil ?? 0)) return false;
  return now - (opts.lastBackupAt ?? 0) > BACKUP_REMIND_AFTER_MS;
}

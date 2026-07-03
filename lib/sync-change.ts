import type { VaultData, VaultSettings, Workspace } from './types';

/**
 * 自动同步只关心会被多端合并的真实内容。
 * 根层 projects/settings.dashboard 只是当前工作区镜像，activeWorkspaceId 只是当前设备 UI 状态；
 * 这些变化不应单独触发远端同步。
 */
export function hasSyncRelevantChange(before: VaultData, after: VaultData): boolean {
  return syncRelevantFingerprint(before) !== syncRelevantFingerprint(after);
}

function syncRelevantFingerprint(data: VaultData): string {
  return stableStringify({
    version: data.version,
    workspaces: syncWorkspaces(data),
    tombstones: data.tombstones ?? [],
    settings: syncSettings(data.settings),
  });
}

function syncWorkspaces(data: VaultData): Workspace[] | Array<Pick<VaultData, 'projects'>> {
  if (Array.isArray(data.workspaces) && data.workspaces.length > 0) return data.workspaces;
  return [{ projects: data.projects ?? [] }];
}

function syncSettings(
  settings: VaultSettings,
): Omit<
  VaultSettings,
  'dashboard' | 'updatedAt' | 'lastBackupAt' | 'backupSnoozeUntil' | 'onboardedBackup' | 'onboardedFeatureSwitches'
> {
  // 引导/备份提醒状态由各设备自动写入。若它们也计入「设置变化」，随手点一次
  // 「稍后再说」就会顶高 settings.updatedAt，让这台设备整体赢走 settings、
  // 抹掉只在别处配置过的内容（如 CNB 令牌）。
  const {
    dashboard: _dashboard,
    updatedAt: _updatedAt,
    lastBackupAt: _lastBackupAt,
    backupSnoozeUntil: _backupSnoozeUntil,
    onboardedBackup: _onboardedBackup,
    onboardedFeatureSwitches: _onboardedFeatureSwitches,
    ...rest
  } = settings;
  return rest;
}

/** 决定 settings.updatedAt 是否需要更新的指纹：与自动同步触发用同一套字段口径。 */
export function settingsStampFingerprint(settings: VaultSettings): string {
  return stableStringify(syncSettings(settings));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortForStableStringify(v);
  }
  return out;
}

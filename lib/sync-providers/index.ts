// 同步目标的工厂与帮助函数：按类型构造 provider，旧配置迁移，脱敏成 UI 视图。
import type { SyncStateMap, SyncTarget, SyncTargetView, VaultData } from '../types';
import { createGitProvider } from './git';
import { createOAuthDriveProvider } from './oauth-drive';
import { SelfHostedProvider } from './self-hosted';
import { createSynologyProvider } from './synology';
import type { SyncProvider } from './types';
import { WebDavProvider } from './webdav';

export * from './engine';
export * from './types';

/** 按目标类型构造对应的同步后端。 */
export function providerFor(target: SyncTarget): SyncProvider {
  switch (target.type) {
    case 'self-hosted':
      return new SelfHostedProvider(target);
    case 'webdav':
      return new WebDavProvider(target);
    case 'github':
    case 'gitlab':
    case 'gitee':
      return createGitProvider(target);
    case 'google-drive':
    case 'onedrive':
    case 'dropbox':
      return createOAuthDriveProvider(target);
    case 'synology':
      return createSynologyProvider(target);
  }
}

/** 该目标启用同步前需申请的 host 权限来源（运行时按需授权）。 */
export function originsFor(target: SyncTarget): string[] {
  switch (target.type) {
    case 'self-hosted':
      return [originPattern(target.serverUrl)];
    case 'webdav':
      return [originPattern(target.url)];
    case 'github':
      return [originPattern(target.apiBase || 'https://api.github.com')];
    case 'gitlab':
      return [originPattern(target.apiBase || 'https://gitlab.com/api/v4')];
    case 'gitee':
      return [originPattern(target.apiBase || 'https://gitee.com/api/v5')];
    case 'google-drive':
      return [
        'https://www.googleapis.com/*',
        'https://oauth2.googleapis.com/*',
        'https://accounts.google.com/*',
      ];
    case 'onedrive':
      return ['https://graph.microsoft.com/*', 'https://login.microsoftonline.com/*'];
    case 'dropbox':
      return ['https://api.dropboxapi.com/*', 'https://content.dropboxapi.com/*'];
    case 'synology':
      return [originPattern(target.baseUrl)];
  }
}

function originPattern(url: string): string {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return url;
  }
}

/**
 * 一次性迁移：把旧的单一 settings.sync 转成 syncTargets 里的一个 self-hosted 目标。
 * 返回是否发生了迁移（调用方据此持久化）。
 */
export function migrateSyncSettings(data: VaultData): boolean {
  const s = data.settings;
  if (s.sync && !s.syncTargets) {
    s.syncTargets = [
      {
        id: crypto.randomUUID(),
        type: 'self-hosted',
        label: '自托管服务器',
        enabled: s.sync.enabled,
        serverUrl: s.sync.serverUrl,
        token: s.sync.token,
      },
    ];
    delete s.sync;
    s.updatedAt = Date.now();
    return true;
  }
  if (!s.syncTargets) {
    s.syncTargets = [];
    return false;
  }
  return false;
}

const SECRET_FIELDS = ['token', 'password', 'refreshToken', 'clientSecret', 'did'] as const;

/** 脱敏成 UI 视图：复制配置但清空所有密钥字段，附带位置摘要与运行状态。 */
export function toTargetView(target: SyncTarget, states: SyncStateMap): SyncTargetView {
  const redacted = { ...target } as unknown as Record<string, unknown>;
  for (const f of SECRET_FIELDS) if (f in redacted && redacted[f]) redacted[f] = '';
  return {
    target: redacted as unknown as SyncTarget,
    authorized: authorizedOf(target),
    summary: summarize(target),
    state: states[target.id] ?? null,
  };
}

function authorizedOf(target: SyncTarget): boolean | undefined {
  if (target.type === 'google-drive' || target.type === 'onedrive' || target.type === 'dropbox') {
    return Boolean(target.refreshToken);
  }
  if (target.type === 'synology') return Boolean(target.did); // 已绑定免 OTP 设备令牌
  return undefined;
}

function summarize(t: SyncTarget): string {
  switch (t.type) {
    case 'self-hosted':
      return safeHost(t.serverUrl);
    case 'webdav':
      return safeHost(t.url) + '/' + (t.filePath || 'vault.enc');
    case 'github':
    case 'gitlab':
    case 'gitee':
      return `${t.owner}/${t.repo} @ ${t.branch}`;
    case 'google-drive':
      return 'Google Drive · 应用数据目录';
    case 'onedrive':
      return 'OneDrive · 应用文件夹';
    case 'dropbox':
      return 'Dropbox · 应用文件夹 / ' + (t.fileName || 'vault.enc');
    case 'synology':
      return `${safeHost(t.baseUrl)} · ${t.filePath || '/home/vault.enc'}`;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

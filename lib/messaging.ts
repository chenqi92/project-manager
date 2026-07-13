// ---------------------------------------------------------------------------
// 类型化消息层：popup / options ←→ background(service worker)
// 所有加解密都集中在 background 完成，UI 侧只拿到解锁后的明文做展示。
// ---------------------------------------------------------------------------
import { browser } from 'wxt/browser';
import type { PreflightResult } from './sync-providers/types';
import type {
  AssistSnapshot,
  BioEnrollmentPublic,
  CapturePending,
  CaptureSuccessSignals,
  ExportMode,
  ImportFormat,
  ImportMode,
  KdfConfig,
  SyncTarget,
  SyncTargetView,
  VaultData,
  VaultStatus,
} from './types';

export interface SyncTargetsResp {
  targets: SyncTargetView[];
  autoSync: boolean;
}

export type Msg =
  | { type: 'vault:status' }
  | { type: 'vault:create'; password: string; kdf?: KdfConfig }
  | { type: 'vault:unlock'; password: string }
  | { type: 'vault:lock' }
  | { type: 'vault:get' }
  // switchWorkspace：本次保存显式携带工作区切换（新建/删除/切换）。普通保存不允许改
  // activeWorkspaceId——它是设备本地 UI 状态，旧快照（popup/其它标签页）保存时不得回滚它。
  | { type: 'vault:save'; data: VaultData; switchWorkspace?: boolean }
  | { type: 'vault:changePassword'; current: string; next: string }
  | { type: 'vault:export'; mode: ExportMode; password?: string; projectIds?: string[] }
  | {
      type: 'vault:import';
      format: ImportFormat;
      mode: ImportMode;
      content: string;
      password?: string;
    }
  | { type: 'vault:reset' }
  | { type: 'activity' }
  | { type: 'clipboard:clearLater'; clearMs: number }
  | { type: 'ui:openUnlock' }
  | { type: 'ui:closeSelf' }
  // 生物识别
  | { type: 'vault:bioEnrollments' }
  | { type: 'vault:unlockWithPrf'; enrollmentId: string; prfOutput: string }
  | {
      type: 'vault:enrollBio';
      label: string;
      credentialId: string;
      prfSalt: string;
      prfOutput: string;
    }
  | { type: 'vault:removeBio'; enrollmentId: string }
  // 多端同步
  | { type: 'sync:targets' }
  | { type: 'sync:targetSave'; target: SyncTarget }
  | { type: 'sync:targetRemove'; id: string }
  | { type: 'sync:targetPreflight'; target: SyncTarget }
  | { type: 'sync:listDir'; id?: string; target?: SyncTarget; path: string[] }
  | { type: 'sync:targetSync'; id: string; foreignPassword?: string; confirmFirstPush?: boolean }
  | { type: 'sync:targetPush'; id: string }
  | { type: 'sync:targetPull'; id: string; foreignPassword?: string }
  | { type: 'sync:now' }
  | {
      type: 'sync:oauthAuthorize';
      driveType: 'google-drive' | 'onedrive' | 'dropbox';
      clientId: string;
      clientSecret?: string;
    }
  | {
      type: 'sync:synologyAuthorize';
      baseUrl: string;
      account: string;
      password: string;
      otpCode?: string;
    }
  | { type: 'sync:synologyRebind'; id: string; otp: string }
  | { type: 'vault:adopt'; serverUrl: string; token: string }
  // 打开链接并自动填充
  | {
      type: 'tab:openAndFill';
      url: string;
      username: string;
      password: string;
      tenant?: string;
      accountId?: string;
      submit: boolean;
    }
  // 网页内助手（content script 发起；后台按 sender origin 二次校验）
  // url：页面上报的 location.href（含 SPA 路由/hash），后台校验同源后用于 path-prefix/exact-url 匹配
  | { type: 'assist:matches'; url?: string }
  // 页面浮层点「此网站不再提示」：把 sender origin 加进按站点静默名单（只能静默自己）
  | { type: 'assist:muteSite' }
  // 页面浮层点「本次会话不再自动弹」：仅本次浏览器会话内不自动弹登录横幅，不进静默名单（storage.session）
  | { type: 'assist:snoozeSite' }
  | { type: 'assist:fillUsername'; accountId: string; submit?: boolean; url?: string }
  | { type: 'assist:fill'; accountId: string; submit?: boolean; url?: string }
  | { type: 'assist:fillTotp'; accountId: string; submit?: boolean; url?: string }
  // 登录捕获
  | {
      type: 'capture:candidate';
      origin: string;
      url: string;
      title?: string;
      username: string;
      password: string;
      tenant?: string;
      authProvider?: string;
      totp?: string;
    }
  | { type: 'capture:successCheck'; origin: string; url: string; title?: string; signals: CaptureSuccessSignals }
  // 内容脚本在第三方登录（OAuth / OIDC / CAS）授权页上报当前地址；
  // background 解析出「哪个 IdP 登录哪个站点」，为站点建立登录候选
  | { type: 'capture:oauthNav'; url: string }
  | {
      type: 'capture:login';
      origin: string;
      url: string;
      title?: string;
      username: string;
      password: string;
      tenant?: string;
      authProvider?: string;
      totp?: string;
    }
  | {
      type: 'capture:manual';
      tabId?: number;
      url: string;
      title?: string;
      username: string;
      password: string;
      tenant?: string;
      totp?: string;
    }
  // popup 直填成功后上报（仅扩展页面可发）：登录捕获时据此识别「未修改的自动填充」并跳过提示
  | {
      type: 'capture:markAutoFill';
      tabId: number;
      url: string;
      username: string;
      password: string;
      tenant?: string;
    }
  | { type: 'capture:pending'; id?: string }
  | {
      type: 'capture:save';
      id?: string;
      accountId?: string;
      username?: string;
      accountLabel?: string;
      tenant?: string;
      targetLinkId?: string;
      targetProjectId?: string;
      newProjectName?: string;
      targetWorkspaceId?: string;
    }
  | { type: 'capture:editSave'; id?: string }
  | { type: 'capture:dismiss'; id?: string }
  | { type: 'capture:muteReprompt'; id?: string };

export interface ExportResult {
  filename: string;
  mime: string;
  content: string;
}

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };
export type MsgResponse<T> = Ok<T> | Err;

async function send<T>(msg: Msg): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as MsgResponse<T> | undefined;
  if (!res) throw new Error('后台无响应');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** UI 侧调用入口。 */
export const api = {
  status: () => send<VaultStatus>({ type: 'vault:status' }),
  create: (password: string, kdf?: KdfConfig) =>
    send<VaultStatus>({ type: 'vault:create', password, kdf }),
  unlock: (password: string) => send<VaultStatus>({ type: 'vault:unlock', password }),
  lock: () => send<VaultStatus>({ type: 'vault:lock' }),
  get: () => send<VaultData>({ type: 'vault:get' }),
  save: (data: VaultData, opts?: { switchWorkspace?: boolean }) =>
    send<void>({ type: 'vault:save', data, switchWorkspace: opts?.switchWorkspace }),
  changePassword: (current: string, next: string) =>
    send<void>({ type: 'vault:changePassword', current, next }),
  export: (mode: ExportMode, password?: string, projectIds?: string[]) =>
    send<ExportResult>({ type: 'vault:export', mode, password, projectIds }),
  import: (
    format: ImportFormat,
    content: string,
    mode: ImportMode,
    password?: string,
  ) =>
    send<{ status: VaultStatus; imported: number }>({
      type: 'vault:import',
      format,
      mode,
      content,
      password,
    }),
  reset: () => send<VaultStatus>({ type: 'vault:reset' }),
  activity: () => send<void>({ type: 'activity' }),
  /** 解锁标签页解锁成功后自请求关闭（脚本无法可靠地 window.close 非自身打开的标签）。 */
  closeSelf: () => send<void>({ type: 'ui:closeSelf' }),

  // 生物识别
  bioEnrollments: () => send<BioEnrollmentPublic[]>({ type: 'vault:bioEnrollments' }),
  unlockWithPrf: (enrollmentId: string, prfOutput: string) =>
    send<VaultStatus>({ type: 'vault:unlockWithPrf', enrollmentId, prfOutput }),
  enrollBio: (label: string, credentialId: string, prfSalt: string, prfOutput: string) =>
    send<void>({ type: 'vault:enrollBio', label, credentialId, prfSalt, prfOutput }),
  removeBio: (enrollmentId: string) => send<void>({ type: 'vault:removeBio', enrollmentId }),

  // 多端同步
  syncTargets: () => send<SyncTargetsResp>({ type: 'sync:targets' }),
  syncTargetSave: (target: SyncTarget) =>
    send<{ id: string; targets: SyncTargetView[] }>({ type: 'sync:targetSave', target }),
  syncTargetRemove: (id: string) =>
    send<{ targets: SyncTargetView[] }>({ type: 'sync:targetRemove', id }),
  syncTargetPreflight: (target: SyncTarget) =>
    send<PreflightResult>({ type: 'sync:targetPreflight', target }),
  syncListDir: (arg: { id?: string; target?: SyncTarget; path: string[] }) =>
    send<{ folders: Array<{ name: string }> }>({ type: 'sync:listDir', ...arg }),
  syncTargetSync: (id: string, foreignPassword?: string, confirmFirstPush?: boolean) =>
    send<{ foreign?: boolean; emptyRemote?: boolean }>({
      type: 'sync:targetSync',
      id,
      foreignPassword,
      confirmFirstPush,
    }),
  syncTargetPush: (id: string) => send<void>({ type: 'sync:targetPush', id }),
  syncTargetPull: (id: string, foreignPassword?: string) =>
    send<{ foreign?: boolean }>({ type: 'sync:targetPull', id, foreignPassword }),
  syncNow: () => send<void>({ type: 'sync:now' }),
  syncOAuthAuthorize: (
    driveType: 'google-drive' | 'onedrive' | 'dropbox',
    clientId: string,
    clientSecret?: string,
  ) => send<{ refreshToken: string }>({ type: 'sync:oauthAuthorize', driveType, clientId, clientSecret }),
  syncSynologyAuthorize: (
    baseUrl: string,
    account: string,
    password: string,
    otpCode?: string,
  ) =>
    send<{ did: string }>({ type: 'sync:synologyAuthorize', baseUrl, account, password, otpCode }),
  syncSynologyRebind: (id: string, otp: string) =>
    send<{ ok: boolean }>({ type: 'sync:synologyRebind', id, otp }),
  adopt: (serverUrl: string, token: string) =>
    send<VaultStatus>({ type: 'vault:adopt', serverUrl, token }),

  // 打开链接并自动填充（调用前需在页面里先 chrome.permissions.request 该 origin）
  openAndFill: (
    url: string,
    username: string,
    password: string,
    submit: boolean,
    tenant?: string,
    accountId?: string,
  ) =>
    send<{ filled: boolean; reason?: string }>({
      type: 'tab:openAndFill',
      url,
      username,
      password,
      tenant,
      accountId,
      submit,
    }),

  // 网页内助手
  assistMatches: (url?: string) => send<AssistSnapshot>({ type: 'assist:matches', url }),

  // 登录捕获
  captureManual: (
    tabId: number | undefined,
    url: string,
    username: string,
    password: string,
    title?: string,
    totp?: string,
    tenant?: string,
  ) =>
    send<CapturePending | null>({ type: 'capture:manual', tabId, url, title, username, password, totp, tenant }),
  /** popup 直填成功后上报，用于登录捕获识别「未修改的自动填充」并跳过保存提示。 */
  markAutoFill: (tabId: number, url: string, username: string, password: string, tenant?: string) =>
    send<void>({ type: 'capture:markAutoFill', tabId, url, username, password, tenant }),
  capturePending: (id?: string) => send<CapturePending | null>({ type: 'capture:pending', id }),
  captureSave: (
    id?: string,
    accountId?: string,
    edits?: {
      username?: string;
      accountLabel?: string;
      tenant?: string;
      targetLinkId?: string;
      targetProjectId?: string;
      newProjectName?: string;
    },
  ) => send<void>({ type: 'capture:save', id, accountId, ...edits }),
  captureEditSave: (id?: string) => send<void>({ type: 'capture:editSave', id }),
  captureDismiss: (id?: string) => send<void>({ type: 'capture:dismiss', id }),
};

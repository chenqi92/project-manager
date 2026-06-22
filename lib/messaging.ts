// ---------------------------------------------------------------------------
// 类型化消息层：popup / options ←→ background(service worker)
// 所有加解密都集中在 background 完成，UI 侧只拿到解锁后的明文做展示。
// ---------------------------------------------------------------------------
import { browser } from 'wxt/browser';
import type {
  BioEnrollmentPublic,
  CapturePending,
  ExportMode,
  ImportFormat,
  ImportMode,
  KdfConfig,
  SyncState,
  VaultData,
  VaultStatus,
} from './types';

export interface SyncStateResp {
  config: { serverUrl: string; enabled: boolean } | null;
  state: SyncState | null;
}

export type Msg =
  | { type: 'vault:status' }
  | { type: 'vault:create'; password: string; kdf?: KdfConfig }
  | { type: 'vault:unlock'; password: string }
  | { type: 'vault:lock' }
  | { type: 'vault:get' }
  | { type: 'vault:save'; data: VaultData }
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
  // 同步
  | { type: 'sync:configure'; serverUrl: string; token: string }
  | { type: 'sync:now' }
  | { type: 'sync:disable' }
  | { type: 'sync:state' }
  | { type: 'vault:adopt'; serverUrl: string; token: string }
  // 打开链接并自动填充
  | {
      type: 'tab:openAndFill';
      url: string;
      username: string;
      password: string;
      submit: boolean;
    }
  // 登录捕获
  | { type: 'capture:login'; origin: string; url: string; username: string; password: string }
  | { type: 'capture:pending' }
  | { type: 'capture:save' }
  | { type: 'capture:dismiss' };

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
  save: (data: VaultData) => send<void>({ type: 'vault:save', data }),
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

  // 生物识别
  bioEnrollments: () => send<BioEnrollmentPublic[]>({ type: 'vault:bioEnrollments' }),
  unlockWithPrf: (enrollmentId: string, prfOutput: string) =>
    send<VaultStatus>({ type: 'vault:unlockWithPrf', enrollmentId, prfOutput }),
  enrollBio: (label: string, credentialId: string, prfSalt: string, prfOutput: string) =>
    send<void>({ type: 'vault:enrollBio', label, credentialId, prfSalt, prfOutput }),
  removeBio: (enrollmentId: string) => send<void>({ type: 'vault:removeBio', enrollmentId }),

  // 同步
  syncConfigure: (serverUrl: string, token: string) =>
    send<SyncStateResp>({ type: 'sync:configure', serverUrl, token }),
  syncNow: () => send<SyncStateResp>({ type: 'sync:now' }),
  syncDisable: () => send<void>({ type: 'sync:disable' }),
  syncState: () => send<SyncStateResp>({ type: 'sync:state' }),
  adopt: (serverUrl: string, token: string) =>
    send<VaultStatus>({ type: 'vault:adopt', serverUrl, token }),

  // 打开链接并自动填充（调用前需在页面里先 chrome.permissions.request 该 origin）
  openAndFill: (url: string, username: string, password: string, submit: boolean) =>
    send<{ filled: boolean; reason?: string }>({
      type: 'tab:openAndFill',
      url,
      username,
      password,
      submit,
    }),

  // 登录捕获
  capturePending: () => send<CapturePending | null>({ type: 'capture:pending' }),
  captureSave: () => send<void>({ type: 'capture:save' }),
  captureDismiss: () => send<void>({ type: 'capture:dismiss' }),
};

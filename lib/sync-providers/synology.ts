// ---------------------------------------------------------------------------
// 群晖 Synology DSM FileStation Web API 后端。
// 登录支持两步验证(OTP)：首次用 otp_code + enable_device_token=yes 登录，拿到受信
// 设备令牌 did；之后用 device_id=<did> 静默登录免 OTP。密文以单文件存进共享文件夹。
// 入口 /webapi/entry.cgi；Auth version=6；Upload/Download/List version=2。
// 参数依据官方《DSM Login Web API Guide》与《File Station API Guide》核实。
// ---------------------------------------------------------------------------
import type { EncryptedVault, SynologyTarget } from '../types';
import { PushResult, RemoteSnapshot, SyncProvider, SyncProviderError } from './types';

const DEVICE_NAME = 'ProjectEnvManager';

function entry(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/webapi/entry.cgi';
}

function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || 'vault.enc';
}

interface SynoResp<T> {
  success: boolean;
  data?: T;
  error?: { code: number };
}

async function synoJson<T>(url: string, init?: RequestInit): Promise<SynoResp<T>> {
  const r = await fetch(url, init);
  if (!r.ok) throw new SyncProviderError(`群晖请求失败 ${r.status}`, 'http');
  return (await r.json()) as SynoResp<T>;
}

/** 群晖 Auth 错误码 → 友好信息（403/404/406 与两步验证相关）。 */
function authError(code: number): SyncProviderError {
  switch (code) {
    case 400:
      return new SyncProviderError('账户不存在或密码错误', 'auth');
    case 401:
      return new SyncProviderError('账户已被停用', 'auth');
    case 402:
      return new SyncProviderError('权限被拒绝', 'auth');
    case 403:
      return new SyncProviderError('该账户开启了两步验证，请输入 OTP 一次性码绑定设备', 'otp_required');
    case 404:
      return new SyncProviderError('两步验证码(OTP)错误或已过期', 'auth');
    case 406:
      return new SyncProviderError('账户被强制要求两步验证，请输入 OTP 一次性码', 'otp_required');
    case 407:
      return new SyncProviderError('来源 IP 已被群晖封锁', 'auth');
    case 409:
    case 410:
      return new SyncProviderError('账户密码已过期，需先在 DSM 修改密码', 'auth');
    default:
      return new SyncProviderError(`群晖登录失败（错误码 ${code}）`, 'auth');
  }
}

export interface SynoLoginResult {
  sid: string;
  /** 受信设备令牌；仅在 2FA + enable_device_token 时返回 */
  did?: string;
}

/** 登录 SYNO.API.Auth。带 otpCode 表示首次绑定（申领 did）；带 deviceId 表示静默免 OTP。 */
export async function synologyLogin(
  baseUrl: string,
  opts: { account: string; password: string; otpCode?: string; deviceId?: string },
): Promise<SynoLoginResult> {
  const q = new URLSearchParams({
    api: 'SYNO.API.Auth',
    version: '6',
    method: 'login',
    account: opts.account,
    passwd: opts.password,
    session: 'FileStation',
    format: 'sid',
    device_name: DEVICE_NAME,
  });
  if (opts.otpCode) {
    q.set('otp_code', opts.otpCode);
    q.set('enable_device_token', 'yes');
  }
  if (opts.deviceId) q.set('device_id', opts.deviceId);

  // 用 POST form-body 传参，避免账户/密码出现在 URL 里。
  const j = await synoJson<{ sid: string; did?: string }>(entry(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: q.toString(),
  });
  if (!j.success || !j.data?.sid) throw authError(j.error?.code ?? 0);
  return { sid: j.data.sid, did: j.data.did };
}

export function createSynologyProvider(target: SynologyTarget): SyncProvider {
  return new SynologyProvider(target);
}

class SynologyProvider implements SyncProvider {
  private sid?: string;
  constructor(private t: SynologyTarget) {}

  private get folder(): string {
    return dirname(this.t.filePath || '/home/vault.enc');
  }
  private get fullPath(): string {
    return this.t.filePath || '/home/vault.enc';
  }

  /** 取得会话 sid：优先用 did 静默登录；无 did 时尝试纯账密（2FA 账户会回 otp_required）。 */
  private async session(): Promise<string> {
    if (this.sid) return this.sid;
    const { sid } = await synologyLogin(this.t.baseUrl, {
      account: this.t.account,
      password: this.t.password,
      deviceId: this.t.did || undefined,
    });
    this.sid = sid;
    return sid;
  }

  /** getinfo 取 mtime+size 作为并发 tag；文件不存在返回 null。 */
  private async statTag(sid: string): Promise<string | null> {
    const url =
      entry(this.t.baseUrl) +
      `?api=SYNO.FileStation.List&version=2&method=getinfo` +
      `&path=${encodeURIComponent(this.fullPath)}&additional=${encodeURIComponent('["size","time"]')}` +
      `&_sid=${encodeURIComponent(sid)}`;
    const j = await synoJson<{
      files?: Array<{ additional?: { size?: number; time?: { mtime?: number } } }>;
    }>(url);
    if (!j.success) return null; // 408=路径不存在等 → 视为远端无文件
    const f = j.data?.files?.[0];
    if (!f || !f.additional) return null;
    const mtime = f.additional.time?.mtime ?? 0;
    const size = f.additional.size ?? 0;
    return `${mtime}-${size}`;
  }

  private async download(sid: string): Promise<string | null> {
    const url =
      entry(this.t.baseUrl) +
      `?api=SYNO.FileStation.Download&version=2&method=download` +
      `&path=${encodeURIComponent(this.fullPath)}&mode=open&_sid=${encodeURIComponent(sid)}`;
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) throw new SyncProviderError(`群晖下载失败 ${r.status}`, 'http');
    const text = await r.text();
    return text.trim() ? text : null;
  }

  private async upload(sid: string, content: string): Promise<void> {
    const fd = new FormData();
    fd.append('api', 'SYNO.FileStation.Upload');
    fd.append('version', '2');
    fd.append('method', 'upload');
    fd.append('path', this.folder);
    fd.append('create_parents', 'true');
    fd.append('overwrite', 'true');
    // 二进制文件必须是最后一个 part。
    fd.append('file', new Blob([content], { type: 'application/octet-stream' }), basename(this.fullPath));
    const j = await synoJson<unknown>(entry(this.t.baseUrl) + `?_sid=${encodeURIComponent(sid)}`, {
      method: 'POST',
      body: fd,
    });
    if (!j.success) throw new SyncProviderError(`群晖上传失败（错误码 ${j.error?.code ?? 0}）`, 'http');
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const sid = await this.session();
    const tag = await this.statTag(sid);
    if (tag === null) return null;
    const content = await this.download(sid);
    if (content === null) return null;
    return { vault: JSON.parse(content) as EncryptedVault, tag };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    const sid = await this.session();
    const current = await this.statTag(sid);
    // 乐观并发：期望不存在却已存在，或 tag 不一致 → 冲突，回拉交给 engine 合并。
    if (expectedTag === undefined) {
      if (current !== null) return { ok: false, current: await this.pull() };
    } else if (current !== expectedTag) {
      return { ok: false, current: current === null ? null : await this.pull() };
    }
    await this.upload(sid, JSON.stringify(vault));
    const tag = await this.statTag(sid);
    return { ok: true, tag: tag ?? '' };
  }

  async remove(): Promise<void> {
    const sid = await this.session();
    const url =
      entry(this.t.baseUrl) +
      `?api=SYNO.FileStation.Delete&version=2&method=delete` +
      `&path=${encodeURIComponent(this.fullPath)}&_sid=${encodeURIComponent(sid)}`;
    await fetch(url).catch(() => {});
  }

  async preflight() {
    // 1) 能登录即连通；2FA 未绑定会以 otp_required 抛出，由 UI 引导输入 OTP。
    const sid = await this.session();
    // 2) 校验存放目录可访问：群晖路径须以共享文件夹名开头（如 /home/…）。
    //    «/test» 这类非共享文件夹会让上传写到无效位置，从而推送反复失败。
    const url =
      entry(this.t.baseUrl) +
      `?api=SYNO.FileStation.List&version=2&method=getinfo` +
      `&path=${encodeURIComponent(this.folder)}&_sid=${encodeURIComponent(sid)}`;
    const j = await synoJson<{ files?: Array<{ isdir?: boolean; name?: string }> }>(url);
    const info = j.success ? j.data?.files?.[0] : null;
    if (!info || info.isdir === false) {
      throw new SyncProviderError(
        `存放目录不存在或不可访问：${this.folder}。群晖路径需以共享文件夹名开头（如 /home/vault.enc）；「/test」这类非共享文件夹会导致推送失败。`,
        'http',
      );
    }
    return { ok: true, warnings: [] };
  }

  /** 列目录：空段 = 列共享文件夹；否则列该路径下的子文件夹。 */
  async listDir(segments: string[]): Promise<Array<{ name: string }>> {
    const sid = await this.session();
    if (segments.length === 0) {
      const url =
        entry(this.t.baseUrl) +
        `?api=SYNO.FileStation.List&version=2&method=list_share&_sid=${encodeURIComponent(sid)}`;
      const j = await synoJson<{ shares?: Array<{ name: string }> }>(url);
      if (!j.success) throw new SyncProviderError('读取共享文件夹失败', 'http');
      return (j.data?.shares ?? []).map((s) => ({ name: s.name }));
    }
    const folderPath = '/' + segments.join('/');
    const url =
      entry(this.t.baseUrl) +
      `?api=SYNO.FileStation.List&version=2&method=list&filetype=dir` +
      `&folder_path=${encodeURIComponent(folderPath)}&_sid=${encodeURIComponent(sid)}`;
    const j = await synoJson<{ files?: Array<{ name: string; isdir?: boolean }> }>(url);
    if (!j.success) throw new SyncProviderError(`读取目录失败：${folderPath}`, 'http');
    return (j.data?.files ?? []).filter((f) => f.isdir !== false).map((f) => ({ name: f.name }));
  }
}

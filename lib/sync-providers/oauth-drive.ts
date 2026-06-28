// Google Drive（appDataFolder 隐藏目录）/ OneDrive（应用专属文件夹）后端。
// 密文存成单个文件；access_token 内存缓存、过期用 refresh_token 续。
// 注意：Drive/OneDrive 需用户自带 client_id 并完成授权，属联调能力。
import { refreshAccessToken } from '../oauth';
import type { EncryptedVault, OAuthDriveTarget } from '../types';
import { PushResult, RemoteSnapshot, SyncProvider, SyncProviderError } from './types';

const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export function createOAuthDriveProvider(target: OAuthDriveTarget): SyncProvider {
  if (target.type === 'onedrive') return new OneDriveProvider(target);
  if (target.type === 'dropbox') return new DropboxProvider(target);
  return new GoogleDriveProvider(target);
}

abstract class BaseDriveProvider {
  constructor(protected t: OAuthDriveTarget) {}

  protected async token(): Promise<string> {
    if (!this.t.refreshToken) throw new SyncProviderError('尚未完成网盘授权', 'auth');
    const cached = tokenCache.get(this.t.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const { accessToken, expiresInMs } = await refreshAccessToken(
      this.t.type as 'google-drive' | 'onedrive' | 'dropbox',
      this.t.clientId,
      this.t.refreshToken,
      this.t.clientSecret,
    );
    tokenCache.set(this.t.id, { accessToken, expiresAt: Date.now() + expiresInMs });
    return accessToken;
  }

  protected get fileName(): string {
    return this.t.fileName || 'vault.enc';
  }
}

// ------------------------------ Google Drive ------------------------------

class GoogleDriveProvider extends BaseDriveProvider implements SyncProvider {
  private async findId(): Promise<string | null> {
    const q = encodeURIComponent(`name='${this.fileName.replace(/'/g, "\\'")}'`);
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${await this.token()}` } },
    );
    if (!r.ok) throw new SyncProviderError(`Drive 查询失败 ${r.status}`, 'http');
    const j = (await r.json()) as { files?: Array<{ id: string }> };
    return j.files?.[0]?.id ?? null;
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const id = await this.findId();
    if (!id) return null;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new SyncProviderError(`Drive 读取失败 ${r.status}`, 'http');
    const text = await r.text();
    if (!text.trim()) return null;
    return { vault: JSON.parse(text) as EncryptedVault, tag: etagOf(r) };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    const id = await this.findId();
    const token = await this.token();
    const blob = JSON.stringify(vault);

    if (!id) {
      // 创建：multipart（元数据 + 内容）
      const boundary = 'envmgr' + Math.abs(hash(this.t.id)).toString(36);
      const meta = JSON.stringify({ name: this.fileName, parents: ['appDataFolder'] });
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${blob}\r\n--${boundary}--`;
      const r = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        },
      );
      if (!r.ok) throw new SyncProviderError(`Drive 创建失败 ${r.status}`, 'http');
    } else {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      if (expectedTag) headers['If-Match'] = expectedTag;
      const r = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
        { method: 'PATCH', headers, body: blob },
      );
      if (r.status === 412) return { ok: false, current: await this.pull() };
      if (!r.ok) throw new SyncProviderError(`Drive 写入失败 ${r.status}`, 'http');
    }
    const snap = await this.pull();
    return { ok: true, tag: snap?.tag ?? '' };
  }

  async remove(): Promise<void> {
    const id = await this.findId();
    if (!id) return;
    await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
  }

  async preflight() {
    await this.token();
    return { ok: true, warnings: [] };
  }
}

// --------------------------------- OneDrive ---------------------------------

class OneDriveProvider extends BaseDriveProvider implements SyncProvider {
  private contentUrl(): string {
    return `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURIComponent(this.fileName)}:/content`;
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const r = await fetch(this.contentUrl(), {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new SyncProviderError(`OneDrive 读取失败 ${r.status}`, 'http');
    const text = await r.text();
    if (!text.trim()) return null;
    return { vault: JSON.parse(text) as EncryptedVault, tag: etagOf(r) };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token()}`,
      'Content-Type': 'application/json',
    };
    if (expectedTag) headers['If-Match'] = expectedTag;
    else headers['If-None-Match'] = '*';
    const r = await fetch(this.contentUrl(), { method: 'PUT', headers, body: JSON.stringify(vault) });
    if (r.status === 412) return { ok: false, current: await this.pull() };
    if (!r.ok) throw new SyncProviderError(`OneDrive 写入失败 ${r.status}`, 'http');
    const j = (await r.json()) as { eTag?: string; cTag?: string };
    return { ok: true, tag: j.eTag || j.cTag || (await this.pull())?.tag || '' };
  }

  async remove(): Promise<void> {
    await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURIComponent(this.fileName)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${await this.token()}` } },
    );
  }

  async preflight() {
    await this.token();
    return { ok: true, warnings: [] };
  }
}

// --------------------------------- Dropbox ---------------------------------
// 「App folder」访问类型：路径相对应用文件夹（/vault.enc）；rev 作并发 tag。

class DropboxProvider extends BaseDriveProvider implements SyncProvider {
  private get path(): string {
    return '/' + this.fileName.replace(/^\/+/, '');
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Dropbox-API-Arg': JSON.stringify({ path: this.path }),
      },
    });
    if (r.status === 409) return null; // path/not_found
    if (!r.ok) throw new SyncProviderError(`Dropbox 读取失败 ${r.status}`, 'http');
    const meta = r.headers.get('Dropbox-API-Result');
    const rev = meta ? ((JSON.parse(meta) as { rev?: string }).rev ?? '') : '';
    const text = await r.text();
    if (!text.trim()) return null;
    return { vault: JSON.parse(text) as EncryptedVault, tag: rev };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    // 乐观并发：有 tag 用 update(rev) 模式，仅当 rev 匹配才写；无 tag 用 add（已存在即冲突）。
    const mode = expectedTag ? { '.tag': 'update', update: expectedTag } : { '.tag': 'add' };
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: this.path, mode, autorename: false, mute: true }),
      },
      body: JSON.stringify(vault),
    });
    if (r.status === 409) return { ok: false, current: await this.pull() };
    if (!r.ok) throw new SyncProviderError(`Dropbox 写入失败 ${r.status}`, 'http');
    const j = (await r.json()) as { rev?: string };
    return { ok: true, tag: j.rev ?? (await this.pull())?.tag ?? '' };
  }

  async remove(): Promise<void> {
    await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: this.path }),
    }).catch(() => {});
  }

  async preflight() {
    await this.token();
    return { ok: true, warnings: [] };
  }
}

function etagOf(r: Response): string {
  const etag = r.headers.get('ETag') || r.headers.get('etag');
  if (etag) return etag.replace(/^W\//, '').replace(/"/g, '');
  return r.headers.get('Last-Modified') || '';
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

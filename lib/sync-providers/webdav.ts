// WebDAV 后端（Nextcloud / 坚果云 / 群晖等）：把保险箱密文存成单个文件。
// 乐观并发用 ETag + If-Match / If-None-Match；服务器不回 ETag 时退化为后写覆盖。
import type { EncryptedVault, WebDavTarget } from '../types';
import { PushResult, RemoteSnapshot, SyncProvider, SyncProviderError } from './types';

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return p ? `${b}/${p}` : b;
}

export class WebDavProvider implements SyncProvider {
  private fileUrl: string;
  private auth: string;

  constructor(private target: WebDavTarget) {
    this.fileUrl = joinUrl(target.url, target.filePath || 'vault.enc');
    this.auth = 'Basic ' + btoa(`${target.username}:${target.password}`);
  }

  private headers(extra?: Record<string, string>): HeadersInit {
    return { Authorization: this.auth, ...extra };
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const r = await fetch(this.fileUrl, { headers: this.headers() });
    if (r.status === 404 || r.status === 410) return null;
    if (r.status === 401 || r.status === 403) {
      throw new SyncProviderError('WebDAV 认证失败，请检查账号/密码', 'auth');
    }
    if (!r.ok) throw new SyncProviderError(`WebDAV 读取失败 ${r.status}`, 'http');
    const text = await r.text();
    if (!text.trim()) return null;
    const vault = JSON.parse(text) as EncryptedVault;
    return { vault, tag: etagOf(r) };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (expectedTag) headers['If-Match'] = expectedTag;
    else headers['If-None-Match'] = '*'; // 期望文件尚不存在，避免覆盖他人

    const r = await fetch(this.fileUrl, {
      method: 'PUT',
      headers: this.headers(headers),
      body: JSON.stringify(vault),
    });

    if (r.status === 412) {
      // 前置条件失败：远端已变化，回拉当前快照交给 engine 合并
      return { ok: false, current: await this.pull() };
    }
    if (r.status === 401 || r.status === 403) {
      throw new SyncProviderError('WebDAV 认证失败，请检查账号/密码', 'auth');
    }
    if (!r.ok) throw new SyncProviderError(`WebDAV 写入失败 ${r.status}`, 'http');

    // 部分服务器 PUT 不回 ETag，回拉一次取新 tag
    let tag = etagOf(r);
    if (!tag) {
      const snap = await this.pull();
      tag = snap?.tag ?? '';
    }
    return { ok: true, tag };
  }

  async remove(): Promise<void> {
    const r = await fetch(this.fileUrl, { method: 'DELETE', headers: this.headers() });
    if (!r.ok && r.status !== 404 && r.status !== 410) {
      throw new SyncProviderError(`WebDAV 删除失败 ${r.status}`, 'http');
    }
  }

  async preflight() {
    // HEAD 文件；404 也算可达（首次还没文件）。
    const r = await fetch(this.fileUrl, { method: 'HEAD', headers: this.headers() });
    if (r.status === 401 || r.status === 403) {
      throw new SyncProviderError('WebDAV 认证失败，请检查账号/密码', 'auth');
    }
    if (!r.ok && r.status !== 404 && r.status !== 405) {
      throw new SyncProviderError(`无法连接 WebDAV（${r.status}）`, 'http');
    }
    return { ok: true, warnings: [] };
  }
}

function etagOf(r: Response): string {
  const etag = r.headers.get('ETag') || r.headers.get('etag');
  if (etag) return etag.replace(/^W\//, '').replace(/"/g, '');
  return r.headers.get('Last-Modified') || '';
}

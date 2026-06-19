// ---------------------------------------------------------------------------
// 客户端同步：HTTP 封装 + 拉取/合并/重推的乐观并发编排。
// 全程端到端加密——只有本机用 DEK 解密后才能合并，服务器永远只见密文。
// 运行在 background（service worker）里，使用全局 fetch。
// ---------------------------------------------------------------------------
import { mergeVaultData } from './merge';
import type { EncryptedVault, SyncConfig } from './types';
import { decryptVaultData, reencryptData } from './vault-core';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: 'vault_mismatch' | 'retry_exhausted' | 'http' | 'network',
    readonly remote?: EncryptedVault,
  ) {
    super(message);
  }
}

interface Meta {
  exists: boolean;
  revision: number;
  updatedAt: number | null;
}

/** 纯 HTTP 客户端。 */
export class SyncClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private url(path: string): string {
    return this.baseUrl.replace(/\/+$/, '') + path;
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  async meta(): Promise<Meta> {
    const r = await fetch(this.url('/v1/vault/meta'), { headers: this.headers() });
    if (!r.ok) throw new SyncError(`meta ${r.status}`, 'http');
    return (await r.json()) as Meta;
  }

  async pull(): Promise<EncryptedVault | null> {
    const r = await fetch(this.url('/v1/vault'), { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new SyncError(`pull ${r.status}`, 'http');
    return (await r.json()) as EncryptedVault;
  }

  /** 推送；返回成功的新 revision，或冲突时的当前密文与 revision。 */
  async push(
    baseRevision: number,
    vault: EncryptedVault,
  ): Promise<
    | { ok: true; revision: number }
    | { ok: false; currentRevision: number; current: EncryptedVault | null }
  > {
    const r = await fetch(this.url('/v1/vault'), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ baseRevision, vault }),
    });
    if (r.status === 409) {
      const j = (await r.json()) as { currentRevision: number; current: EncryptedVault | null };
      return { ok: false, currentRevision: j.currentRevision, current: j.current };
    }
    if (!r.ok) throw new SyncError(`push ${r.status}`, 'http');
    const j = (await r.json()) as { revision: number };
    return { ok: true, revision: j.revision };
  }

  async deleteRemote(): Promise<void> {
    const r = await fetch(this.url('/v1/vault'), { method: 'DELETE', headers: this.headers() });
    if (!r.ok && r.status !== 404) throw new SyncError(`delete ${r.status}`, 'http');
  }
}

export interface SyncResult {
  /** 合并后应在本地保存的密文（若与本地不同）；null 表示本地无需更新 */
  mergedEncrypted: EncryptedVault | null;
  serverRevision: number;
}

/**
 * 执行一次完整同步：拉取远端 -> 用 DEK 解密双方 -> 合并 -> 重新加密 -> 乐观并发推送。
 * 远端为空时直接推送本地；vaultId 不一致时抛 vault_mismatch（由 UI 决定采用/覆盖）。
 */
export async function syncVault(
  config: SyncConfig,
  localEnc: EncryptedVault,
  dek: Uint8Array,
): Promise<SyncResult> {
  const client = new SyncClient(config.serverUrl, config.token);
  const meta = await client.meta();

  if (!meta.exists) {
    const res = await client.push(0, localEnc);
    if (!res.ok) {
      // 极少见：刚好被并发创建，回退到合并路径。
      return mergeAndPush(client, localEnc, dek, res.currentRevision, res.current);
    }
    return { mergedEncrypted: null, serverRevision: res.revision };
  }

  const remote = await client.pull();
  if (!remote) {
    const res = await client.push(meta.revision, localEnc);
    if (res.ok) return { mergedEncrypted: null, serverRevision: res.revision };
    return mergeAndPush(client, localEnc, dek, res.currentRevision, res.current);
  }

  if (remote.vaultId !== localEnc.vaultId) {
    throw new SyncError('服务器上是另一个金库', 'vault_mismatch', remote);
  }

  return mergeAndPush(client, localEnc, dek, meta.revision, remote);
}

async function mergeAndPush(
  client: SyncClient,
  localEnc: EncryptedVault,
  dek: Uint8Array,
  baseRevision: number,
  remote: EncryptedVault | null,
): Promise<SyncResult> {
  let mergedEnc = localEnc;
  let base = baseRevision;
  let current = remote;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (current) {
      const localData = await decryptVaultData(mergedEnc, dek);
      const remoteData = await decryptVaultData(current, dek);
      const merged = mergeVaultData(localData, remoteData);
      mergedEnc = await reencryptData(mergedEnc, merged, dek);
    }
    const res = await client.push(base, mergedEnc);
    if (res.ok) return { mergedEncrypted: mergedEnc, serverRevision: res.revision };
    base = res.currentRevision;
    current = res.current;
  }
  throw new SyncError('合并重试次数耗尽', 'retry_exhausted');
}

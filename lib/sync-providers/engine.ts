// ---------------------------------------------------------------------------
// 同步引擎：在任意 SyncProvider 之上做「拉取 → 解密 → 合并 → 重加密 → 乐观并发推送」。
// 全程端到端加密——只有本机用 DEK（或异库主密码）解密后才合并，后端只见密文。
// 泛化自旧版 lib/sync.ts 的 mergeAndPush。
// ---------------------------------------------------------------------------
import { mergeVaultData } from '../merge';
import type { EncryptedVault } from '../types';
import { decryptVaultData, reencryptData, unwrapDEK } from '../vault-core';
import type { RemoteSnapshot, SyncProvider } from './types';

const MAX_ATTEMPTS = 6;

export class SyncEngineError extends Error {
  constructor(
    message: string,
    readonly code: 'foreign_vault' | 'retry_exhausted' | 'bad_password' | 'empty_remote',
    /** foreign_vault 时附带远端密文，供 UI 弹窗输入其主密码 */
    readonly remote?: EncryptedVault,
  ) {
    super(message);
    this.name = 'SyncEngineError';
  }
}

export interface SyncOutcome {
  /** 应保存回本地的密文；null 表示本地无需更新（远端已是最新或本地首推） */
  mergedEncrypted: EncryptedVault | null;
  /** 推送后远端的新 tag，存入本地同步状态 */
  tag: string;
}

export interface SyncOpts {
  /** 远端是「另一个保险箱」时，用于解密它的主密码 */
  foreignPassword?: string;
  /** 新目标首次同步保护：远端为空且未确认时，不自动推送，改抛 empty_remote 让 UI 确认。 */
  guardEmptyPush?: boolean;
  /** 用户已确认「远端为空 → 以本地内容建立首次副本」。 */
  confirmEmptyPush?: boolean;
}

/**
 * 双向合并同步：拉取远端，与本地三路合并（含墓碑），重加密后并发推送；冲突自动重拉重试。
 * 远端是异库且未提供 foreignPassword 时抛 foreign_vault，由调用方提示输入密码。
 */
export async function syncWithProvider(
  provider: SyncProvider,
  localEnc: EncryptedVault,
  dek: Uint8Array,
  opts: SyncOpts = {},
): Promise<SyncOutcome> {
  const remote = await provider.pull();
  if (!remote) {
    // 新目标首次同步且远端为空：不静默推送，交由 UI 确认（防止本想拉取却把本地推上空路径）。
    if (opts.guardEmptyPush && !opts.confirmEmptyPush) {
      throw new SyncEngineError('远端为空：首次同步将以本地内容建立远端副本', 'empty_remote');
    }
    const res = await provider.push(localEnc, undefined);
    if (res.ok) return { mergedEncrypted: null, tag: res.tag };
    return mergeLoop(provider, localEnc, dek, res.current, opts);
  }
  return mergeLoop(provider, localEnc, dek, remote, opts);
}

async function mergeLoop(
  provider: SyncProvider,
  localEnc: EncryptedVault,
  dek: Uint8Array,
  first: RemoteSnapshot | null,
  opts: SyncOpts,
): Promise<SyncOutcome> {
  let mergedEnc = localEnc;
  let current = first;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let expectedTag: string | undefined;
    if (current) {
      expectedTag = current.tag || undefined;
      const remoteData = await decryptRemote(current.vault, mergedEnc, dek, opts);
      const localData = await decryptVaultData(mergedEnc, dek);
      const merged = mergeVaultData(localData, remoteData);
      // 始终用「本地」DEK 重加密：合并结果归属本地保险箱身份。
      mergedEnc = await reencryptData(mergedEnc, merged, dek);
    }
    const res = await provider.push(mergedEnc, expectedTag);
    if (res.ok) {
      return { mergedEncrypted: mergedEnc === localEnc ? null : mergedEnc, tag: res.tag };
    }
    current = res.current;
  }
  throw new SyncEngineError('合并重试次数耗尽', 'retry_exhausted');
}

/** 解密远端密文：同库用本地 DEK，异库用 foreignPassword 解出远端 DEK。 */
async function decryptRemote(
  remote: EncryptedVault,
  localEnc: EncryptedVault,
  dek: Uint8Array,
  opts: SyncOpts,
) {
  if (remote.vaultId === localEnc.vaultId) {
    return decryptVaultData(remote, dek);
  }
  if (!opts.foreignPassword) {
    throw new SyncEngineError('远端是另一个保险箱', 'foreign_vault', remote);
  }
  const remoteDek = await unwrapDEK(remote, opts.foreignPassword).catch(() => {
    throw new SyncEngineError('远端保险箱主密码不正确', 'bad_password', remote);
  });
  return decryptVaultData(remote, remoteDek);
}

/** 强制推送：用本地整体覆盖远端（不合并），仅处理并发 tag。 */
export async function forcePushToProvider(
  provider: SyncProvider,
  localEnc: EncryptedVault,
): Promise<{ tag: string }> {
  let current = await provider.pull();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await provider.push(localEnc, current?.tag || undefined);
    if (res.ok) return { tag: res.tag };
    current = res.current;
  }
  throw new SyncEngineError('强制推送冲突重试耗尽', 'retry_exhausted');
}

export type ForcePullResult =
  | { kind: 'replaced'; localEncrypted: EncryptedVault; tag: string }
  | { kind: 'empty' }
  | { kind: 'foreign'; remote: EncryptedVault };

/**
 * 强制拉取：用远端整体覆盖本地内容（保留本地主密码 / DEK，仅替换数据）。
 * 远端为异库且未给 foreignPassword 时返回 {kind:'foreign'} 供 UI 索要密码。
 */
export async function forcePullFromProvider(
  provider: SyncProvider,
  localEnc: EncryptedVault,
  dek: Uint8Array,
  opts: SyncOpts = {},
): Promise<ForcePullResult> {
  const remote = await provider.pull();
  if (!remote) return { kind: 'empty' };
  const rv = remote.vault;
  let data;
  if (rv.vaultId === localEnc.vaultId) {
    data = await decryptVaultData(rv, dek);
  } else {
    if (!opts.foreignPassword) return { kind: 'foreign', remote: rv };
    const rdek = await unwrapDEK(rv, opts.foreignPassword).catch(() => {
      throw new SyncEngineError('远端保险箱主密码不正确', 'bad_password', rv);
    });
    data = await decryptVaultData(rv, rdek);
  }
  const localEncrypted = await reencryptData(localEnc, data, dek);
  return { kind: 'replaced', localEncrypted, tag: remote.tag };
}

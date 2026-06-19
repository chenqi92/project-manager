import { browser } from 'wxt/browser';
import { fromB64, toB64 } from '@/lib/crypto';
import { buildExport, mergeVaults, parseImport } from '@/lib/import-export';
import type { Msg, MsgResponse, SyncStateResp } from '@/lib/messaging';
import { vaultBackend } from '@/lib/storage';
import { SyncClient, syncVault } from '@/lib/sync';
import type { BioEnrollmentPublic, SyncState, VaultData, VaultStatus } from '@/lib/types';
import {
  createEncryptedVault,
  decryptVaultData,
  emptyVaultData,
  enrollBiometric,
  reencryptData,
  removeBioEnrollment,
  rewrapDEK,
  unwrapDEK,
  unwrapDEKWithPrf,
} from '@/lib/vault-core';

const SESSION_DEK = 'dek';
const SYNC_STATE_KEY = 'syncState';

// 全部仅存在于内存（SW 重启后从 session 恢复，浏览器关闭即丢失）。
let dek: Uint8Array | null = null;
let cachedData: VaultData | null = null;
let autoLockMinutes = 15;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export default defineBackground(() => {
  browser.storage.session
    .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch(() => {});

  browser.idle.onStateChanged.addListener((state) => {
    if (state !== 'active') lock();
  });

  browser.runtime.onMessage.addListener((msg: Msg) => handle(msg));
});

async function handle(msg: Msg): Promise<MsgResponse<unknown>> {
  try {
    return { ok: true, data: await route(msg) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function route(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case 'vault:status':
      return getStatus();

    case 'vault:create': {
      if (await vaultBackend.load()) throw new Error('金库已存在，请直接解锁');
      const data = emptyVaultData();
      if (msg.kdf) data.settings.kdf = msg.kdf;
      const { encrypted, dek: newDek } = await createEncryptedVault(
        data,
        msg.password,
        data.settings.kdf,
      );
      await vaultBackend.save(encrypted);
      await setUnlocked(newDek, data);
      return getStatus();
    }

    case 'vault:unlock': {
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('尚未创建金库');
      let newDek: Uint8Array;
      try {
        newDek = await unwrapDEK(enc, msg.password);
      } catch {
        throw new Error('主密码错误');
      }
      await setUnlocked(newDek, await decryptVaultData(enc, newDek));
      return getStatus();
    }

    case 'vault:lock':
      lock();
      return getStatus();

    case 'vault:get':
      return requireData();

    case 'vault:save': {
      await requireUnlocked();
      await persistData(msg.data);
      scheduleAutoSync();
      return;
    }

    case 'vault:changePassword': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('金库不存在');
      try {
        await unwrapDEK(enc, msg.current);
      } catch {
        throw new Error('当前主密码错误');
      }
      await vaultBackend.save(await rewrapDEK(enc, dek!, msg.next));
      return;
    }

    case 'vault:export': {
      const data = await requireData();
      return buildExport(data, msg.mode, msg.password);
    }

    case 'vault:import': {
      const data = await requireData();
      const incoming = await parseImport(msg.format, msg.content, msg.password);
      const { data: merged, imported } = mergeVaults(data, incoming, msg.mode);
      await persistData(merged);
      scheduleAutoSync();
      return { status: await getStatus(), imported };
    }

    case 'vault:reset':
      lock();
      await vaultBackend.clear();
      await browser.storage.local.remove(SYNC_STATE_KEY);
      return getStatus();

    case 'activity':
      resetLockTimer();
      return;

    // ---------------- 生物识别 ----------------
    case 'vault:bioEnrollments': {
      const enc = await vaultBackend.load();
      const list: BioEnrollmentPublic[] = (enc?.bioEnrollments ?? []).map((e) => ({
        id: e.id,
        label: e.label,
        credentialId: e.credentialId,
        prfSalt: e.prfSalt,
      }));
      return list;
    }

    case 'vault:unlockWithPrf': {
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('尚未创建金库');
      let newDek: Uint8Array;
      try {
        newDek = await unwrapDEKWithPrf(enc, msg.enrollmentId, fromB64(msg.prfOutput));
      } catch {
        throw new Error('生物识别校验失败');
      }
      await setUnlocked(newDek, await decryptVaultData(enc, newDek));
      return getStatus();
    }

    case 'vault:enrollBio': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('金库不存在');
      const next = await enrollBiometric(enc, dek!, {
        label: msg.label,
        credentialId: msg.credentialId,
        prfSalt: msg.prfSalt,
        prfOutput: fromB64(msg.prfOutput),
      });
      await vaultBackend.save(next);
      return;
    }

    case 'vault:removeBio': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('金库不存在');
      await vaultBackend.save(removeBioEnrollment(enc, msg.enrollmentId));
      return;
    }

    // ---------------- 同步 ----------------
    case 'sync:configure': {
      const data = await requireData();
      // 先用 meta 验证服务器/令牌可达
      await new SyncClient(msg.serverUrl, msg.token).meta();
      data.settings.sync = { serverUrl: msg.serverUrl, token: msg.token, enabled: true };
      await persistData(data);
      await runSync();
      return syncStateResp();
    }

    case 'sync:now':
      await runSync();
      return syncStateResp();

    case 'sync:disable': {
      const data = await requireData();
      const cfg = data.settings.sync;
      if (cfg) {
        try {
          await new SyncClient(cfg.serverUrl, cfg.token).deleteRemote();
        } catch {
          /* 远端删除失败不阻断本地关闭 */
        }
      }
      delete data.settings.sync;
      await persistData(data);
      await browser.storage.local.remove(SYNC_STATE_KEY);
      return;
    }

    case 'sync:state':
      return syncStateResp();

    case 'vault:adopt': {
      const client = new SyncClient(msg.serverUrl, msg.token);
      const remote = await client.pull();
      if (!remote) throw new Error('服务器上没有可恢复的金库');
      await vaultBackend.save(remote);
      const meta = await client.meta();
      await saveSyncState({ serverRevision: meta.revision, lastSyncAt: Date.now() });
      lock(); // 用该金库的主密码重新解锁
      return getStatus();
    }
  }
}

// --------------------------- 状态 / 锁 ---------------------------

async function getStatus(): Promise<VaultStatus> {
  const enc = await vaultBackend.load();
  await ensureRestored();
  return {
    initialized: enc !== null,
    locked: dek === null,
    autoLockMinutes,
    hasBiometric: (enc?.bioEnrollments?.length ?? 0) > 0,
    syncEnabled: cachedData?.settings.sync?.enabled ?? false,
  };
}

async function setUnlocked(d: Uint8Array, data: VaultData): Promise<void> {
  dek = d;
  cachedData = data;
  autoLockMinutes = data.settings.autoLockMinutes ?? 15;
  await browser.storage.session.set({ [SESSION_DEK]: toB64(d) });
  applyAutoLock();
  resetLockTimer();
}

/** 重新加密并持久化数据；更新内存缓存。 */
async function persistData(data: VaultData): Promise<void> {
  const enc = await vaultBackend.load();
  if (!enc) throw new Error('金库不存在');
  await vaultBackend.save(await reencryptData(enc, data, dek!));
  cachedData = data;
  autoLockMinutes = data.settings.autoLockMinutes ?? 15;
  applyAutoLock();
  resetLockTimer();
}

function lock(): void {
  dek = null;
  cachedData = null;
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  browser.storage.session.remove(SESSION_DEK).catch(() => {});
}

async function ensureRestored(): Promise<void> {
  if (dek) return;
  const s = await browser.storage.session.get(SESSION_DEK);
  const b64 = s[SESSION_DEK] as string | undefined;
  if (!b64) return;
  const restored = fromB64(b64);
  const enc = await vaultBackend.load();
  if (!enc) return;
  try {
    cachedData = await decryptVaultData(enc, restored);
  } catch {
    await browser.storage.session.remove(SESSION_DEK);
    return;
  }
  dek = restored;
  autoLockMinutes = cachedData.settings.autoLockMinutes ?? 15;
  applyAutoLock();
}

async function requireUnlocked(): Promise<void> {
  await ensureRestored();
  if (!dek || !cachedData) throw new Error('金库已锁定');
}

async function requireData(): Promise<VaultData> {
  await requireUnlocked();
  return cachedData!;
}

function applyAutoLock(): void {
  if (autoLockMinutes > 0) {
    browser.idle.setDetectionInterval(Math.max(15, autoLockMinutes * 60));
  }
}

function resetLockTimer(): void {
  if (lockTimer) clearTimeout(lockTimer);
  if (autoLockMinutes > 0) lockTimer = setTimeout(lock, autoLockMinutes * 60_000);
}

// --------------------------- 同步辅助 ---------------------------

async function loadSyncState(): Promise<SyncState | null> {
  const r = await browser.storage.local.get(SYNC_STATE_KEY);
  return (r[SYNC_STATE_KEY] as SyncState | undefined) ?? null;
}

async function saveSyncState(s: SyncState): Promise<void> {
  await browser.storage.local.set({ [SYNC_STATE_KEY]: s });
}

async function syncStateResp(): Promise<SyncStateResp> {
  const cfg = cachedData?.settings.sync;
  return {
    config: cfg ? { serverUrl: cfg.serverUrl, enabled: cfg.enabled } : null,
    state: await loadSyncState(),
  };
}

async function runSync(): Promise<void> {
  await requireUnlocked();
  const cfg = cachedData!.settings.sync;
  if (!cfg?.enabled) throw new Error('同步未启用');
  const enc = await vaultBackend.load();
  if (!enc) throw new Error('金库不存在');

  const result = await syncVault(cfg, enc, dek!);
  if (result.mergedEncrypted) {
    await vaultBackend.save(result.mergedEncrypted);
    cachedData = await decryptVaultData(result.mergedEncrypted, dek!);
  }
  await saveSyncState({ serverRevision: result.serverRevision, lastSyncAt: Date.now() });
}

/** 本地保存后延迟自动同步（合并多次连续修改，失败只记录不打断）。 */
function scheduleAutoSync(): void {
  if (!cachedData?.settings.sync?.enabled) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    runSync().catch(async (e) => {
      const prev = (await loadSyncState()) ?? { serverRevision: 0 };
      await saveSyncState({
        ...prev,
        lastError: e instanceof Error ? e.message : String(e),
      });
    });
  }, 2500);
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { api } from '@/lib/messaging';
import { VAULT_KEY } from '@/lib/storage';
import { VAULT_LOCKED_MSG, type VaultData, type VaultStatus } from '@/lib/types';
import { normalizeVaultData } from '@/lib/vault-ops';
import { commitWorkspaceDraft } from '@/lib/workspace';

export interface VaultController {
  status: VaultStatus | null;
  data: VaultData | null;
  loading: boolean;
  refresh: () => Promise<void>;
  unlock: (password: string) => Promise<void>;
  create: (password: string) => Promise<void>;
  lock: () => Promise<void>;
  save: (data: VaultData) => Promise<void>;
  reload: () => Promise<void>;
  /** 轻量探测后台是否已锁定（如空闲自动锁定）：仅在已锁定时切到锁定态并清空数据，
   *  解锁态不做任何事（不重拉数据，避免闪烁）。返回是否已锁定。 */
  checkLocked: () => Promise<boolean>;
}

export function useVault(): VaultController {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [data, setData] = useState<VaultData | null>(null);
  const [loading, setLoading] = useState(true);
  const saveChain = useRef(Promise.resolve());

  const syncData = useCallback(async (s: VaultStatus) => {
    if (!s.initialized || s.locked) {
      setData(null);
      return;
    }
    try {
      setData(await api.get());
    } catch (e) {
      if (e instanceof Error && e.message === VAULT_LOCKED_MSG) {
        setStatus({ ...s, locked: true });
        setData(null);
        return;
      }
      throw e;
    }
  }, []);

  const refresh = useCallback(async () => {
    const s = await api.status();
    setStatus(s);
    await syncData(s);
  }, [syncData]);

  useEffect(() => {
    refresh()
      .catch((e) => {
        console.warn('vault refresh failed:', e);
        setData(null);
      })
      .finally(() => setLoading(false));
    api.activity().catch(() => {});
  }, [refresh]);

  useEffect(() => {
    const onChanged = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local' || !(VAULT_KEY in changes)) return;
      refresh().catch((e) => console.warn('vault refresh after storage change failed:', e));
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const unlock = useCallback(
    async (password: string) => {
      const s = await api.unlock(password);
      setStatus(s);
      await syncData(s);
    },
    [syncData],
  );

  const create = useCallback(
    async (password: string) => {
      const s = await api.create(password);
      setStatus(s);
      await syncData(s);
    },
    [syncData],
  );

  const lock = useCallback(async () => {
    const s = await api.lock();
    setStatus(s);
    setData(null);
  }, []);

  const save = useCallback(async (next: VaultData) => {
    const prepared = structuredClone(next);
    commitWorkspaceDraft(prepared);
    normalizeVaultData(prepared);
    const op = saveChain.current.catch(() => {}).then(() => api.save(prepared));
    saveChain.current = op.catch(() => {});
    await op;
    setData(prepared);
  }, []);

  const checkLocked = useCallback(async () => {
    const s = await api.status();
    if (s.locked) {
      setStatus(s);
      setData(null);
    }
    return s.locked;
  }, []);

  const reload = useCallback(async () => {
    try {
      setData(await api.get());
    } catch (e) {
      if (e instanceof Error && e.message === VAULT_LOCKED_MSG) {
        await checkLocked();
        return;
      }
      throw e;
    }
  }, [checkLocked]);

  return { status, data, loading, refresh, unlock, create, lock, save, reload, checkLocked };
}

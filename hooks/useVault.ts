import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/messaging';
import type { VaultData, VaultStatus } from '@/lib/types';

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
}

export function useVault(): VaultController {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [data, setData] = useState<VaultData | null>(null);
  const [loading, setLoading] = useState(true);
  const saveChain = useRef(Promise.resolve());

  const syncData = useCallback(async (s: VaultStatus) => {
    if (s.initialized && !s.locked) setData(await api.get());
    else setData(null);
  }, []);

  const refresh = useCallback(async () => {
    const s = await api.status();
    setStatus(s);
    await syncData(s);
  }, [syncData]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    api.activity().catch(() => {});
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
    const op = saveChain.current.catch(() => {}).then(() => api.save(next));
    saveChain.current = op.catch(() => {});
    await op;
    setData(next);
  }, []);

  const reload = useCallback(async () => {
    setData(await api.get());
  }, []);

  return { status, data, loading, refresh, unlock, create, lock, save, reload };
}

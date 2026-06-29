// ---------------------------------------------------------------------------
// 多设备同步的明文合并：按稳定 id 合并，逐项以 updatedAt 取较新者，
// 删除用墓碑（tombstone）表达，避免「已删项被旧副本复活」。
// 服务器对此一无所知——合并只在客户端解密后进行。
// ---------------------------------------------------------------------------
import type {
  Account,
  Environment,
  MemoItem,
  PlatformLink,
  Project,
  ProjectDoc,
  VaultSettings,
  VaultData,
} from './types';

const PRUNE_MS = 365 * 24 * 60 * 60 * 1000; // 墓碑保留 365 天：长期离线的设备重连后，避免它带回的旧副本把已删项「复活」。

// 取较新者：updatedAt 不同则取较大；相等时用确定性的内容序列化做 tiebreaker，
// 保证两台设备对同一对版本合并出相同胜者，结果收敛、不会来回翻转。
function newer<T extends { updatedAt: number }>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}

export function mergeVaultData(
  local: VaultData,
  remote: VaultData,
  nowMs: number = Date.now(),
): VaultData {
  // 合并双方墓碑，按 id 取最晚删除时间。
  const tomb = new Map<string, number>();
  for (const t of [...(local.tombstones ?? []), ...(remote.tombstones ?? [])]) {
    tomb.set(t.id, Math.max(tomb.get(t.id) ?? 0, t.deletedAt));
  }

  const mergeAccount = (a: Account, b: Account): Account => newer(a, b);
  const mergeDoc = (a: ProjectDoc, b: ProjectDoc): ProjectDoc => newer(a, b);
  const mergeMemo = (a: MemoItem, b: MemoItem): MemoItem => newer(a, b);

  const mergeLink = (a: PlatformLink, b: PlatformLink): PlatformLink => {
    const base = newer(a, b);
    return { ...base, accounts: mergeList(a.accounts, b.accounts, tomb, mergeAccount) };
  };

  const mergeEnv = (a: Environment, b: Environment): Environment => {
    const base = newer(a, b);
    return { ...base, links: mergeList(a.links, b.links, tomb, mergeLink) };
  };

  const mergeProject = (a: Project, b: Project): Project => {
    const base = newer(a, b);
    return {
      ...base,
      docs: mergeList(a.docs ?? [], b.docs ?? [], tomb, mergeDoc),
      memos: mergeList(a.memos ?? [], b.memos ?? [], tomb, mergeMemo),
      environments: mergeList(a.environments, b.environments, tomb, mergeEnv),
    };
  };

  const projects = mergeList(local.projects, remote.projects, tomb, mergeProject);

  const tombstones = [...tomb.entries()]
    .filter(([, d]) => d >= nowMs - PRUNE_MS)
    .map(([id, deletedAt]) => ({ id, deletedAt }));

  return {
    version: Math.max(local.version, remote.version),
    projects,
    settings: mergeSettings(local.settings, remote.settings),
    tombstones,
  };
}

function mergeSettings(local: VaultSettings, remote: VaultSettings): VaultSettings {
  const localAt = local.updatedAt ?? 0;
  const remoteAt = remote.updatedAt ?? 0;
  // 旧数据没有 settings.updatedAt：保持历史行为，本机设置优先，避免升级后被旧远端覆盖。
  if (localAt === 0 && remoteAt === 0) return local;
  if (localAt !== remoteAt) return remoteAt > localAt ? remote : local;
  // 极少数同毫秒冲突用确定性内容排序保证多端最终收敛。
  return JSON.stringify(local) <= JSON.stringify(remote) ? local : remote;
}

function mergeList<T extends { id: string; updatedAt: number }>(
  a: T[],
  b: T[],
  tomb: Map<string, number>,
  mergeOne: (x: T, y: T) => T,
): T[] {
  const byId = new Map<string, T>();
  for (const item of a) byId.set(item.id, item);
  for (const item of b) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? mergeOne(existing, item) : item);
  }
  const out: T[] = [];
  for (const item of byId.values()) {
    const deletedAt = tomb.get(item.id);
    // 删除时间晚于或等于最后编辑时间 -> 视为已删除；否则是删除后又被编辑/重建 -> 保留。
    if (deletedAt !== undefined && deletedAt >= item.updatedAt) continue;
    out.push(item);
  }
  return out;
}

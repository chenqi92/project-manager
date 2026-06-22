// ---------------------------------------------------------------------------
// 账号「最近使用」记录：仅本机、不加密、不同步。
// 只存 accountId(UUID,不含任何站点/账号明文) -> 时间戳，用于 popup 无匹配时
// 展示「最近使用」。存 storage.local 即可,锁定/重启都保留。
// ---------------------------------------------------------------------------
import { browser } from 'wxt/browser';

const KEY = 'recentUse';
const MAX_KEEP = 50; // 只保留最近 50 条,避免无限增长

export type UsageMap = Record<string, number>;

export async function getUsage(): Promise<UsageMap> {
  const r = await browser.storage.local.get(KEY);
  return (r[KEY] as UsageMap | undefined) ?? {};
}

export async function recordUse(accountId: string): Promise<void> {
  if (!accountId) return;
  const map = await getUsage();
  map[accountId] = Date.now();
  // 裁剪到最近 MAX_KEEP 条
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const trimmed: UsageMap = {};
  for (const [id, ts] of entries.slice(0, MAX_KEEP)) trimmed[id] = ts;
  await browser.storage.local.set({ [KEY]: trimmed });
}

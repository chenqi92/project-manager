// ---------------------------------------------------------------------------
// 联网磁贴数据源：今日热榜 / 股票行情。
// 仅在用户「显式开启联网」+「授权对应数据源域名」后才请求；默认不联网。
// 授权用 chrome.permissions.request（host 权限），授权后扩展页 fetch 不受 CORS 限制。
// ---------------------------------------------------------------------------
import { browser } from 'wxt/browser';

/** 由任意 URL 取其 origin 的 host 权限匹配模式（如 https://x.com/*）。 */
export function originPattern(url: string): string | null {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return null;
  }
}

/** 该数据源是否已授权。 */
export async function hasHost(url: string): Promise<boolean> {
  const p = originPattern(url);
  if (!p) return false;
  try {
    return await browser.permissions.contains({ origins: [p] });
  } catch {
    return false;
  }
}

/** 请求该数据源的 host 权限（需用户手势，如配置面板里的「授权」按钮）。 */
export async function requestHost(url: string): Promise<boolean> {
  const p = originPattern(url);
  if (!p) return false;
  return browser.permissions.request({ origins: [p] });
}

// ============================ 今日热榜 ============================

export interface HotItem {
  title: string;
  url?: string;
  hot?: string;
}

// 内置热榜来源：第三方开放聚合服务（60s API，Cloudflare Workers 部署，全球有效证书）。
// 属第三方服务器、仅在授权后请求；免费接口随时可能变动/限流，失败时可在 ⚙ 换源或填自定义源。
export const HOTLIST_SOURCES: Array<{ key: string; name: string; url: string }> = [
  { key: 'zhihu', name: '知乎热榜', url: 'https://60s.viki.moe/v2/zhihu' },
  { key: 'weibo', name: '微博热搜', url: 'https://60s.viki.moe/v2/weibo' },
  { key: 'douyin', name: '抖音热点', url: 'https://60s.viki.moe/v2/douyin' },
  { key: 'toutiao', name: '今日头条', url: 'https://60s.viki.moe/v2/toutiao' },
  { key: 'juejin', name: '掘金热榜', url: 'https://60s.viki.moe/v2/juejin' },
  { key: '36kr', name: '36氪热榜', url: 'https://60s.viki.moe/v2/36kr' },
];

/** 解析出实际请求 URL：内置取预设，custom 取用户填写。 */
export function hotlistUrl(source: string | undefined, customUrl?: string): string | null {
  if (source === 'custom') return customUrl?.trim() || null;
  return HOTLIST_SOURCES.find((s) => s.key === source)?.url ?? HOTLIST_SOURCES[0]!.url;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchHotlist(url: string, count: number): Promise<HotItem[]> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('热榜获取失败（' + r.status + '）');
  const j: any = await r.json();
  const arr: any[] = Array.isArray(j)
    ? j
    : Array.isArray(j?.data)
      ? j.data
      : Array.isArray(j?.data?.list)
        ? j.data.list
        : Array.isArray(j?.list)
          ? j.list
          : [];
  return arr
    .map((it) => ({
      title: String(it?.title ?? it?.name ?? it?.word ?? ''),
      url: it?.url ?? it?.link ?? it?.mobileUrl ?? undefined,
      hot:
        it?.hot != null
          ? String(it.hot)
          : it?.heat != null
            ? String(it.heat)
            : it?.hot_value_desc != null
              ? String(it.hot_value_desc)
              : it?.hot_value != null
                ? String(it.hot_value)
                : undefined,
    }))
    .filter((x) => x.title)
    .slice(0, count);
}

// ============================ 股票行情 ============================

export interface Quote {
  symbol: string;
  name?: string;
  currency?: string;
  price: number;
  changePct: number;
  ok: boolean;
  bars?: QuoteBar[];
}

export interface QuoteBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
/** 内置股票源所需授权的代表性 URL（用于权限检测/请求）。 */
export const STOCKS_BUILTIN_PROBE = YAHOO + 'AAPL';

function num(...vals: any[]): number | undefined {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

/** 内置源：Yahoo Finance（免密钥）。代码示例：AAPL、600519.SS、0700.HK。 */
async function fetchOneBuiltin(symbol: string): Promise<Quote> {
  try {
    const r = await fetch(YAHOO + encodeURIComponent(symbol) + '?range=3mo&interval=1d', {
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await r.json();
    const result = j?.chart?.result?.[0];
    const m = result?.meta;
    const q = result?.indicators?.quote?.[0];
    const timestamps: any[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const bars = timestamps.reduce<QuoteBar[]>((acc, t, i) => {
      const open = num(q?.open?.[i]);
      const high = num(q?.high?.[i]);
      const low = num(q?.low?.[i]);
      const close = num(q?.close?.[i]);
      if (
        typeof t !== 'number' ||
        open == null ||
        high == null ||
        low == null ||
        close == null
      ) {
        return acc;
      }
      const bar: QuoteBar = {
        time: t * 1000,
        open,
        high,
        low,
        close,
      };
      const volume = num(q?.volume?.[i]);
      if (volume != null) bar.volume = volume;
      acc.push(bar);
      return acc;
    }, []);
    const lastBar = bars[bars.length - 1];
    const price = num(m?.regularMarketPrice, lastBar?.close);
    if (price == null) return { symbol, price: 0, changePct: 0, ok: false };
    const prev = num(m?.chartPreviousClose, m?.previousClose) ?? price;
    return {
      symbol,
      name: m?.shortName,
      currency: m?.currency,
      price,
      changePct: prev ? ((price - prev) / prev) * 100 : 0,
      ok: true,
      bars,
    };
  } catch {
    return { symbol, price: 0, changePct: 0, ok: false };
  }
}

/** 自定义源：URL 模板含 {symbol}，返回 JSON。尽力从常见字段解析价格/涨跌幅。 */
async function fetchOneCustom(template: string, symbol: string): Promise<Quote> {
  try {
    const u = template.includes('{symbol}')
      ? template.replace('{symbol}', encodeURIComponent(symbol))
      : template + encodeURIComponent(symbol);
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    const o = j?.data ?? j;
    const price = num(o?.price, o?.last, o?.regularMarketPrice, o?.c, o?.current);
    if (price == null) return { symbol, price: 0, changePct: 0, ok: false };
    const pct = num(o?.changePct, o?.percent, o?.dp, o?.change_percent, o?.changePercent);
    const prev = num(o?.prevClose, o?.previousClose, o?.pc);
    return {
      symbol,
      name: o?.name ?? o?.shortName,
      price,
      changePct: pct ?? (prev ? ((price - prev) / prev) * 100 : 0),
      ok: true,
    };
  } catch {
    return { symbol, price: 0, changePct: 0, ok: false };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchQuotes(
  symbols: string[],
  source: string | undefined,
  customUrl?: string,
): Promise<Quote[]> {
  const list = symbols.slice(0, 12);
  if (source === 'custom') {
    const tpl = customUrl?.trim();
    if (!tpl) return [];
    return Promise.all(list.map((s) => fetchOneCustom(tpl, s)));
  }
  return Promise.all(list.map(fetchOneBuiltin));
}

/** 股票源授权检测/请求用的 URL。 */
export function stocksProbeUrl(source: string | undefined, customUrl?: string): string | null {
  if (source === 'custom') {
    const t = customUrl?.trim();
    if (!t) return null;
    return t.replace('{symbol}', 'AAPL');
  }
  return STOCKS_BUILTIN_PROBE;
}

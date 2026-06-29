export type StockColorMode = 'red-rise' | 'green-rise';

/** A 股/港股常用“红涨绿跌”，美股等默认“绿涨红跌”。 */
export function stockColorMode(symbol: string): StockColorMode {
  const s = symbol.trim().toUpperCase();
  if (!s) return 'green-rise';
  if (/\.(SS|SZ|SH|HK)$/.test(s)) return 'red-rise';
  if (/^(SH|SZ)\d{6}$/.test(s)) return 'red-rise';
  if (/^HK\d{4,5}$/.test(s)) return 'red-rise';
  if (/^\d{6}$/.test(s)) return 'red-rise';
  return 'green-rise';
}

export function stockMoveColor(symbol: string, up: boolean): string {
  const redRise = stockColorMode(symbol) === 'red-rise';
  if (up) return redRise ? 'var(--color-danger)' : 'var(--color-ok)';
  return redRise ? 'var(--color-ok)' : 'var(--color-danger)';
}

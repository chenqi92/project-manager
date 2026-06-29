// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { stockColorMode, stockMoveColor } from '../lib/stock-colors';

describe('stock market colors', () => {
  it('A 股和港股使用红涨绿跌', () => {
    expect(stockColorMode('600519.SS')).toBe('red-rise');
    expect(stockColorMode('000001.SZ')).toBe('red-rise');
    expect(stockColorMode('0700.HK')).toBe('red-rise');
    expect(stockColorMode('SH600519')).toBe('red-rise');
    expect(stockColorMode('600519')).toBe('red-rise');
    expect(stockMoveColor('600519.SS', true)).toBe('var(--color-danger)');
    expect(stockMoveColor('600519.SS', false)).toBe('var(--color-ok)');
  });

  it('其他市场默认绿涨红跌', () => {
    expect(stockColorMode('AAPL')).toBe('green-rise');
    expect(stockColorMode('MSFT')).toBe('green-rise');
    expect(stockMoveColor('AAPL', true)).toBe('var(--color-ok)');
    expect(stockMoveColor('AAPL', false)).toBe('var(--color-danger)');
  });
});

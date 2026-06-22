// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultDashboard, newDashWidget } from '../lib/dashboard';
import { weatherLabel } from '../lib/weather';

describe('dashboard defaults', () => {
  it('默认 4 张卡片、span 合法、id 唯一', () => {
    const d = defaultDashboard();
    expect(d.widgets.map((w) => w.type)).toEqual(['stats', 'todos', 'calendar', 'launcher']);
    expect(d.widgets.every((w) => w.span >= 1 && w.span <= 4)).toBe(true);
    expect(new Set(d.widgets.map((w) => w.id)).size).toBe(4);
  });

  it('newDashWidget 默认 span', () => {
    expect(newDashWidget('weather').span).toBe(1);
    expect(newDashWidget('stats').span).toBe(4);
    expect(newDashWidget('image', 3).span).toBe(3);
  });
});

describe('weatherLabel', () => {
  it('WMO code 映射', () => {
    expect(weatherLabel(0).text).toBe('晴');
    expect(weatherLabel(3).text).toBe('阴');
    expect(weatherLabel(65).text).toBe('雨');
    expect(weatherLabel(95).text).toBe('雷暴');
  });
});

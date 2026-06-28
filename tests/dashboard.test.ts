// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultDashboard, newDashWidget, normWidget } from '../lib/dashboard';
import { weatherLabel } from '../lib/weather';

describe('dashboard defaults', () => {
  it('默认 4 张卡片、尺寸合法、id 唯一', () => {
    const d = defaultDashboard();
    expect(d.widgets!.map((w) => w.type)).toEqual(['stats', 'search', 'launcher', 'todos']);
    expect(
      d.widgets!.every(
        (w) => (w.w ?? 0) >= 1 && (w.w ?? 0) <= 4 && (w.h ?? 0) >= 1 && (w.h ?? 0) <= 3,
      ),
    ).toBe(true);
    expect(new Set(d.widgets!.map((w) => w.id)).size).toBe(4);
  });

  it('newDashWidget 默认尺寸', () => {
    expect(newDashWidget('weather').w).toBe(1);
    expect(newDashWidget('stats').w).toBe(4);
    expect(newDashWidget('image', 3, 2).w).toBe(3);
  });

  it('normWidget 迁移旧 span -> w，并夹到合法范围', () => {
    expect(normWidget({ id: 'x', type: 'todos', span: 3 }).w).toBe(3);
    expect(normWidget({ id: 'y', type: 'stats', w: 9 }).w).toBe(4);
    expect(normWidget({ id: 'z', type: 'weather', h: 0 }).h).toBe(1);
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

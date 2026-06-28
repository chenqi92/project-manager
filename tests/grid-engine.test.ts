// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyChange,
  clampRect,
  colsForWidth,
  compact,
  flowPack,
  layoutRows,
  placeNew,
  rectsOverlap,
  scaleLayout,
  type GridItem,
} from '../lib/grid-engine';

/** 任意两个磁贴都不重叠。 */
function noOverlap(items: GridItem[]): boolean {
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) if (rectsOverlap(items[i]!, items[j]!)) return false;
  return true;
}

/** 全部磁贴落在 [0,cols] 范围内。 */
function inBounds(items: GridItem[], cols: number): boolean {
  return items.every((it) => it.x >= 0 && it.y >= 0 && it.w >= 1 && it.h >= 1 && it.x + it.w <= cols);
}

describe('rectsOverlap', () => {
  it('相交判定，共享边不算重叠', () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false); // 紧贴
    expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 2, w: 2, h: 2 })).toBe(false); // 上下相邻
  });
});

describe('clampRect', () => {
  it('夹紧 w/x/y/h 到合法范围', () => {
    expect(clampRect({ x: 5, y: -1, w: 9, h: 0 }, 4)).toEqual({ x: 0, y: 0, w: 4, h: 1 });
    expect(clampRect({ x: 3, y: 2, w: 2, h: 2 }, 4)).toEqual({ x: 2, y: 2, w: 2, h: 2 }); // x+w 不超 cols
  });
});

describe('compact 纵向重力', () => {
  it('上拉消除纵向空洞', () => {
    const out = compact([
      { id: 'a', x: 0, y: 0, w: 2, h: 1 },
      { id: 'b', x: 0, y: 5, w: 2, h: 1 }, // 中间有大空洞
    ]);
    expect(out.find((i) => i.id === 'b')!.y).toBe(1);
    expect(noOverlap(out)).toBe(true);
  });

  it('被拖磁贴权威不动、其余让位且不重叠', () => {
    const out = compact(
      [
        { id: 'drag', x: 0, y: 2, w: 4, h: 1 },
        { id: 'a', x: 0, y: 0, w: 2, h: 1 },
        { id: 'b', x: 2, y: 0, w: 2, h: 1 },
      ],
      'drag',
    );
    expect(out.find((i) => i.id === 'drag')!.y).toBe(2); // 拖动者停在原地
    expect(noOverlap(out)).toBe(true);
  });

  it('被拖磁贴压到他人头上时，他人被推到下方', () => {
    const out = compact(
      [
        { id: 'a', x: 0, y: 0, w: 4, h: 1 },
        { id: 'drag', x: 0, y: 0, w: 2, h: 1 }, // 与 a 同位
      ],
      'drag',
    );
    expect(noOverlap(out)).toBe(true);
    expect(out.find((i) => i.id === 'drag')!.y).toBe(0);
    expect(out.find((i) => i.id === 'a')!.y).toBe(1);
  });

  it('保持输入顺序（稳定 key）', () => {
    const out = compact([
      { id: 'a', x: 0, y: 3, w: 1, h: 1 },
      { id: 'b', x: 0, y: 0, w: 1, h: 1 },
    ]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('flowPack 旧数据迁移', () => {
  it('按顺序流式装入、无重叠、在界内', () => {
    const out = flowPack(
      [
        { id: 'a', w: 4, h: 1 },
        { id: 'b', w: 2, h: 2 },
        { id: 'c', w: 2, h: 2 },
        { id: 'd', w: 4, h: 2 },
      ],
      4,
    );
    expect(noOverlap(out)).toBe(true);
    expect(inBounds(out, 4)).toBe(true);
    expect(out.find((i) => i.id === 'a')).toMatchObject({ x: 0, y: 0 });
    // b、c 并排填到第二行
    expect(out.find((i) => i.id === 'b')).toMatchObject({ x: 0, y: 1 });
    expect(out.find((i) => i.id === 'c')).toMatchObject({ x: 2, y: 1 });
  });

  it('超宽磁贴被夹到 cols', () => {
    const out = flowPack([{ id: 'a', w: 9, h: 1 }], 4);
    expect(out[0]!.w).toBe(4);
  });
});

describe('scaleLayout 断点派生', () => {
  it('4→2 列缩放后无重叠且在界内', () => {
    const base: GridItem[] = [
      { id: 'a', x: 0, y: 0, w: 4, h: 1 },
      { id: 'b', x: 0, y: 1, w: 2, h: 2 },
      { id: 'c', x: 2, y: 1, w: 2, h: 2 },
      { id: 'd', x: 0, y: 3, w: 1, h: 1 },
    ];
    const out = scaleLayout(base, 4, 2);
    expect(noOverlap(out)).toBe(true);
    expect(inBounds(out, 2)).toBe(true);
    expect(out.length).toBe(4);
  });

  it('目标列数≥基准时仅夹紧压缩、保留全部磁贴', () => {
    const base: GridItem[] = [
      { id: 'a', x: 0, y: 0, w: 2, h: 1 },
      { id: 'b', x: 2, y: 0, w: 2, h: 1 },
    ];
    const out = scaleLayout(base, 4, 4);
    expect(noOverlap(out)).toBe(true);
    expect(out.length).toBe(2);
  });
});

describe('applyChange / placeNew / layoutRows', () => {
  it('applyChange 拖动后整体无重叠、被拖者优先', () => {
    const items: GridItem[] = [
      { id: 'a', x: 0, y: 0, w: 2, h: 1 },
      { id: 'b', x: 2, y: 0, w: 2, h: 1 },
      { id: 'c', x: 0, y: 1, w: 2, h: 1 },
    ];
    const out = applyChange(items, 'c', { x: 2, y: 0, w: 2, h: 1 }, 4);
    expect(noOverlap(out)).toBe(true);
    expect(out.find((i) => i.id === 'c')).toMatchObject({ x: 2, y: 0 });
  });

  it('placeNew 把新卡放到底部且不重叠', () => {
    const items: GridItem[] = [{ id: 'a', x: 0, y: 0, w: 4, h: 2 }];
    const placed = placeNew(items, 2, 2, 4, 'new');
    expect(placed.id).toBe('new');
    expect(noOverlap([...items, placed])).toBe(true);
    expect(placed.y).toBeGreaterThanOrEqual(2);
  });

  it('layoutRows 计算总行数', () => {
    expect(
      layoutRows([
        { id: 'a', x: 0, y: 0, w: 1, h: 2 },
        { id: 'b', x: 1, y: 1, w: 1, h: 3 },
      ]),
    ).toBe(4);
  });
});

describe('colsForWidth', () => {
  it('断点列数', () => {
    expect(colsForWidth(1280)).toBe(4);
    expect(colsForWidth(800)).toBe(3);
    expect(colsForWidth(500)).toBe(2);
    expect(colsForWidth(0)).toBe(2);
  });
});

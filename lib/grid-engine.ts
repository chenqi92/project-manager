// ---------------------------------------------------------------------------
// 轻量坐标网格引擎（零依赖、纯函数、可单测）。
//
// 把仪表盘磁贴从「数组顺序 + 流式回填」升级为「(x,y) 锚点 + w×h 占格」：
//  - 可把磁贴精确放到任意格子并保留空洞（homarr 式自由定位）；
//  - 移动/缩放时其它磁贴向下让位、再做纵向重力压缩消除多余空洞；
//  - 旧数据（只有 w/h、位置靠数组顺序）用 flowPack 一次性生成坐标，零感知迁移；
//  - 窄屏用 scaleLayout 由基准布局派生，避免给每个断点各存一份布局。
//
// 坐标系：x∈[0,cols-w] 列号，y≥0 行号，w≥1 列，h≥1 行；CSS Grid 行列号从 1 起，
// 渲染时用 gridColumn:`${x+1}/span ${w}`、gridRow:`${y+1}/span ${h}`。
// ---------------------------------------------------------------------------

/** 仪表盘基准列数：在该列数下编辑并落库，窄屏由它派生。 */
export const BASE_COLS = 4;
/** 每行高度（px）。 */
export const ROW_HEIGHT = 130;
/** 磁贴间距（px）：网格 gap 与缩放手柄换算的单一来源。 */
export const GAP = 16;

/** 视口宽度 → 列数断点（从宽到窄匹配）。 */
export const BREAKPOINTS: ReadonlyArray<{ minWidth: number; cols: number }> = [
  { minWidth: 1024, cols: 4 },
  { minWidth: 640, cols: 3 },
  { minWidth: 0, cols: 2 },
];

export function colsForWidth(width: number): number {
  for (const bp of BREAKPOINTS) if (width >= bp.minWidth) return bp.cols;
  return 2;
}

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GridItem extends GridRect {
  id: string;
}

/** 两个矩形是否相交（共享边不算重叠）。 */
export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 把矩形夹到合法范围：w∈[1,cols]、x∈[0,cols-w]、y≥0、h≥1。 */
export function clampRect<T extends GridRect>(r: T, cols: number): T {
  const w = Math.max(1, Math.min(cols, Math.round(r.w)));
  const x = Math.max(0, Math.min(cols - w, Math.round(r.x)));
  const y = Math.max(0, Math.round(r.y));
  const h = Math.max(1, Math.round(r.h));
  return { ...r, x, y, w, h };
}

/**
 * 纵向重力压缩：把每个磁贴上拉到不与已放置者碰撞的最小 y。
 *  - 不传 draggedId：纯压缩，按 (y,x) 顺序逐个上拉，消除所有纵向空洞。
 *  - 传 draggedId：被拖动的磁贴保持其 (x,y) 权威不动、作为障碍物，其余磁贴在它周围压缩，
 *    实现「拖到哪停在哪、别人让位」的 homarr 手感。
 * 返回顺序与输入一致（稳定 React key）。
 */
export function compact(items: GridItem[], draggedId?: string): GridItem[] {
  const placed: GridItem[] = [];
  const dragged = draggedId ? items.find((i) => i.id === draggedId) : undefined;
  if (dragged) placed.push({ ...dragged });

  const rest = items
    .filter((i) => i.id !== draggedId)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of rest) {
    const item: GridItem = { ...it, y: 0 };
    while (placed.some((p) => rectsOverlap(p, item))) item.y++;
    placed.push(item);
  }

  const byId = new Map(placed.map((p) => [p.id, p]));
  return items.map((i) => byId.get(i.id)!);
}

/**
 * 旧数据迁移 / 重排：按给定顺序把 {id,w,h} 流式装入网格，
 * 每个磁贴落到从上到下、从左到右第一个放得下的空位。等价旧版 dense 流式排布。
 */
export function flowPack(items: Array<{ id: string; w: number; h: number }>, cols: number): GridItem[] {
  const placed: GridItem[] = [];
  for (const it of items) {
    const w = Math.max(1, Math.min(cols, Math.round(it.w)));
    const h = Math.max(1, Math.round(it.h));
    let found: GridRect | null = null;
    for (let y = 0; !found; y++) {
      for (let x = 0; x <= cols - w; x++) {
        const cand: GridRect = { x, y, w, h };
        if (!placed.some((p) => rectsOverlap(p, cand))) {
          found = cand;
          break;
        }
      }
    }
    placed.push({ id: it.id, ...found });
  }
  return placed;
}

/**
 * 断点派生：把基准列数下的布局缩放到目标列数。
 *  - toCols ≥ fromCols：仅夹紧并压缩，保留相对位置。
 *  - toCols < fromCols：按 (y,x) 顺序、等比缩小 w 后用 flowPack 重排，保证无重叠。
 */
export function scaleLayout(items: GridItem[], fromCols: number, toCols: number): GridItem[] {
  if (toCols >= fromCols) return compact(items.map((it) => clampRect(it, toCols)));
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const scaled = sorted.map((it) => ({
    id: it.id,
    w: Math.max(1, Math.min(toCols, Math.round((it.w * toCols) / fromCols))),
    h: it.h,
  }));
  return flowPack(scaled, toCols);
}

/** 网格占用的总行数（用于容器留白 / 末行追加空间）。 */
export function layoutRows(items: GridItem[]): number {
  return items.reduce((max, it) => Math.max(max, it.y + it.h), 0);
}

/**
 * 应用一次移动/缩放：把目标矩形夹到合法范围后，被拖磁贴权威不动、其余压缩让位。
 * resize=true 时视为缩放（同样的碰撞/压缩规则）。
 */
export function applyChange(items: GridItem[], id: string, rect: GridRect, cols: number): GridItem[] {
  const next = items.map((it) => (it.id === id ? clampRect({ ...it, ...rect }, cols) : it));
  return compact(next, id);
}

/**
 * 解析基准布局：输入可能带坐标的磁贴。
 *  - 全部都有有限 x/y：按存储坐标夹紧（保留用户留出的空洞，不强制压缩）。
 *  - 任一缺坐标：整体按数组顺序 flowPack 迁移生成坐标（旧数据零感知升级）。
 */
export function buildBaseLayout(
  items: Array<{ id: string; x?: number; y?: number; w: number; h: number }>,
  cols: number,
): GridItem[] {
  const allPlaced = items.every((it) => Number.isFinite(it.x) && Number.isFinite(it.y));
  if (allPlaced) {
    return items.map((it) => clampRect({ id: it.id, x: it.x!, y: it.y!, w: it.w, h: it.h }, cols));
  }
  return flowPack(
    items.map((it) => ({ id: it.id, w: it.w, h: it.h })),
    cols,
  );
}

/** 为新磁贴找落点：追加到底部后压缩，返回其坐标。 */
export function placeNew(items: GridItem[], w: number, h: number, cols: number, id: string): GridItem {
  const bottom = layoutRows(items);
  const packed = compact([...items, { id, x: 0, y: bottom, w: Math.min(w, cols), h }]);
  return packed.find((p) => p.id === id)!;
}

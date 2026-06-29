// ---------------------------------------------------------------------------
// 首页仪表盘：默认布局、卡片元数据、多看板与坐标布局工具。
// 网格为基准 4 列、坐标自由定位（见 lib/grid-engine.ts），窄屏由断点派生。
// ---------------------------------------------------------------------------
import type { DashAppearance, DashBoard, DashWidget, DashWidgetType, DashboardConfig } from './types';
import { uid } from './vault-ops';
import {
  BASE_COLS,
  GAP as ENGINE_GAP,
  ROW_HEIGHT as ENGINE_ROW_HEIGHT,
  buildBaseLayout,
  clampRect,
  flowPack,
  scaleLayout,
  type GridItem,
} from './grid-engine';

/** 基准列数（兼容旧引用）。 */
export const GRID_COLS = BASE_COLS;
export const ROW_HEIGHT = ENGINE_ROW_HEIGHT;
export const GAP = ENGINE_GAP;

export const WIDGET_LABELS: Record<DashWidgetType, string> = {
  stats: '统计',
  todos: '待办',
  calendar: '日历',
  launcher: '快捷入口',
  weather: '天气',
  image: '图片 / 图表',
  clock: '时钟',
  search: '全局搜索',
  totp: '验证码墙',
  health: '密码健康度',
  recent: '最近使用',
  repos: 'Git 仓库',
  tags: '标签云',
  doc: '文档速览',
  changed: '近期改动',
  backup: '备份 / 同步',
  hotlist: '今日热榜',
  stocks: '股票行情',
  cnb: 'CNB 仓库',
};

/** 各类型最小 [w, h]：缩放时夹紧，避免内容型磁贴被缩成 1×1 不可读。 */
export function minWH(type: DashWidgetType): [number, number] {
  switch (type) {
    // 统计/快捷入口需要一定宽度承载多列内容，最窄保留 2 列。
    case 'stats':
      return [2, 1];
    case 'launcher':
      return [2, 2];
    // 内容偏多的磁贴：可缩到 1 列（更细的宽度控制），但保留 2 行高度避免内容被压扁。
    case 'totp':
    case 'health':
    case 'recent':
    case 'repos':
    case 'doc':
    case 'changed':
    case 'calendar':
    case 'hotlist':
    case 'stocks':
    case 'cnb':
      return [1, 2];
    // 其余（search / backup / clock / tags / weather / image / todos）允许缩到 1×1。
    default:
      return [1, 1];
  }
}

/** 各类型默认 [w, h]。 */
export function defaultWH(type: DashWidgetType): [number, number] {
  switch (type) {
    case 'stats':
      return [4, 1];
    case 'launcher':
      return [4, 2];
    case 'search':
      return [4, 1];
    case 'todos':
      return [2, 2];
    case 'calendar':
      return [2, 2];
    case 'image':
      return [2, 2];
    case 'totp':
      return [2, 2];
    case 'health':
      return [2, 2];
    case 'recent':
      return [2, 2];
    case 'repos':
      return [2, 2];
    case 'doc':
      return [2, 2];
    case 'changed':
      return [2, 2];
    case 'backup':
      return [2, 1];
    case 'clock':
      return [2, 1];
    case 'tags':
      return [2, 1];
    case 'weather':
      return [1, 1];
    case 'hotlist':
      return [2, 3];
    case 'stocks':
      return [2, 2];
    case 'cnb':
      return [2, 3];
  }
}

export function newDashWidget(type: DashWidgetType, w?: number, h?: number): DashWidget {
  const [dw, dh] = defaultWH(type);
  return { id: uid(), type, w: w ?? dw, h: h ?? dh };
}

/** 读取时归一化：补全 w/h（兼容旧版 span），夹到合法范围，并透传坐标。 */
export function normWidget(widget: DashWidget): DashWidget & { w: number; h: number } {
  const [dw, dh] = defaultWH(widget.type);
  const w = Math.min(GRID_COLS, Math.max(1, widget.w ?? widget.span ?? dw));
  const h = Math.max(1, widget.h ?? dh);
  return {
    ...widget,
    w,
    h,
    x: Number.isFinite(widget.x) ? Math.max(0, widget.x!) : undefined,
    y: Number.isFinite(widget.y) ? Math.max(0, widget.y!) : undefined,
  };
}

// --- 外观：预设渐变背景 -----------------------------------------------------
// 每个预设是一个主题感知的 CSS 变量：亮色用清浅渐变、暗色用深色渐变（定义见
// assets/tailwind.css 的 :root / .dark）。这样无论亮暗，背景都与面板/文字协调，
// 不会出现某一模式下「背景很怪」。内联 style 直接引用 var(--dash-*) 即随主题切换。
export const GRADIENTS: Record<string, string> = {
  aurora: 'var(--dash-aurora)',
  dusk: 'var(--dash-dusk)',
  sunset: 'var(--dash-sunset)',
  forest: 'var(--dash-forest)',
  mist: 'var(--dash-mist)',
};
export const DEFAULT_GRADIENT = 'aurora';

export function normAppearance(a: DashAppearance | undefined): Required<DashAppearance> {
  return {
    // 默认无背景：全新安装 / 未设置过外观的看板使用纯净底色，不强加主题。
    bg: a?.bg ?? 'none',
    gradient: a?.gradient && GRADIENTS[a.gradient] ? a.gradient : DEFAULT_GRADIENT,
    imageDataUrl: a?.imageDataUrl ?? '',
    tileOpacity: typeof a?.tileOpacity === 'number' ? Math.min(100, Math.max(20, a.tileOpacity)) : 75,
    tileBlur: typeof a?.tileBlur === 'number' ? Math.min(24, Math.max(0, a.tileBlur)) : 8,
  };
}

/** 把外观解析成可直接用的 CSS 背景值（'' 表示无背景，用页面默认底色）。 */
export function appearanceBackground(a: Required<DashAppearance>): string {
  if (a.bg === 'image' && a.imageDataUrl) return `center / cover no-repeat url("${a.imageDataUrl}")`;
  if (a.bg === 'gradient') return GRADIENTS[a.gradient] ?? GRADIENTS[DEFAULT_GRADIENT]!;
  return '';
}

// --- 多看板 -----------------------------------------------------------------
export interface NormBoard {
  id: string;
  name: string;
  widgets: Array<DashWidget & { w: number; h: number }>;
  appearance: DashAppearance;
}

export function defaultDashboard(): DashboardConfig {
  return {
    widgets: [newDashWidget('stats'), newDashWidget('search'), newDashWidget('launcher'), newDashWidget('todos')],
  };
}

/** 把（可能是旧版单看板的）配置归一化为多看板视图。 */
export function normDashboard(cfg: DashboardConfig | undefined): {
  boards: NormBoard[];
  activeBoardId: string;
} {
  let boards: NormBoard[];
  if (cfg?.boards && cfg.boards.length > 0) {
    boards = cfg.boards.map((b) => ({
      id: b.id,
      name: b.name,
      widgets: (b.widgets ?? []).map(normWidget),
      appearance: b.appearance ?? {},
    }));
  } else {
    // 旧版单看板（或全新）：迁移成单个「默认」看板。
    const widgets = (cfg?.widgets ?? defaultDashboard().widgets!).map(normWidget);
    boards = [{ id: 'default', name: '默认', widgets, appearance: {} }];
  }
  const wantedId = cfg?.activeBoardId;
  const activeBoardId = wantedId && boards.some((b) => b.id === wantedId) ? wantedId : boards[0]!.id;
  return { boards, activeBoardId };
}

/** 归一化看板写回存储结构（仅保留必要字段）。 */
export function toStoredBoards(boards: NormBoard[], activeBoardId: string): DashboardConfig {
  return {
    boards: boards.map((b) => ({
      id: b.id,
      name: b.name,
      widgets: b.widgets,
      ...(b.appearance && Object.keys(b.appearance).length ? { appearance: b.appearance } : {}),
    })) as DashBoard[],
    activeBoardId,
  };
}

export function newBoard(name: string): NormBoard {
  return { id: uid(), name, widgets: [], appearance: {} };
}

/**
 * 把一组归一化磁贴解析成「基准列数」下的坐标布局：
 *  - 全部磁贴都有 x/y：按存储坐标（允许留空洞）。
 *  - 存在缺坐标的旧数据：整体按数组顺序 flowPack 迁移。
 */
export function baseLayout(widgets: Array<DashWidget & { w: number; h: number }>): GridItem[] {
  return buildBaseLayout(
    widgets.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h })),
    GRID_COLS,
  );
}

/** 当前列数下的渲染布局：基准列直接用，窄屏由基准派生。 */
export function layoutForCols(widgets: Array<DashWidget & { w: number; h: number }>, cols: number): GridItem[] {
  const base = baseLayout(widgets);
  if (cols === GRID_COLS) return base;
  return scaleLayout(base, GRID_COLS, cols);
}

/** 把编辑后的坐标布局合并回磁贴（仅基准列下落库）。 */
export function applyLayoutToWidgets(
  widgets: Array<DashWidget & { w: number; h: number }>,
  layout: GridItem[],
): Array<DashWidget & { w: number; h: number }> {
  const byId = new Map(layout.map((l) => [l.id, l]));
  return widgets.map((w) => {
    const l = byId.get(w.id);
    return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
  });
}

// 透传给 UI 使用的引擎工具（避免到处 import grid-engine）。
export { clampRect, flowPack };

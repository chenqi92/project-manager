// ---------------------------------------------------------------------------
// 首页仪表盘：卡片默认布局与工具。
// 网格为 4 列，卡片用 w(1-4) × h(1-3) 占格；流式 dense 排布。
// ---------------------------------------------------------------------------
import type { DashWidget, DashWidgetType, DashboardConfig } from './types';
import { uid } from './vault-ops';

export const GRID_COLS = 4;
export const ROW_HEIGHT = 130; // px，每行高度

export const WIDGET_LABELS: Record<DashWidgetType, string> = {
  stats: '统计',
  todos: '待办',
  calendar: '日历',
  launcher: '快捷导航',
  weather: '天气',
  image: '图片 / 图表',
};

/** 各类型默认 [w, h]。 */
export function defaultWH(type: DashWidgetType): [number, number] {
  switch (type) {
    case 'stats':
      return [4, 1];
    case 'launcher':
      return [4, 2];
    case 'todos':
      return [2, 2];
    case 'calendar':
      return [2, 2];
    case 'image':
      return [2, 2];
    case 'weather':
      return [1, 1];
  }
}

export function newDashWidget(type: DashWidgetType, w?: number, h?: number): DashWidget {
  const [dw, dh] = defaultWH(type);
  return { id: uid(), type, w: w ?? dw, h: h ?? dh };
}

/** 读取时归一化：补全 w/h（兼容旧版 span），并夹到合法范围。 */
export function normWidget(widget: DashWidget): DashWidget & { w: number; h: number } {
  const [dw, dh] = defaultWH(widget.type);
  const w = Math.min(GRID_COLS, Math.max(1, widget.w ?? widget.span ?? dw));
  const h = Math.min(3, Math.max(1, widget.h ?? dh));
  return { ...widget, w, h };
}

export function defaultDashboard(): DashboardConfig {
  return {
    widgets: [newDashWidget('stats'), newDashWidget('todos'), newDashWidget('calendar'), newDashWidget('launcher')],
  };
}

// ---------------------------------------------------------------------------
// 首页仪表盘：卡片默认布局与工具。
// ---------------------------------------------------------------------------
import type { DashWidget, DashWidgetType, DashboardConfig } from './types';
import { uid } from './vault-ops';

export const WIDGET_LABELS: Record<DashWidgetType, string> = {
  stats: '统计',
  todos: '待办',
  calendar: '日历',
  launcher: '快捷导航',
  weather: '天气',
  image: '图片 / 图表',
};

function defaultSpan(type: DashWidgetType): number {
  switch (type) {
    case 'stats':
    case 'launcher':
      return 4;
    case 'todos':
    case 'calendar':
    case 'image':
      return 2;
    case 'weather':
      return 1;
  }
}

export function newDashWidget(type: DashWidgetType, span?: number): DashWidget {
  return { id: uid(), type, span: span ?? defaultSpan(type) };
}

export function defaultDashboard(): DashboardConfig {
  return {
    widgets: [
      newDashWidget('stats', 4),
      newDashWidget('todos', 2),
      newDashWidget('calendar', 2),
      newDashWidget('launcher', 4),
    ],
  };
}

/** span -> Tailwind 列宽类（静态字面量，确保被 Tailwind 收集）。 */
export const SPAN_CLASS: Record<number, string> = {
  1: 'md:col-span-1 xl:col-span-1',
  2: 'md:col-span-2 xl:col-span-2',
  3: 'md:col-span-2 xl:col-span-3',
  4: 'md:col-span-2 xl:col-span-4',
};

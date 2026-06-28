// ---------------------------------------------------------------------------
// 磁贴注册表：类型 → 图标 / 标签 / 正文组件 / 是否可配置。
// 新增一类磁贴只需在 types 的 DashWidgetType、dashboard 的 WIDGET_LABELS/defaultWH
// 与此处各加一项。
// ---------------------------------------------------------------------------
import {
  BarChart3,
  CalendarDays,
  Clock,
  CloudSun,
  DatabaseBackup,
  FileText,
  Flame,
  FolderGit2,
  GitBranch,
  Hash,
  History as HistoryIcon,
  Image as ImageIcon,
  KeyRound,
  LayoutGrid,
  ListTodo,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { WIDGET_LABELS } from '@/lib/dashboard';
import type { DashWidgetType } from '@/lib/types';
import type { WidgetProps } from './Tile';
import {
  BackupWidget,
  CalendarWidget,
  ChangedWidget,
  ClockWidget,
  CnbReposWidget,
  DocWidget,
  HealthWidget,
  HotlistWidget,
  ImageWidget,
  LauncherWidget,
  RecentWidget,
  ReposWidget,
  SearchWidget,
  StatsWidget,
  StocksWidget,
  TagsWidget,
  TodosWidget,
  TotpWidget,
  WeatherWidget,
} from './bodies';

export interface WidgetMeta {
  Icon: LucideIcon;
  Component: (props: WidgetProps) => React.ReactNode;
  /** 是否在编辑态提供「配置」入口（标题/数据绑定等） */
  configurable: boolean;
}

export const REGISTRY: Record<DashWidgetType, WidgetMeta> = {
  stats: { Icon: BarChart3, Component: StatsWidget, configurable: true },
  search: { Icon: Search, Component: SearchWidget, configurable: true },
  launcher: { Icon: LayoutGrid, Component: LauncherWidget, configurable: true },
  todos: { Icon: ListTodo, Component: TodosWidget, configurable: true },
  calendar: { Icon: CalendarDays, Component: CalendarWidget, configurable: true },
  clock: { Icon: Clock, Component: ClockWidget, configurable: true },
  totp: { Icon: KeyRound, Component: TotpWidget, configurable: true },
  health: { Icon: ShieldCheck, Component: HealthWidget, configurable: false },
  recent: { Icon: HistoryIcon, Component: RecentWidget, configurable: false },
  repos: { Icon: GitBranch, Component: ReposWidget, configurable: true },
  tags: { Icon: Hash, Component: TagsWidget, configurable: true },
  doc: { Icon: FileText, Component: DocWidget, configurable: true },
  changed: { Icon: Sparkles, Component: ChangedWidget, configurable: true },
  backup: { Icon: DatabaseBackup, Component: BackupWidget, configurable: false },
  weather: { Icon: CloudSun, Component: WeatherWidget, configurable: true },
  image: { Icon: ImageIcon, Component: ImageWidget, configurable: true },
  hotlist: { Icon: Flame, Component: HotlistWidget, configurable: true },
  stocks: { Icon: TrendingUp, Component: StocksWidget, configurable: true },
  cnb: { Icon: FolderGit2, Component: CnbReposWidget, configurable: true },
};

/** 「添加卡片」菜单的展示顺序。 */
export const WIDGET_ORDER: DashWidgetType[] = [
  'stats',
  'search',
  'launcher',
  'todos',
  'calendar',
  'clock',
  'totp',
  'health',
  'recent',
  'repos',
  'tags',
  'doc',
  'changed',
  'backup',
  'weather',
  'cnb',
  'hotlist',
  'stocks',
  'image',
];

/** 磁贴目录里每种磁贴的一句话说明。 */
export const WIDGET_DESC: Record<DashWidgetType, string> = {
  stats: '项目 / 环境 / 账号 / 待办的总览数字',
  search: '在首页直接发起全局搜索',
  launcher: '常用项目链接的图标墙，一键打开',
  todos: '跨项目待办，按截止排序',
  calendar: '按截止日聚合的月历热力',
  clock: '数字时钟与时区',
  totp: '聚合所有两步验证码，环形倒计时',
  health: '密码健康评分与问题计数',
  recent: '最近使用过的账号，快速填充',
  repos: '所有 Git 仓库，一键复制 clone',
  tags: '项目标签云',
  doc: '某篇说明文档速览',
  changed: '近期改动的条目',
  backup: '备份与同步状态',
  weather: '天气（需显式开启联网）',
  hotlist: '今日热榜（需联网，可选来源）',
  stocks: '股票行情（需联网，填股票代码）',
  cnb: 'CNB 代码仓库，按子组织/项目分组（需令牌）',
  image: '自定义图片 / 图表',
};

export function widgetLabel(type: DashWidgetType): string {
  return WIDGET_LABELS[type];
}

export function WidgetBody(props: WidgetProps) {
  const Comp = REGISTRY[props.widget.type].Component;
  return <Comp {...props} />;
}

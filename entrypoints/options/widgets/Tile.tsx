// ---------------------------------------------------------------------------
// 磁贴共享外壳与原子组件：玻璃拟态卡片、标题、状态点、homarr 式 app 磁贴。
// 所有磁贴只渲染解锁态内存明文，纯本地、不联网。
// ---------------------------------------------------------------------------
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '@/components/ui';
import type { DashAppearance, DashWidget, VaultData } from '@/lib/types';

/** 主页传给每个磁贴的共享操作上下文（凭据动作走 App 顶层处理）。 */
export interface WidgetCtx {
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (url: string, username: string, password: string, tenant?: string) => void;
  onOpenTab: (url: string) => void;
  onToggleTodo: (id: string) => void;
  onEnableWeather: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  /** 打开「代码仓库」整页 */
  onOpenCnb: () => void;
  weatherEnabled: boolean;
  hostPermissionVersion: number;
}

export interface WidgetProps {
  widget: DashWidget & { w: number; h: number };
  data: VaultData;
  editing: boolean;
  onConfig: (cfg: NonNullable<DashWidget['config']>) => void;
  ctx: WidgetCtx;
}

/** 玻璃拟态磁贴的内联样式：背景透明度 + 模糊由外观面板控制（主题感知）。 */
export function tileSurfaceStyle(a: Required<DashAppearance>): CSSProperties {
  if (a.bg === 'none') return {};
  const style: Record<string, string> = {
    backgroundColor: `color-mix(in oklab, var(--color-surface) ${a.tileOpacity}%, transparent)`,
    backdropFilter: `blur(${a.tileBlur}px)`,
    WebkitBackdropFilter: `blur(${a.tileBlur}px)`,
  };
  return style as CSSProperties;
}

/** 磁贴内部标题行：图标 + 文本 + 可选右侧操作。 */
export function WidgetTitle({
  icon,
  children,
  right,
}: {
  icon: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-700">
      <span className="text-brand-600">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
      {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
    </div>
  );
}

/** 本地语义状态点（绝非联网在线状态；tooltip 写明含义）。 */
export function StatusDot({ tone, title }: { tone: 'ok' | 'warn' | 'muted'; title: string }) {
  const cls =
    tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-gray-300';
  return <span title={title} className={cx('h-2 w-2 shrink-0 rounded-full', cls)} />;
}

/** 空态占位文案。 */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-gray-400">{children}</p>;
}

/**
 * homarr 式 app 磁贴：首字母图标块（底色取项目色）+ 名称 + 副标题 + 徽标 + 本地状态点。
 * 图标用首字母而非远程 favicon（不联网、不申请 host 权限）。状态点是本地语义，
 * 非联网在线状态。
 */
export function AppTile({
  name,
  sub,
  color,
  badge,
  badgeClass,
  fav,
  dot,
  title,
  onClick,
}: {
  name: string;
  sub?: string;
  color?: string;
  badge?: string;
  badgeClass?: string;
  fav?: boolean;
  dot?: { tone: 'ok' | 'warn' | 'muted'; title: string };
  title?: string;
  onClick?: () => void;
}) {
  const initial = (name.trim()[0] ?? '·').toUpperCase();
  return (
    <button
      onClick={onClick}
      title={title ?? name}
      className="group/app flex items-center gap-2.5 rounded-xl border border-gray-200/70 bg-gray-50/70 p-2 text-left transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-sm"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white shadow-sm"
        style={{ backgroundColor: color || 'var(--color-brand-600)' }}
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="min-w-0 truncate text-xs font-semibold text-gray-800">{name}</span>
          {fav && <span className="shrink-0 text-amber-400">★</span>}
          {dot && <StatusDot tone={dot.tone} title={dot.title} />}
        </div>
        <div className="flex items-center gap-1">
          {badge && (
            <span className={cx('shrink-0 rounded px-1 py-px text-[9px] font-medium', badgeClass)}>
              {badge}
            </span>
          )}
          {sub && <span className="min-w-0 truncate text-[10px] text-gray-400">{sub}</span>}
        </div>
      </div>
    </button>
  );
}

import {
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { X } from 'lucide-react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle' | 'outline';

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-brand-600 text-white shadow-[0_3px_8px_-2px_rgba(13,148,136,.42)] hover:bg-brand-700',
    danger: 'bg-danger text-white hover:brightness-90',
    ghost: 'text-gray-600 hover:bg-gray-100',
    subtle: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
    outline: 'border border-gray-200 bg-surface text-gray-600 hover:bg-gray-50',
  };
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100',
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'w-full rounded-lg border border-gray-300 bg-surface px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-gray-500">{children}</label>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  embedded,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** 整页模式：去掉遮罩与标题栏（标题由 App 顶栏提供），内容直接铺在主区域。 */
  embedded?: boolean;
}) {
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, embedded]);

  if (embedded) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <div className={cx('mx-auto', wide ? 'max-w-4xl' : 'max-w-2xl')}>{children}</div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        className={cx(
          'pem-pop max-h-[90vh] w-full overflow-auto rounded-2xl bg-surface shadow-2xl',
          wide ? 'max-w-2xl' : 'max-w-md',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-surface px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  children: ReactNode;
}) {
  const tones = {
    info: 'bg-pribg text-prid',
    warn: 'bg-amber-50 text-amber-800',
    error: 'bg-rose-50 text-rose-800',
  };
  return (
    <div className={cx('rounded-lg px-3 py-2 text-xs leading-relaxed', tones[tone])}>
      {children}
    </div>
  );
}

/* ============================ 设计稿复用基元 ============================ */

/** pill 开关（设计：38×22 轨道、16 圆点、3px 内边距）。 */
export function Toggle({
  checked,
  onChange,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-600' : 'bg-gray-300',
      )}
    >
      <span
        className={cx(
          'absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-all',
          checked ? 'left-[19px]' : 'left-[3px]',
        )}
      />
    </button>
  );
}

/** 分段控件（顶栏明暗 / 设置主题 / 看板页签 / 模式切换复用）。 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'flex shrink-0 gap-0.5 rounded-[9px] border border-gray-200 bg-gray-50 p-[3px]',
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
            value === o.value
              ? 'bg-surface text-gray-900 shadow-sm'
              : 'text-gray-400 hover:text-gray-600',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 整页设置区块卡片（标题 + 若干 SettingsRow）。 */
export function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-gray-200 bg-surface px-[18px]">
      <div className="pb-1 pt-3.5 text-[11px] font-bold uppercase tracking-wide text-gray-400">
        {title}
      </div>
      {children}
    </div>
  );
}

/** 设置行：左侧标题 + 描述，右侧控件（首行不画上边线）。 */
export function SettingsRow({
  title,
  desc,
  children,
  first,
  titleClass,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  first?: boolean;
  titleClass?: string;
}) {
  return (
    <div
      className={cx('flex items-center gap-3 py-[15px]', !first && 'border-t border-gray-100')}
    >
      <div className="min-w-0 flex-1">
        <div className={cx('text-[13px] font-semibold', titleClass)}>{title}</div>
        {desc && <div className="mt-0.5 text-[11.5px] leading-snug text-gray-400">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/* 色块首字母头像：项目 / 账号 / 同步目标统一用。颜色按名字 hash 取自固定调色板，
 * 跨明暗主题保持稳定（浅底 + 饱和前景，作为彩色徽标在深色上同样清晰）。 */
const AVATAR_PALETTE: Array<{ bg: string; color: string }> = [
  { bg: '#e3f5f1', color: '#0d9488' },
  { bg: '#e7ecfd', color: '#4f63d2' },
  { bg: '#f3e8fd', color: '#9333ea' },
  { bg: '#fde8ef', color: '#db2777' },
  { bg: '#fff1e2', color: '#ea7a0c' },
  { bg: '#e9f8ee', color: '#15a34a' },
  { bg: '#e4f2fb', color: '#2c84c8' },
  { bg: '#feeceb', color: '#dc2626' },
];

export function avatarColors(seed: string): { bg: string; color: string } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export function avatarInitial(name: string): string {
  const t = (name ?? '').trim();
  return t ? t.charAt(0).toUpperCase() : '·';
}

export function Avatar({
  name,
  size = 28,
  radius = 8,
  className,
}: {
  name: string;
  size?: number;
  radius?: number;
  className?: string;
}) {
  const { bg, color } = avatarColors(name || '?');
  return (
    <span
      className={cx('flex shrink-0 items-center justify-center font-bold', className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: bg,
        color,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {avatarInitial(name)}
    </span>
  );
}

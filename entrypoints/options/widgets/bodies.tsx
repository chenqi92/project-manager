// ---------------------------------------------------------------------------
// 各磁贴的正文组件。全部只读解锁态内存明文，纯本地、不联网；密码/TOTP 默认遮蔽。
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  FileText,
  Flame,
  FolderGit2,
  GitBranch,
  Image as ImageIcon,
  Hash,
  History as HistoryIcon,
  KeyRound,
  Layers,
  Link as LinkIcon,
  ListTodo,
  LogIn,
  Search,
  ShieldCheck,
  Terminal,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react';
import { Button, Input, cx } from '@/components/ui';
import { MemoRow } from '@/components/MemoRow';
import { Markdown } from '@/components/Markdown';
import { audit, ISSUE_LABELS } from '@/lib/audit';
import { flatMemos, sortMemos } from '@/lib/memo';
import { flatten, search, type FlatEntry } from '@/lib/search';
import { generateTotp, parseTotp } from '@/lib/totp';
import { getUsage } from '@/lib/usage';
import { ENV_KIND_COLORS, ENV_KIND_LABELS, gitCloneCommand, linkUrls } from '@/lib/vault-ops';
import { fetchWeather, geocodeCity, weatherLabel, type WeatherNow } from '@/lib/weather';
import { stockMoveColor } from '@/lib/stock-colors';
import {
  fetchHotlist,
  fetchQuotes,
  hasHost,
  HOTLIST_SOURCES,
  hotlistUrl,
  stocksProbeUrl,
  type HotItem,
  type Quote,
  type QuoteBar,
} from '@/lib/feeds';
import { CNB_API_BASE, loadOrgRepos, type CnbRepo } from '@/lib/cnb';
import type { DashWidget, Environment, GitRepo, ProjectDoc, VaultData } from '@/lib/types';
import { AppTile, Empty, StatusDot, WidgetTitle, type WidgetProps } from './Tile';

// --- 工具 -------------------------------------------------------------------
function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const envBadgeClass = (kind: string) =>
  ENV_KIND_COLORS[(kind as Environment['kind']) in ENV_KIND_COLORS ? (kind as Environment['kind']) : 'other'];
const envLabel = (kind: string) =>
  ENV_KIND_LABELS[(kind as Environment['kind']) in ENV_KIND_LABELS ? (kind as Environment['kind']) : 'other'];

function projectFilter<T extends { id: string; favorite?: boolean }>(
  projects: T[],
  cfg: DashWidget['config'],
): T[] {
  let out = projects;
  if (cfg?.projectId) out = out.filter((p) => p.id === cfg.projectId);
  if (cfg?.onlyFavorite) out = out.filter((p) => p.favorite);
  return out;
}

function feedErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return /failed to fetch|networkerror|load failed|abort|timeout/i.test(raw)
    ? '数据源暂时不可用（第三方免费接口可能变动或限流）。点右上角 ⚙ 换个来源，或填自定义源。'
    : raw;
}

function formatPrice(value: number, currency?: string): string {
  const price = value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 3 });
  return currency ? `${price} ${currency}` : price;
}

function formatShortDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function TilePager({
  label,
  index,
  total,
  onPrev,
  onNext,
}: {
  label: string;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (total <= 1) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 text-[10px] text-gray-400">
      <button
        type="button"
        onClick={onPrev}
        title="上一页"
        className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
      >
        <ChevronLeft size={13} />
      </button>
      <span className="max-w-[92px] truncate rounded-md bg-gray-50 px-1.5 py-0.5 font-medium text-gray-500">
        {label} {index + 1}/{total}
      </span>
      <button
        type="button"
        onClick={onNext}
        title="下一页"
        className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  );
}

function KlineChart({ bars, symbol }: { bars: QuoteBar[]; symbol: string }) {
  const visible = bars.slice(-45);
  if (visible.length < 2) return <Empty>暂无 K 线数据</Empty>;

  const width = 320;
  const height = 146;
  const left = 38;
  const right = 8;
  const top = 10;
  const bottom = 22;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const prices = visible.flatMap((b) => [b.high, b.low]);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = Math.max(0.000001, max - min);
  const y = (v: number) => top + ((max - v) / range) * plotH;
  const step = plotW / visible.length;
  const candleW = Math.max(2, Math.min(8, step * 0.55));
  const ticks = [max, min + range / 2, min];
  const first = visible[0]!;
  const last = visible[visible.length - 1]!;

  return (
    <div className="min-h-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[150px] w-full overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={width - right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--color-gray-100)"
              strokeWidth="1"
            />
            <text x={0} y={y(t) + 3} fill="var(--color-gray-400)" fontSize="9">
              {t.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </text>
          </g>
        ))}
        {visible.map((b, i) => {
          const up = b.close >= b.open;
          const color = stockMoveColor(symbol, up);
          const x = left + step * i + step / 2;
          const bodyTop = Math.min(y(b.open), y(b.close));
          const bodyH = Math.max(1.5, Math.abs(y(b.open) - y(b.close)));
          return (
            <g key={b.time}>
              <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="1.2" />
              <rect
                x={x - candleW / 2}
                y={bodyTop}
                width={candleW}
                height={bodyH}
                rx="1"
                fill={up ? color : 'transparent'}
                stroke={color}
                strokeWidth="1.2"
              />
            </g>
          );
        })}
        <text x={left} y={height - 4} fill="var(--color-gray-400)" fontSize="9">
          {formatShortDate(first.time)}
        </text>
        <text x={width - right} y={height - 4} fill="var(--color-gray-400)" fontSize="9" textAnchor="end">
          {formatShortDate(last.time)}
        </text>
      </svg>
    </div>
  );
}

// --- 统计 -------------------------------------------------------------------
export function StatsWidget({ widget, data }: WidgetProps) {
  const entries = flatten(data);
  const envs = data.projects.reduce((n, p) => n + p.environments.length, 0);
  const links = data.projects.reduce(
    (n, p) => n + p.environments.reduce((m, e) => m + e.links.length, 0),
    0,
  );
  const totp = entries.filter((e) => e.totp).length;
  const pending = data.projects.reduce((n, p) => n + (p.memos ?? []).filter((m) => !m.done).length, 0);
  const cells = [
    { label: '项目', value: data.projects.length },
    { label: '环境', value: envs },
    { label: '链接', value: links },
    { label: '账号', value: entries.length },
    { label: '验证码', value: totp },
    { label: '待办', value: pending, accent: pending > 0 },
  ];
  const grid = (
    <div className="grid h-full min-h-0 grid-cols-6 gap-2.5">
      {cells.map((c) => (
        <div key={c.label} className="flex min-w-0 flex-col justify-center rounded-[10px] bg-gray-50 px-2 py-2">
          <div
            className={cx(
              'truncate text-2xl font-bold leading-none tracking-tight',
              c.accent ? 'text-danger' : 'text-gray-900',
            )}
          >
            {c.value}
          </div>
          <div className="mt-1 truncate text-[11px] text-gray-500">{c.label}</div>
        </div>
      ))}
    </div>
  );
  if (!widget.config?.label) return grid;
  return (
    <>
      <WidgetTitle icon={<BarChart3 size={15} />}>{widget.config.label}</WidgetTitle>
      <div className="h-[calc(100%-2rem)] min-h-0">{grid}</div>
    </>
  );
}

// --- 待办（due-aware）-------------------------------------------------------
export function TodosWidget({ widget, data, ctx }: WidgetProps) {
  const now = Date.now();
  const all = flatMemos(data.projects).filter((m) => !m.done);
  const todos = sortMemos(all).slice(0, 30);
  const overdue = all.filter((m) => m.dueAt && m.dueAt < now).length;
  const soon = all.filter((m) => m.dueAt && m.dueAt >= now && m.dueAt - now < 2 * 86400000).length;
  return (
    <>
      <WidgetTitle
        icon={<ListTodo size={15} />}
        right={
          (overdue > 0 || soon > 0) && (
            <span className="flex items-center gap-1 text-[10px] font-normal">
              {overdue > 0 && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700">逾期 {overdue}</span>}
              {soon > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">临期 {soon}</span>}
            </span>
          )
        }
      >
        {widget.config?.label || '待办'}
      </WidgetTitle>
      {todos.length === 0 ? (
        <Empty>没有待办，去项目里添加</Empty>
      ) : (
        <div className="flex flex-col gap-1.5">
          {todos.map((m) => (
            <div key={m.id} className="flex items-center gap-1.5">
              <span className="max-w-[5rem] shrink-0 truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                {m.projectName}
              </span>
              <div className="min-w-0 flex-1">
                <MemoRow memo={m} onToggleDone={() => ctx.onToggleTodo(m.id)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// --- 日历 -------------------------------------------------------------------
export function CalendarWidget({ widget, data }: WidgetProps) {
  const now = new Date();
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [selected, setSelected] = useState<string | null>(null);

  const dueMemos = flatMemos(data.projects).filter((m) => m.dueAt && !m.done);
  const dayKey = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const byDay = new Map<string, number>();
  for (const m of dueMemos) byDay.set(dayKey(m.dueAt!), (byDay.get(dayKey(m.dueAt!)) ?? 0) + 1);

  const first = new Date(cursor.y, cursor.m, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const shift = (delta: number) => {
    const m = cursor.m + delta;
    setCursor({ y: cursor.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
    setSelected(null);
  };
  const selectedMemos = selected ? sortMemos(dueMemos.filter((m) => dayKey(m.dueAt!) === selected)) : [];

  return (
    <>
      <WidgetTitle
        icon={<CalendarDays size={15} />}
        right={
          <>
            <button onClick={() => shift(-1)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
              <ChevronLeft size={15} />
            </button>
            <button onClick={() => shift(1)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
              <ChevronRight size={15} />
            </button>
          </>
        }
      >
        {widget.config?.label || `${cursor.y} 年 ${cursor.m + 1} 月`}
      </WidgetTitle>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-gray-400">
        {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const key = `${cursor.y}-${cursor.m}-${d}`;
          const count = byDay.get(key) ?? 0;
          const isToday = key === todayKey;
          const isSel = key === selected;
          return (
            <button
              key={key}
              onClick={() => setSelected(isSel ? null : key)}
              className={cx(
                'relative flex h-8 flex-col items-center justify-center rounded-lg text-xs',
                isSel ? 'bg-pribg text-prid' : isToday ? 'bg-pribg text-prid' : 'hover:bg-gray-100',
              )}
            >
              {d}
              {count > 0 && (
                <span className="absolute bottom-0.5 h-1.5 w-1.5 rounded-full bg-rose-500" title={`${count} 项待办`} />
              )}
            </button>
          );
        })}
      </div>
      {selected && (
        <div className="mt-2 flex flex-col gap-1 border-t border-gray-100 pt-2">
          {selectedMemos.length === 0 ? (
            <p className="text-center text-[11px] text-gray-400">这天没有待办</p>
          ) : (
            selectedMemos.map((m) => (
              <div key={m.id} className="flex items-center gap-1.5 text-xs">
                <span className="max-w-[5rem] shrink-0 truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                  {m.projectName}
                </span>
                <span className="min-w-0 flex-1 truncate text-gray-700">{m.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}

// --- 快捷入口（homarr app 磁贴）--------------------------------------------
export function LauncherWidget({ widget, data, ctx }: WidgetProps) {
  const cfg = widget.config;
  const tiles: {
    id: string;
    name: string;
    host: string;
    url: string;
    color?: string;
    kind: string;
    fav: boolean;
    accounts: number;
  }[] = [];
  for (const p of projectFilter(data.projects, cfg))
    for (const e of p.environments)
      for (const l of e.links) {
        const url = l.url || linkUrls(l)[0] || '';
        if (!url) continue;
        let host = url;
        try {
          host = new URL(url).host;
        } catch {
          /* keep */
        }
        tiles.push({
          id: l.id,
          name: l.name || host,
          host,
          url,
          color: p.color,
          kind: e.kind,
          fav: !!p.favorite,
          accounts: l.accounts.length,
        });
      }
  return (
    <>
      <WidgetTitle icon={<LinkIcon size={15} />}>{cfg?.label || '快捷入口'}</WidgetTitle>
      {tiles.length === 0 ? (
        <Empty>还没有链接</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {tiles.map((t) => (
            <AppTile
              key={t.id}
              name={t.name}
              sub={t.host}
              color={t.color}
              fav={t.fav}
              badge={envLabel(t.kind)}
              badgeClass={envBadgeClass(t.kind)}
              dot={
                t.kind === 'prod'
                  ? { tone: 'warn', title: '生产环境，谨慎操作' }
                  : t.accounts > 0
                    ? { tone: 'ok', title: `${t.accounts} 个账号` }
                    : { tone: 'muted', title: '暂无账号' }
              }
              title={t.url}
              onClick={() => ctx.onOpenTab(t.url)}
            />
          ))}
        </div>
      )}
    </>
  );
}

// --- 全局搜索（命令条）-----------------------------------------------------
export function SearchWidget({ widget, data, ctx }: WidgetProps) {
  const [q, setQ] = useState('');
  const results = useMemo(() => (q.trim() ? search(data, q).slice(0, 8) : []), [data, q]);
  return (
    <>
      <div className="relative mb-2">
        <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={widget.config?.label || '搜索项目 / 环境 / 链接 / 账号'}
          className="pl-8"
        />
      </div>
      {q.trim() && (
        <div className="flex flex-col gap-1">
          {results.length === 0 ? (
            <Empty>没有匹配</Empty>
          ) : (
            results.map((e) => <SearchRow key={e.accountId} entry={e} ctx={ctx} />)
          )}
        </div>
      )}
    </>
  );
}

function SearchRow({ entry, ctx }: { entry: FlatEntry; ctx: WidgetProps['ctx'] }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate font-medium text-gray-800">{entry.linkName}</span>
          <span className={cx('shrink-0 rounded px-1 py-px text-[9px]', envBadgeClass(entry.envKind))}>
            {envLabel(entry.envKind)}
          </span>
        </div>
        <div className="truncate text-[10px] text-gray-400">
          {entry.projectName} · {entry.username || '—'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconBtn title="复制密码" onClick={() => ctx.onCopy(entry.password, '密码')}>
          <span className="text-[10px] font-bold">PW</span>
        </IconBtn>
        {entry.url && (
          <IconBtn title="打开并登录" onClick={() => ctx.onOpenLogin(entry.url, entry.username, entry.password, entry.tenant)}>
            <LogIn size={14} />
          </IconBtn>
        )}
      </div>
    </div>
  );
}

// --- 验证码墙（默认遮蔽）---------------------------------------------------
export function TotpWidget({ widget, data, ctx, onConfig }: WidgetProps) {
  const reveal = widget.config?.reveal === true;
  const entries = useMemo(() => projectScopedEntries(data, widget.config).filter((e) => e.totp), [data, widget.config]);
  return (
    <>
      <WidgetTitle
        icon={<KeyRound size={15} />}
        right={
          entries.length > 0 && (
            <button
              title={reveal ? '遮蔽验证码' : '显示验证码'}
              onClick={() => onConfig({ reveal: !reveal })}
              className="rounded p-1 text-gray-400 hover:bg-gray-100"
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          )
        }
      >
        {widget.config?.label || '验证码墙'}
      </WidgetTitle>
      {entries.length === 0 ? (
        <Empty>没有配置两步验证的账号</Empty>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <TotpRow key={e.accountId} entry={e} reveal={reveal} onCopy={ctx.onCopy} />
          ))}
        </div>
      )}
    </>
  );
}

function TotpRow({
  entry,
  reveal,
  onCopy,
}: {
  entry: FlatEntry;
  reveal: boolean;
  onCopy: (text: string, what: string) => void;
}) {
  const [code, setCode] = useState('------');
  const [rem, setRem] = useState(30);
  const [period, setPeriod] = useState(30);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const cfg = parseTotp(entry.totp!);
    if (!cfg) {
      setBad(true);
      return;
    }
    setBad(false);
    setPeriod(cfg.period);
    let active = true;
    const tick = async () => {
      const r = await generateTotp(cfg, Date.now());
      if (!active) return;
      setCode(r.code);
      setRem(r.secondsRemaining);
    };
    void tick().catch(() => {});
    const t = setInterval(() => void tick().catch(() => {}), 1000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [entry.totp]);

  const shown = reveal ? `${code.slice(0, 3)} ${code.slice(3)}` : '••• •••';
  if (bad)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-200/70 px-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate text-gray-700">{entry.linkName}</span>
        <span className="text-rose-500">密钥无效</span>
      </div>
    );
  return (
    <button
      onClick={() => onCopy(code, '验证码')}
      title="点击复制验证码"
      className="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2 py-1.5 text-left text-xs hover:border-brand-300"
    >
      <span
        className="h-4 w-4 shrink-0 rounded-full"
        style={{
          background: `conic-gradient(var(--color-brand-500) ${(rem / period) * 360}deg, var(--color-gray-200) 0deg)`,
        }}
        title={`${rem}s`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-gray-800">{entry.accountLabel || entry.username || entry.linkName}</div>
        <div className="truncate text-[10px] text-gray-400">{entry.linkName}</div>
      </div>
      <span className="shrink-0 font-mono text-sm tracking-widest text-brand-700">{shown}</span>
    </button>
  );
}

// --- 密码健康度 -------------------------------------------------------------
export function HealthWidget({ widget, data }: WidgetProps) {
  const report = useMemo(() => audit(data), [data]);
  const problem = report.issues.length;
  const score = report.total === 0 ? 100 : Math.round(((report.total - problem) / report.total) * 100);
  const ringColor = score >= 80 ? 'var(--color-emerald-500)' : score >= 50 ? 'var(--color-amber-500)' : 'var(--color-rose-500)';
  return (
    <>
      <WidgetTitle icon={<ShieldCheck size={15} />}>{widget.config?.label || '密码健康度'}</WidgetTitle>
      {report.total === 0 ? (
        <Empty>还没有密码可评估</Empty>
      ) : (
        <div className="flex h-[calc(100%-2rem)] gap-3">
          <div className="flex shrink-0 flex-col items-center justify-center">
            <div
              className="flex h-16 w-16 items-center justify-center rounded-full"
              style={{ background: `conic-gradient(${ringColor} ${score * 3.6}deg, var(--color-gray-200) 0deg)` }}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface">
                <span className="text-base font-bold text-gray-900">{score}</span>
              </div>
            </div>
            <div className="mt-1 flex gap-1 text-[10px]">
              <span className="text-rose-600">弱{report.weak}</span>
              <span className="text-amber-600">复{report.reused}</span>
              <span className="text-gray-500">旧{report.old}</span>
            </div>
          </div>
          <div className="no-scrollbar min-w-0 flex-1 overflow-auto">
            {problem === 0 ? (
              <p className="py-4 text-center text-xs text-emerald-600">全部密码良好 👍</p>
            ) : (
              <div className="flex flex-col gap-1">
                {report.issues.slice(0, 20).map((it) => (
                  <div
                    key={it.entry.accountId}
                    className="flex items-center gap-1.5 rounded-lg border border-gray-200/60 px-2 py-1 text-[11px]"
                  >
                    <span className="min-w-0 flex-1 truncate text-gray-700">
                      {it.entry.linkName}
                      <span className="text-gray-400"> · {it.entry.accountLabel || it.entry.username}</span>
                    </span>
                    {it.kinds.map((k) => (
                      <span key={k} className="shrink-0 rounded bg-rose-50 px-1 text-[9px] text-rose-600">
                        {ISSUE_LABELS[k]}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// --- 最近使用 ---------------------------------------------------------------
export function RecentWidget({ widget, data, ctx }: WidgetProps) {
  const [usage, setUsage] = useState<Record<string, number>>({});
  useEffect(() => {
    let active = true;
    void getUsage().then((u) => active && setUsage(u));
    return () => {
      active = false;
    };
  }, []);
  const now = Date.now();
  const rows = useMemo(() => {
    const byId = new Map(flatten(data).map((e) => [e.accountId, e]));
    return Object.entries(usage)
      .map(([id, ts]) => ({ entry: byId.get(id), ts }))
      .filter((r): r is { entry: FlatEntry; ts: number } => !!r.entry)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 12);
  }, [data, usage]);
  return (
    <>
      <WidgetTitle icon={<Clock size={15} />}>{widget.config?.label || '最近使用'}</WidgetTitle>
      {rows.length === 0 ? (
        <Empty>还没有使用记录</Empty>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map(({ entry, ts }) => (
            <div
              key={entry.accountId}
              className="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate font-medium text-gray-800">{entry.linkName}</span>
                  <span className={cx('shrink-0 rounded px-1 py-px text-[9px]', envBadgeClass(entry.envKind))}>
                    {envLabel(entry.envKind)}
                  </span>
                </div>
                <div className="truncate text-[10px] text-gray-400">
                  {entry.username || '—'} · {relativeTime(ts, now)}
                </div>
              </div>
              {entry.url && (
                <IconBtn
                  title="再次打开并登录"
                  onClick={() => ctx.onOpenLogin(entry.url, entry.username, entry.password, entry.tenant)}
                >
                  <LogIn size={14} />
                </IconBtn>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// --- Git 仓库 ---------------------------------------------------------------
export function ReposWidget({ widget, data, ctx }: WidgetProps) {
  const repos = useMemo(() => {
    const seen = new Set<string>();
    const out: { repo: GitRepo; project: string }[] = [];
    for (const p of projectFilter(data.projects, widget.config)) {
      const push = (r: GitRepo) => {
        const k = `${r.url}@@${r.branch ?? ''}`;
        if (r.url && !seen.has(k)) {
          seen.add(k);
          out.push({ repo: r, project: p.name });
        }
      };
      for (const e of p.environments) {
        (e.gitRepos ?? []).forEach(push);
        for (const l of e.links) (l.gitRepos ?? []).forEach(push);
      }
    }
    return out;
  }, [data, widget.config]);
  return (
    <>
      <WidgetTitle icon={<GitBranch size={15} />}>{widget.config?.label || 'Git 仓库'}</WidgetTitle>
      {repos.length === 0 ? (
        <Empty>还没有 Git 仓库</Empty>
      ) : (
        <div className="flex flex-col gap-1.5">
          {repos.map(({ repo, project }) => (
            <div
              key={`${repo.url}@@${repo.branch ?? ''}`}
              className="flex items-center gap-1 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate font-medium text-gray-800">{repo.label || repo.url}</span>
                  {repo.branch && <span className="shrink-0 rounded bg-brand-50 px-1 text-[9px] text-prid">{repo.branch}</span>}
                </div>
                <div className="truncate font-mono text-[10px] text-gray-400">{project}</div>
              </div>
              <IconBtn title="复制仓库地址" onClick={() => ctx.onCopy(repo.url, '仓库地址')}>
                <LinkIcon size={13} />
              </IconBtn>
              <IconBtn title="复制 git clone 命令" onClick={() => ctx.onCopy(gitCloneCommand(repo), 'git clone 命令')}>
                <Terminal size={13} />
              </IconBtn>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// --- 标签云 -----------------------------------------------------------------
export function TagsWidget({ widget, data }: WidgetProps) {
  const counts = new Map<string, number>();
  for (const p of data.projects) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <>
      <WidgetTitle icon={<Hash size={15} />}>{widget.config?.label || '标签云'}</WidgetTitle>
      {tags.length === 0 ? (
        <Empty>项目还没有标签</Empty>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tags.map(([t, n]) => (
            <span
              key={t}
              className="rounded-full bg-brand-50 px-2 py-0.5 text-prid"
              style={{ fontSize: `${11 + Math.min(6, n - 1)}px` }}
              title={`${n} 个项目`}
            >
              {t} <span className="text-brand-400">{n}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

// --- 文档速览 ---------------------------------------------------------------
export function DocWidget({ widget, data }: WidgetProps) {
  const all = useMemo(() => {
    const out: (ProjectDoc & { projectName: string })[] = [];
    for (const p of data.projects) for (const d of p.docs ?? []) out.push({ ...d, projectName: p.name });
    return out;
  }, [data]);
  const doc = useMemo(() => {
    if (widget.config?.docId) return all.find((d) => d.id === widget.config!.docId) ?? null;
    let pool = all;
    if (widget.config?.projectId) pool = all.filter((d) => d.projectName && data.projects.find((p) => p.id === widget.config!.projectId)?.docs?.some((x) => x.id === d.id));
    return pool.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }, [all, widget.config, data.projects]);
  return (
    <>
      <WidgetTitle icon={<FileText size={15} />}>{widget.config?.label || doc?.title || '文档速览'}</WidgetTitle>
      {!doc ? (
        <Empty>还没有项目文档</Empty>
      ) : (
        <div className="no-scrollbar h-[calc(100%-2rem)] overflow-auto">
          <Markdown source={doc.content || '（空文档）'} />
        </div>
      )}
    </>
  );
}

// --- 近期改动 ---------------------------------------------------------------
export function ChangedWidget({ widget, data }: WidgetProps) {
  const now = Date.now();
  const rows = useMemo(
    () => projectScopedEntries(data, widget.config).slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12),
    [data, widget.config],
  );
  return (
    <>
      <WidgetTitle icon={<HistoryIcon size={15} />}>{widget.config?.label || '近期改动'}</WidgetTitle>
      {rows.length === 0 ? (
        <Empty>还没有账号记录</Empty>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((e) => (
            <div
              key={e.accountId}
              className="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate font-medium text-gray-800">{e.linkName}</span>
                  <span className={cx('shrink-0 rounded px-1 py-px text-[9px]', envBadgeClass(e.envKind))}>
                    {envLabel(e.envKind)}
                  </span>
                </div>
                <div className="truncate text-[10px] text-gray-400">
                  {e.projectName} · {e.accountLabel || e.username || '—'}
                </div>
              </div>
              <span className="shrink-0 text-[10px] text-gray-400">{relativeTime(e.updatedAt, now)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// --- 备份 / 同步健康 --------------------------------------------------------
export function BackupWidget({ widget, data, ctx }: WidgetProps) {
  const now = Date.now();
  const targets = data.settings.syncTargets ?? [];
  const enabled = targets.filter((t) => t.enabled).length;
  const lastBackup = data.settings.lastBackupAt;
  const DAY = 86400000;
  const backupAge = lastBackup ? Math.floor((now - lastBackup) / DAY) : null;
  const backupTone = lastBackup == null ? 'warn' : backupAge! > 30 ? 'warn' : 'ok';
  const syncTone = targets.length === 0 ? 'muted' : enabled > 0 ? 'ok' : 'muted';
  return (
    <>
      <WidgetTitle icon={<ShieldCheck size={15} />}>{widget.config?.label || '备份 / 同步'}</WidgetTitle>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2.5 py-2 text-xs">
          <StatusDot tone={backupTone} title="本地加密备份状态" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-700">本地备份</div>
            <div className="text-[10px] text-gray-400">
              {lastBackup ? `上次 ${relativeTime(lastBackup, now)}（${backupAge} 天前）` : '从未导出，建议立即备份'}
            </div>
          </div>
          <button onClick={ctx.onOpenExport} className="shrink-0 rounded-md bg-brand-50 px-2 py-1 text-[11px] text-prid hover:bg-brand-100">
            去备份
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-gray-200/70 bg-gray-50/60 px-2.5 py-2 text-xs">
          <StatusDot tone={syncTone} title="云端同步状态" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-700">云端同步</div>
            <div className="text-[10px] text-gray-400">
              {targets.length === 0 ? '未配置同步' : `${enabled}/${targets.length} 个目标已启用`}
            </div>
          </div>
          <button onClick={ctx.onOpenSettings} className="shrink-0 rounded-md bg-gray-100 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-200">
            设置
          </button>
        </div>
      </div>
    </>
  );
}

// --- 时钟 -------------------------------------------------------------------
export function ClockWidget({ widget }: WidgetProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return (
    <div className="flex h-full flex-col items-center justify-center">
      {widget.config?.label && <div className="mb-1 text-xs text-gray-400">{widget.config.label}</div>}
      <div className="font-mono text-3xl font-bold tracking-wide text-gray-900">
        {hh}:{mm}
        <span className="text-lg text-gray-400">:{ss}</span>
      </div>
      <div className="mt-1 text-xs text-gray-500">
        {now.getFullYear()}/{now.getMonth() + 1}/{now.getDate()} {week}
      </div>
    </div>
  );
}

// --- 天气（默认关闭联网）---------------------------------------------------
export function WeatherWidget({ widget, ctx }: WidgetProps) {
  const enabled = ctx.weatherEnabled;
  const city = widget.config?.city ?? '';
  const unit = widget.config?.unit === 'f' ? 'f' : 'c';
  const [state, setState] = useState<{ loading: boolean; data?: WeatherNow; err?: string }>({ loading: false });

  useEffect(() => {
    if (!enabled || !city) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      try {
        const geo = await geocodeCity(city);
        if (!geo) throw new Error('找不到该城市');
        const w = await fetchWeather(geo.lat, geo.lon, geo.name);
        if (!cancelled) setState({ loading: false, data: w });
      } catch (e) {
        if (!cancelled) setState({ loading: false, err: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, city]);

  const temp = (c: number) => (unit === 'f' ? Math.round((c * 9) / 5 + 32) : Math.round(c));

  return (
    <>
      <WidgetTitle icon={<span>🌦️</span>}>{widget.config?.label || '天气'}</WidgetTitle>
      {!enabled ? (
        <div className="py-3 text-center">
          <p className="text-xs text-gray-400">天气需联网获取，默认关闭。</p>
          <button onClick={ctx.onEnableWeather} className="mt-1.5 text-xs text-brand-600 hover:underline">
            开启联网天气
          </button>
        </div>
      ) : !city ? (
        <Empty>点磁贴右上角 ⚙ 设置城市</Empty>
      ) : state.loading ? (
        <Empty>加载中…</Empty>
      ) : state.err ? (
        <p className="py-4 text-center text-xs text-rose-500">{state.err}</p>
      ) : state.data ? (
        <div className="flex items-center gap-3">
          <span className="text-4xl">{weatherLabel(state.data.code).emoji}</span>
          <div>
            <div className="text-3xl font-bold text-gray-900">
              {temp(state.data.temp)}°{unit === 'f' ? 'F' : ''}
            </div>
            <div className="text-xs text-gray-500">
              {state.data.city} · {weatherLabel(state.data.code).text} · 风 {Math.round(state.data.wind)} km/h
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// --- 图片 / 图表 ------------------------------------------------------------
export function ImageWidget({ widget }: WidgetProps) {
  const dataUrl = widget.config?.dataUrl;
  const caption = widget.config?.caption ?? '';

  return (
    <>
      <WidgetTitle icon={<ImageIcon size={15} />}>{widget.config?.label || '图片 / 图表'}</WidgetTitle>
      {dataUrl ? (
        <img src={dataUrl} alt={caption || 'image'} className="max-h-64 w-full rounded-lg object-contain" />
      ) : (
        <Empty>点磁贴右上角 ⚙ 上传图片</Empty>
      )}
      {caption && <p className="mt-1 text-center text-xs text-gray-500">{caption}</p>}
    </>
  );
}

// --- 今日热榜（联网，需开启+授权）------------------------------------------
function EnableNet({ onEnable, what }: { onEnable: () => void; what: string }) {
  return (
    <div className="py-3 text-center">
      <p className="text-xs text-gray-400">{what}需联网获取，默认关闭。</p>
      <button onClick={onEnable} className="mt-1.5 text-xs text-brand-600 hover:underline">
        开启联网功能
      </button>
    </div>
  );
}

export function HotlistWidget({ widget, ctx }: WidgetProps) {
  const enabled = ctx.weatherEnabled;
  const source = widget.config?.source ?? 'zhihu';
  const customUrl = widget.config?.sourceUrl;
  const count = widget.config?.count ?? 10;
  const url = hotlistUrl(source, customUrl);
  const sourceDefs = useMemo(() => {
    if (source === 'custom') {
      return url ? [{ key: 'custom', name: '自定义', url }] : [];
    }
    const selected = HOTLIST_SOURCES.findIndex((s) => s.key === source);
    const start = selected >= 0 ? selected : 0;
    return [...HOTLIST_SOURCES.slice(start), ...HOTLIST_SOURCES.slice(0, start)];
  }, [source, url]);
  const sourceKey = sourceDefs.map((s) => s.url).join('|');
  const [page, setPage] = useState(0);
  const [state, setState] = useState<{
    loading: boolean;
    pages?: Array<{ key: string; name: string; items: HotItem[]; err?: string }>;
    err?: string;
    needAuth?: boolean;
  }>({ loading: false });

  useEffect(() => {
    setPage(0);
  }, [sourceKey]);

  useEffect(() => {
    if (!enabled || sourceDefs.length === 0) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      const hosts = await Promise.all(sourceDefs.map((s) => hasHost(s.url)));
      if (hosts.some((ok) => !ok)) {
        if (!cancelled) setState({ loading: false, needAuth: true });
        return;
      }
      try {
        const pages = await Promise.all(
          sourceDefs.map(async (s) => {
            try {
              return { key: s.key, name: s.name, items: await fetchHotlist(s.url, count) };
            } catch (e) {
              return { key: s.key, name: s.name, items: [], err: feedErrorMessage(e) };
            }
          }),
        );
        if (!cancelled) setState({ loading: false, pages });
      } catch (e) {
        if (!cancelled) setState({ loading: false, err: feedErrorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, sourceKey, count, ctx.hostPermissionVersion]);

  const pages = state.pages ?? [];
  const activePage = pages[Math.min(page, Math.max(0, pages.length - 1))];
  const changePage = (delta: number) =>
    setPage((p) => {
      const total = Math.max(1, pages.length);
      return (p + delta + total) % total;
    });

  return (
    <>
      <WidgetTitle
        icon={<Flame size={15} />}
        right={
          <TilePager
            label={activePage?.name ?? '热榜'}
            index={Math.min(page, Math.max(0, pages.length - 1))}
            total={pages.length}
            onPrev={() => changePage(-1)}
            onNext={() => changePage(1)}
          />
        }
      >
        {widget.config?.label || '今日热榜'}
      </WidgetTitle>
      {!enabled ? (
        <EnableNet onEnable={ctx.onEnableWeather} what="热榜" />
      ) : sourceDefs.length === 0 ? (
        <Empty>点磁贴右上角 ⚙ 选择来源</Empty>
      ) : state.needAuth ? (
        <Empty>点磁贴右上角 ⚙ 授权数据源后显示</Empty>
      ) : state.loading ? (
        <Empty>加载中…</Empty>
      ) : state.err ? (
        <p className="py-4 text-center text-xs text-rose-500">{state.err}</p>
      ) : activePage?.err ? (
        <p className="py-4 text-center text-xs text-rose-500">{activePage.err}</p>
      ) : activePage?.items && activePage.items.length > 0 ? (
        <div className="flex flex-col">
          {activePage.items.map((it, i) => (
            <button
              key={i}
              onClick={() => it.url && ctx.onOpenTab(it.url)}
              disabled={!it.url}
              className="flex cursor-pointer items-center gap-2.5 border-t border-gray-100 py-1.5 text-left first:border-t-0 hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span
                className={cx(
                  'w-4 shrink-0 text-center text-[12px] font-bold',
                  i < 3 ? 'text-brand-600' : 'text-gray-400',
                )}
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-800">{it.title}</span>
              {it.hot && <span className="shrink-0 text-[10px] text-gray-400">{it.hot}</span>}
            </button>
          ))}
        </div>
      ) : (
        <Empty>暂无数据</Empty>
      )}
    </>
  );
}

// --- 股票行情（联网，需开启+授权）------------------------------------------
export function StocksWidget({ widget, ctx }: WidgetProps) {
  const enabled = ctx.weatherEnabled;
  const source = widget.config?.source ?? 'builtin';
  const customUrl = widget.config?.sourceUrl;
  const symbols = (widget.config?.symbols ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const probe = stocksProbeUrl(source, customUrl);
  const key = symbols.join(',');
  const [page, setPage] = useState(0);
  const [state, setState] = useState<{
    loading: boolean;
    quotes?: Quote[];
    err?: string;
    needAuth?: boolean;
  }>({ loading: false });

  useEffect(() => {
    setPage(0);
  }, [key, source, customUrl]);

  useEffect(() => {
    if (!enabled || symbols.length === 0 || !probe) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      if (!(await hasHost(probe))) {
        if (!cancelled) setState({ loading: false, needAuth: true });
        return;
      }
      try {
        const quotes = await fetchQuotes(symbols, source, customUrl);
        if (!cancelled) setState({ loading: false, quotes });
      } catch (e) {
        if (!cancelled) setState({ loading: false, err: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, source, customUrl, probe, ctx.hostPermissionVersion]);

  const quotes = state.quotes ?? [];
  const pageCount = quotes.length > 0 ? quotes.length + 1 : 1;
  const activePage = Math.min(page, pageCount - 1);
  const activeQuote = activePage > 0 ? quotes[activePage - 1] : undefined;
  const changePage = (delta: number) =>
    setPage((p) => {
      const total = Math.max(1, pageCount);
      return (p + delta + total) % total;
    });

  return (
    <>
      <WidgetTitle
        icon={<TrendingUp size={15} />}
        right={
          state.quotes && state.quotes.length > 0 ? (
            <TilePager
              label={activeQuote?.symbol ?? '总览'}
              index={activePage}
              total={pageCount}
              onPrev={() => changePage(-1)}
              onNext={() => changePage(1)}
            />
          ) : null
        }
      >
        {widget.config?.label || '股票行情'}
      </WidgetTitle>
      {!enabled ? (
        <EnableNet onEnable={ctx.onEnableWeather} what="股票行情" />
      ) : symbols.length === 0 ? (
        <Empty>点磁贴右上角 ⚙ 填写股票代码</Empty>
      ) : state.needAuth ? (
        <Empty>点磁贴右上角 ⚙ 授权数据源后显示</Empty>
      ) : state.loading ? (
        <Empty>加载中…</Empty>
      ) : state.err ? (
        <p className="py-4 text-center text-xs text-rose-500">{state.err}</p>
      ) : activeQuote ? (
        <StockChartPage quote={activeQuote} />
      ) : quotes.length > 0 ? (
        <div className="flex flex-col">
          {quotes.map((q, i) => {
            const up = q.changePct >= 0;
            return (
              <button
                key={q.symbol}
                onClick={() => setPage(i + 1)}
                disabled={!q.ok}
                className="flex cursor-pointer items-center gap-2.5 border-t border-gray-100 py-2 text-left first:border-t-0 hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold text-gray-800">
                    {q.name || q.symbol}
                  </div>
                  <div className="truncate font-mono text-[10px] text-gray-400">{q.symbol}</div>
                </div>
                {q.ok ? (
                  <div className="text-right">
                    <div className="font-mono text-[13px] font-semibold text-gray-900">
                      {formatPrice(q.price, q.currency)}
                    </div>
                    <div className="font-mono text-[11px] font-semibold" style={{ color: stockMoveColor(q.symbol, up) }}>
                      {up ? '+' : ''}
                      {q.changePct.toFixed(2)}%
                    </div>
                  </div>
                ) : (
                  <span className="text-[11px] text-gray-400">取数失败</span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <Empty>暂无数据</Empty>
      )}
    </>
  );
}

function StockChartPage({ quote }: { quote: Quote }) {
  const up = quote.changePct >= 0;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-start gap-3 rounded-lg bg-gray-50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-gray-800">{quote.name || quote.symbol}</div>
          <div className="truncate font-mono text-[10px] text-gray-400">{quote.symbol}</div>
        </div>
        {quote.ok ? (
          <div className="text-right">
            <div className="font-mono text-[14px] font-semibold text-gray-900">
              {formatPrice(quote.price, quote.currency)}
            </div>
            <div className="font-mono text-[11px] font-semibold" style={{ color: stockMoveColor(quote.symbol, up) }}>
              {up ? '+' : ''}
              {quote.changePct.toFixed(2)}%
            </div>
          </div>
        ) : (
          <span className="text-[11px] text-gray-400">取数失败</span>
        )}
      </div>
      <KlineChart bars={quote.bars ?? []} symbol={quote.symbol} />
    </div>
  );
}

// --- CNB 代码仓库（联网，需配置令牌 + 授权 api.cnb.cool）-------------------
export function CnbReposWidget({ widget, data, ctx }: WidgetProps) {
  const cfg = data.settings.cnb;
  const orgs = useMemo(() => cfg?.orgs ?? [], [cfg?.orgs]);
  const orgsKey = orgs.join(',');
  const count = widget.config?.count ?? 10;
  const configured = !!cfg?.token && orgs.length > 0;
  const [state, setState] = useState<{
    loading: boolean;
    repos?: CnbRepo[];
    err?: string;
    needAuth?: boolean;
  }>({ loading: false });

  useEffect(() => {
    if (!configured) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState({ loading: true });
    (async () => {
      if (!(await hasHost(CNB_API_BASE))) {
        if (!cancelled) setState({ loading: false, needAuth: true });
        return;
      }
      try {
        const lists = await Promise.all(
          orgs.map((slug) =>
            loadOrgRepos(cfg!.token!, slug, { base: cfg!.apiBase }).then((r) => r.repos),
          ),
        );
        const repos = lists
          .flat()
          .sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));
        if (!cancelled) setState({ loading: false, repos });
      } catch (e) {
        if (!cancelled) setState({ loading: false, err: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, cfg?.token, orgsKey, ctx.hostPermissionVersion]);

  const repos = state.repos ?? [];
  const subOrgOf = (path: string) => {
    const segs = path.split('/').filter(Boolean);
    return segs.length >= 3 ? segs[1] : segs[0];
  };

  return (
    <>
      <WidgetTitle
        icon={<FolderGit2 size={15} />}
        right={
          <button
            onClick={ctx.onOpenCnb}
            title="打开代码仓库整页"
            className="text-[11px] font-semibold text-brand-600 hover:underline"
          >
            全部 →
          </button>
        }
      >
        {widget.config?.label || 'CNB 仓库'}
      </WidgetTitle>
      {!configured ? (
        <div className="py-3 text-center">
          <p className="text-xs text-gray-400">尚未配置 CNB 访问令牌与组织。</p>
          <button onClick={ctx.onOpenCnb} className="mt-1.5 text-xs text-brand-600 hover:underline">
            前往配置
          </button>
        </div>
      ) : state.needAuth ? (
        <div className="py-3 text-center">
          <p className="text-xs text-gray-400">需授权 api.cnb.cool 后联网拉取。</p>
          <button onClick={ctx.onOpenCnb} className="mt-1.5 text-xs text-brand-600 hover:underline">
            前往授权
          </button>
        </div>
      ) : state.loading ? (
        <Empty>加载中…</Empty>
      ) : state.err ? (
        <p className="py-4 text-center text-xs text-rose-500">{state.err}</p>
      ) : repos.length === 0 ? (
        <Empty>没有仓库</Empty>
      ) : (
        <div className="flex flex-col">
          {repos.slice(0, count).map((r) => (
            <button
              key={r.id}
              onClick={() => r.webUrl && ctx.onOpenTab(r.webUrl)}
              disabled={!r.webUrl}
              className="flex items-center gap-2 border-t border-gray-100 py-1.5 text-left first:border-t-0 disabled:cursor-default"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-gray-800">{r.name}</div>
                <div className="truncate font-mono text-[10px] text-gray-400">{subOrgOf(r.path)}</div>
              </div>
              {r.language && <span className="shrink-0 text-[10px] text-gray-400">{r.language}</span>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// --- 共享小件 ---------------------------------------------------------------
function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
    >
      {children}
    </button>
  );
}

function projectScopedEntries(data: VaultData, cfg: DashWidget['config']): FlatEntry[] {
  const all = flatten(data);
  if (!cfg?.projectId && !cfg?.onlyFavorite) return all;
  const allowed = new Set(projectFilter(data.projects, cfg).map((p) => p.id));
  return all.filter((e) => allowed.has(e.projectId));
}

// 让 StatusDot 在本文件可用（注册表外露给别处复用时一致）。
export { StatusDot };

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Image as ImageIcon,
  Layers,
  Link as LinkIcon,
  ListTodo,
  Pencil,
  Plus,
  StickyNote,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { Button, Input, cx } from '@/components/ui';
import { MemoRow } from '@/components/MemoRow';
import type { DashWidget, DashWidgetType, VaultData } from '@/lib/types';
import {
  GRID_COLS,
  ROW_HEIGHT,
  WIDGET_LABELS,
  defaultDashboard,
  newDashWidget,
  normWidget,
} from '@/lib/dashboard';
import { flatMemos, sortMemos } from '@/lib/memo';
import { ENV_KIND_COLORS, ENV_KIND_LABELS } from '@/lib/vault-ops';
import { fetchWeather, geocodeCity, weatherLabel, type WeatherNow } from '@/lib/weather';

export function Home({
  data,
  onUpdate,
}: {
  data: VaultData;
  onUpdate: (recipe: (d: VaultData) => void) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [addType, setAddType] = useState<DashWidgetType>('weather');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; w: number; h: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const widgets = (data.settings.dashboard?.widgets ?? defaultDashboard().widgets).map(normWidget);
  const setWidgets = (next: DashWidget[]) =>
    onUpdate((d) => {
      d.settings.dashboard = { widgets: next };
    });
  const updateConfig = (id: string, cfg: NonNullable<DashWidget['config']>) =>
    setWidgets(widgets.map((w) => (w.id === id ? { ...w, config: { ...w.config, ...cfg } } : w)));
  const remove = (id: string) => setWidgets(widgets.filter((w) => w.id !== id));
  const add = () => setWidgets([...widgets, newDashWidget(addType)]);
  const move = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const from = widgets.findIndex((w) => w.id === fromId);
    const to = widgets.findIndex((w) => w.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...widgets];
    const [m] = next.splice(from, 1);
    if (m) next.splice(to, 0, m);
    setWidgets(next);
  };

  // 拖右下角手柄改变 w(列)×h(行)，按格吸附；松手才落库。
  const startResize = (e: React.PointerEvent, wgt: DashWidget & { w: number; h: number }) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    const gap = 16;
    const cellW = (grid.clientWidth - gap * (GRID_COLS - 1)) / GRID_COLS;
    const sx = e.clientX;
    const sy = e.clientY;
    let lastW = wgt.w;
    let lastH = wgt.h;
    const onMove = (ev: PointerEvent) => {
      const dw = Math.round((ev.clientX - sx) / (cellW + gap));
      const dh = Math.round((ev.clientY - sy) / (ROW_HEIGHT + gap));
      lastW = Math.min(GRID_COLS, Math.max(1, wgt.w + dw));
      lastH = Math.min(3, Math.max(1, wgt.h + dh));
      setResizing({ id: wgt.id, w: lastW, h: lastH });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (lastW !== wgt.w || lastH !== wgt.h)
        setWidgets(widgets.map((x) => (x.id === wgt.id ? { ...x, w: lastW, h: lastH } : x)));
      setResizing(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleTodo = (id: string) =>
    onUpdate((d) => {
      for (const p of d.projects) {
        const m = (p.memos ?? []).find((x) => x.id === id);
        if (m) {
          m.done = !m.done;
          m.updatedAt = Date.now();
          p.updatedAt = Date.now();
          return;
        }
      }
    });

  return (
    <>
      <header className="flex items-center gap-2 border-b border-gray-200 bg-surface px-6 py-4">
        <h1 className="text-lg font-semibold">首页</h1>
        <span className="text-xs text-gray-400">仪表盘</span>
        <div className="ml-auto flex items-center gap-2">
          {editing && (
            <>
              <select
                value={addType}
                onChange={(e) => setAddType(e.target.value as DashWidgetType)}
                className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
              >
                {(Object.keys(WIDGET_LABELS) as DashWidgetType[]).map((t) => (
                  <option key={t} value={t}>
                    {WIDGET_LABELS[t]}
                  </option>
                ))}
              </select>
              <Button variant="subtle" onClick={add}>
                <Plus size={15} /> 添加卡片
              </Button>
            </>
          )}
          <Button variant={editing ? 'primary' : 'subtle'} onClick={() => setEditing((e) => !e)}>
            {editing ? <Check size={15} /> : <Pencil size={15} />} {editing ? '完成' : '编辑布局'}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {editing && (
          <p className="mb-3 text-xs text-gray-400">
            编辑模式：拖卡片左上角手柄移动、拖右下角改变大小（1–4 列 × 1–3 行）。
          </p>
        )}
        {widgets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
            没有卡片。点右上角「编辑布局 → 添加卡片」。
          </p>
        ) : (
          <div
            ref={gridRef}
            className="grid grid-flow-row-dense gap-4"
            style={{
              gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
              gridAutoRows: `${ROW_HEIGHT}px`,
            }}
          >
            {widgets.map((w) => {
              const live = resizing && resizing.id === w.id ? resizing : w;
              return (
                <div
                  key={w.id}
                  onDragOver={(e) => {
                    if (editing && dragId && dragId !== w.id) {
                      e.preventDefault();
                      setDragOverId(w.id);
                    }
                  }}
                  onDragLeave={() => setDragOverId((c) => (c === w.id ? null : c))}
                  onDrop={() => {
                    if (editing && dragId) move(dragId, w.id);
                    setDragId(null);
                    setDragOverId(null);
                  }}
                  style={{ gridColumn: `span ${live.w}`, gridRow: `span ${live.h}` }}
                  className={cx(
                    'relative min-w-0',
                    dragId === w.id && 'opacity-40',
                    dragOverId === w.id && 'rounded-2xl ring-2 ring-brand-300',
                  )}
                >
                  <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-surface shadow-sm">
                    {editing && (
                      <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-xs">
                        <span
                          draggable
                          onDragStart={() => setDragId(w.id)}
                          onDragEnd={() => {
                            setDragId(null);
                            setDragOverId(null);
                          }}
                          className="cursor-grab"
                          title="拖动移动"
                        >
                          <GripVertical size={14} className="text-gray-400" />
                        </span>
                        <span className="font-medium text-gray-600">{WIDGET_LABELS[w.type]}</span>
                        <span className="text-gray-400">
                          {live.w}×{live.h}
                        </span>
                        <button
                          onClick={() => remove(w.id)}
                          title="移除"
                          className="ml-auto rounded p-0.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    <div className="min-h-0 flex-1 overflow-auto p-4">
                      <WidgetBody
                        widget={w}
                        data={data}
                        editing={editing}
                        onToggleTodo={toggleTodo}
                        onConfig={(cfg) => updateConfig(w.id, cfg)}
                      />
                    </div>
                  </div>
                  {editing && (
                    <div
                      onPointerDown={(e) => startResize(e, w)}
                      title="拖动改变大小"
                      style={{ touchAction: 'none' }}
                      className="absolute bottom-1.5 right-1.5 h-3 w-3 cursor-se-resize border-b-2 border-r-2 border-gray-400 hover:border-brand-500"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function WidgetBody({
  widget,
  data,
  editing,
  onToggleTodo,
  onConfig,
}: {
  widget: DashWidget;
  data: VaultData;
  editing: boolean;
  onToggleTodo: (id: string) => void;
  onConfig: (cfg: NonNullable<DashWidget['config']>) => void;
}) {
  switch (widget.type) {
    case 'stats':
      return <StatsWidget data={data} />;
    case 'todos':
      return <TodosWidget data={data} onToggle={onToggleTodo} />;
    case 'calendar':
      return <CalendarWidget data={data} />;
    case 'launcher':
      return <LauncherWidget data={data} />;
    case 'weather':
      return <WeatherWidget widget={widget} editing={editing} onConfig={onConfig} />;
    case 'image':
      return <ImageWidget widget={widget} editing={editing} onConfig={onConfig} />;
  }
}

function WidgetTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-700">
      {icon}
      {children}
    </div>
  );
}

function StatsWidget({ data }: { data: VaultData }) {
  const envs = data.projects.reduce((n, p) => n + p.environments.length, 0);
  const accts = data.projects.reduce(
    (n, p) => n + p.environments.reduce((m, e) => m + e.links.reduce((k, l) => k + l.accounts.length, 0), 0),
    0,
  );
  const pending = data.projects.reduce((n, p) => n + (p.memos ?? []).filter((m) => !m.done).length, 0);
  const cells: { icon: ReactNode; label: string; value: number; accent?: boolean }[] = [
    { icon: <Layers size={18} />, label: '项目', value: data.projects.length },
    { icon: <Layers size={18} />, label: '环境', value: envs },
    { icon: <Users size={18} />, label: '账号', value: accts },
    { icon: <ListTodo size={18} />, label: '待办', value: pending, accent: pending > 0 },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cells.map((c) => (
        <div
          key={c.label}
          className={cx(
            'flex items-center gap-2.5 rounded-xl border px-3 py-2.5',
            c.accent ? 'border-rose-200 bg-rose-50' : 'border-gray-200 bg-gray-50',
          )}
        >
          <span className={c.accent ? 'text-rose-600' : 'text-brand-600'}>{c.icon}</span>
          <div>
            <div className={cx('text-xl font-bold leading-none', c.accent ? 'text-rose-700' : 'text-gray-900')}>
              {c.value}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-500">{c.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TodosWidget({ data, onToggle }: { data: VaultData; onToggle: (id: string) => void }) {
  const todos = sortMemos(flatMemos(data.projects).filter((m) => !m.done)).slice(0, 30);
  return (
    <>
      <WidgetTitle icon={<ListTodo size={15} className="text-brand-600" />}>待办</WidgetTitle>
      {todos.length === 0 ? (
        <p className="py-6 text-center text-xs text-gray-400">没有待办，去项目里添加</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {todos.map((m) => (
            <div key={m.id} className="flex items-center gap-1.5">
              <span className="max-w-[5rem] shrink-0 truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                {m.projectName}
              </span>
              <div className="min-w-0 flex-1">
                <MemoRow memo={m} onToggleDone={() => onToggle(m.id)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CalendarWidget({ data }: { data: VaultData }) {
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
  const selectedMemos = selected
    ? sortMemos(dueMemos.filter((m) => dayKey(m.dueAt!) === selected))
    : [];

  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <CalendarDays size={15} className="text-brand-600" />
        <span className="text-sm font-semibold text-gray-700">
          {cursor.y} 年 {cursor.m + 1} 月
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => shift(-1)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
            <ChevronLeft size={15} />
          </button>
          <button onClick={() => shift(1)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
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
                isSel ? 'bg-brand-100 text-brand-700' : isToday ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-100',
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

function LauncherWidget({ data }: { data: VaultData }) {
  const links: { id: string; name: string; url: string; host: string; kind: string }[] = [];
  for (const p of data.projects)
    for (const e of p.environments)
      for (const l of e.links) {
        if (!l.url) continue;
        let host = l.url;
        try {
          host = new URL(l.url).host;
        } catch {
          /* keep */
        }
        links.push({ id: l.id, name: l.name || host, url: l.url, host, kind: e.kind });
      }
  return (
    <>
      <WidgetTitle icon={<LinkIcon size={15} className="text-brand-600" />}>快捷导航</WidgetTitle>
      {links.length === 0 ? (
        <p className="py-6 text-center text-xs text-gray-400">还没有链接</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {links.map((l) => (
            <button
              key={l.id}
              onClick={() => browser.tabs.create({ url: l.url })}
              title={l.url}
              className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 p-2 text-left hover:border-brand-300"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
                {(l.name[0] ?? '·').toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-gray-800">{l.name}</div>
                <div className="truncate text-[10px] text-gray-400">{l.host}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function WeatherWidget({
  widget,
  editing,
  onConfig,
}: {
  widget: DashWidget;
  editing: boolean;
  onConfig: (cfg: NonNullable<DashWidget['config']>) => void;
}) {
  const city = widget.config?.city ?? '';
  const [cityInput, setCityInput] = useState(city);
  const [state, setState] = useState<{ loading: boolean; data?: WeatherNow; err?: string }>({
    loading: false,
  });

  useEffect(() => {
    setCityInput(city);
  }, [city]);

  useEffect(() => {
    if (!city) {
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
  }, [city]);

  return (
    <>
      <WidgetTitle icon={<span>🌦️</span>}>天气</WidgetTitle>
      {editing && (
        <div className="mb-2">
          <Input
            value={cityInput}
            onChange={(e) => setCityInput(e.target.value)}
            onBlur={() => cityInput.trim() !== city && onConfig({ city: cityInput.trim() })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfig({ city: cityInput.trim() });
            }}
            placeholder="输入城市，如 北京 / Shanghai"
          />
        </div>
      )}
      {!city ? (
        <p className="py-4 text-center text-xs text-gray-400">点「编辑布局」后填写城市</p>
      ) : state.loading ? (
        <p className="py-4 text-center text-xs text-gray-400">加载中…</p>
      ) : state.err ? (
        <p className="py-4 text-center text-xs text-rose-500">{state.err}</p>
      ) : state.data ? (
        <div className="flex items-center gap-3">
          <span className="text-4xl">{weatherLabel(state.data.code).emoji}</span>
          <div>
            <div className="text-3xl font-bold text-gray-900">{Math.round(state.data.temp)}°</div>
            <div className="text-xs text-gray-500">
              {state.data.city} · {weatherLabel(state.data.code).text} · 风 {Math.round(state.data.wind)} km/h
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ImageWidget({
  widget,
  editing,
  onConfig,
}: {
  widget: DashWidget;
  editing: boolean;
  onConfig: (cfg: NonNullable<DashWidget['config']>) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dataUrl = widget.config?.dataUrl;
  const caption = widget.config?.caption ?? '';
  const [captionInput, setCaptionInput] = useState(caption);
  useEffect(() => setCaptionInput(caption), [caption]);

  const pick = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => onConfig({ dataUrl: String(reader.result ?? '') });
    reader.readAsDataURL(file);
  };

  return (
    <>
      <WidgetTitle icon={<ImageIcon size={15} className="text-brand-600" />}>图片 / 图表</WidgetTitle>
      {dataUrl ? (
        <img src={dataUrl} alt={caption || 'image'} className="max-h-64 w-full rounded-lg object-contain" />
      ) : (
        <p className="py-6 text-center text-xs text-gray-400">
          {editing ? '点下方上传一张图片/图表' : '点「编辑布局」上传图片'}
        </p>
      )}
      {(caption || (!editing && dataUrl)) && (
        <p className="mt-1 text-center text-xs text-gray-500">{caption}</p>
      )}
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <Button variant="subtle" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> 上传
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) pick(f);
            }}
          />
          <Input
            value={captionInput}
            onChange={(e) => setCaptionInput(e.target.value)}
            onBlur={() => captionInput !== caption && onConfig({ caption: captionInput })}
            placeholder="说明（可选）"
          />
        </div>
      )}
    </>
  );
}

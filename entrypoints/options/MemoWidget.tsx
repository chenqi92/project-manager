import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { EyeOff, ListChecks, Minus } from 'lucide-react';
import { cx } from '@/components/ui';
import { AddMemo, MemoRow } from '@/components/MemoRow';
import type { MemoItem, VaultData } from '@/lib/types';
import { isAlarming, sortMemos } from '@/lib/memo';
import { addTombstone, newMemo } from '@/lib/vault-ops';

const KEY = 'memoWidget';
const ALL_PROJECTS = '__all__';

interface WidgetState {
  x: number;
  y: number;
  collapsed: boolean;
  /** 组件内「隐藏」（眼睛按钮）→ 只剩右下角圆形 FAB 可复显；区别于设置里的整体隐藏。 */
  hidden: boolean;
}

export function MemoWidget({
  data,
  selectedProjectId,
  onUpdate,
}: {
  data: VaultData;
  selectedProjectId?: string | null;
  onUpdate: (recipe: (d: VaultData) => void) => Promise<void>;
}) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, window.innerWidth - 340),
    y: Math.max(8, window.innerHeight - 540),
  }));
  const [collapsed, setCollapsed] = useState(true); // 默认收起，遮挡隐私
  const [hidden, setHidden] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [scopeProjectId, setScopeProjectId] = useState(ALL_PROJECTS);
  const posRef = useRef(pos);
  posRef.current = pos;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    browser.storage.local
      .get(KEY)
      .then((r) => {
        const s = r[KEY] as Partial<WidgetState> | undefined;
        if (s) {
          if (typeof s.x === 'number' && typeof s.y === 'number') setPos({ x: s.x, y: s.y });
          setCollapsed(s.collapsed ?? true);
          setHidden(s.hidden ?? false);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = (s: WidgetState) => {
    browser.storage.local.set({ [KEY]: s }).catch(() => {});
  };

  // 展开时把面板夹回视口内：收起态小圆按钮可能停在右/下边缘，若仍以左上角为锚点展开，
  // 面板会越界、显示不全。这里按实际面板尺寸把锚点向左/上回移，使其完整可见。
  useLayoutEffect(() => {
    if (collapsed || hidden) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const nx = Math.min(Math.max(posRef.current.x, margin), maxLeft);
    const ny = Math.min(Math.max(posRef.current.y, margin), maxTop);
    if (nx !== posRef.current.x || ny !== posRef.current.y) {
      setPos({ x: nx, y: ny });
      save({ x: nx, y: ny, collapsed: false, hidden: false });
    }
  }, [collapsed, hidden]);

  // 面板顶栏拖动：纯移动。
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = posRef.current.x;
    const oy = posRef.current.y;
    let last = { x: ox, y: oy };
    const move = (ev: PointerEvent) => {
      last = {
        x: Math.min(Math.max(ox + ev.clientX - sx, 4), window.innerWidth - 60),
        y: Math.min(Math.max(oy + ev.clientY - sy, 4), window.innerHeight - 40),
      };
      setPos(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save({ x: last.x, y: last.y, collapsed, hidden });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const n = !c;
      save({ ...posRef.current, collapsed: n, hidden });
      return n;
    });
  };

  // 小圆按钮 / FAB：可拖动移动；几乎没移动则当作点击（执行 onTap）。
  const startMoveOrTap = (e: React.PointerEvent, onTap: () => void) => {
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = posRef.current.x;
    const oy = posRef.current.y;
    let moved = false;
    let last = { x: ox, y: oy };
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) moved = true;
      last = {
        x: Math.min(Math.max(ox + ev.clientX - sx, 4), window.innerWidth - 60),
        y: Math.min(Math.max(oy + ev.clientY - sy, 4), window.innerHeight - 40),
      };
      if (moved) setPos(last);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) save({ x: last.x, y: last.y, collapsed, hidden });
      else onTap();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const hide = () => {
    setHidden(true);
    save({ ...posRef.current, collapsed, hidden: true });
  };
  const show = () => {
    setHidden(false);
    save({ ...posRef.current, collapsed, hidden: false });
  };

  const mutate = (id: string, fn: (m: MemoItem) => void) =>
    onUpdate((d) => {
      for (const p of d.projects) {
        const m = (p.memos ?? []).find((x) => x.id === id);
        if (m) {
          fn(m);
          m.updatedAt = Date.now();
          p.updatedAt = Date.now();
          return;
        }
      }
    });
  const del = (id: string) =>
    onUpdate((d) => {
      for (const p of d.projects) {
        if ((p.memos ?? []).some((m) => m.id === id)) {
          addTombstone(d, id);
          p.memos = (p.memos ?? []).filter((m) => m.id !== id);
          p.updatedAt = Date.now();
        }
      }
    });
  const add = (pid: string, text: string, dueAt: number | undefined, urgent: boolean) =>
    onUpdate((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (p) {
        p.memos = [...(p.memos ?? []), newMemo({ text, dueAt, urgent })];
        p.updatedAt = Date.now();
      }
    });

  if (data.projects.length === 0 || !loaded || data.settings.floatingMemoHidden) return null;

  const now = Date.now();
  const selectedScope =
    scopeProjectId === ALL_PROJECTS || data.projects.some((p) => p.id === scopeProjectId)
      ? scopeProjectId
      : ALL_PROJECTS;
  const visibleProjects =
    selectedScope === ALL_PROJECTS
      ? data.projects
      : data.projects.filter((p) => p.id === selectedScope);
  const groups = visibleProjects
    .map((p) => ({ id: p.id, name: p.name, memos: sortMemos(p.memos ?? []) }))
    .filter((g) => g.memos.length > 0);
  const allMemos = visibleProjects.flatMap((p) => p.memos ?? []);
  const pendingTotal = allMemos.filter((m) => !m.done).length;
  const alarmCount = allMemos.filter((m) => isAlarming(m, now)).length;
  const fallbackAddPid =
    (selectedProjectId && data.projects.some((p) => p.id === selectedProjectId)
      ? selectedProjectId
      : data.projects[0]?.id) || '';
  const addPid = selectedScope === ALL_PROJECTS ? fallbackAddPid : selectedScope;

  // 组件内隐藏：右下角圆形 FAB（teal），点击复显；可拖动。
  if (hidden) {
    return (
      <button
        onPointerDown={(e) => startMoveOrTap(e, show)}
        style={{ left: pos.x, top: pos.y, touchAction: 'none' }}
        className={cx(
          'fixed z-40 flex h-[46px] w-[46px] items-center justify-center rounded-full text-white shadow-[0_12px_28px_-8px_rgba(13,148,136,.45)] active:cursor-grabbing',
          alarmCount > 0 ? 'memo-shake bg-rose-600' : 'bg-brand-600',
        )}
        title="显示待办（拖动可移动）"
      >
        <ListChecks size={20} />
      </button>
    );
  }

  // 收起态：胶囊按钮（拖动移动 / 点击展开）。
  if (collapsed) {
    return (
      <button
        onPointerDown={(e) => startMoveOrTap(e, toggleCollapsed)}
        style={{ left: pos.x, top: pos.y, touchAction: 'none' }}
        className={cx(
          'fixed z-40 flex cursor-grab items-center gap-2 rounded-full border bg-surface px-4 py-2.5 text-[12.5px] font-semibold shadow-[0_12px_30px_-10px_rgba(20,26,40,.3)] active:cursor-grabbing',
          alarmCount > 0 ? 'memo-shake border-rose-200' : 'border-gray-200',
        )}
        title="拖动移动 / 点击展开"
      >
        <ListChecks size={16} className="text-warn" />
        <span className="text-gray-800">待办</span>
        {alarmCount > 0 ? (
          <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white">
            {alarmCount}
          </span>
        ) : (
          pendingTotal > 0 && (
            <span className="rounded-full bg-gray-100 px-1.5 text-[11px] text-gray-500">
              {pendingTotal}
            </span>
          )
        )}
      </button>
    );
  }

  // 展开态：面板。
  return (
    <div
      ref={panelRef}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-40 flex max-h-[72vh] w-[300px] flex-col overflow-hidden rounded-[14px] border border-gray-200 bg-surface shadow-[0_18px_44px_-12px_rgba(20,26,40,.32)]"
    >
      <div
        onPointerDown={startDrag}
        className="flex cursor-move touch-none items-center gap-2.5 border-b border-gray-200 bg-gray-50 px-3.5 py-3"
      >
        <ListChecks size={16} className="text-warn" />
        <span className="flex-1 text-[12.5px] font-bold text-gray-800">待办</span>
        {alarmCount > 0 && (
          <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white">
            {alarmCount} 紧急
          </span>
        )}
        <button
          onClick={toggleCollapsed}
          className="flex h-6 w-6 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200"
          title="收起"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={hide}
          className="flex h-6 w-6 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200"
          title="隐藏（右下角可复显）"
        >
          <EyeOff size={14} />
        </button>
      </div>

      {/* 聚合列表（主体） */}
      <div className="flex-1 overflow-auto p-2">
        {groups.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-gray-400">还没有待办，下方添加</p>
        ) : (
          groups.map((g) => (
            <div key={g.id} className="mb-2">
              <div className="px-1 pb-1 text-[11px] font-semibold text-gray-400">{g.name}</div>
              <div className="flex flex-col gap-1">
                {g.memos.map((m) => (
                  <MemoRow
                    key={m.id}
                    memo={m}
                    onToggleDone={() => mutate(m.id, (x) => (x.done = !x.done))}
                    onToggleUrgent={() => mutate(m.id, (x) => (x.urgent = !x.urgent))}
                    onDelete={() => del(m.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 添加（次要） */}
      <div className="space-y-1.5 border-t border-gray-100 p-2">
        <select
          value={selectedScope}
          onChange={(e) => setScopeProjectId(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-brand-500"
          title="待办范围"
        >
          <option value={ALL_PROJECTS}>全部</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <AddMemo onAdd={(text, due, urgent) => add(addPid, text, due, urgent)} />
      </div>
    </div>
  );
}

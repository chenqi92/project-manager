import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { GripVertical, StickyNote, X } from 'lucide-react';
import { cx } from '@/components/ui';
import { AddMemo, MemoRow } from '@/components/MemoRow';
import type { MemoItem, VaultData } from '@/lib/types';
import { isAlarming, sortMemos } from '@/lib/memo';
import { addTombstone, newMemo } from '@/lib/vault-ops';

const KEY = 'memoWidget';
interface WidgetState {
  x: number;
  y: number;
  collapsed: boolean;
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
    x: Math.max(8, window.innerWidth - 400),
    y: Math.max(8, window.innerHeight - 540),
  }));
  const [collapsed, setCollapsed] = useState(true); // 默认收起，遮挡隐私
  const [loaded, setLoaded] = useState(false);
  const [addProjectId, setAddProjectId] = useState('');
  const posRef = useRef(pos);
  posRef.current = pos;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    browser.storage.local
      .get(KEY)
      .then((r) => {
        const s = r[KEY] as WidgetState | undefined;
        if (s) {
          setPos({ x: s.x, y: s.y });
          setCollapsed(s.collapsed);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = (s: WidgetState) => {
    browser.storage.local.set({ [KEY]: s }).catch(() => {});
  };

  // 展开时把面板夹回视口内：收起态小圆按钮可能停在右/下边缘，若仍以左上角为锚点展开，
  // 面板会越界、显示不全。这里按实际面板尺寸把锚点向左/上回移，使其完整可见
  //（等价于在右下角时以右下角为基准展开）。在 useLayoutEffect 里于绘制前修正，无闪烁。
  useLayoutEffect(() => {
    if (collapsed) return;
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
      save({ x: nx, y: ny, collapsed: false });
    }
  }, [collapsed]);

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
      save({ x: last.x, y: last.y, collapsed });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const n = !c;
      save({ ...posRef.current, collapsed: n });
      return n;
    });
  };

  // 收起态小圆按钮：可拖动移动；几乎没移动则当作点击 → 展开。
  const startPillDrag = (e: React.PointerEvent) => {
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
      if (moved) save({ x: last.x, y: last.y, collapsed: true });
      else toggleCollapsed();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
  const groups = data.projects
    .map((p) => ({ id: p.id, name: p.name, memos: sortMemos(p.memos ?? []) }))
    .filter((g) => g.memos.length > 0);
  const allMemos = data.projects.flatMap((p) => p.memos ?? []);
  const pendingTotal = allMemos.filter((m) => !m.done).length;
  const alarmCount = allMemos.filter((m) => isAlarming(m, now)).length;
  const addPid = addProjectId || selectedProjectId || data.projects[0]?.id || '';

  if (collapsed) {
    return (
      <button
        onPointerDown={startPillDrag}
        style={{ left: pos.x, top: pos.y, touchAction: 'none' }}
        className={cx(
          'fixed z-40 flex cursor-grab items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-white shadow-lg active:cursor-grabbing',
          alarmCount > 0 ? 'memo-shake bg-rose-600' : 'bg-brand-600',
        )}
        title="拖动移动 / 点击展开"
      >
        <StickyNote size={16} /> 待办
        {pendingTotal > 0 && (
          <span className="rounded-full bg-white/25 px-1.5 text-xs">{pendingTotal}</span>
        )}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-40 flex max-h-[72vh] w-96 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-surface shadow-2xl"
    >
      <div
        onPointerDown={startDrag}
        className="flex cursor-move touch-none items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2"
      >
        <GripVertical size={15} className="text-gray-400" />
        <StickyNote size={15} className="text-brand-600" />
        <span className="text-sm font-semibold text-gray-800">待办任务</span>
        {pendingTotal > 0 && (
          <span
            className={cx(
              'rounded-full px-1.5 text-[11px] font-medium',
              alarmCount > 0 ? 'bg-rose-100 text-rose-700' : 'bg-gray-200 text-gray-600',
            )}
          >
            待办 {pendingTotal}
          </span>
        )}
        <button
          onClick={toggleCollapsed}
          className="ml-auto rounded-md p-1 text-gray-400 hover:bg-gray-200"
          title="收起"
        >
          <X size={16} />
        </button>
      </div>

      {/* 聚合列表（主体） */}
      <div className="flex-1 overflow-auto p-2">
        {groups.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-gray-400">还没有待办，下方添加</p>
        ) : (
          groups.map((g) => (
            <div key={g.id} className="mb-2">
              <div className="px-1 pb-1 text-[11px] font-medium text-gray-400">{g.name}</div>
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
          value={addPid}
          onChange={(e) => setAddProjectId(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-brand-500"
          title="添加到项目"
        >
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

import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertTriangle, GripVertical, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import type { MemoItem, VaultData } from '@/lib/types';
import { newMemo } from '@/lib/vault-ops';

const KEY = 'memoWidget';
interface WidgetState {
  x: number;
  y: number;
  collapsed: boolean;
}

export function MemoWidget({
  data,
  onUpdate,
}: {
  data: VaultData;
  onUpdate: (recipe: (d: VaultData) => void) => Promise<void>;
}) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, window.innerWidth - 360),
    y: Math.max(8, window.innerHeight - 500),
  }));
  const [collapsed, setCollapsed] = useState(false);
  const [addProjectId, setAddProjectId] = useState('');
  const [addText, setAddText] = useState('');
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    browser.storage.local
      .get(KEY)
      .then((r) => {
        const s = r[KEY] as WidgetState | undefined;
        if (s) {
          setPos({ x: s.x, y: s.y });
          setCollapsed(s.collapsed);
        }
      })
      .catch(() => {});
  }, []);

  const save = (s: WidgetState) => {
    browser.storage.local.set({ [KEY]: s }).catch(() => {});
  };

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

  // 改备忘时一并 bump 所属项目的 updatedAt，保证同步合并(按项目 updatedAt 取较新)不丢改动。
  const forMemo = (d: VaultData, id: string, fn: (m: MemoItem) => void) => {
    for (const p of d.projects) {
      const m = (p.memos ?? []).find((x) => x.id === id);
      if (m) {
        fn(m);
        p.updatedAt = Date.now();
        return;
      }
    }
  };
  const toggleDone = (id: string) =>
    onUpdate((d) => forMemo(d, id, (m) => {
      m.done = !m.done;
      m.updatedAt = Date.now();
    }));
  const toggleUrgent = (id: string) =>
    onUpdate((d) => forMemo(d, id, (m) => {
      m.urgent = !m.urgent;
      m.updatedAt = Date.now();
    }));
  const del = (id: string) =>
    onUpdate((d) => {
      for (const p of d.projects) {
        if ((p.memos ?? []).some((m) => m.id === id)) {
          p.memos = (p.memos ?? []).filter((m) => m.id !== id);
          p.updatedAt = Date.now();
        }
      }
    });
  const add = () => {
    const pid = addProjectId || data.projects[0]?.id;
    if (!pid || !addText.trim()) return;
    const text = addText.trim();
    onUpdate((d) => {
      const p = d.projects.find((x) => x.id === pid);
      if (p) {
        p.memos = [...(p.memos ?? []), newMemo({ text })];
        p.updatedAt = Date.now();
      }
    });
    setAddText('');
  };

  if (data.projects.length === 0) return null;

  const groups = data.projects
    .map((p) => ({ id: p.id, name: p.name, memos: p.memos ?? [] }))
    .filter((g) => g.memos.length > 0);
  const pendingUrgent = data.projects.reduce(
    (n, p) => n + (p.memos ?? []).filter((m) => !m.done && m.urgent).length,
    0,
  );
  const pendingTotal = data.projects.reduce(
    (n, p) => n + (p.memos ?? []).filter((m) => !m.done).length,
    0,
  );

  // 收起态：悬浮按钮（有紧急未完成则抖动标红）
  if (collapsed) {
    return (
      <button
        onClick={toggleCollapsed}
        style={{ left: pos.x, top: pos.y }}
        className={cx(
          'fixed z-40 flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-white shadow-lg',
          pendingUrgent > 0 ? 'memo-shake bg-rose-600' : 'bg-brand-600',
        )}
        title="展开备忘"
      >
        <StickyNote size={16} /> 备忘
        {pendingTotal > 0 && (
          <span className="rounded-full bg-white/25 px-1.5 text-xs">{pendingTotal}</span>
        )}
      </button>
    );
  }

  return (
    <div
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-40 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-surface shadow-2xl"
    >
      {/* 拖拽头 */}
      <div
        onPointerDown={startDrag}
        className="flex cursor-move touch-none items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2"
      >
        <GripVertical size={15} className="text-gray-400" />
        <StickyNote size={15} className="text-brand-600" />
        <span className="text-sm font-semibold text-gray-800">备忘录</span>
        {pendingTotal > 0 && (
          <span
            className={cx(
              'rounded-full px-1.5 text-[11px] font-medium',
              pendingUrgent > 0 ? 'bg-rose-100 text-rose-700' : 'bg-gray-200 text-gray-600',
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

      {/* 添加 */}
      <div className="flex items-center gap-1.5 border-b border-gray-100 px-3 py-2">
        <select
          value={addProjectId || data.projects[0]?.id || ''}
          onChange={(e) => setAddProjectId(e.target.value)}
          className="w-24 shrink-0 rounded-md border border-gray-300 px-1 py-1 text-xs outline-none focus:border-brand-500"
          title="添加到项目"
        >
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          placeholder="新增备忘…"
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs outline-none focus:border-brand-500"
        />
        <Button variant="subtle" className="!px-2 !py-1" onClick={add} disabled={!addText.trim()}>
          <Plus size={14} />
        </Button>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-auto p-2">
        {groups.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-gray-400">还没有备忘，上方添加一条</p>
        ) : (
          groups.map((g) => (
            <div key={g.id} className="mb-2">
              <div className="px-1 pb-1 text-[11px] font-medium text-gray-400">{g.name}</div>
              <div className="flex flex-col gap-1">
                {g.memos.map((m) => {
                  const alarm = m.urgent && !m.done;
                  return (
                    <div
                      key={m.id}
                      className={cx(
                        'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs',
                        alarm
                          ? 'memo-shake border-rose-300 bg-rose-50'
                          : 'border-gray-200 bg-surface',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={m.done}
                        onChange={() => toggleDone(m.id)}
                        className="shrink-0"
                      />
                      <span
                        className={cx(
                          'min-w-0 flex-1 break-words',
                          m.done ? 'text-gray-400 line-through' : alarm ? 'text-rose-700' : 'text-gray-700',
                        )}
                      >
                        {m.text}
                      </span>
                      <button
                        onClick={() => toggleUrgent(m.id)}
                        title={m.urgent ? '取消紧急' : '标记紧急'}
                        className={cx(
                          'shrink-0 rounded p-0.5',
                          m.urgent ? 'text-rose-600' : 'text-gray-300 hover:text-gray-500',
                        )}
                      >
                        <AlertTriangle size={13} />
                      </button>
                      <button
                        onClick={() => del(m.id)}
                        title="删除"
                        className="shrink-0 rounded p-0.5 text-gray-300 hover:text-rose-600"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

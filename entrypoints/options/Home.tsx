import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { browser } from 'wxt/browser';
import { Check, Palette, Pencil, Plus, Settings2, Trash2, Wand2, X } from 'lucide-react';
import { Button, Modal, cx } from '@/components/ui';
import { useDialog } from '@/components/Dialog';
import type { DashAppearance, DashWidget, DashWidgetType, VaultData } from '@/lib/types';
import {
  GAP,
  GRID_COLS,
  ROW_HEIGHT,
  appearanceBackground,
  applyLayoutToWidgets,
  baseLayout,
  layoutForCols,
  minWH,
  newBoard,
  newDashWidget,
  normAppearance,
  normDashboard,
  normWidget,
  toStoredBoards,
  type NormBoard,
} from '@/lib/dashboard';
import { applyChange, colsForWidth, flowPack, layoutRows, placeNew, type GridItem } from '@/lib/grid-engine';
import { BACKUP_SNOOZE_MS, shouldRemindBackup } from '@/lib/backup';
import { BackupReminder } from './BackupGuard';
import { REGISTRY, WIDGET_DESC, WIDGET_ORDER, WidgetBody, widgetLabel } from './widgets/registry';
import { tileSurfaceStyle, type WidgetCtx } from './widgets/Tile';
import { ConfigModal } from './widgets/ConfigModal';
import { AppearancePanel } from './widgets/AppearancePanel';

interface DragState {
  id: string;
  mode: 'move' | 'resize';
  live: { left: number; top: number; w: number; h: number };
  preview: GridItem[];
}

export function Home({
  data,
  onUpdate,
  syncEnabled,
  onOpenExport,
  onOpenSettings,
  onOpenCnb,
  onCopy,
  onOpenLogin,
}: {
  data: VaultData;
  onUpdate: (recipe: (d: VaultData) => void) => Promise<void>;
  syncEnabled: boolean;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  onOpenCnb: () => void;
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (url: string, username: string, password: string, tenant?: string) => void;
}) {
  const { confirm, prompt } = useDialog();
  const [editing, setEditing] = useState(false);
  const [localActive, setLocalActive] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [configId, setConfigId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [width, setWidth] = useState(0);
  const [hostPermissionVersion, setHostPermissionVersion] = useState(0);
  const [portalTargets, setPortalTargets] = useState<{
    boardSwitcher: HTMLElement | null;
    boardActions: HTMLElement | null;
  }>({ boardSwitcher: null, boardActions: null });
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    setPortalTargets({
      boardSwitcher: document.getElementById('home-board-switcher-slot'),
      boardActions: document.getElementById('home-board-actions-slot'),
    });
  }, []);

  // 看板：把（可能旧版的）配置归一化为多看板视图。
  const { boards, activeBoardId } = useMemo(
    () => normDashboard(data.settings.dashboard),
    [data.settings.dashboard],
  );
  const activeId = localActive && boards.some((b) => b.id === localActive) ? localActive : activeBoardId;
  const board = boards.find((b) => b.id === activeId) ?? boards[0]!;
  const widgets = board.widgets;
  const appearance = normAppearance(board.appearance);

  // 响应式列数：窄屏由基准布局派生且只读（仅基准 4 列下可编辑落库）。
  // 用回调 ref 让网格挂载/卸载时正确接上 ResizeObserver（空看板→加卡时也能测宽）。
  const setGridEl = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el;
    roRef.current?.disconnect();
    if (el) {
      setWidth(el.clientWidth);
      const ro = new ResizeObserver((es) => setWidth(es[0]?.contentRect.width ?? el.clientWidth));
      ro.observe(el);
      roRef.current = ro;
    }
  }, []);
  const cols = width ? colsForWidth(width) : GRID_COLS;
  const canEdit = editing && cols === GRID_COLS;

  // 像素换算
  const cellW = width ? (width - GAP * (cols - 1)) / cols : 0;
  const pxLeft = (x: number) => x * (cellW + GAP);
  const pxTop = (y: number) => y * (ROW_HEIGHT + GAP);
  const pxW = (w: number) => w * cellW + (w - 1) * GAP;
  const pxH = (h: number) => h * ROW_HEIGHT + (h - 1) * GAP;

  // --- 持久化 ---------------------------------------------------------------
  const persist = (nextBoards: NormBoard[], nextActive = activeId) =>
    onUpdate((d) => {
      d.settings.dashboard = toStoredBoards(nextBoards, nextActive);
    });
  const updateBoard = (id: string, fn: (b: NormBoard) => NormBoard) =>
    persist(boards.map((b) => (b.id === id ? fn(b) : b)));
  const setWidgets = (next: NormBoard['widgets']) => updateBoard(board.id, (b) => ({ ...b, widgets: next }));
  const setAppearance = (a: DashAppearance) => updateBoard(board.id, (b) => ({ ...b, appearance: a }));

  const addWidget = (type: DashWidgetType) => {
    const wdg = normWidget(newDashWidget(type));
    const base = baseLayout(widgets);
    const placed = placeNew(base, wdg.w, wdg.h, GRID_COLS, wdg.id);
    setWidgets(applyLayoutToWidgets([...widgets, wdg], [...base, placed]));
    setShowAdd(false);
  };
  const removeWidget = (id: string) => setWidgets(widgets.filter((w) => w.id !== id));
  // 一键自动排版：按当前阅读顺序（上→下、左→右）紧凑回填，消除空隙，免去逐个手动调。
  const autoArrange = () => {
    if (!canEdit) return;
    const base = baseLayout(widgets);
    const ordered = [...base].sort((a, b) => a.y - b.y || a.x - b.x);
    const packed = flowPack(
      ordered.map((i) => ({ id: i.id, w: i.w, h: i.h })),
      GRID_COLS,
    );
    setWidgets(applyLayoutToWidgets(widgets, packed));
  };
  const updateConfig = (id: string, cfg: NonNullable<DashWidget['config']>) =>
    setWidgets(widgets.map((w) => (w.id === id ? { ...w, config: { ...w.config, ...cfg } } : w)));

  // --- 看板增删改 -----------------------------------------------------------
  const addBoard = async () => {
    const name = await prompt({ title: '新看板', message: '看板名称', placeholder: '如：运维 / 前端' });
    if (name == null) return;
    const b = newBoard(name.trim() || `看板 ${boards.length + 1}`);
    await persist([...boards, b], b.id);
    setLocalActive(b.id);
  };
  const renameBoard = async (id: string) => {
    const cur = boards.find((b) => b.id === id);
    const name = await prompt({ title: '重命名看板', defaultValue: cur?.name });
    if (name == null) return;
    updateBoard(id, (b) => ({ ...b, name: name.trim() || b.name }));
  };
  const deleteBoard = async (id: string) => {
    if (boards.length <= 1) return;
    const cur = boards.find((b) => b.id === id);
    if (!(await confirm({ message: `删除看板「${cur?.name}」及其卡片？`, danger: true }))) return;
    const next = boards.filter((b) => b.id !== id);
    const nextActive = next[0]!.id;
    await persist(next, nextActive);
    setLocalActive(nextActive);
  };

  // --- 拖拽：指针跟随 + 自动让位 + 边缘自动滚动（松手才落库）----------------
  const beginDrag = (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => {
    if (!canEdit || !width) return;
    e.preventDefault();
    e.stopPropagation();
    const base = baseLayout(widgets);
    const start = base.find((i) => i.id === id);
    const grid = gridRef.current;
    if (!start || !grid) return;
    const [minW, minH] = minWH(widgets.find((w) => w.id === id)!.type);
    const r0 = grid.getBoundingClientRect();
    const grabDX = e.clientX - r0.left - pxLeft(start.x);
    const grabDY = e.clientY - r0.top - pxTop(start.y);
    const ptr = { x: e.clientX, y: e.clientY };
    let latest = base;
    let raf = 0;

    const compute = () => {
      const g = gridRef.current;
      if (!g) return;
      const r = g.getBoundingClientRect();
      const cx = ptr.x - r.left;
      const cy = ptr.y - r.top;
      let rect: GridItem;
      let live: DragState['live'];
      if (mode === 'move') {
        const left = cx - grabDX;
        const top = cy - grabDY;
        const sx = Math.max(0, Math.min(GRID_COLS - start.w, Math.round(left / (cellW + GAP))));
        const sy = Math.max(0, Math.round(top / (ROW_HEIGHT + GAP)));
        rect = { id, x: sx, y: sy, w: start.w, h: start.h };
        live = { left, top, w: pxW(start.w), h: pxH(start.h) };
      } else {
        const left = pxLeft(start.x);
        const top = pxTop(start.y);
        const wpx = Math.max(cellW * 0.6, cx - left);
        const hpx = Math.max(ROW_HEIGHT * 0.6, cy - top);
        const sw = Math.max(minW, Math.min(GRID_COLS - start.x, Math.round((wpx + GAP) / (cellW + GAP))));
        const sh = Math.max(minH, Math.round((hpx + GAP) / (ROW_HEIGHT + GAP)));
        rect = { id, x: start.x, y: start.y, w: sw, h: sh };
        live = { left, top, w: wpx, h: hpx };
      }
      latest = applyChange(base, id, rect, GRID_COLS);
      setDrag({ id, mode, live, preview: latest });
    };

    const autoScroll = () => {
      const sc = scrollRef.current;
      if (sc) {
        const r = sc.getBoundingClientRect();
        const EDGE = 64;
        const SPEED = 16;
        let dy = 0;
        if (ptr.y < r.top + EDGE) dy = -SPEED;
        else if (ptr.y > r.bottom - EDGE) dy = SPEED;
        if (dy) {
          const before = sc.scrollTop;
          sc.scrollTop = Math.max(0, before + dy);
          if (sc.scrollTop !== before) compute();
        }
      }
      raf = requestAnimationFrame(autoScroll);
    };
    const onMove = (ev: PointerEvent) => {
      ptr.x = ev.clientX;
      ptr.y = ev.clientY;
      compute();
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDrag(null);
      setWidgets(applyLayoutToWidgets(widgets, latest));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    raf = requestAnimationFrame(autoScroll);
    setDrag({
      id,
      mode,
      live: { left: pxLeft(start.x), top: pxTop(start.y), w: pxW(start.w), h: pxH(start.h) },
      preview: base,
    });
  };

  // --- 上下文与布局 ---------------------------------------------------------
  const ctx: WidgetCtx = {
    onCopy,
    onOpenLogin,
    onOpenExport,
    onOpenSettings,
    onOpenCnb,
    onOpenTab: (url) => void browser.tabs.create({ url }).catch(() => {}),
    onToggleTodo: (id) =>
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
      }),
    onEnableWeather: () =>
      onUpdate((d) => {
        d.settings.weatherEnabled = true;
      }),
    weatherEnabled: data.settings.weatherEnabled === true,
    hostPermissionVersion,
  };

  const layout = drag ? drag.preview : layoutForCols(widgets, cols);
  const layoutById = new Map(layout.map((l) => [l.id, l]));
  const rows = layoutRows(layout);
  const contentH = (rows > 0 ? pxH(rows) : ROW_HEIGHT) + (canEdit ? ROW_HEIGHT + GAP : 0);
  const glass = tileSurfaceStyle(appearance);
  const bg = appearanceBackground(appearance);
  const configWidget = configId ? widgets.find((w) => w.id === configId) : null;
  const dragSnap = drag ? layoutById.get(drag.id) : null;
  const boardSwitcher = (
    <div
      className="no-scrollbar flex max-w-[280px] items-center gap-0.5 overflow-x-auto rounded-[9px] border border-gray-200 bg-gray-50 p-[3px]"
      aria-label="看板切换"
    >
      {boards.map((b) => (
        <div key={b.id} className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => setLocalActive(b.id)}
            onDoubleClick={() => editing && renameBoard(b.id)}
            className={cx(
              'rounded-md px-3 py-1 text-[12px] font-semibold transition-colors',
              b.id === activeId
                ? 'bg-surface text-gray-900 shadow-sm'
                : 'text-gray-400 hover:text-gray-600',
            )}
            title={editing ? '双击重命名' : undefined}
          >
            {b.name}
          </button>
          {editing && b.id === activeId && boards.length > 1 && (
            <button
              type="button"
              onClick={() => deleteBoard(b.id)}
              title="删除看板"
              className="ml-0.5 rounded p-0.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
      {editing && (
        <button
          type="button"
          onClick={addBoard}
          title="新建看板"
          className="flex w-7 shrink-0 items-center justify-center rounded-md py-1 text-gray-400 hover:text-gray-600"
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  );
  const boardActions = (
    <>
      {editing && (
        <>
          <Button variant="outline" className="h-9 whitespace-nowrap" onClick={() => setShowAdd(true)}>
            <Plus size={15} /> 添加磁贴
          </Button>
          <Button variant="outline" className="h-9 whitespace-nowrap" onClick={() => setShowAppearance(true)}>
            <Palette size={15} /> 外观
          </Button>
          <Button
            variant="outline"
            className="h-9 whitespace-nowrap"
            onClick={autoArrange}
            disabled={!canEdit}
            title="按当前顺序紧凑回填，消除空隙"
          >
            <Wand2 size={15} /> 自动排版
          </Button>
        </>
      )}
      <Button
        variant={editing ? 'primary' : 'outline'}
        className="h-9 whitespace-nowrap"
        onClick={() => setEditing((e) => !e)}
      >
        {editing ? <Check size={15} /> : <Pencil size={15} />} {editing ? '完成' : '编辑看板'}
      </Button>
    </>
  );

  return (
    <>
      {portalTargets.boardSwitcher && createPortal(boardSwitcher, portalTargets.boardSwitcher)}
      {portalTargets.boardActions && createPortal(boardActions, portalTargets.boardActions)}

      <div
        ref={scrollRef}
        className={cx('no-scrollbar flex-1 overflow-auto p-6', drag && 'select-none')}
        style={bg ? { background: bg } : undefined}
      >
        {shouldRemindBackup(
          {
            syncEnabled,
            projectCount: data.projects.length,
            lastBackupAt: data.settings.lastBackupAt,
            snoozeUntil: data.settings.backupSnoozeUntil,
          },
          Date.now(),
        ) && (
          <BackupReminder
            onExport={onOpenExport}
            onEnableSync={onOpenSettings}
            onSnooze={() =>
              onUpdate((d) => {
                d.settings.backupSnoozeUntil = Date.now() + BACKUP_SNOOZE_MS;
              })
            }
          />
        )}

        {editing && cols !== GRID_COLS && (
          <p className="mb-3 inline-block rounded-lg bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
            当前为窄屏自适应视图（只读）。请在更宽的窗口下编辑布局。
          </p>
        )}
        {canEdit && (
          <p className="mb-3 inline-block rounded-lg bg-black/5 px-2.5 py-1 text-xs text-gray-500 backdrop-blur">
            编辑模式：拖动磁贴移动、拖右下角手柄改变大小；其它磁贴会自动让位。
          </p>
        )}

        {widgets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-300 bg-surface/60 py-16 text-center text-sm text-gray-400 backdrop-blur">
            这个看板还没有磁贴。点右上角「{editing ? '添加磁贴' : '编辑看板'}」开始。
          </p>
        ) : (
          <div ref={setGridEl} className="relative w-full" style={{ height: contentH }}>
            {/* 拖拽时的落点虚位 */}
            {drag && dragSnap && (
              <div
                className="pointer-events-none absolute rounded-2xl border-2 border-dashed border-brand-400/70 bg-brand-400/5"
                style={{
                  left: 0,
                  top: 0,
                  width: pxW(dragSnap.w),
                  height: pxH(dragSnap.h),
                  transform: `translate(${pxLeft(dragSnap.x)}px, ${pxTop(dragSnap.y)}px)`,
                  transition: 'transform .12s ease',
                }}
              />
            )}
            {width > 0 &&
              widgets.map((w) => {
                const l = layoutById.get(w.id);
                if (!l) return null;
                const dragged = drag?.id === w.id;
                const left = dragged ? drag!.live.left : pxLeft(l.x);
                const top = dragged ? drag!.live.top : pxTop(l.y);
                const wpx = dragged ? drag!.live.w : pxW(l.w);
                const hpx = dragged ? drag!.live.h : pxH(l.h);
                const showConfig = true;
                const showActions = canEdit || showConfig;
                const privacyMode = w.config?.privacyMode === 'soft' || w.config?.privacyMode === 'strong'
                  ? w.config.privacyMode
                  : 'off';
                return (
                  <div
                    key={w.id}
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: wpx,
                      height: hpx,
                      transform: `translate(${left}px, ${top}px)`,
                      transition: dragged ? 'none' : 'transform .18s ease, width .18s ease, height .18s ease',
                      zIndex: dragged ? 30 : undefined,
                    }}
                  >
                    <div
                      onPointerDown={canEdit ? (e) => beginDrag(e, w.id, 'move') : undefined}
                      style={{ ...glass, touchAction: canEdit ? 'none' : undefined }}
                      tabIndex={privacyMode !== 'off' && !canEdit ? 0 : undefined}
                      className={cx(
                        'tile-glass relative flex h-full flex-col overflow-hidden',
                        privacyMode !== 'off' && 'privacy-tile',
                        privacyMode === 'soft' && 'privacy-soft',
                        privacyMode === 'strong' && 'privacy-strong',
                        canEdit && 'cursor-move ring-1 ring-brand-300/60',
                        dragged && 'scale-[1.01] shadow-2xl ring-2 ring-brand-400',
                      )}
                    >
                      {showActions && (
                        <div className="absolute right-1.5 top-1.5 z-20 flex items-center gap-1">
                          {showConfig && (
                            <button
                              type="button"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfigId(w.id);
                              }}
                              title="配置磁贴"
                              aria-label="配置磁贴"
                              className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[7px] border border-gray-200 bg-surface text-gray-500 shadow-sm hover:text-gray-800"
                            >
                              <Settings2 size={13} />
                            </button>
                          )}
                          {canEdit && (
                            <button
                              type="button"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeWidget(w.id);
                              }}
                              title="移除磁贴"
                              aria-label="移除磁贴"
                              className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[7px] bg-dangerbg text-danger hover:brightness-95"
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      )}
                      {canEdit && (
                        <>
                          <button
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              beginDrag(e, w.id, 'resize');
                            }}
                            title="拖动调整大小"
                            style={{ touchAction: 'none' }}
                            className="absolute bottom-1.5 right-1.5 z-10 flex h-[18px] w-6 cursor-nwse-resize items-center justify-center rounded-md border border-gray-200 bg-surface text-gray-400 hover:text-brand-600"
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                              <path
                                d="M9 4H4v5M15 20h5v-5M4 4l6 6M20 20l-6-6"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        </>
                      )}
                      <div
                        className={cx(
                          'privacy-content no-scrollbar min-h-0 flex-1 overflow-auto p-4',
                          showConfig && !canEdit && 'pr-10',
                          canEdit && 'pr-[4.5rem]',
                          canEdit && 'pointer-events-none select-none',
                        )}
                      >
                        <WidgetBody
                          widget={w}
                          data={data}
                          editing={editing}
                          onConfig={(cfg) => updateConfig(w.id, cfg)}
                          ctx={ctx}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {showAdd && (
        <Modal title="添加磁贴" onClose={() => setShowAdd(false)} wide>
          <div className="mb-3 text-[11.5px] text-gray-400">
            选择一种磁贴添加到当前看板，之后可拖拽调整位置与大小。
          </div>
          <div className="grid grid-cols-2 gap-3">
            {WIDGET_ORDER.map((t) => {
              const Icon = REGISTRY[t].Icon;
              return (
                <button
                  key={t}
                  onClick={() => addWidget(t)}
                  className="group flex items-start gap-3 rounded-xl border border-gray-200 bg-surface p-3 text-left transition hover:border-brand-500 hover:shadow-[0_6px_16px_-8px_rgba(20,26,40,.18)]"
                >
                  <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-prid">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{widgetLabel(t)}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-gray-400">
                      {WIDGET_DESC[t]}
                    </div>
                  </div>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-gray-50 text-brand-600">
                    <Plus size={14} />
                  </span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
      {configWidget && (
        <ConfigModal
          widget={configWidget}
          data={data}
          onClose={() => setConfigId(null)}
          onHostPermissionChange={() => setHostPermissionVersion((v) => v + 1)}
          onConfig={(cfg) => updateConfig(configWidget.id, cfg)}
        />
      )}
      {showAppearance && (
        <AppearancePanel
          appearance={board.appearance}
          onChange={setAppearance}
          onClose={() => setShowAppearance(false)}
        />
      )}
    </>
  );
}

/** 拖拽手柄的点阵图标。 */
function GripDots() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <circle cx="3" cy="2.5" r="1" />
      <circle cx="9" cy="2.5" r="1" />
      <circle cx="3" cy="6" r="1" />
      <circle cx="9" cy="6" r="1" />
      <circle cx="3" cy="9.5" r="1" />
      <circle cx="9" cy="9.5" r="1" />
    </svg>
  );
}

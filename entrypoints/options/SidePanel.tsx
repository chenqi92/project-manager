import { useEffect, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  FileText,
  StickyNote,
} from 'lucide-react';
import { cx } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import { AddMemo, MemoRow } from '@/components/MemoRow';
import { sortMemos } from '@/lib/memo';
import type { MemoItem, Project, ProjectDoc } from '@/lib/types';

// 右侧栏布局偏好：每设备本地保存（非加密、不随保险箱同步）。
const KEY = 'sidePanel';

type Tab = 'memo' | 'docs';

interface PanelState {
  /** 整栏收起为右边缘竖标签条 */
  collapsed: boolean;
  /** 展开时的面板宽度（px） */
  width: number;
  /** 当前展示的标签：待办 / 说明（一次只展示一个，各自占满，内容更多） */
  tab: Tab;
}

const DEFAULTS: PanelState = { collapsed: false, width: 380, tab: 'memo' };

const MIN_W = 280;
const MAX_W = 760;
const clampWidth = (w: number) =>
  Math.max(MIN_W, Math.min(w, MAX_W, Math.max(MIN_W, window.innerWidth - 360)));

export interface SidePanelProps {
  project: Project;
  onOpenDocs: () => void;
  onAddMemo: (text: string, dueAt: number | undefined, urgent: boolean) => void;
  onToggleMemoDone: (id: string) => void;
  onToggleMemoUrgent: (id: string) => void;
  onDeleteMemo: (id: string) => void;
}

export function SidePanel(props: SidePanelProps) {
  const { project } = props;
  const [st, setSt] = useState<PanelState>(DEFAULTS);
  const stRef = useRef(st);
  stRef.current = st;

  useEffect(() => {
    browser.storage.local
      .get(KEY)
      .then((r) => {
        const s = r[KEY] as Partial<PanelState> | undefined;
        if (s)
          setSt({
            collapsed: s.collapsed ?? DEFAULTS.collapsed,
            width: clampWidth(s.width ?? DEFAULTS.width),
            tab: s.tab === 'docs' ? 'docs' : 'memo',
          });
      })
      .catch(() => {});
  }, []);

  const patch = (p: Partial<PanelState>) => {
    const next = { ...stRef.current, ...p };
    stRef.current = next;
    setSt(next);
    browser.storage.local.set({ [KEY]: next }).catch(() => {});
  };

  const memos = sortMemos(project.memos ?? []);
  const pending = (project.memos ?? []).filter((m) => !m.done).length;
  const docs = project.docs ?? [];

  const startWidthDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const startW = stRef.current.width;
    let last = startW;
    const onMove = (ev: PointerEvent) => {
      // 手柄在面板左侧：往左拖（clientX 变小）→ 变宽。
      last = clampWidth(startW - (ev.clientX - sx));
      setSt((prev) => ({ ...prev, width: last }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      patch({ width: last });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 整栏收起 → 右边缘竖标签条：每个标签单独展开自己的内容。
  if (st.collapsed) {
    return (
      <div className="flex h-full shrink-0 flex-col gap-2 py-6 pr-6">
        <RailTab
          icon={<FileText size={14} />}
          label="说明文档"
          badge={docs.length > 0 ? docs.length : undefined}
          onClick={() => patch({ collapsed: false, tab: 'docs' })}
        />
        <RailTab
          icon={<StickyNote size={14} />}
          label="待办"
          badge={pending > 0 ? pending : undefined}
          onClick={() => patch({ collapsed: false, tab: 'memo' })}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full shrink-0 py-6 pr-6">
      {/* 宽度拖拽手柄 */}
      <div
        onPointerDown={startWidthDrag}
        title="拖拽改变宽度"
        className="-ml-1 w-2 shrink-0 cursor-col-resize touch-none rounded-full bg-transparent transition hover:bg-brand-200"
      />
      <div
        style={{ width: st.width }}
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[14px] border border-gray-200 bg-surface"
      >
        {/* 标签栏：说明文档 / 待办，一次只展示一个 */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2.5">
          <div className="flex flex-1 gap-0.5 rounded-[9px] border border-gray-200 bg-gray-50 p-[3px]">
            <TabBtn
              active={st.tab === 'docs'}
              onClick={() => patch({ tab: 'docs' })}
              label="说明文档"
              badge={docs.length}
            />
            <TabBtn
              active={st.tab === 'memo'}
              onClick={() => patch({ tab: 'memo' })}
              label="待办"
              badge={pending}
            />
          </div>
          <button
            onClick={() => patch({ collapsed: true })}
            title="收起到右侧边"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-surface text-gray-500 hover:bg-gray-50"
          >
            <ChevronsRight size={15} />
          </button>
        </div>

        {st.tab === 'memo' ? (
          <MemoPane
            memos={memos}
            onAdd={props.onAddMemo}
            onToggleDone={props.onToggleMemoDone}
            onToggleUrgent={props.onToggleMemoUrgent}
            onDelete={props.onDeleteMemo}
          />
        ) : (
          <DocsPane docs={docs} projectId={project.id} onOpen={props.onOpenDocs} />
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-[12.5px] font-semibold transition-colors',
        active ? 'bg-surface text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600',
      )}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          className={cx(
            'rounded-full px-1.5 text-[10px]',
            active ? 'bg-pribg text-prid' : 'bg-gray-200 text-gray-500',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function RailTab({
  icon,
  label,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`展开${label}`}
      className="flex w-[34px] flex-col items-center gap-1.5 rounded-[11px] border border-gray-200 bg-surface py-3 text-gray-500 shadow-[0_1px_3px_rgba(16,24,40,.06)] hover:text-brand-600"
    >
      {icon}
      <span className="text-[11.5px] font-semibold tracking-wide [writing-mode:vertical-rl]">
        {label}
      </span>
      {badge !== undefined && (
        <span className="rounded-full bg-brand-50 px-1 text-[10px] font-semibold text-brand-700">
          {badge}
        </span>
      )}
    </button>
  );
}

function MemoPane({
  memos,
  onAdd,
  onToggleDone,
  onToggleUrgent,
  onDelete,
}: {
  memos: MemoItem[];
  onAdd: (text: string, dueAt: number | undefined, urgent: boolean) => void;
  onToggleDone: (id: string) => void;
  onToggleUrgent: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-gray-100 p-2">
        <AddMemo onAdd={onAdd} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {memos.length === 0 ? (
          <p className="py-6 text-center text-xs text-gray-400">还没有待办，上方添加</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {memos.map((m) => (
              <MemoRow
                key={m.id}
                memo={m}
                onToggleDone={() => onToggleDone(m.id)}
                onToggleUrgent={() => onToggleUrgent(m.id)}
                onDelete={() => onDelete(m.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DocsPane({
  docs,
  projectId,
  onOpen,
}: {
  docs: ProjectDoc[];
  projectId: string;
  onOpen: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    setActiveId(null);
  }, [projectId]);
  const active = docs.find((d) => d.id === activeId) ?? docs[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-gray-100 px-1.5 py-1.5">
        {docs.length > 1 ? (
          <DocsTabs docs={docs} activeId={active?.id ?? null} onSelect={setActiveId} />
        ) : (
          <div className="flex-1" />
        )}
        <button
          onClick={onOpen}
          className="shrink-0 text-xs text-brand-600 hover:text-brand-700"
        >
          {docs.length ? '编辑 / 管理' : '新建文档'}
        </button>
      </div>
      {docs.length === 0 ? (
        <button
          onClick={onOpen}
          className="m-3 rounded-lg border border-dashed border-gray-200 py-8 text-center text-xs text-gray-400 hover:border-brand-300 hover:text-brand-600"
        >
          还没有说明文档，点此新建
        </button>
      ) : active ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <Markdown source={active.content} />
        </div>
      ) : null}
    </div>
  );
}

// 单行横向标签 + 左右箭头：溢出时箭头变可用；面板拖宽/拖窄时用 ResizeObserver 实时重判，
// 即「手动拖动时自动变换」。
function DocsTabs({
  docs,
  activeId,
  onSelect,
}: {
  docs: ProjectDoc[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ov, setOv] = useState({ left: false, right: false });

  const recompute = () => {
    const el = ref.current;
    if (!el) return;
    setOv({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  };

  useEffect(() => {
    recompute();
  }, [docs.length]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !activeId) return;
    const node = el.querySelector(`[data-doc="${activeId}"]`) as HTMLElement | null;
    node?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeId]);

  const by = (dx: number) => ref.current?.scrollBy({ left: dx, behavior: 'smooth' });

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <button
        onClick={() => by(-140)}
        disabled={!ov.left}
        className={cx(
          'shrink-0 rounded p-0.5',
          ov.left ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-200',
        )}
      >
        <ChevronLeft size={15} />
      </button>
      <div
        ref={ref}
        onScroll={recompute}
        className="flex flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {docs.map((d) => (
          <button
            key={d.id}
            data-doc={d.id}
            onClick={() => onSelect(d.id)}
            title={d.title}
            className={cx(
              'max-w-[140px] shrink-0 truncate rounded-md px-2 py-1 text-xs',
              activeId === d.id ? 'bg-pribg text-prid' : 'text-gray-500 hover:bg-gray-100',
            )}
          >
            {d.title}
          </button>
        ))}
      </div>
      <button
        onClick={() => by(140)}
        disabled={!ov.right}
        className={cx(
          'shrink-0 rounded p-0.5',
          ov.right ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-200',
        )}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

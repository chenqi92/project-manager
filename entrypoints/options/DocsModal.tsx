import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  FileText,
  List,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button, Input, cx } from '@/components/ui';
import { Markdown, type TocItem } from '@/components/Markdown';
import { useDialog } from '@/components/Dialog';
import type { ProjectDoc } from '@/lib/types';
import { newDoc } from '@/lib/vault-ops';

type DocMode = 'read' | 'split' | 'source';
type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export function DocsModal({
  projectName,
  docs,
  onClose,
  onChange,
}: {
  projectName: string;
  docs: ProjectDoc[];
  onClose: () => void;
  onChange: (docs: ProjectDoc[]) => void | Promise<void>;
}) {
  const [list, setList] = useState<ProjectDoc[]>(docs);
  const [activeId, setActiveId] = useState<string | null>(docs[0]?.id ?? null);
  const [mode, setMode] = useState<DocMode>('read');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [showToc, setShowToc] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [hits, setHits] = useState(0);
  const [activeHit, setActiveHit] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const readScrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<ProjectDoc[]>(docs);
  const onChangeRef = useRef(onChange);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);
  // 串行链：把实际写入排队，避免防抖保存与 immediate 保存并发写 vault（不依赖外部串行化）。
  const flushChain = useRef<Promise<void>>(Promise.resolve());
  const { confirm } = useDialog();

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    listRef.current = list;
  }, [list]);

  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        // 卸载时把未保存的防抖编辑排到串行链尾，避免与在途写入并发。
        flushChain.current = flushChain.current
          .then(() => onChangeRef.current(listRef.current))
          .catch(() => {});
      }
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && mode === 'read') {
        e.preventDefault();
        setShowSearch(true);
        return;
      }
      if (e.key === 'Escape') {
        if (showSearch) {
          setShowSearch(false);
          setSearchTerm('');
        } else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, showSearch, mode]);

  // 切换文档/退出阅读：清掉搜索与目录态，避免高亮串到别的文档
  useEffect(() => {
    setShowSearch(false);
    setSearchTerm('');
    setActiveHit(0);
    setHits(0);
    setToc([]);
  }, [activeId]);

  const nextHit = () => {
    if (hits) setActiveHit((i) => (i + 1) % hits);
  };
  const prevHit = () => {
    if (hits) setActiveHit((i) => (i - 1 + hits) % hits);
  };
  const jumpTo = (id: string) => {
    const target = readScrollRef.current?.querySelector(`#${CSS.escape(id)}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const active = list.find((d) => d.id === activeId) ?? null;
  const flush = (next: ProjectDoc[] = listRef.current): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const seq = ++saveSeq.current;
    setSaveState('saving');
    setSaveError(null);
    flushChain.current = flushChain.current.then(async () => {
      try {
        await onChangeRef.current(next);
        if (seq === saveSeq.current) setSaveState('saved');
      } catch (e) {
        if (seq === saveSeq.current) {
          setSaveState('error');
          setSaveError(e instanceof Error ? e.message : String(e));
        }
      }
    });
    return flushChain.current;
  };
  const scheduleSave = (next: ProjectDoc[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('pending');
    setSaveError(null);
    saveTimer.current = setTimeout(() => {
      void flush(next);
    }, 600);
  };
  const commit = (next: ProjectDoc[], opts: { immediate?: boolean } = {}) => {
    setList(next);
    listRef.current = next;
    if (opts.immediate) void flush(next);
    else scheduleSave(next);
  };

  const addDoc = () => {
    const d = newDoc({ title: '未命名文档', content: '# 标题\n\n在这里写项目说明，支持代码块与 mermaid 流程图。' });
    commit([...list, d], { immediate: true });
    setActiveId(d.id);
    setMode('split');
  };
  const delDoc = async (id: string) => {
    if (!(await confirm({ message: '删除该文档？', danger: true }))) return;
    const next = list.filter((d) => d.id !== id);
    commit(next, { immediate: true });
    if (activeId === id) {
      setActiveId(next[0]?.id ?? null);
      setMode('read');
    }
  };
  const updateActive = (patch: Partial<ProjectDoc>) => {
    if (!active) return;
    commit(list.map((d) => (d.id === active.id ? { ...d, ...patch, updatedAt: Date.now() } : d)));
  };
  const importFiles = async (files: FileList) => {
    const added: ProjectDoc[] = [];
    for (const f of Array.from(files)) {
      try {
        const text = await f.text();
        added.push(newDoc({ title: f.name.replace(/\.(md|markdown|txt)$/i, ''), content: text }));
      } catch {
        // 单个文件读取失败时跳过，不中断其余文件的导入。
      }
    }
    if (added.length) {
      commit([...list, ...added], { immediate: true });
      setActiveId(added[0]!.id);
      setMode('read');
    }
  };

  const saveLabel =
    saveState === 'pending'
      ? '待保存'
      : saveState === 'saving'
        ? '保存中...'
        : saveState === 'error'
          ? `保存失败：${saveError ?? ''}`
          : '已保存';

  return (
    <div className="fixed inset-0 z-50 flex bg-black/20" onMouseDown={onClose}>
      <div
        className="drawer-in-left flex h-full w-full flex-col overflow-hidden bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
            <FileText size={18} className="text-brand-600" /> 项目说明 · {projectName}
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-100" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 文档列表 */}
          <div className="flex w-52 shrink-0 flex-col border-r border-gray-100 p-2">
            <div className="mb-2 flex gap-1">
              <Button variant="subtle" className="flex-1 !px-2 !py-1 text-xs" onClick={addDoc}>
                <Plus size={13} /> 新建
              </Button>
              <Button variant="subtle" className="flex-1 !px-2 !py-1 text-xs" onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> 导入
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) importFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="flex-1 overflow-auto">
              {list.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-gray-400">还没有文档</p>
              ) : (
                list.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => {
                      setActiveId(d.id);
                      setMode('read');
                    }}
                    className={cx(
                      'mb-0.5 flex w-full items-center gap-1.5 truncate rounded-lg px-2 py-1.5 text-left text-sm',
                      activeId === d.id ? 'bg-pribg text-prid' : 'hover:bg-gray-100',
                    )}
                  >
                    <FileText size={13} className="shrink-0 text-gray-400" />
                    <span className="truncate">{d.title}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 右侧：阅读 / 编辑 */}
          <div className="flex min-w-0 flex-1 flex-col p-4">
            {!active ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-gray-400">
                <FileText size={32} />
                <p className="text-sm">新建或导入一个 Markdown 文档</p>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2">
                  {mode === 'read' ? (
                    <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-gray-900">{active.title}</h3>
                  ) : (
                    <Input
                      value={active.title}
                      onChange={(e) => updateActive({ title: e.target.value })}
                      placeholder="文档标题"
                      className="min-w-0 flex-1"
                    />
                  )}
                  <span
                    className={cx(
                      'shrink-0 text-xs',
                      saveState === 'error' ? 'text-rose-600' : 'text-gray-400',
                    )}
                  >
                    {saveLabel}
                  </span>
                  {mode === 'read' && (
                    <>
                      <button
                        type="button"
                        title="文档内搜索 (Ctrl+F)"
                        onClick={() => setShowSearch((s) => !s)}
                        className={cx(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                          showSearch ? 'bg-pribg text-prid' : 'text-gray-500 hover:bg-gray-100',
                        )}
                      >
                        <Search size={15} />
                      </button>
                      <button
                        type="button"
                        title={showToc ? '隐藏目录' : '显示目录'}
                        onClick={() => setShowToc((s) => !s)}
                        className={cx(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                          showToc ? 'bg-pribg text-prid' : 'text-gray-500 hover:bg-gray-100',
                        )}
                      >
                        <List size={15} />
                      </button>
                    </>
                  )}
                  <div className="flex shrink-0 rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                    <ModeButton active={mode === 'read'} onClick={() => setMode('read')}>
                      <Eye size={14} /> 阅读
                    </ModeButton>
                    <ModeButton active={mode === 'split'} onClick={() => setMode('split')}>
                      <Pencil size={14} /> 分屏
                    </ModeButton>
                    <ModeButton active={mode === 'source'} onClick={() => setMode('source')}>
                      源码
                    </ModeButton>
                  </div>
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    title="删除"
                    onClick={() => delDoc(active.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
                {mode === 'read' ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    {showSearch && (
                      <div className="mb-2 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5">
                        <Search size={14} className="shrink-0 text-gray-400" />
                        <input
                          autoFocus
                          value={searchTerm}
                          onChange={(e) => {
                            setSearchTerm(e.target.value);
                            setActiveHit(0);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (e.shiftKey) prevHit();
                              else nextHit();
                            }
                          }}
                          placeholder="在本文档内搜索"
                          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                        />
                        <span className="shrink-0 text-xs text-gray-400">
                          {searchTerm ? `${hits ? activeHit + 1 : 0}/${hits}` : ''}
                        </span>
                        <button
                          type="button"
                          title="上一个 (Shift+Enter)"
                          onClick={prevHit}
                          disabled={!hits}
                          className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-40"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          title="下一个 (Enter)"
                          onClick={nextHit}
                          disabled={!hits}
                          className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-40"
                        >
                          <ChevronDown size={14} />
                        </button>
                        <button
                          type="button"
                          title="关闭搜索"
                          onClick={() => {
                            setShowSearch(false);
                            setSearchTerm('');
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-200"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    <div className="flex min-h-0 flex-1 gap-3">
                      <div
                        ref={readScrollRef}
                        className="min-h-0 flex-1 overflow-auto rounded-xl border border-gray-200 p-4"
                      >
                        <Markdown
                          source={active.content}
                          onToc={setToc}
                          searchTerm={searchTerm}
                          searchActive={activeHit}
                          onSearchHits={setHits}
                        />
                      </div>
                      {showToc && toc.length > 1 && (
                        <nav className="hidden w-52 shrink-0 overflow-auto rounded-xl border border-gray-200 bg-gray-50/50 p-2 lg:block">
                          <div className="mb-1 px-1 text-xs font-medium text-gray-400">目录</div>
                          {toc.map((t, i) => (
                            <button
                              key={`${t.id}-${i}`}
                              type="button"
                              onClick={() => jumpTo(t.id)}
                              style={{ paddingLeft: `${(Math.max(t.level, 1) - 1) * 12 + 8}px` }}
                              className="block w-full truncate rounded py-1 pr-2 text-left text-xs text-gray-600 hover:bg-gray-100 hover:text-brand-700"
                              title={t.text}
                            >
                              {t.text}
                            </button>
                          ))}
                        </nav>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    className={cx(
                      'grid min-h-0 flex-1 gap-3',
                      mode === 'split' ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1',
                    )}
                  >
                    <textarea
                      value={active.content}
                      onChange={(e) => updateActive({ content: e.target.value })}
                      className="resize-none overflow-auto rounded-xl border border-gray-300 p-3 font-mono text-xs leading-relaxed outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                      placeholder="# Markdown 源文&#10;&#10;```mermaid&#10;graph TD; A-->B;&#10;```"
                    />
                    {mode === 'split' && (
                      <div className="overflow-auto rounded-xl border border-gray-200 p-3">
                        <Markdown source={active.content} />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex h-7 items-center gap-1 rounded-md px-2 text-xs',
        active ? 'bg-surface text-brand-700 shadow-sm' : 'text-gray-500 hover:text-gray-800',
      )}
    >
      {children}
    </button>
  );
}

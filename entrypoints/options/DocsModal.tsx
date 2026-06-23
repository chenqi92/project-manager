import { useEffect, useRef, useState } from 'react';
import { Eye, FileText, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { Button, Input, cx } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import { useDialog } from '@/components/Dialog';
import type { ProjectDoc } from '@/lib/types';
import { newDoc } from '@/lib/vault-ops';

export function DocsModal({
  projectName,
  docs,
  onClose,
  onChange,
}: {
  projectName: string;
  docs: ProjectDoc[];
  onClose: () => void;
  onChange: (docs: ProjectDoc[]) => void;
}) {
  const [list, setList] = useState<ProjectDoc[]>(docs);
  const [activeId, setActiveId] = useState<string | null>(docs[0]?.id ?? null);
  const [editing, setEditing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { confirm } = useDialog();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const active = list.find((d) => d.id === activeId) ?? null;
  const commit = (next: ProjectDoc[]) => {
    setList(next);
    onChange(next);
  };

  const addDoc = () => {
    const d = newDoc({ title: '未命名文档', content: '# 标题\n\n在这里写项目说明，支持代码块与 mermaid 流程图。' });
    commit([...list, d]);
    setActiveId(d.id);
    setEditing(true);
  };
  const delDoc = async (id: string) => {
    if (!(await confirm({ message: '删除该文档？', danger: true }))) return;
    const next = list.filter((d) => d.id !== id);
    commit(next);
    if (activeId === id) {
      setActiveId(next[0]?.id ?? null);
      setEditing(false);
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
      commit([...list, ...added]);
      setActiveId(added[0]!.id);
      setEditing(false);
    }
  };

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
                      setEditing(false);
                    }}
                    className={cx(
                      'mb-0.5 flex w-full items-center gap-1.5 truncate rounded-lg px-2 py-1.5 text-left text-sm',
                      activeId === d.id ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-100',
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
            ) : editing ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <Input
                    value={active.title}
                    onChange={(e) => updateActive({ title: e.target.value })}
                    placeholder="文档标题"
                    className="min-w-0 flex-1"
                  />
                  <Button
                    variant="subtle"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => setEditing(false)}
                  >
                    <Eye size={15} /> 预览
                  </Button>
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    title="删除"
                    onClick={() => delDoc(active.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
                  <textarea
                    value={active.content}
                    onChange={(e) => updateActive({ content: e.target.value })}
                    className="resize-none overflow-auto rounded-xl border border-gray-300 p-3 font-mono text-xs leading-relaxed outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    placeholder="# Markdown 源文&#10;&#10;```mermaid&#10;graph TD; A-->B;&#10;```"
                  />
                  <div className="overflow-auto rounded-xl border border-gray-200 p-3">
                    <Markdown source={active.content} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-gray-900">{active.title}</h3>
                  <Button
                    variant="subtle"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => setEditing(true)}
                  >
                    <Pencil size={15} /> 编辑
                  </Button>
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    title="删除"
                    onClick={() => delDoc(active.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-gray-200 p-4">
                  <Markdown source={active.content} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

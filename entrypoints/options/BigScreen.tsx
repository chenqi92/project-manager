import { useEffect, useState, type ReactNode } from 'react';
import {
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Layers,
  Link as LinkIcon,
  StickyNote,
  Users,
  X,
} from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { MemoRow } from '@/components/MemoRow';
import { cx } from '@/components/ui';
import type { Project } from '@/lib/types';
import { sortMemos } from '@/lib/memo';
import { ENV_KIND_COLORS, ENV_KIND_LABELS, envTagName, gitCloneCommand, linkUrls } from '@/lib/vault-ops';

/** 项目大屏展示：链接 / 账号 / 备忘 / 说明文档，密码默认隐藏（可切换）。 */
export function BigScreen({ project, onClose }: { project: Project; onClose: () => void }) {
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const envCount = project.environments.length;
  const acctCount = project.environments.reduce(
    (n, e) => n + e.links.reduce((m, l) => m + l.accounts.length, 0),
    0,
  );
  const memos = sortMemos(project.memos ?? []);
  const pending = (project.memos ?? []).filter((m) => !m.done).length;
  const docs = project.docs ?? [];

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-gray-50">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-200 bg-surface/90 px-8 py-4 backdrop-blur">
        <Layers className="text-brand-600" size={24} />
        <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
        {(project.tags ?? []).map((t) => (
          <span key={t} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
            {t}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowPw((s) => !s)}
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            {showPw ? <EyeOff size={15} /> : <Eye size={15} />} {showPw ? '隐藏密码' : '显示密码'}
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            <X size={15} /> 退出 (Esc)
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-8 py-6">
        <div className="mb-6 flex flex-wrap gap-3">
          <Stat icon={<Layers size={18} />} label="环境" value={envCount} />
          <Stat icon={<Users size={18} />} label="账号" value={acctCount} />
          <Stat icon={<StickyNote size={18} />} label="待办" value={pending} accent={pending > 0} />
          <Stat icon={<FileText size={18} />} label="文档" value={docs.length} />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <section className="space-y-4 xl:col-span-2">
            <SectionTitle icon={<LinkIcon size={18} />}>链接与账号</SectionTitle>
            {project.environments.length === 0 ? (
              <Empty>还没有环境</Empty>
            ) : (
              project.environments.map((env) => {
                const tagName = envTagName(env.kind, env.name);
                return (
                <div key={env.id} className="rounded-2xl border border-gray-200 bg-surface p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <span className={cx('rounded px-2 py-0.5 text-xs font-medium', ENV_KIND_COLORS[env.kind])}>
                      {ENV_KIND_LABELS[env.kind]}
                    </span>
                    {tagName !== ENV_KIND_LABELS[env.kind] && <span className="font-semibold">{tagName}</span>}
                  </div>
                  {(env.gitRepos ?? []).length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {(env.gitRepos ?? []).map((r) => (
                        <span
                          key={r.id}
                          className="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-600"
                        >
                          <GitBranch size={11} className="shrink-0 text-gray-400" />
                          <span className="max-w-[280px] truncate font-mono">{gitCloneCommand(r)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="grid gap-3 md:grid-cols-2">
                    {env.links.length === 0 && <p className="text-xs text-gray-400">无链接</p>}
                    {env.links.map((link) => (
                      <div key={link.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                        <div className="flex items-center gap-1.5">
                          <LinkIcon size={14} className="shrink-0 text-gray-400" />
                          <span className="truncate font-medium">{link.name}</span>
                        </div>
                        {linkUrls(link).map((u) => (
                          <a
                            key={u}
                            href={u}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="mt-1 flex items-center gap-1 truncate text-xs text-brand-600 hover:underline"
                          >
                            <span className="truncate">{u}</span>
                            <ExternalLink size={11} className="shrink-0" />
                          </a>
                        ))}
                        {(link.gitRepos ?? []).map((r) => (
                          <div
                            key={r.id}
                            className="mt-1 flex items-center gap-1 truncate text-[11px] text-gray-500"
                          >
                            <GitBranch size={11} className="shrink-0" />
                            <span className="truncate font-mono">{gitCloneCommand(r)}</span>
                          </div>
                        ))}
                        {(link.customFields ?? []).length > 0 && (
                          <div className="mt-1 inline-flex rounded-md bg-surface px-1.5 py-0.5 text-[10.5px] font-semibold text-gray-500">
                            {(link.customFields ?? []).length} 项补充信息
                          </div>
                        )}
                        {link.accounts.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {link.accounts.map((a) => (
                              <div
                                key={a.id}
                                className="flex items-center justify-between gap-2 rounded-lg bg-surface px-2 py-1 text-xs"
                              >
                                <span className="truncate text-gray-700">
                                  {a.label || '默认'}：{a.username || '—'}
                                  {(a.customFields ?? []).length > 0 && (
                                    <span className="ml-1 text-[10px] text-gray-400">
                                      +{(a.customFields ?? []).length} 信息
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 font-mono text-gray-500">
                                  {showPw ? a.password : '••••••'}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                );
              })
            )}
          </section>

          <section className="space-y-6">
            <div>
              <SectionTitle icon={<StickyNote size={18} />}>
                待办{pending > 0 ? `（${pending}）` : ''}
              </SectionTitle>
              {memos.length === 0 ? (
                <Empty>还没有待办</Empty>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {memos.map((m) => (
                    <MemoRow key={m.id} memo={m} />
                  ))}
                </div>
              )}
            </div>
            <div>
              <SectionTitle icon={<FileText size={18} />}>说明文档</SectionTitle>
              {docs.length === 0 ? (
                <Empty>还没有文档</Empty>
              ) : (
                <div className="space-y-4">
                  {docs.map((d) => (
                    <div key={d.id} className="rounded-2xl border border-gray-200 bg-surface p-4">
                      <h3 className="mb-2 text-base font-semibold text-gray-900">{d.title}</h3>
                      <Markdown source={d.content} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  accent,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div
      className={cx(
        'flex items-center gap-2.5 rounded-2xl border px-4 py-2.5',
        accent ? 'border-rose-200 bg-rose-50' : 'border-gray-200 bg-surface',
      )}
    >
      <span className={accent ? 'text-rose-600' : 'text-brand-600'}>{icon}</span>
      <div>
        <div className={cx('text-xl font-bold leading-none', accent ? 'text-rose-800' : 'text-gray-900')}>
          {value}
        </div>
        <div className="mt-0.5 text-[11px] text-gray-500">{label}</div>
      </div>
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-800">
      {icon}
      {children}
    </h2>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-gray-200 py-6 text-center text-sm text-gray-400">
      {children}
    </p>
  );
}

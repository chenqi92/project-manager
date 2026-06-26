import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  FolderPlus,
  GitBranch,
  GripVertical,
  Layers,
  LayoutDashboard,
  Link as LinkIcon,
  Lock,
  LogIn,
  Monitor,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Star,
  Terminal,
  Trash2,
  UploadCloud,
  UserPlus,
  Users,
} from 'lucide-react';
import { LockScreen } from '@/components/LockScreen';
import { TotpBadge } from '@/components/TotpBadge';
import { Button, Input, cx } from '@/components/ui';
import { useVault } from '@/hooks/useVault';
import { getOrigin } from '@/lib/autofill';
import { biometricUnlock } from '@/lib/bio-unlock';
import { api } from '@/lib/messaging';
import { applyTheme, watchSystemTheme } from '@/lib/theme';
import { copyWithAutoClear } from '@/lib/clipboard';
import { search, type FlatEntry } from '@/lib/search';
import type {
  Account,
  Environment,
  GitRepo,
  MemoItem,
  PlatformLink,
  Project,
  VaultData,
} from '@/lib/types';
import {
  ENV_KIND_COLORS,
  ENV_KIND_LABELS,
  addTombstone,
  gitCloneCommand,
  newAccount,
  newEnvironment,
  newLink,
  newMemo,
  newProject,
  produce,
} from '@/lib/vault-ops';
import { useDialog } from '@/components/Dialog';
import { AuditModal } from './AuditModal';
import { BigScreen } from './BigScreen';
import { CaptureModal } from './CaptureModal';
import { Home } from './Home';
import { DocsModal } from './DocsModal';
import { MemoWidget } from './MemoWidget';
import { OpenLoginModal } from './OpenLoginModal';
import { AccountEditor, EnvEditor, LinkEditor, ProjectEditor } from './editors';
import { ImportExport } from './ImportExport';
import { Settings } from './Settings';
import { SidePanel } from './SidePanel';
import { BackupOnboardingModal } from './BackupGuard';

type Editing =
  | { kind: 'project'; project?: Project }
  | { kind: 'env'; projectId: string; env?: Environment }
  | { kind: 'link'; projectId: string; envId: string; link?: PlatformLink }
  | {
      kind: 'account';
      projectId: string;
      envId: string;
      linkId: string;
      account?: Account;
    }
  | null;

export default function App() {
  const vault = useVault();
  const { status, data, loading } = vault;
  const { confirm } = useDialog();

  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHome, setShowHome] = useState(true);
  const [editing, setEditing] = useState<Editing>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showIO, setShowIO] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [docsProjectId, setDocsProjectId] = useState<string | null>(null);
  const [bigScreenId, setBigScreenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [capture, setCapture] = useState(() => {
    const p = new URLSearchParams(location.search);
    return p.get('capture') === '1'
      ? { url: p.get('url') ?? '', title: p.get('title') ?? '' }
      : null;
  });
  const [loginHandoff, setLoginHandoff] = useState(() => {
    const p = new URLSearchParams(location.search);
    return p.get('openlogin') === '1'
      ? { accountId: p.get('account') ?? '', url: p.get('url') ?? '' }
      : null;
  });

  useEffect(() => {
    applyTheme(data?.settings.theme);
    return watchSystemTheme(() => data?.settings.theme);
  }, [data?.settings.theme]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  };

  const update = async (recipe: (d: VaultData) => void) => {
    if (!data) return;
    try {
      await vault.save(produce(data, recipe));
    } catch (e) {
      flash('保存失败：' + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const copy = async (text: string, what: string) => {
    await copyWithAutoClear(text);
    flash(`${what}已复制（25 秒后自动清空）`);
  };

  const openLogin = async (url: string, username: string, password: string) => {
    const origin = getOrigin(url);
    if (!origin) return flash('链接地址不合法');
    const pattern = origin + '/*';
    try {
      // 已授权则直接继续（不弹窗）；未授权才申请。请求放进 try 内：内网 http 等被拒
      // 或抛错时给出提示，避免静默失效。
      const granted =
        (await browser.permissions.contains({ origins: [pattern] })) ||
        (await browser.permissions.request({ origins: [pattern] }));
      if (!granted) return flash('未授权访问该网站');
      const r = await api.openAndFill(
        url,
        username,
        password,
        data?.settings.autoSubmit === true,
      );
      if (!r.filled && r.reason) flash(r.reason);
    } catch (e) {
      flash('打开失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 备份引导相关的轻量写入（失败不影响主流程）：标记已展示一次性强提示；记录一次成功备份的时间。
  const ackOnboardBackup = () =>
    update((d) => void (d.settings.onboardedBackup = true)).catch(() => {});
  const recordBackup = () =>
    update((d) => void (d.settings.lastBackupAt = Date.now())).catch(() => {});

  const projects = data?.projects ?? [];
  // 显示顺序 = 数组顺序（可拖拽调整）；收藏星标只作标记，不再自动置顶。
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0] ?? null;
  const docsProject = projects.find((p) => p.id === docsProjectId) ?? null;

  const reorderProjects = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    await update((d) => {
      const arr = d.projects;
      const from = arr.findIndex((p) => p.id === fromId);
      const to = arr.findIndex((p) => p.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = arr.splice(from, 1);
      if (moved) arr.splice(to, 0, moved);
    });
  };

  const bigScreenProject = projects.find((p) => p.id === bigScreenId) ?? null;

  // 备忘操作（项目内）：改动同时 bump 项目 updatedAt，保证同步合并不丢。
  const addMemo = (projectId: string, text: string, dueAt: number | undefined, urgent: boolean) =>
    update((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (p) {
        p.memos = [...(p.memos ?? []), newMemo({ text, dueAt, urgent })];
        p.updatedAt = Date.now();
      }
    });
  const mutateMemo = (projectId: string, memoId: string, fn: (m: MemoItem) => void) =>
    update((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      const m = p?.memos?.find((x) => x.id === memoId);
      if (p && m) {
        fn(m);
        m.updatedAt = Date.now();
        p.updatedAt = Date.now();
      }
    });
  const deleteMemo = (projectId: string, memoId: string) =>
    update((d) => {
      const p = d.projects.find((x) => x.id === projectId);
      if (p) {
        if ((p.memos ?? []).some((m) => m.id === memoId)) addTombstone(d, memoId);
        p.memos = (p.memos ?? []).filter((m) => m.id !== memoId);
        p.updatedAt = Date.now();
      }
    });
  const searchResults = useMemo(
    () => (data && query.trim() ? search(data, query) : null),
    [data, query],
  );

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-gray-400">加载中…</div>;
  }
  if (!status || status.locked) {
    return (
      <LockScreen
        initialized={status?.initialized ?? false}
        hasBiometric={status?.hasBiometric}
        onUnlock={vault.unlock}
        onCreate={vault.create}
        onBioUnlock={async () => {
          await biometricUnlock();
          await vault.refresh();
        }}
        onAdopt={async (serverUrl, token) => {
          await api.adopt(serverUrl, token);
          await vault.refresh();
        }}
      />
    );
  }
  if (!data) return null;

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900">
      {/* sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-gray-200 bg-surface">
        <div className="flex items-center gap-2 px-4 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Layers size={18} />
          </div>
          <span className="font-semibold">项目环境管家</span>
        </div>

        <div className="px-3 pb-2">
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="全局搜索"
              className="pl-8"
            />
          </div>
        </div>

        <div className="px-2 pb-1">
          <button
            onClick={() => {
              setShowHome(true);
              setQuery('');
            }}
            className={cx(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium',
              showHome && !searchResults ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-100',
            )}
          >
            <LayoutDashboard size={16} /> 首页
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-1.5 text-xs font-medium text-gray-400">
          <span>项目（{projects.length}）</span>
          <button
            onClick={() => setEditing({ kind: 'project' })}
            className="flex items-center gap-1 text-brand-600 hover:text-brand-700"
          >
            <FolderPlus size={14} /> 新建
          </button>
        </div>

        <nav className="flex-1 overflow-auto px-2 pb-3">
          {projects.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-gray-400">还没有项目</p>
          )}
          {projects.map((p) => {
            const envCount = p.environments.length;
            const acctCount = p.environments.reduce(
              (n, e) => n + e.links.reduce((m, l) => m + l.accounts.length, 0),
              0,
            );
            return (
              <button
                key={p.id}
                draggable
                onDragStart={() => setDragId(p.id)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== p.id) setDragOverId(p.id);
                }}
                onDragLeave={() => setDragOverId((cur) => (cur === p.id ? null : cur))}
                onDrop={() => {
                  if (dragId) reorderProjects(dragId, p.id);
                  setDragId(null);
                  setDragOverId(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDragOverId(null);
                }}
                onClick={() => {
                  setSelectedId(p.id);
                  setShowHome(false);
                  setQuery('');
                }}
                className={cx(
                  'group mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2 py-2 text-left',
                  dragId === p.id && 'opacity-40',
                  dragOverId === p.id && 'ring-2 ring-brand-300',
                  selected?.id === p.id && !searchResults && !showHome
                    ? 'bg-brand-50 text-brand-700'
                    : 'hover:bg-gray-100',
                )}
              >
                <GripVertical
                  size={14}
                  className="shrink-0 cursor-grab text-gray-300 opacity-0 group-hover:opacity-100"
                />
                <Star
                  size={14}
                  className={cx(
                    'shrink-0',
                    p.favorite ? 'fill-amber-400 text-amber-400' : 'text-gray-300',
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    update((d) => {
                      const t = d.projects.find((x) => x.id === p.id);
                      if (t) t.favorite = !t.favorite;
                    });
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-gray-400">
                  <span className="flex items-center gap-0.5" title={`${envCount} 个环境`}>
                    <Layers size={11} />
                    {envCount}
                  </span>
                  <span className="flex items-center gap-0.5" title={`${acctCount} 个账号`}>
                    <Users size={11} />
                    {acctCount}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex gap-1 border-t border-gray-100 p-2">
          <SideAction icon={<ShieldCheck size={16} />} label="审计" onClick={() => setShowAudit(true)} />
          <SideAction icon={<UploadCloud size={16} />} label="导入导出" onClick={() => setShowIO(true)} />
          <SideAction icon={<SettingsIcon size={16} />} label="设置" onClick={() => setShowSettings(true)} />
          <SideAction icon={<Lock size={16} />} label="锁定" onClick={() => vault.lock()} />
        </div>
      </aside>

      {/* main */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {searchResults ? (
          <SearchView results={searchResults} onCopy={copy} onOpenLogin={openLogin} />
        ) : showHome ? (
          <Home
            data={data}
            onUpdate={update}
            syncEnabled={status?.syncEnabled === true}
            onOpenExport={() => setShowIO(true)}
            onOpenSettings={() => setShowSettings(true)}
          />
        ) : selected ? (
          <ProjectView
            project={selected}
            onEditProject={() => setEditing({ kind: 'project', project: selected })}
            onDeleteProject={async () => {
              if (!(await confirm({ message: `删除项目「${selected.name}」及其全部内容？`, danger: true })))
                return;
              update((d) => {
                d.projects = d.projects.filter((p) => p.id !== selected.id);
                addTombstone(d, selected.id);
              });
              setSelectedId(null);
            }}
            onAddEnv={() => setEditing({ kind: 'env', projectId: selected.id })}
            onEditEnv={(env) => setEditing({ kind: 'env', projectId: selected.id, env })}
            onDeleteEnv={async (env) => {
              if (!(await confirm({ message: `删除环境「${env.name}」？`, danger: true }))) return;
              update((d) => {
                const p = d.projects.find((x) => x.id === selected.id);
                if (p) p.environments = p.environments.filter((e) => e.id !== env.id);
                addTombstone(d, env.id);
              });
            }}
            onAddLink={(envId) => setEditing({ kind: 'link', projectId: selected.id, envId })}
            onEditLink={(envId, link) =>
              setEditing({ kind: 'link', projectId: selected.id, envId, link })
            }
            onDeleteLink={async (envId, link) => {
              if (!(await confirm({ message: `删除链接「${link.name}」？`, danger: true }))) return;
              update((d) => {
                const e = d.projects
                  .find((x) => x.id === selected.id)
                  ?.environments.find((x) => x.id === envId);
                if (e) e.links = e.links.filter((l) => l.id !== link.id);
                addTombstone(d, link.id);
              });
            }}
            onAddAccount={(envId, linkId) =>
              setEditing({ kind: 'account', projectId: selected.id, envId, linkId })
            }
            onEditAccount={(envId, linkId, account) =>
              setEditing({ kind: 'account', projectId: selected.id, envId, linkId, account })
            }
            onDeleteAccount={async (envId, linkId, account) => {
              if (!(await confirm({ message: `删除账号「${account.label || account.username}」？`, danger: true })))
                return;
              update((d) => {
                const l = d.projects
                  .find((x) => x.id === selected.id)
                  ?.environments.find((x) => x.id === envId)
                  ?.links.find((x) => x.id === linkId);
                if (l) l.accounts = l.accounts.filter((a) => a.id !== account.id);
                addTombstone(d, account.id);
              });
            }}
            onCopy={copy}
            onOpenLogin={openLogin}
            onOpenDocs={() => setDocsProjectId(selected.id)}
            onOpenBigScreen={() => setBigScreenId(selected.id)}
            onAddMemo={(text, dueAt, urgent) => addMemo(selected.id, text, dueAt, urgent)}
            onToggleMemoDone={(id) => mutateMemo(selected.id, id, (m) => (m.done = !m.done))}
            onToggleMemoUrgent={(id) => mutateMemo(selected.id, id, (m) => (m.urgent = !m.urgent))}
            onDeleteMemo={(id) => deleteMemo(selected.id, id)}
          />
        ) : (
          <EmptyState onCreate={() => setEditing({ kind: 'project' })} />
        )}
      </main>

      {/* editors */}
      {editing?.kind === 'project' && (
        <ProjectEditor
          initial={editing.project}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            update((d) => {
              if (editing.project) {
                const t = d.projects.find((p) => p.id === editing.project!.id);
                if (t) Object.assign(t, v, { updatedAt: Date.now() });
              } else {
                const p = newProject(v);
                d.projects.push(p);
                setSelectedId(p.id);
              }
            });
            setEditing(null);
          }}
        />
      )}
      {editing?.kind === 'env' && (
        <EnvEditor
          initial={editing.env}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            update((d) => {
              const p = d.projects.find((x) => x.id === editing.projectId);
              if (!p) return;
              if (editing.env) {
                const t = p.environments.find((e) => e.id === editing.env!.id);
                if (t) Object.assign(t, v, { updatedAt: Date.now() });
              } else {
                p.environments.push(newEnvironment(v));
              }
            });
            setEditing(null);
          }}
        />
      )}
      {editing?.kind === 'link' && (
        <LinkEditor
          initial={editing.link}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            update((d) => {
              const e = d.projects
                .find((x) => x.id === editing.projectId)
                ?.environments.find((x) => x.id === editing.envId);
              if (!e) return;
              if (editing.link) {
                const t = e.links.find((l) => l.id === editing.link!.id);
                if (t) Object.assign(t, v, { updatedAt: Date.now() });
              } else {
                e.links.push(newLink(v));
              }
            });
            setEditing(null);
          }}
        />
      )}
      {editing?.kind === 'account' && (
        <AccountEditor
          initial={editing.account}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            update((d) => {
              const l = d.projects
                .find((x) => x.id === editing.projectId)
                ?.environments.find((x) => x.id === editing.envId)
                ?.links.find((x) => x.id === editing.linkId);
              if (!l) return;
              if (editing.account) {
                const t = l.accounts.find((a) => a.id === editing.account!.id);
                if (t) Object.assign(t, v, { updatedAt: Date.now() });
              } else {
                l.accounts.push(newAccount(v));
              }
            });
            setEditing(null);
          }}
        />
      )}

      {showSettings && (
        <Settings
          data={data}
          onClose={() => setShowSettings(false)}
          onSave={vault.save}
          onReset={async () => {
            await api.reset();
            await vault.lock();
          }}
          refresh={vault.refresh}
        />
      )}
      {showIO && (
        <ImportExport
          data={data}
          onClose={() => setShowIO(false)}
          onImported={vault.reload}
          onBackedUp={recordBackup}
        />
      )}
      {showAudit && <AuditModal data={data} onClose={() => setShowAudit(false)} />}
      {docsProject && (
        <DocsModal
          projectName={docsProject.name}
          docs={docsProject.docs ?? []}
          onClose={() => setDocsProjectId(null)}
          onChange={(docs) =>
            update((d) => {
              const p = d.projects.find((x) => x.id === docsProject.id);
              if (p) {
                const nextIds = new Set(docs.map((doc) => doc.id));
                for (const old of p.docs ?? []) {
                  if (!nextIds.has(old.id)) addTombstone(d, old.id);
                }
                p.docs = docs.map((doc) => ({ ...doc }));
                p.updatedAt = Date.now();
              }
            })
          }
        />
      )}
      {bigScreenProject && (
        <BigScreen project={bigScreenProject} onClose={() => setBigScreenId(null)} />
      )}
      {capture && (
        <CaptureModal
          data={data}
          initialUrl={capture.url}
          initialTitle={capture.title}
          onClose={() => {
            setCapture(null);
            history.replaceState(null, '', location.pathname);
          }}
          onSave={async (next) => {
            await vault.save(next);
            setCapture(null);
            history.replaceState(null, '', location.pathname);
            flash('已保存到保险箱');
          }}
        />
      )}
      {loginHandoff && (
        <OpenLoginModal
          data={data}
          accountId={loginHandoff.accountId}
          url={loginHandoff.url}
          autoSubmit={data.settings.autoSubmit === true}
          onClose={() => {
            setLoginHandoff(null);
            history.replaceState(null, '', location.pathname);
          }}
          onDone={async () => {
            const t = await browser.tabs.getCurrent().catch(() => null);
            if (t?.id) {
              try {
                await browser.tabs.remove(t.id);
                return;
              } catch {
                /* 关不掉就退回到清掉弹窗 */
              }
            }
            setLoginHandoff(null);
            history.replaceState(null, '', location.pathname);
          }}
        />
      )}

      {/* 首次创建保险箱后的一次性强提示：本地数据无兜底，引导备份或开同步。
          已开同步（已有云端副本）或正在走捕获 / 登录交接流程时不打扰。 */}
      {status?.syncEnabled !== true &&
        !data.settings.onboardedBackup &&
        !capture &&
        !loginHandoff && (
          <BackupOnboardingModal
            onExport={() => {
              ackOnboardBackup();
              setShowIO(true);
            }}
            onEnableSync={() => {
              ackOnboardBackup();
              setShowSettings(true);
            }}
            onAck={ackOnboardBackup}
          />
        )}

      <MemoWidget data={data} selectedProjectId={selected?.id ?? null} onUpdate={update} />

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-neutral-800/95 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function SideAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] text-gray-500 hover:bg-gray-100"
    >
      {icon}
      {label}
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-gray-400">
      <Layers size={40} />
      <p className="text-sm">还没有项目，先创建一个吧</p>
      <Button onClick={onCreate}>
        <Plus size={16} /> 新建项目
      </Button>
    </div>
  );
}

interface ProjectViewProps {
  project: Project;
  onEditProject: () => void;
  onDeleteProject: () => void;
  onAddEnv: () => void;
  onEditEnv: (env: Environment) => void;
  onDeleteEnv: (env: Environment) => void;
  onAddLink: (envId: string) => void;
  onEditLink: (envId: string, link: PlatformLink) => void;
  onDeleteLink: (envId: string, link: PlatformLink) => void;
  onAddAccount: (envId: string, linkId: string) => void;
  onEditAccount: (envId: string, linkId: string, account: Account) => void;
  onDeleteAccount: (envId: string, linkId: string, account: Account) => void;
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (url: string, username: string, password: string) => void;
  onOpenDocs: () => void;
  onOpenBigScreen: () => void;
  onAddMemo: (text: string, dueAt: number | undefined, urgent: boolean) => void;
  onToggleMemoDone: (id: string) => void;
  onToggleMemoUrgent: (id: string) => void;
  onDeleteMemo: (id: string) => void;
}

function ProjectView(props: ProjectViewProps) {
  const { project } = props;
  const docCount = project.docs?.length ?? 0;
  return (
    <>
      <header className="flex items-center gap-2 border-b border-gray-200 bg-surface px-6 py-4">
        <h1 className="text-lg font-semibold">{project.name}</h1>
        {(project.tags ?? []).map((t) => (
          <span key={t} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
            {t}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="subtle" onClick={props.onOpenBigScreen}>
            <Monitor size={15} /> 大屏
          </Button>
          <Button variant="subtle" onClick={props.onOpenDocs}>
            <FileText size={15} /> 说明{docCount > 0 ? `（${docCount}）` : ''}
          </Button>
          <IconButton title="编辑项目" onClick={props.onEditProject}>
            <Pencil size={16} />
          </IconButton>
          <IconButton title="删除项目" onClick={props.onDeleteProject} danger>
            <Trash2 size={16} />
          </IconButton>
          <Button className="ml-1" onClick={props.onAddEnv}>
            <Plus size={16} /> 新建环境
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 主区：环境 / 链接 / 账号（独立滚动，宽度随右栏拖拽而变） */}
        <div className="min-w-0 flex-1 space-y-5 overflow-auto p-6">
          {project.note && <p className="text-sm text-gray-500">{project.note}</p>}
          {project.environments.length === 0 && (
            <p className="rounded-xl border border-dashed border-gray-200 py-10 text-center text-sm text-gray-400">
              还没有环境，点右上角「新建环境」
            </p>
          )}
          {project.environments.map((env) => (
            <EnvBlock key={env.id} env={env} {...props} />
          ))}
        </div>

        {/* 右栏：待办 + 说明（可拖拽宽度/高度、可折叠、可整栏收起到右侧边） */}
        <SidePanel
          project={project}
          onOpenDocs={props.onOpenDocs}
          onAddMemo={props.onAddMemo}
          onToggleMemoDone={props.onToggleMemoDone}
          onToggleMemoUrgent={props.onToggleMemoUrgent}
          onDeleteMemo={props.onDeleteMemo}
        />
      </div>
    </>
  );
}

function EnvBlock({ env, ...props }: { env: Environment } & ProjectViewProps) {
  return (
    <section className="rounded-xl border border-gray-200 bg-surface">
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
        <span className={cx('rounded px-2 py-0.5 text-xs font-medium', ENV_KIND_COLORS[env.kind])}>
          {ENV_KIND_LABELS[env.kind]}
        </span>
        <span className="font-medium">{env.name}</span>
        {env.note && <span className="text-xs text-gray-400">· {env.note}</span>}
        <div className="ml-auto flex items-center gap-1">
          <IconButton title="编辑环境" onClick={() => props.onEditEnv(env)}>
            <Pencil size={14} />
          </IconButton>
          <IconButton title="删除环境" onClick={() => props.onDeleteEnv(env)} danger>
            <Trash2 size={14} />
          </IconButton>
          <Button variant="subtle" className="ml-1" onClick={() => props.onAddLink(env.id)}>
            <LinkIcon size={14} /> 链接
          </Button>
        </div>
      </div>

      {env.gitRepos && env.gitRepos.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-gray-100 px-4 py-2">
          {env.gitRepos.map((r) => (
            <GitRepoChip key={r.id} repo={r} onCopy={props.onCopy} />
          ))}
        </div>
      )}

      <div className="space-y-3 p-3">
        {env.links.length === 0 && (
          <p className="py-3 text-center text-xs text-gray-400">还没有链接</p>
        )}
        {env.links.map((link) => (
          <LinkBlock key={link.id} env={env} link={link} {...props} />
        ))}
      </div>
    </section>
  );
}

function LinkBlock({
  env,
  link,
  ...props
}: { env: Environment; link: PlatformLink } & ProjectViewProps) {
  return (
    <div className="rounded-lg border border-gray-200">
      <div className="flex items-center gap-2 px-3 py-2">
        <LinkIcon size={14} className="shrink-0 text-gray-400" />
        <span className="font-medium">{link.name}</span>
        {link.url && (
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-1 truncate text-xs text-brand-600 hover:underline"
          >
            <span className="truncate">{link.url}</span>
            <ExternalLink size={12} className="shrink-0" />
          </a>
        )}
        {link.urls && link.urls.length > 0 && (
          <span
            title={link.urls.join('\n')}
            className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500"
          >
            +{link.urls.length}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <IconButton title="编辑链接" onClick={() => props.onEditLink(env.id, link)}>
            <Pencil size={14} />
          </IconButton>
          <IconButton title="删除链接" onClick={() => props.onDeleteLink(env.id, link)} danger>
            <Trash2 size={14} />
          </IconButton>
          <Button variant="subtle" onClick={() => props.onAddAccount(env.id, link.id)}>
            <UserPlus size={14} /> 账号
          </Button>
        </div>
      </div>

      {link.gitRepos && link.gitRepos.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-gray-100 px-3 py-2">
          {link.gitRepos.map((r) => (
            <GitRepoChip key={r.id} repo={r} onCopy={props.onCopy} />
          ))}
        </div>
      )}

      {link.accounts.length > 0 && (
        <div className="divide-y divide-gray-50 border-t border-gray-100">
          {link.accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              onCopy={props.onCopy}
              onEdit={() => props.onEditAccount(env.id, link.id, a)}
              onDelete={() => props.onDeleteAccount(env.id, link.id, a)}
              onOpenLogin={
                link.url ? () => props.onOpenLogin(link.url, a.username, a.password) : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountRow({
  account,
  onCopy,
  onEdit,
  onDelete,
  onOpenLogin,
}: {
  account: Account;
  onCopy: (text: string, what: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenLogin?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50">
      <div className="w-32 shrink-0 truncate font-medium text-gray-700">
        {account.label || '（默认账号）'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-gray-700">{account.username || '—'}</div>
        {account.note && <div className="truncate text-xs text-gray-400">{account.note}</div>}
        {account.totp && (
          <div className="mt-1">
            <TotpBadge secret={account.totp} onCopy={(c) => onCopy(c, '验证码')} />
          </div>
        )}
      </div>
      <div className="w-40 shrink-0 truncate font-mono text-xs text-gray-500">
        {show ? account.password : '••••••••••'}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton title={show ? '隐藏' : '显示'} onClick={() => setShow((s) => !s)}>
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </IconButton>
        <IconButton title="复制用户名" onClick={() => onCopy(account.username, '用户名')}>
          <Copy size={15} />
        </IconButton>
        <IconButton title="复制密码" onClick={() => onCopy(account.password, '密码')}>
          <span className="text-[10px] font-bold">PW</span>
        </IconButton>
        {onOpenLogin && (
          <IconButton title="打开并登录" onClick={onOpenLogin}>
            <LogIn size={15} />
          </IconButton>
        )}
        <IconButton title="编辑" onClick={onEdit}>
          <Pencil size={15} />
        </IconButton>
        <IconButton title="删除" onClick={onDelete} danger>
          <Trash2 size={15} />
        </IconButton>
      </div>
    </div>
  );
}

function SearchView({
  results,
  onCopy,
  onOpenLogin,
}: {
  results: FlatEntry[];
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (url: string, username: string, password: string) => void;
}) {
  return (
    <>
      <header className="border-b border-gray-200 bg-surface px-6 py-4">
        <h1 className="text-lg font-semibold">搜索结果（{results.length}）</h1>
      </header>
      <div className="flex-1 space-y-2 overflow-auto p-6">
        {results.length === 0 && (
          <p className="py-10 text-center text-sm text-gray-400">没有匹配的条目</p>
        )}
        {results.map((e) => (
          <SearchRow key={e.accountId} entry={e} onCopy={onCopy} onOpenLogin={onOpenLogin} />
        ))}
      </div>
    </>
  );
}

function SearchRow({
  entry,
  onCopy,
  onOpenLogin,
}: {
  entry: FlatEntry;
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (url: string, username: string, password: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-surface px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{entry.linkName}</span>
          <span className={cx('rounded px-1.5 py-0.5 text-[10px] font-medium', ENV_KIND_COLORS[entry.envKind as Environment['kind']] ?? ENV_KIND_COLORS.other)}>
            {ENV_KIND_LABELS[entry.envKind as Environment['kind']] ?? entry.envName}
          </span>
          {entry.accountLabel && <span className="text-xs text-gray-400">· {entry.accountLabel}</span>}
        </div>
        <div className="truncate text-xs text-gray-400">
          {entry.projectName} · {entry.envName} · {entry.username}
        </div>
        {entry.totp && (
          <div className="mt-1">
            <TotpBadge secret={entry.totp} onCopy={(c) => onCopy(c, '验证码')} />
          </div>
        )}
      </div>
      <div className="w-40 shrink-0 truncate font-mono text-xs text-gray-500">
        {show ? entry.password : '••••••••'}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton title={show ? '隐藏' : '显示'} onClick={() => setShow((s) => !s)}>
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </IconButton>
        <IconButton title="复制用户名" onClick={() => onCopy(entry.username, '用户名')}>
          <Copy size={15} />
        </IconButton>
        <IconButton title="复制密码" onClick={() => onCopy(entry.password, '密码')}>
          <span className="text-[10px] font-bold">PW</span>
        </IconButton>
        {entry.url && (
          <>
            <IconButton
              title="打开并登录"
              onClick={() => onOpenLogin(entry.url, entry.username, entry.password)}
            >
              <LogIn size={15} />
            </IconButton>
            <IconButton title="打开链接" onClick={() => void browser.tabs.create({ url: entry.url }).catch(() => {})}>
              <ExternalLink size={15} />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}

// Git 仓库小标签：左半（图标 + 地址）复制仓库地址；右半（分支 + 终端图标）复制 git clone 命令。
function GitRepoChip({
  repo,
  onCopy,
}: {
  repo: GitRepo;
  onCopy: (text: string, what: string) => void;
}) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border border-gray-200 bg-gray-50 text-[11px] text-gray-600">
      <button
        title={`点击复制仓库地址：${repo.url}`}
        onClick={() => onCopy(repo.url, '仓库地址')}
        className="flex min-w-0 items-center gap-1 px-2 py-1 hover:bg-gray-100"
      >
        <GitBranch size={12} className="shrink-0 text-gray-400" />
        <span className="max-w-[220px] truncate font-mono">{repo.url}</span>
      </button>
      <button
        title={`点击复制 clone 命令：${gitCloneCommand(repo)}`}
        onClick={() => onCopy(gitCloneCommand(repo), 'git clone 命令')}
        className="flex shrink-0 items-center gap-1 self-stretch border-l border-gray-200 px-2 py-1 hover:bg-gray-100"
      >
        {repo.branch && (
          <span className="rounded bg-brand-50 px-1 text-brand-600">{repo.branch}</span>
        )}
        <Terminal size={12} className="shrink-0 text-gray-400" />
      </button>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cx(
        'flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100',
        danger && 'hover:bg-rose-50 hover:text-rose-600',
      )}
    >
      {children}
    </button>
  );
}

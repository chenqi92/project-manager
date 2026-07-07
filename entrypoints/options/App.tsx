import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
  Moon,
  Pencil,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Star,
  Sun,
  Terminal,
  Trash2,
  UploadCloud,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import { LockScreen } from '@/components/LockScreen';
import { TotpBadge } from '@/components/TotpBadge';
import { Avatar, Button, Segmented, cx } from '@/components/ui';
import { useVault } from '@/hooks/useVault';
import { getOrigin } from '@/lib/autofill';
import { biometricUnlock } from '@/lib/bio-unlock';
import { api } from '@/lib/messaging';
import { applyTheme, watchSystemTheme } from '@/lib/theme';
import { copyWithAutoClear } from '@/lib/clipboard';
import { search, type FlatEntry } from '@/lib/search';
import { VAULT_LOCKED_MSG } from '@/lib/types';
import type {
  Account,
  CustomField,
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
  envTagName,
  gitCloneCommand,
  newAccount,
  newEnvironment,
  newLink,
  newMemo,
  newProject,
  produce,
} from '@/lib/vault-ops';
import {
  commitWorkspaceDraft,
  createWorkspace,
  deleteWorkspace,
  prepareWorkspaceDraft,
  renameWorkspace,
  switchActiveWorkspace,
  workspaceScopedData,
} from '@/lib/workspace';
import { useDialog } from '@/components/Dialog';
import { AuditModal } from './AuditModal';
import { BigScreen } from './BigScreen';
import { CaptureModal } from './CaptureModal';
import { Home } from './Home';
import { CnbPage } from './CnbPage';
import { DocsModal } from './DocsModal';
import { MemoWidget } from './MemoWidget';
import { OpenLoginModal } from './OpenLoginModal';
import { AccountEditor, EnvEditor, LinkEditor, ProjectEditor } from './editors';
import { ImportExport } from './ImportExport';
import { Settings } from './Settings';
import { SidePanel } from './SidePanel';
import { SyncPage } from './SyncPage';
import { ToolsModal } from './ToolsModal';
import { FeatureOnboardingModal } from './BackupGuard';

type Editing =
  | { kind: 'project'; project?: Project }
  | { kind: 'env'; projectId: string; env?: Environment }
  | { kind: 'link'; workspaceId: string; projectId: string; envId: string; link?: PlatformLink }
  | {
      kind: 'account';
      projectId: string;
      envId: string;
      linkId: string;
      account?: Account;
    }
  | null;

const PAGE_TITLES = {
  settings: '设置',
  sync: '多端同步',
  audit: '安全审计',
  io: '导入导出',
  tools: '工具',
  cnb: '代码仓库',
} as const;

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function tombstoneProjectTree(data: VaultData, project: Project): void {
  addDeleteTombstone(data, project.id, project.updatedAt);
  for (const doc of project.docs ?? []) addDeleteTombstone(data, doc.id, doc.updatedAt);
  for (const memo of project.memos ?? []) addDeleteTombstone(data, memo.id, memo.updatedAt);
  for (const env of project.environments) {
    addDeleteTombstone(data, env.id, env.updatedAt);
    for (const link of env.links) {
      addDeleteTombstone(data, link.id, link.updatedAt);
      for (const account of link.accounts) addDeleteTombstone(data, account.id, account.updatedAt);
    }
  }
}

function addDeleteTombstone(data: VaultData, id: string, updatedAt = 0): void {
  const deletedAt = Math.max(Date.now(), updatedAt + 1);
  addMoveTombstone(data, id, deletedAt);
}

function addMoveTombstone(data: VaultData, id: string, deletedAt: number): void {
  data.tombstones = data.tombstones ?? [];
  const existing = data.tombstones.find((t) => t.id === id);
  if (existing) existing.deletedAt = Math.max(existing.deletedAt, deletedAt);
  else data.tombstones.push({ id, deletedAt });
}

type CaptureDraft = {
  url: string;
  title: string;
  username?: string;
  password?: string;
  tenant?: string;
  totp?: string;
  accountLabel?: string;
  pendingId?: string;
};

export default function App() {
  const vault = useVault();
  const { status, data, loading } = vault;
  const { confirm, prompt } = useDialog();
  const appVersion = browser.runtime.getManifest().version;
  const [firstRunWelcome] = useState(() => new URLSearchParams(location.search).get('welcome') === '1');

  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHome, setShowHome] = useState(true);
  const [editing, setEditing] = useState<Editing>(null);
  const [page, setPage] = useState<'settings' | 'sync' | 'audit' | 'io' | 'tools' | 'cnb' | null>(
    null,
  );
  const openPage = (p: 'settings' | 'sync' | 'audit' | 'io' | 'tools' | 'cnb') => {
    setQuery('');
    setPage(p);
  };
  // 侧栏宽度 / 收起态（每设备本地保存，不随保险箱同步）。
  const [navW, setNavW] = useState(232);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const navWRef = useRef(232);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  navWRef.current = navW;
  useEffect(() => {
    browser.storage.local
      .get('optionsNav')
      .then((r) => {
        const s = r.optionsNav as { width?: number; collapsed?: boolean } | undefined;
        if (s) {
          if (typeof s.width === 'number') setNavW(Math.max(190, Math.min(360, s.width)));
          setNavCollapsed(!!s.collapsed);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const closeOnPointerDown = (e: PointerEvent) => {
      const root = workspaceMenuRef.current;
      if (root && !root.contains(e.target as Node)) setWorkspaceMenuOpen(false);
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorkspaceMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [workspaceMenuOpen]);
  const [docsProjectId, setDocsProjectId] = useState<string | null>(null);
  const [bigScreenId, setBigScreenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureDraft | null>(() => {
    const p = new URLSearchParams(location.search);
    return p.get('capture') === '1'
      ? { url: p.get('url') ?? '', title: p.get('title') ?? '' }
      : null;
  });
  const [capturePendingId, setCapturePendingId] = useState(() => {
    const p = new URLSearchParams(location.search);
    return p.get('capturePending') || null;
  });
  // 从网页浮层「解锁」打开的标签页（?unlock=1）：解锁成功后自动关闭、回到原网页。
  const [openedForUnlock] = useState(
    () => new URLSearchParams(location.search).get('unlock') === '1',
  );
  useEffect(() => {
    if (openedForUnlock && status && status.initialized && !status.locked) {
      api.closeSelf().catch(() => {});
    }
  }, [openedForUnlock, status]);
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

  useEffect(() => {
    if (!data || !capturePendingId || capture) return;
    let active = true;
    api
      .capturePending(capturePendingId)
      .then((p) => {
        if (!active || !p) return;
        setCapture({
          url: p.url,
          title: p.linkName || hostOf(p.origin),
          username: p.username,
          password: p.password,
          tenant: p.tenant,
          totp: p.totp,
          accountLabel: p.accountLabel ?? '',
          pendingId: p.id,
        });
      })
      .catch((e) => flash('读取登录捕获失败：' + (e instanceof Error ? e.message : String(e))));
    return () => {
      active = false;
    };
  }, [data, capturePendingId, capture]);

  // 标签页重新获得焦点 / 变为可见时，探测后台是否已锁定（如空闲自动锁定）。已锁定则切到
  // 锁屏，避免停留在「已解锁」的旧界面、直到改东西保存时才报错。
  useEffect(() => {
    const check = () => {
      if (!document.hidden) void vault.checkLocked().catch(() => {});
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [vault.checkLocked]);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  };

  const update = async (recipe: (d: VaultData) => void) => {
    if (!data) return;
    try {
      await vault.save(
        produce(data, (draft) => {
          prepareWorkspaceDraft(draft);
          recipe(draft);
          commitWorkspaceDraft(draft);
        }),
      );
    } catch (e) {
      // 后台已锁定（如空闲自动锁定）：不弹「保存失败」，直接切到锁屏让用户重新输入主密码。
      if (e instanceof Error && e.message === VAULT_LOCKED_MSG) {
        await vault.checkLocked();
        return;
      }
      flash('保存失败：' + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
  };

  const copy = async (text: string, what: string) => {
    await copyWithAutoClear(text);
    flash(`${what}已复制（25 秒后自动清空）`);
  };

  const openLogin = async (url: string, username: string, password: string, tenant?: string) => {
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
        tenant,
      );
      if (r.reason) flash(r.reason);
    } catch (e) {
      flash('打开失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 备份相关的轻量写入（失败不影响主流程）：记录一次成功备份的时间。
  const recordBackup = () =>
    update((d) => void (d.settings.lastBackupAt = Date.now())).catch(() => {});
  const ackFeatureOnboarding = () =>
    update((d) => void (d.settings.onboardedFeatureSwitches = true)).catch(() => {});
  const enableFeatureAssist = async () => {
    await update((d) => void (d.settings.webAssist = true));
    flash('已开启网页内账号提示');
  };
  const enableFeatureNetwork = async () => {
    await update((d) => void (d.settings.weatherEnabled = true));
    flash('已开启联网磁贴');
  };
  const enableFeatureAllSites = async () => {
    try {
      const granted = await browser.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
      if (!granted) {
        flash('未获得全站访问权限');
        return;
      }
      await update((d) => {
        d.settings.webAssist = true;
        d.settings.webAssistAllSites = true;
      });
      flash('已开启新网站登录捕获，新打开或刷新后的页面生效');
    } catch (e) {
      flash('授权失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 网页 JSON 自动格式化开关：开启需 http(s) 全站权限。返回错误信息（null 表示成功）。
  const setJsonViewer = async (next: boolean): Promise<string | null> => {
    if (!next) {
      await update((d) => void (d.settings.jsonViewerEnabled = false));
      return null;
    }
    try {
      const granted = await browser.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
      if (!granted) return '未获得全站访问权限，已保持关闭。';
      await update((d) => void (d.settings.jsonViewerEnabled = true));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const activeData = data ? workspaceScopedData(data) : null;
  const workspaces = data?.workspaces ?? [];
  const activeWorkspace =
    workspaces.find((ws) => ws.id === data?.activeWorkspaceId) ?? workspaces[0] ?? null;
  const projects = activeData?.projects ?? [];
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
        const memo = p.memos?.find((m) => m.id === memoId);
        if (memo) addDeleteTombstone(d, memo.id, memo.updatedAt);
        p.memos = (p.memos ?? []).filter((m) => m.id !== memoId);
        p.updatedAt = Date.now();
      }
    });
  const searchResults = useMemo(
    () => (data && query.trim() ? search(workspaceScopedData(data), query) : null),
    [data, query],
  );

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-gray-400">加载中…</div>;
  }
  if (!status || status.locked) {
    return (
      <LockScreen
        initialized={status?.initialized ?? false}
        firstRun={firstRunWelcome && !(status?.initialized ?? false)}
        hasBiometric={status?.hasBiometric}
        onUnlock={vault.unlock}
        onCreate={vault.create}
        onBioUnlock={async () => {
          await biometricUnlock();
          await vault.refresh();
        }}
        onAdopt={async (serverUrl, token) => {
          const origin = getOrigin(serverUrl);
          if (!origin) throw new Error('同步服务器地址不合法');
          const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
          if (!granted) throw new Error('未授权访问同步服务器');
          await api.adopt(serverUrl, token);
          await vault.refresh();
        }}
      />
    );
  }
  if (!data) return null;

  const saveNav = (w: number, collapsed: boolean) =>
    browser.storage.local.set({ optionsNav: { width: w, collapsed } }).catch(() => {});
  const startNavResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const start = navWRef.current;
    let last = start;
    const move = (ev: PointerEvent) => {
      last = Math.max(190, Math.min(360, start + ev.clientX - sx));
      setNavW(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveNav(last, false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const toggleNav = () =>
    setNavCollapsed((c) => {
      saveNav(navWRef.current, !c);
      return !c;
    });

  // 顶栏明暗分段：把 system 解析为当前生效色，点选写入显式 light/dark。
  const setTheme = (t: 'light' | 'dark') => update((d) => void (d.settings.theme = t));
  const themeVal: 'light' | 'dark' =
    data.settings.theme === 'dark'
      ? 'dark'
      : data.settings.theme === 'light'
        ? 'light'
        : window.matchMedia?.('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
  const showFeatureOnboarding =
    !data.settings.onboardedFeatureSwitches && !capture && !loginHandoff;

  const resetWorkspaceView = () => {
    setSelectedId(null);
    setDocsProjectId(null);
    setBigScreenId(null);
    setShowHome(true);
    setQuery('');
    setPage(null);
  };

  // 工作区变更用 structuredClone 而非 immer produce：金库把 data.projects 别名到当前
  // 工作区的 projects 数组，这种「共享引用」immer 不支持（重排工作区数组时会把新建的
  // 工作区丢掉），所以这里走纯克隆 + 直接修改。
  const saveWorkspaceMutation = async (mutate: (d: VaultData) => void) => {
    if (!data) return;
    const draft = structuredClone(data);
    mutate(draft);
    // switchWorkspace：告知后台本次保存显式变更当前工作区（切换/新建/删除），
    // 普通保存会保留后台已知的 activeWorkspaceId，防止旧快照把工作区拉回去。
    await vault.save(draft, { switchWorkspace: true });
  };

  const changeWorkspace = async (workspaceId: string) => {
    if (!data || workspaceId === activeWorkspace?.id) return;
    await saveWorkspaceMutation((d) => void switchActiveWorkspace(d, workspaceId));
    resetWorkspaceView();
  };

  const addWorkspace = async () => {
    if (!data) return;
    const name = await prompt({
      title: '新建工作区',
      message: '工作区用于区分个人、公司等完全不同的首页和项目。',
      placeholder: '例如：个人 / 公司',
    });
    if (name == null) return;
    await saveWorkspaceMutation((d) =>
      void createWorkspace(d, name.trim() || `工作区 ${(d.workspaces?.length ?? 0) + 1}`),
    );
    resetWorkspaceView();
    flash('工作区已创建');
  };

  const renameCurrentWorkspace = async () => {
    if (!data || !activeWorkspace) return;
    const name = await prompt({
      title: '重命名工作区',
      defaultValue: activeWorkspace.name,
    });
    if (name == null) return;
    await saveWorkspaceMutation((d) => void renameWorkspace(d, activeWorkspace.id, name));
    flash('工作区已重命名');
  };

  const deleteCurrentWorkspace = async () => {
    if (!data || !activeWorkspace) return;
    if (workspaces.length <= 1) {
      flash('至少保留一个工作区');
      return;
    }
    const targetId = activeWorkspace.id;
    const ok = await confirm({
      title: '删除工作区',
      message: `删除工作区「${activeWorkspace.name}」及其下的全部项目？此操作不可恢复。`,
      danger: true,
      confirmText: '删除工作区',
    });
    if (!ok) return;
    await saveWorkspaceMutation((d) => {
      // 留墓碑：否则下次同步会把已删工作区从远端合并回来（复活）。
      const ws = (d.workspaces ?? []).find((w) => w.id === targetId);
      if (ws) {
        addDeleteTombstone(d, ws.id, ws.updatedAt);
        for (const p of ws.projects) tombstoneProjectTree(d, p);
      }
      deleteWorkspace(d, targetId);
    });
    resetWorkspaceView();
    flash('工作区已删除');
  };

  const deleteSelectedProject = async () => {
    if (!selected) return;
    if (!(await confirm({ message: `删除项目「${selected.name}」及其全部内容？`, danger: true })))
      return;
    await update((d) => {
      d.projects = d.projects.filter((p) => p.id !== selected.id);
      tombstoneProjectTree(d, selected);
    });
    setSelectedId(null);
    setShowHome(true);
    flash('项目已删除');
  };

  const saveLinkDraft = async (
    sourceWorkspaceId: string,
    sourceProjectId: string,
    sourceEnvId: string,
    existing: PlatformLink | undefined,
    value: {
      name: string;
      envKind?: Environment['kind'];
      envName?: string;
      matchMode?: PlatformLink['matchMode'];
      url: string;
      note?: string;
      urls?: string[];
      gitRepos?: GitRepo[];
      customFields?: CustomField[];
    },
    target?: {
      workspaceId?: string;
      projectId: string;
    },
  ) => {
    if (!data) return;
    let nextProjectId: string | null = null;
    let movedLocation = false;
    let movedAcrossWorkspace = false;
    try {
      const draft = structuredClone(data);
      prepareWorkspaceDraft(draft);
      commitWorkspaceDraft(draft);
      const now = Date.now();
      const workspaceList = draft.workspaces ?? [];
      const sourceWorkspace =
        workspaceList.find((ws) => ws.id === sourceWorkspaceId) ?? workspaceList[0];
      if (!sourceWorkspace) throw new Error('找不到当前工作区');
      const sourceProject = sourceWorkspace.projects.find((p) => p.id === sourceProjectId);
      if (!sourceProject) throw new Error('找不到当前项目');

      // 环境 = 链接上的标签(kind + name)：容器只是按标签归类的实现细节，找不到就建。
      const kind = value.envKind ?? 'other';
      const tagName = envTagName(kind, value.envName);
      const linkValue = { ...value, envKind: kind, envName: tagName };
      const findOrCreateEnv = (proj: Project): Environment => {
        let env = proj.environments.find((e) => e.kind === kind && e.name === tagName);
        if (!env) {
          env = newEnvironment({ kind, name: tagName });
          proj.environments.push(env);
        }
        return env;
      };
      const targetWorkspace =
        workspaceList.find((ws) => ws.id === (target?.workspaceId || sourceWorkspace.id));
      if (!targetWorkspace) throw new Error('找不到目标工作区');
      const targetProject = targetWorkspace.projects.find(
        (p) => p.id === (target?.projectId || sourceProjectId),
      );
      if (!targetProject) throw new Error('找不到目标项目');

      // 新建链接：直接按标签归入对应容器（0 环境也能加）。
      if (!existing) {
        const env = findOrCreateEnv(targetProject);
        env.links.push(newLink(linkValue));
        env.updatedAt = now;
        targetProject.updatedAt = now;
        targetWorkspace.updatedAt = Math.max(targetWorkspace.updatedAt ?? 0, now);
      } else {
        // 编辑：定位原容器与索引。
        const sourceEnv = sourceProject.environments.find((env) => env.id === sourceEnvId);
        if (!sourceEnv) throw new Error('找不到当前环境');
        const sourceIndex = sourceEnv.links.findIndex((link) => link.id === existing.id);
        if (sourceIndex < 0) throw new Error('找不到要编辑的链接');

        const targetEnv = findOrCreateEnv(targetProject);

        // 标签未变且同位置 → 原地更新。
        if (
          targetWorkspace.id === sourceWorkspace.id &&
          targetProject.id === sourceProject.id &&
          targetEnv.id === sourceEnv.id
        ) {
          Object.assign(sourceEnv.links[sourceIndex]!, linkValue, { updatedAt: now });
          sourceEnv.updatedAt = now;
          sourceProject.updatedAt = now;
          sourceWorkspace.updatedAt = Math.max(sourceWorkspace.updatedAt ?? 0, now);
        } else {
          // 改了标签或换了位置 → 从原容器移出、并入目标容器（用墓碑防同步重现旧位置）。
          const [moved] = sourceEnv.links.splice(sourceIndex, 1);
          if (!moved) throw new Error('找不到要移动的链接');
          const updatedAt = now + 1;
          addMoveTombstone(draft, moved.id, now);
          Object.assign(moved, linkValue, { updatedAt });
          sourceEnv.updatedAt = updatedAt;
          sourceProject.updatedAt = updatedAt;
          targetEnv.links.push(moved);
          targetEnv.updatedAt = updatedAt;
          targetProject.updatedAt = updatedAt;
          sourceWorkspace.updatedAt = Math.max(sourceWorkspace.updatedAt ?? 0, updatedAt);
          targetWorkspace.updatedAt = Math.max(targetWorkspace.updatedAt ?? 0, updatedAt);
        }
      }

      movedLocation = targetWorkspace.id !== sourceWorkspace.id || targetProject.id !== sourceProject.id;
      movedAcrossWorkspace = targetWorkspace.id !== sourceWorkspace.id;
      if (movedLocation && !movedAcrossWorkspace) {
        nextProjectId = targetProject.id;
      }
      await vault.save(draft);
    } catch (e) {
      if (e instanceof Error && e.message === VAULT_LOCKED_MSG) {
        await vault.checkLocked();
        return;
      }
      flash('保存失败：' + (e instanceof Error ? e.message : String(e)));
      throw e;
    }
    if (movedLocation && nextProjectId) {
      setSelectedId(nextProjectId);
      setShowHome(false);
      setPage(null);
      flash('已移动链接');
    } else if (movedAcrossWorkspace) {
      flash('已移动到目标工作区');
    }
  };

  // 顶栏在所有视图共用一个实例（含常驻搜索框），标题/返回/右操作按当前视图计算。
  const viewTitle =
    page && !searchResults
      ? PAGE_TITLES[page]
      : searchResults
        ? `搜索结果（${searchResults.length}）`
        : showHome
          ? '首页看板'
          : selected
            ? selected.name
            : '项目';
  const viewBack =
    page && !searchResults
      ? () => setPage(null)
      : !searchResults && !showHome && selected
        ? () => {
            setSelectedId(null);
            setShowHome(true);
          }
        : undefined;
  const newProjectBtn = (
    <Button onClick={() => setEditing({ kind: 'project' })}>
      <Plus size={16} /> 新建项目
    </Button>
  );
  const viewRight =
    page || searchResults ? undefined : showHome ? (
      newProjectBtn
    ) : selected ? (
      <IconButton title="大屏只读展示" onClick={() => setBigScreenId(selected.id)}>
        <Monitor size={16} />
      </IconButton>
    ) : (
      newProjectBtn
    );

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900">
      {/* sidebar（可拖拽改宽 / 可收起） */}
      {navCollapsed && (
        <div className="flex w-6 shrink-0 flex-col items-center border-r border-gray-200 bg-surface pt-4">
          <button
            onClick={toggleNav}
            title="展开侧栏"
            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      {!navCollapsed && (
        <aside
          style={{ width: navW }}
          className="relative flex shrink-0 flex-col border-r border-gray-200 bg-surface px-3 py-4"
        >
        <div className="flex items-center gap-2.5 px-2 pb-2.5 pt-1">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-brand-600 text-white shadow-[0_4px_10px_-2px_rgba(13,148,136,.4)]">
            <Layers size={17} />
          </span>
          <div
            className="min-w-0 flex-1 truncate text-[13.5px] font-bold leading-tight"
            title={`env vault · v${appVersion}`}
          >
            项目环境管家
          </div>
          <button
            onClick={toggleNav}
            title="收起侧栏"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100"
          >
            <ChevronLeft size={16} />
          </button>
        </div>

        <div ref={workspaceMenuRef} className="relative mb-2">
          <button
            type="button"
            title="切换工作区"
            aria-haspopup="menu"
            aria-expanded={workspaceMenuOpen}
            onClick={() => setWorkspaceMenuOpen((v) => !v)}
            className="flex h-9 w-full items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 text-left text-xs font-semibold text-gray-900 transition hover:border-brand-200 hover:bg-pribg focus:border-brand-500 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-100"
          >
            <span className="min-w-0 flex-1 truncate">{activeWorkspace?.name ?? '工作区'}</span>
            <ChevronDown
              size={14}
              className={cx('shrink-0 text-gray-400 transition-transform', workspaceMenuOpen && 'rotate-180')}
            />
          </button>

          {workspaceMenuOpen && (
            <div
              role="menu"
              className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-surface shadow-xl shadow-gray-200/60"
            >
              <div className="max-h-56 overflow-auto p-1">
                {workspaces.map((ws) => {
                  const active = ws.id === activeWorkspace?.id;
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setWorkspaceMenuOpen(false);
                        void changeWorkspace(ws.id);
                      }}
                      className={cx(
                        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition',
                        active
                          ? 'bg-pribg font-semibold text-prid'
                          : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                      {active && <Check size={13} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-gray-100 p-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    void renameCurrentWorkspace();
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                >
                  <Pencil size={13} className="shrink-0 text-gray-400" />
                  <span className="min-w-0 flex-1 truncate">重命名当前工作区</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    void addWorkspace();
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-gray-600 hover:bg-gray-50 hover:text-brand-700"
                >
                  <Plus size={14} className="shrink-0 text-gray-400" />
                  <span className="min-w-0 flex-1 truncate">新建工作区</span>
                </button>
                {workspaces.length > 1 && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      void deleteCurrentWorkspace();
                    }}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-gray-600 hover:bg-rose-50 hover:text-rose-700"
                  >
                    <Trash2 size={13} className="shrink-0 text-gray-400" />
                    <span className="min-w-0 flex-1 truncate">删除当前工作区</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            setShowHome(true);
            setSelectedId(null);
            setQuery('');
            setPage(null);
          }}
          className={cx(
            'flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[13px] font-medium',
            showHome && !page && !searchResults
              ? 'bg-pribg text-prid'
              : 'text-gray-700 hover:bg-gray-100',
          )}
        >
          <LayoutDashboard size={16} /> <span className="flex-1">首页</span>
        </button>

        <div className="flex items-center px-2.5 pb-1.5 pt-3.5">
          <span className="text-[11px] font-bold text-gray-400">
            项目 <span className="font-medium">({projects.length})</span>
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setEditing({ kind: 'project' })}
            className="flex items-center gap-1 px-1 text-[11.5px] font-semibold text-brand-600 hover:text-brand-700"
          >
            <FolderPlus size={13} /> 新建
          </button>
        </div>

        <nav className="-mx-1 flex-1 overflow-auto px-1 pb-1">
          {projects.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-gray-400">还没有项目</p>
          )}
          {projects.map((p) => {
            const envCount = p.environments.length;
            const acctCount = p.environments.reduce(
              (n, e) => n + e.links.reduce((m, l) => m + l.accounts.length, 0),
              0,
            );
            const active = selected?.id === p.id && !searchResults && !showHome && !page;
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
                  setPage(null);
                }}
                className={cx(
                  'group mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] px-2 py-2 text-left',
                  dragId === p.id && 'opacity-40',
                  dragOverId === p.id && 'ring-2 ring-brand-300',
                  active ? 'bg-pribg' : 'hover:bg-gray-100',
                )}
              >
                <Avatar name={p.name} size={26} radius={8} />
                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      'block truncate text-[12.5px] font-semibold',
                      active ? 'text-prid' : 'text-gray-800',
                    )}
                  >
                    {p.name}
                  </span>
                  <span className="block truncate text-[10px] text-gray-400">
                    {envCount} 环境 · {acctCount} 账号
                  </span>
                </span>
                <Star
                  size={14}
                  className={cx(
                    'shrink-0 transition-opacity',
                    p.favorite
                      ? 'fill-amber-400 text-amber-400'
                      : 'text-gray-300 opacity-0 group-hover:opacity-100',
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    update((d) => {
                      const t = d.projects.find((x) => x.id === p.id);
                      if (t) t.favorite = !t.favorite;
                    });
                  }}
                />
              </button>
            );
          })}
        </nav>

        <div className="mt-1.5 flex gap-0.5 border-t border-gray-100 pt-2.5">
          <SideAction icon={<ShieldCheck size={17} />} label="审计" active={page === 'audit'} onClick={() => openPage('audit')} />
          <SideAction icon={<UploadCloud size={17} />} label="导入导出" active={page === 'io'} onClick={() => openPage('io')} />
          <SideAction icon={<SettingsIcon size={17} />} label="设置" active={page === 'settings' || page === 'sync'} onClick={() => openPage('settings')} />
          <SideAction icon={<Wrench size={17} />} label="工具" active={page === 'tools'} onClick={() => openPage('tools')} />
        </div>
        <div
          onPointerDown={startNavResize}
          title="拖拽改变宽度"
          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none hover:bg-brand-200"
        />
        </aside>
      )}

      {/* main */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          title={viewTitle}
          onBack={viewBack}
          right={viewRight}
          search={<TopSearch query={query} setQuery={setQuery} />}
          themeVal={themeVal}
          onSetTheme={setTheme}
          onLock={() => vault.lock()}
        />
        {page && !searchResults ? (
          <div className="flex min-h-0 flex-1 flex-col">
              {page === 'settings' && (
                <Settings
                  data={data}
                  onSave={vault.save}
                  onReset={async () => {
                    await api.reset();
                    await vault.lock();
                  }}
                  refresh={vault.refresh}
                  onOpenSync={() => setPage('sync')}
                  onOpenIO={() => setPage('io')}
                  onOpenCnb={() => setPage('cnb')}
                  onGoHome={() => {
                    setPage(null);
                    setSelectedId(null);
                    setShowHome(true);
                  }}
                />
              )}
              {page === 'sync' && (
                <SyncPage
                  data={data}
                  onSave={vault.save}
                  refresh={vault.refresh}
                  onBackToSettings={() => setPage('settings')}
                />
              )}
              {page === 'audit' && (
                <AuditModal
                  data={activeData ?? data}
                  onClose={() => setPage(null)}
                  embedded
                  onFix={(e) => {
                    const acct = (activeData ?? data).projects
                      .find((p) => p.id === e.projectId)
                      ?.environments.find((x) => x.id === e.envId)
                      ?.links.find((x) => x.id === e.linkId)
                      ?.accounts.find((a) => a.id === e.accountId);
                    setPage(null);
                    setShowHome(false);
                    setSelectedId(e.projectId);
                    setEditing({
                      kind: 'account',
                      projectId: e.projectId,
                      envId: e.envId,
                      linkId: e.linkId,
                      account: acct,
                    });
                  }}
                />
              )}
              {page === 'io' && (
                <ImportExport
                  data={activeData ?? data}
                  onClose={() => setPage(null)}
                  onImported={vault.reload}
                  onBackedUp={recordBackup}
                  embedded
                />
              )}
              {page === 'tools' && (
                <ToolsModal
                  onClose={() => setPage(null)}
                  onCopy={copy}
                  embedded
                  networkEnabled={data.settings.weatherEnabled === true}
                  onEnableNetwork={() => update((d) => void (d.settings.weatherEnabled = true))}
                  jsonViewerEnabled={data.settings.jsonViewerEnabled === true}
                  onSetJsonViewer={setJsonViewer}
                />
              )}
              {page === 'cnb' && <CnbPage data={data} onSave={vault.save} onCopy={copy} />}
            </div>
        ) : searchResults ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <SearchView results={searchResults} onCopy={copy} onOpenLogin={openLogin} />
          </div>
        ) : showHome ? (
          <div className="flex min-h-0 flex-1 flex-col">
              <Home
                data={activeData ?? data}
                onUpdate={update}
                syncEnabled={status?.syncEnabled === true}
                onOpenExport={() => openPage('io')}
                onOpenSettings={() => openPage('settings')}
                onOpenCnb={() => openPage('cnb')}
                onCopy={copy}
                onOpenLogin={openLogin}
              />
            </div>
        ) : selected ? (
          <div className="flex min-h-0 flex-1 flex-col">
              <ProjectView
                project={selected}
                onBack={() => {
                  setSelectedId(null);
                  setShowHome(true);
                }}
                onToggleFav={() =>
                  update((d) => {
                    const t = d.projects.find((p) => p.id === selected.id);
                    if (t) t.favorite = !t.favorite;
                  })
                }
                onEditProject={() => setEditing({ kind: 'project', project: selected })}
                onDeleteProject={deleteSelectedProject}
                onAddEnv={() => setEditing({ kind: 'env', projectId: selected.id })}
            onEditEnv={(env) => setEditing({ kind: 'env', projectId: selected.id, env })}
            onDeleteEnv={async (env) => {
              if (!(await confirm({ message: `删除环境「${env.name}」？`, danger: true }))) return;
              update((d) => {
                const p = d.projects.find((x) => x.id === selected.id);
                if (p) p.environments = p.environments.filter((e) => e.id !== env.id);
                addDeleteTombstone(d, env.id, env.updatedAt);
              });
            }}
            onAddLink={() =>
              setEditing({
                kind: 'link',
                workspaceId: activeWorkspace?.id ?? '',
                projectId: selected.id,
                envId: '',
              })
            }
            onEditLink={(envId, link) =>
              setEditing({
                kind: 'link',
                workspaceId: activeWorkspace?.id ?? '',
                projectId: selected.id,
                envId,
                link,
              })
            }
            onDeleteLink={async (envId, link) => {
              if (!(await confirm({ message: `删除链接「${link.name}」？`, danger: true }))) return;
              update((d) => {
                const e = d.projects
                  .find((x) => x.id === selected.id)
                  ?.environments.find((x) => x.id === envId);
                if (e) e.links = e.links.filter((l) => l.id !== link.id);
                addDeleteTombstone(d, link.id, link.updatedAt);
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
                addDeleteTombstone(d, account.id, account.updatedAt);
              });
            }}
            onCopy={copy}
            onOpenLogin={openLogin}
            onOpenDocs={() => setDocsProjectId(selected.id)}
            onAddMemo={(text, dueAt, urgent) => addMemo(selected.id, text, dueAt, urgent)}
            onToggleMemoDone={(id) => mutateMemo(selected.id, id, (m) => (m.done = !m.done))}
            onToggleMemoUrgent={(id) => mutateMemo(selected.id, id, (m) => (m.urgent = !m.urgent))}
                onDeleteMemo={(id) => deleteMemo(selected.id, id)}
              />
            </div>
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
                if (t) {
                  const oldKind = t.kind;
                  const oldName = t.name;
                  Object.assign(t, v, { updatedAt: Date.now() });
                  for (const link of t.links) {
                    if ((link.envKind ?? oldKind) === oldKind && (link.envName ?? oldName) === oldName) {
                      link.envKind = v.kind;
                      link.envName = v.name;
                      link.updatedAt = Date.now();
                    }
                  }
                }
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
          location={
            {
              projects,
              workspaces,
              workspaceId: editing.workspaceId,
              projectId: editing.projectId,
              envId: editing.envId,
            }
          }
          onClose={() => setEditing(null)}
          onSave={async (v, target) => {
            await saveLinkDraft(editing.workspaceId, editing.projectId, editing.envId, editing.link, v, target);
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
                  if (!nextIds.has(old.id)) addDeleteTombstone(d, old.id, old.updatedAt);
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
          data={activeData ?? data}
          initialUrl={capture.url}
          initialTitle={capture.title}
          initialUsername={capture.username}
          initialPassword={capture.password}
          initialTenant={capture.tenant}
          initialTotp={capture.totp}
          initialAccountLabel={capture.accountLabel}
          onClose={() => {
            setCapture(null);
            setCapturePendingId(null);
            history.replaceState(null, '', location.pathname);
          }}
          onSave={async (next) => {
            await vault.save(next);
            if (capture.pendingId) await api.captureDismiss(capture.pendingId).catch(() => {});
            setCapture(null);
            setCapturePendingId(null);
            history.replaceState(null, '', location.pathname);
            flash('已保存到保险箱');
          }}
        />
      )}
      {loginHandoff && (
        <OpenLoginModal
          data={activeData ?? data}
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

      {showFeatureOnboarding && (
        <FeatureOnboardingModal
          webAssist={data.settings.webAssist !== false}
          webAssistAllSites={data.settings.webAssistAllSites === true}
          networkEnabled={data.settings.weatherEnabled === true}
          onEnableAssist={enableFeatureAssist}
          onEnableAllSites={enableFeatureAllSites}
          onEnableNetwork={enableFeatureNetwork}
          onDone={ackFeatureOnboarding}
        />
      )}

      <MemoWidget data={activeData ?? data} selectedProjectId={selected?.id ?? null} onUpdate={update} />

      {toast && (
        <div className="pem-toast fixed bottom-6 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-2.5 rounded-[11px] bg-[#1a1d23] px-4 py-2.5 text-white shadow-[0_14px_34px_-8px_rgba(0,0,0,.4)]">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok">
            <Check size={12} />
          </span>
          <span className="text-[12.5px]">{toast}</span>
        </div>
      )}
    </div>
  );
}

/** 统一顶栏：返回 + 标题 + 锁定 + 明暗分段 + 主操作。 */
function TopBar({
  title,
  onBack,
  right,
  search,
  themeVal,
  onSetTheme,
  onLock,
}: {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
  search?: React.ReactNode;
  themeVal: 'light' | 'dark';
  onSetTheme: (t: 'light' | 'dark') => void;
  onLock: () => void;
}) {
  return (
    <header className="flex h-[60px] shrink-0 items-center gap-3.5 border-b border-gray-200 bg-surface px-6">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {onBack && (
          <button
            onClick={onBack}
            title="返回"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <h1 className="shrink-0 truncate text-base font-bold">{title}</h1>
        <div id="home-board-switcher-slot" className="min-w-0" />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end">{search}</div>
      <button
        onClick={onLock}
        title="锁定保险箱"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-gray-200 bg-surface text-gray-600 hover:bg-gray-50"
      >
        <Lock size={16} />
      </button>
      <Segmented
        value={themeVal}
        onChange={onSetTheme}
        options={[
          { value: 'light', label: <Sun size={16} />, title: '明亮' },
          { value: 'dark', label: <Moon size={16} />, title: '深色' },
        ]}
      />
      <div id="home-board-actions-slot" className="flex shrink-0 items-center gap-1.5" />
      {right && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
    </header>
  );
}

/** 顶栏右侧的全局搜索框（单实例、常驻，输入不切视图不丢焦点）。 */
function TopSearch({ query, setQuery }: { query: string; setQuery: (v: string) => void }) {
  return (
    <div className="relative w-full max-w-[300px]">
      <Search
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
      />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="全局搜索项目 / 环境 / 链接 / 账号"
        className="h-9 w-full rounded-[9px] border border-gray-200 bg-gray-50 pl-8 pr-12 text-xs text-gray-700 outline-none placeholder:text-gray-400 focus:border-brand-500 focus:bg-surface"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-gray-200 px-1 font-mono text-[9.5px] text-gray-400">
        ⌘K
      </span>
    </div>
  );
}

function SideAction({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cx(
        'flex flex-1 flex-col items-center gap-1 rounded-[9px] py-2 text-[9.5px] font-medium',
        active ? 'bg-pribg text-prid' : 'text-gray-500 hover:bg-gray-100',
      )}
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
  onBack: () => void;
  onToggleFav: () => void;
  onEditProject: () => void;
  onDeleteProject: () => void;
  onAddEnv: () => void;
  onEditEnv: (env: Environment) => void;
  onDeleteEnv: (env: Environment) => void;
  onAddLink: () => void;
  onEditLink: (envId: string, link: PlatformLink) => void;
  onDeleteLink: (envId: string, link: PlatformLink) => void;
  onAddAccount: (envId: string, linkId: string) => void;
  onEditAccount: (envId: string, linkId: string, account: Account) => void;
  onDeleteAccount: (envId: string, linkId: string, account: Account) => void;
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (url: string, username: string, password: string, tenant?: string) => void;
  onOpenDocs: () => void;
  onAddMemo: (text: string, dueAt: number | undefined, urgent: boolean) => void;
  onToggleMemoDone: (id: string) => void;
  onToggleMemoUrgent: (id: string) => void;
  onDeleteMemo: (id: string) => void;
}

function ProjectView(props: ProjectViewProps) {
  const { project } = props;
  const linkCount = project.environments.reduce((m, e) => m + e.links.length, 0);
  const acctCount = project.environments.reduce(
    (n, e) => n + e.links.reduce((m, l) => m + l.accounts.length, 0),
    0,
  );
  const linkRows = project.environments.flatMap((env) =>
    env.links.map((link) => ({ env, link })),
  );
  // 环境 = 链接上的彩色标签(kind+name)：从链接聚合出去重标签，供顶部筛选。
  const TAGSEP = '\0';
  const tagKeyOf = (env: Environment, link: PlatformLink) => {
    const kind = link.envKind ?? env.kind;
    return kind + TAGSEP + envTagName(kind, link.envName ?? env.name);
  };
  const tags = (() => {
    const seen = new Map<
      string,
      { key: string; kind: Environment['kind']; name: string; count: number }
    >();
    for (const { env, link } of linkRows) {
      const kind = link.envKind ?? env.kind;
      const name = envTagName(kind, link.envName ?? env.name);
      const key = kind + TAGSEP + name;
      const cur = seen.get(key);
      if (cur) cur.count++;
      else seen.set(key, { key, kind, name, count: 1 });
    }
    return [...seen.values()];
  })();
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const activeFilter = tagFilter && tags.some((t) => t.key === tagFilter) ? tagFilter : null;
  const shownRows = activeFilter
    ? linkRows.filter(({ env, link }) => tagKeyOf(env, link) === activeFilter)
    : linkRows;
  return (
    <div className="flex min-h-0 flex-1">
      {/* 主区：环境 / 链接 / 账号（独立滚动，宽度随右栏拖拽而变） */}
      <div className="min-w-0 flex-1 overflow-auto p-6">
        {/* 面包屑 */}
        <div className="mb-4 flex items-center gap-2 text-xs text-gray-400">
          <span className="cursor-pointer hover:text-gray-600" onClick={props.onBack}>
            项目
          </span>
          <span>/</span>
          <span className="font-semibold text-gray-700">{project.name}</span>
        </div>

        {/* 项目头卡 */}
        <div className="mb-[18px] flex items-center gap-3.5 rounded-[14px] border border-gray-200 bg-surface px-5 py-[18px]">
          <Avatar name={project.name} size={48} radius={13} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="truncate text-[18px] font-bold">{project.name}</span>
              <button
                onClick={props.onToggleFav}
                title={project.favorite ? '取消收藏' : '收藏'}
                className="flex shrink-0 items-center"
              >
                <Star
                  size={18}
                  className={project.favorite ? 'fill-amber-400 text-amber-400' : 'text-gray-300'}
                />
              </button>
            </div>
            <div className="mt-0.5 text-xs text-gray-400">
              {tags.length} 标签 · {linkCount} 链接 · {acctCount} 账号
            </div>
          </div>
          {(project.tags ?? []).map((t) => (
            <span
              key={t}
              className="hidden rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10.5px] font-semibold text-gray-600 sm:inline"
            >
              {t}
            </span>
          ))}
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={props.onEditProject}>
              <Pencil size={13} /> 编辑
            </Button>
            <Button
              variant="outline"
              onClick={props.onDeleteProject}
              className="border-rose-100 text-rose-600 hover:bg-rose-50"
            >
              <Trash2 size={13} /> 删除
            </Button>
          </div>
        </div>

        {project.note && <p className="mb-4 text-sm text-gray-500">{project.note}</p>}
        <div className="mb-3 flex items-center">
          <div className="text-[13px] font-bold">链接与账号</div>
          <div className="flex-1" />
          <Button variant="outline" onClick={() => props.onAddLink()}>
            <Plus size={14} /> 添加链接
          </Button>
        </div>

        {/* 按环境标签筛选 */}
        {tags.length > 0 && (
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setTagFilter(null)}
              className={cx(
                'rounded-full px-3 py-1 text-[11px] font-bold transition-colors',
                !activeFilter
                  ? 'bg-brand-600 text-white shadow-[0_4px_10px_-6px_rgba(13,148,136,.75)] hover:bg-brand-700'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-800',
              )}
            >
              全部 {linkRows.length}
            </button>
            {tags.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTagFilter(activeFilter === t.key ? null : t.key)}
                className={cx(
                  'rounded-full px-3 py-1 text-[11px] font-bold',
                  ENV_KIND_COLORS[t.kind],
                  activeFilter === t.key
                    ? 'ring-2 ring-brand-400 ring-offset-1'
                    : 'opacity-70 hover:opacity-100',
                )}
              >
                {t.name} {t.count}
              </button>
            ))}
          </div>
        )}

        <div className="overflow-hidden rounded-[14px] border border-gray-200 bg-surface">
          {shownRows.length === 0 && (
            <p className="py-10 text-center text-sm text-gray-400">
              {linkRows.length === 0
                ? '还没有链接，点「添加链接 / 平台」新增，保存时选一个环境标签即可'
                : '该标签下暂无链接'}
            </p>
          )}
          {shownRows.map(({ env, link }) => (
            <LinkBlock key={link.id} env={env} link={link} {...props} />
          ))}
          <div className="border-t border-gray-100 p-3">
            <button
              onClick={() => props.onAddLink()}
              className="flex h-[30px] items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 text-[11.5px] font-semibold text-gray-500 hover:border-brand-400 hover:text-brand-600"
            >
              <Plus size={12} /> 添加链接 / 平台
            </button>
          </div>
        </div>
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
  );
}

function LinkBlock({
  env,
  link,
  ...props
}: { env: Environment; link: PlatformLink } & ProjectViewProps) {
  const acc0 = link.accounts[0];
  const fields = link.customFields ?? [];
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const canOpenDefaultLogin = Boolean(link.url && acc0);
  const linkEnvKind = link.envKind ?? env.kind;
  const linkEnvName = envTagName(linkEnvKind, link.envName ?? env.name);
  const matchModeLabel =
    link.matchMode === 'path-prefix' ? '路径匹配' : link.matchMode === 'exact-url' ? '精确匹配' : '';
  const openDefaultLogin = () => {
    if (!link.url || !acc0) return;
    props.onOpenLogin(link.url, acc0.username, acc0.password, acc0.tenant);
  };
  return (
    <div className="border-t border-gray-100 px-4 py-3.5">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-500">
          <LinkIcon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          {canOpenDefaultLogin ? (
            <button
              type="button"
              title="打开并登录"
              onClick={openDefaultLogin}
              className="block max-w-full truncate rounded text-left text-[13px] font-semibold hover:text-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200"
            >
              {link.name}
            </button>
          ) : (
            <div className="truncate text-[13px] font-semibold">{link.name}</div>
          )}
          {link.url && (
            <div
              onClick={() => props.onCopy(link.url, '链接')}
              title="点击复制链接"
              className="cursor-pointer truncate font-mono text-[11px] text-gray-400 hover:text-brand-600"
            >
              {link.url}
            </div>
          )}
        </div>
        <span
          title={`环境标签：${linkEnvName}`}
          className={cx(
            'shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-bold',
            ENV_KIND_COLORS[linkEnvKind],
          )}
        >
          {ENV_KIND_LABELS[linkEnvKind]}
          {linkEnvName && linkEnvName !== ENV_KIND_LABELS[linkEnvKind] ? ` · ${linkEnvName}` : ''}
        </span>
        {link.urls && link.urls.length > 0 && (
          <span
            title={link.urls.join('\n')}
            className="shrink-0 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600"
          >
            +{link.urls.length} 网址
          </span>
        )}
        {matchModeLabel && (
          <span
            title="自动匹配方式"
            className="shrink-0 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600"
          >
            {matchModeLabel}
          </span>
        )}
        {link.gitRepos?.map((r) => (
          <GitRepoChip key={r.id} repo={r} onCopy={props.onCopy} />
        ))}
        {fields.length > 0 && (
          <CustomFieldsToggle
            count={fields.length}
            open={fieldsOpen}
            onClick={() => setFieldsOpen((v) => !v)}
          />
        )}
        {canOpenDefaultLogin && (
          <button
            onClick={openDefaultLogin}
            className="shrink-0 rounded-lg border border-gray-200 bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-brand-600 hover:bg-gray-50"
          >
            打开并登录
          </button>
        )}
        {link.url && !acc0 && (
          <IconButton
            title="打开链接"
            onClick={() => void browser.tabs.create({ url: link.url }).catch(() => {})}
          >
            <ExternalLink size={14} />
          </IconButton>
        )}
        <IconButton title="编辑链接" onClick={() => props.onEditLink(env.id, link)}>
          <Pencil size={13} />
        </IconButton>
        <IconButton title="删除链接" onClick={() => props.onDeleteLink(env.id, link)} danger>
          <Trash2 size={13} />
        </IconButton>
      </div>
      {fieldsOpen && <CustomFieldsPanel fields={fields} onCopy={props.onCopy} />}
      <div className="space-y-1.5">
        {link.accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            onCopy={props.onCopy}
            onEdit={() => props.onEditAccount(env.id, link.id, a)}
            onDelete={() => props.onDeleteAccount(env.id, link.id, a)}
            onOpenLogin={
              link.url ? () => props.onOpenLogin(link.url, a.username, a.password, a.tenant) : undefined
            }
          />
        ))}
        <button
          onClick={() => props.onAddAccount(env.id, link.id)}
          className="flex h-[30px] w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 text-[11px] font-semibold text-gray-400 hover:border-brand-400 hover:text-brand-600"
        >
          <Plus size={12} /> 添加账号
        </button>
      </div>
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
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const fields = account.customFields ?? [];
  return (
    <div className="rounded-[10px] bg-gray-50 text-sm">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Avatar name={account.label || account.username || '账号'} size={28} radius={7} />
        <div className="w-[130px] min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-gray-800">
            {account.username || '—'}
          </div>
          <div className="truncate text-[10.5px] text-gray-400">
            {account.label || '（默认账号）'}
            {account.tenant ? ` · 租户 ${account.tenant}` : ''}
          </div>
        </div>
        <div className="min-w-0 flex-1 truncate font-mono text-[12.5px] tracking-wide text-gray-500">
          {show ? account.password : '••••••••••'}
        </div>
        {account.totp && (
          <div className="shrink-0">
            <TotpBadge secret={account.totp} onCopy={(c) => onCopy(c, '验证码')} />
          </div>
        )}
        {fields.length > 0 && (
          <CustomFieldsToggle
            count={fields.length}
            open={fieldsOpen}
            onClick={() => setFieldsOpen((v) => !v)}
          />
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton title={show ? '隐藏密码' : '显示密码'} onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </IconButton>
          <IconButton title="复制用户名" onClick={() => onCopy(account.username, '用户名')}>
            <Users size={15} />
          </IconButton>
          {account.tenant && (
            <IconButton title="复制租户" onClick={() => onCopy(account.tenant!, '租户')}>
              <Building2 size={15} />
            </IconButton>
          )}
          <IconButton title="复制密码" onClick={() => onCopy(account.password, '密码')}>
            <Copy size={15} />
          </IconButton>
          {onOpenLogin && (
            <IconButton title="打开并登录" onClick={onOpenLogin}>
              <LogIn size={15} />
            </IconButton>
          )}
          <IconButton title="编辑账号" onClick={onEdit}>
            <Pencil size={15} />
          </IconButton>
          <IconButton title="删除账号" onClick={onDelete} danger>
            <Trash2 size={15} />
          </IconButton>
        </div>
      </div>
      {fieldsOpen && <CustomFieldsPanel fields={fields} onCopy={onCopy} compact />}
    </div>
  );
}

function CustomFieldsToggle({
  count,
  open,
  onClick,
}: {
  count: number;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold',
        open
          ? 'border-brand-200 bg-brand-50 text-prid'
          : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100',
      )}
    >
      <FileText size={12} />
      {count} 项信息
    </button>
  );
}

function fieldTypeLabel(type: CustomField['type']): string {
  const labels: Record<CustomField['type'], string> = {
    text: '文本',
    url: 'URL',
    email: '电子邮件',
    address: '地址',
    date: '日期',
    otp: '一次性密码',
    password: '密码',
    phone: '电话',
    login: '登录方式',
    file: '附件说明',
  };
  return labels[type] ?? '文本';
}

function fieldIsSensitive(field: CustomField): boolean {
  return field.sensitive === true || field.type === 'password' || field.type === 'otp';
}

function CustomFieldsPanel({
  fields,
  onCopy,
  compact,
}: {
  fields: CustomField[];
  onCopy: (text: string, what: string) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cx(
        'mb-2 grid grid-cols-1 gap-1.5 rounded-lg border border-gray-100 bg-surface/70 p-2',
        !compact && 'mx-[42px] md:grid-cols-2',
        compact && 'mx-3 border-t-0 md:grid-cols-2',
      )}
    >
      {fields.map((field) => (
        <CustomFieldItem key={field.id} field={field} onCopy={onCopy} />
      ))}
    </div>
  );
}

function CustomFieldItem({
  field,
  onCopy,
}: {
  field: CustomField;
  onCopy: (text: string, what: string) => void;
}) {
  const [show, setShow] = useState(false);
  const sensitive = fieldIsSensitive(field);
  const display = sensitive && !show ? '••••••••' : field.value;
  const canOpen = field.type === 'url' && !sensitive && /^https?:\/\//i.test(field.value);
  return (
    <div className="min-w-0 rounded-md bg-gray-50 px-2 py-1.5">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="truncate text-[11px] font-semibold text-gray-700">{field.label || fieldTypeLabel(field.type)}</span>
        <span className="shrink-0 rounded bg-gray-100 px-1 text-[9.5px] text-gray-400">
          {fieldTypeLabel(field.type)}
        </span>
        <div className="flex-1" />
        {sensitive && (
          <button
            type="button"
            title={show ? '隐藏' : '显示'}
            onClick={() => setShow((v) => !v)}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            {show ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
        {canOpen && (
          <button
            type="button"
            title="打开"
            onClick={() => void browser.tabs.create({ url: field.value }).catch(() => {})}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-brand-600"
          >
            <ExternalLink size={12} />
          </button>
        )}
        <button
          type="button"
          title="复制"
          onClick={() => onCopy(field.value, field.label || fieldTypeLabel(field.type))}
          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-brand-600"
        >
          <Copy size={12} />
        </button>
      </div>
      <div
        title={sensitive ? undefined : field.value}
        className="truncate font-mono text-[11px] text-gray-500"
      >
        {display || '—'}
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
  onOpenLogin: (url: string, username: string, password: string, tenant?: string) => void;
}) {
  return (
    <div className="flex-1 space-y-2 overflow-auto p-6">
      {results.length === 0 && (
        <p className="py-10 text-center text-sm text-gray-400">没有匹配的条目</p>
      )}
      {results.map((e) => (
        <SearchRow key={e.accountId} entry={e} onCopy={onCopy} onOpenLogin={onOpenLogin} />
      ))}
    </div>
  );
}

function SearchRow({
  entry,
  onCopy,
  onOpenLogin,
}: {
  entry: FlatEntry;
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (url: string, username: string, password: string, tenant?: string) => void;
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
              onClick={() => onOpenLogin(entry.url, entry.username, entry.password, entry.tenant)}
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
          <span className="rounded bg-brand-50 px-1 text-prid">{repo.branch}</span>
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

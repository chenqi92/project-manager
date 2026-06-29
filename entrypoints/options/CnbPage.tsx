// ---------------------------------------------------------------------------
// 代码仓库整页：把 cnb.cool 那份按时间平铺的「最近更新」列表，重构成
// 「子组织 → 项目 → 仓库」的可折叠层级，支持搜索 / 语言 / 可见性筛选、
// 一键打开仓库、复制 clone。令牌随保险箱加密存储，仅授权 api.cnb.cool 后联网。
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  ChevronRight,
  CircleDot,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FolderGit2,
  GitFork,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Star,
  Terminal,
} from 'lucide-react';
import { Banner, Button, Input, Label, cx } from '@/components/ui';
import { hasHost, requestHost } from '@/lib/feeds';
import {
  CNB_API_BASE,
  buildRepoTree,
  cnbCloneCommand,
  cnbCloneUrl,
  clearRepoCache,
  fetchCnbGroups,
  loadOrgRepos,
  ROOT_PROJECT,
  type CnbGroup,
  type CnbRepo,
  type RepoGroupNode,
} from '@/lib/cnb';
import type { VaultData } from '@/lib/types';
import { produce } from '@/lib/vault-ops';

interface OrgResult {
  loading: boolean;
  repos?: CnbRepo[];
  error?: string;
  cachedAt?: number;
}

const errMsg = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  return /failed to fetch|networkerror|load failed|abort|timeout/i.test(raw)
    ? '无法连接 CNB（请确认已授权 api.cnb.cool 域名、网络可达）。'
    : raw;
};

export function CnbPage({
  data,
  onSave,
  onCopy,
}: {
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
  onCopy: (text: string, what: string) => void;
}) {
  const cfg = data.settings.cnb ?? {};
  const orgs = useMemo(() => cfg.orgs ?? [], [cfg.orgs]);
  const orgsKey = orgs.join(',');

  const [authed, setAuthed] = useState<boolean | null>(null);
  const [results, setResults] = useState<Record<string, OrgResult>>({});
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('');
  const [vis, setVis] = useState('');
  const [cfgOpen, setCfgOpen] = useState(false);

  const persist = (recipe: (d: VaultData) => void) => onSave(produce(data, recipe));

  // host 授权状态
  useEffect(() => {
    hasHost(CNB_API_BASE).then(setAuthed);
  }, []);

  // 没令牌 / 没组织时默认展开连接设置
  useEffect(() => {
    if (!cfg.token || orgs.length === 0) setCfgOpen(true);
  }, [cfg.token, orgs.length]);

  const loadAll = async (force: boolean) => {
    if (!cfg.token || orgs.length === 0) return;
    if (!(await hasHost(CNB_API_BASE))) {
      setAuthed(false);
      return;
    }
    setAuthed(true);
    await Promise.all(
      orgs.map(async (slug) => {
        setResults((r) => ({ ...r, [slug]: { ...r[slug], loading: true, error: undefined } }));
        try {
          const { repos, cachedAt } = await loadOrgRepos(cfg.token!, slug, {
            force,
            base: cfg.apiBase,
          });
          setResults((r) => ({ ...r, [slug]: { loading: false, repos, cachedAt } }));
        } catch (e) {
          setResults((r) => ({ ...r, [slug]: { loading: false, error: errMsg(e) } }));
        }
      }),
    );
  };

  // 配置变化时自动加载（走缓存）
  useEffect(() => {
    loadAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.token, orgsKey]);

  const refreshAll = async () => {
    await clearRepoCache();
    await loadAll(true);
  };

  // 全部已加载仓库（用于派生语言/可见性筛选项与计数）
  const allRepos = useMemo(
    () => orgs.flatMap((s) => results[s]?.repos ?? []),
    [orgs, results],
  );
  const languages = useMemo(
    () => [...new Set(allRepos.map((r) => r.language).filter(Boolean) as string[])].sort(),
    [allRepos],
  );
  const visibilities = useMemo(
    () => [...new Set(allRepos.map((r) => r.visibility).filter(Boolean) as string[])].sort(),
    [allRepos],
  );

  const filterRepo = (r: CnbRepo) => {
    if (lang && r.language !== lang) return false;
    if (vis && r.visibility !== vis) return false;
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      if (!(`${r.path} ${r.description ?? ''}`.toLowerCase().includes(t))) return false;
    }
    return true;
  };

  const anyLoading = orgs.some((s) => results[s]?.loading);
  const totalShown = allRepos.filter(filterRepo).length;
  const totalAll = allRepos.length;

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* 连接设置 */}
      <ConnectPanel
        data={data}
        persist={persist}
        authed={authed}
        setAuthed={setAuthed}
        open={cfgOpen}
        setOpen={setCfgOpen}
      />

      {/* 工具条 */}
      {cfg.token && orgs.length > 0 && (
        <div className="mb-4 mt-[18px] flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[220px] flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索仓库名 / 路径 / 描述"
              className="pl-8"
            />
          </div>
          {languages.length > 0 && (
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="h-[38px] rounded-lg border border-gray-300 bg-surface px-3 text-sm text-gray-700 outline-none focus:border-brand-500"
            >
              <option value="">全部语言</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
          {visibilities.length > 1 && (
            <select
              value={vis}
              onChange={(e) => setVis(e.target.value)}
              className="h-[38px] rounded-lg border border-gray-300 bg-surface px-3 text-sm text-gray-700 outline-none focus:border-brand-500"
            >
              <option value="">全部可见性</option>
              {visibilities.map((v) => (
                <option key={v} value={v}>
                  {visLabel(v)}
                </option>
              ))}
            </select>
          )}
          <Button variant="outline" disabled={anyLoading} onClick={refreshAll}>
            {anyLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}{' '}
            刷新
          </Button>
          <span className="text-[11.5px] text-gray-400">
            {q || lang || vis ? `${totalShown} / ${totalAll}` : `${totalAll}`} 个仓库
          </span>
        </div>
      )}

      {/* 各组织仓库：左侧子组导航 + 右侧仓库网格（master-detail） */}
      {cfg.token && orgs.length > 0 && (
        <RepoBrowser
          orgs={orgs}
          results={results}
          filterRepo={filterRepo}
          filtering={!!(q || lang || vis)}
          onCopy={onCopy}
          onOpen={(url) => void browser.tabs.create({ url }).catch(() => {})}
        />
      )}

      {cfg.token && orgs.length === 0 && (
        <p className="mt-4 rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
          还没有选择要展示的组织。在上方「连接设置」里拉取并勾选组织。
        </p>
      )}
    </div>
  );
}

// --------------------------- 连接设置面板 ---------------------------
function ConnectPanel({
  data,
  persist,
  authed,
  setAuthed,
  open,
  setOpen,
}: {
  data: VaultData;
  persist: (recipe: (d: VaultData) => void) => Promise<void>;
  authed: boolean | null;
  setAuthed: (v: boolean) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const cfg = data.settings.cnb ?? {};
  const [token, setToken] = useState(cfg.token ?? '');
  const [showToken, setShowToken] = useState(false);
  const [groups, setGroups] = useState<CnbGroup[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(cfg.orgs ?? []));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);

  const configured = !!cfg.token && (cfg.orgs?.length ?? 0) > 0;

  const authorize = async () => {
    const ok = await requestHost(CNB_API_BASE);
    setAuthed(ok);
    if (!ok) setMsg({ tone: 'warn', text: '未授权 api.cnb.cool，无法联网拉取。' });
  };

  // 测试令牌并拉取可见组织（顺带确保 host 授权）
  const testAndList = async () => {
    setMsg(null);
    const t = token.trim();
    if (!t) return setMsg({ tone: 'error', text: '请先填写访问令牌' });
    setBusy(true);
    try {
      const granted = (await hasHost(CNB_API_BASE)) || (await requestHost(CNB_API_BASE));
      setAuthed(granted);
      if (!granted) {
        setMsg({ tone: 'warn', text: '需要先授权访问 api.cnb.cool 才能拉取。' });
        return;
      }
      const gs = await fetchCnbGroups(t);
      setGroups(gs);
      // 默认勾选已配置的，否则若只有一个组织则自动勾选
      setPicked((cur) => {
        if (cur.size) return cur;
        return new Set(gs.length === 1 ? [gs[0]!.path] : []);
      });
      if (gs.length === 0) setMsg({ tone: 'warn', text: '该令牌下没有可见的顶层组织。' });
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setMsg(null);
    const t = token.trim();
    if (!t) return setMsg({ tone: 'error', text: '请先填写访问令牌' });
    const orgs = [...picked];
    setBusy(true);
    try {
      await persist((d) => {
        d.settings.cnb = { ...(d.settings.cnb ?? {}), token: t, orgs };
      });
      setMsg({ tone: 'info', text: '已保存配置' });
      if (orgs.length) setOpen(false);
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (slug: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  return (
    <div className="rounded-[14px] border border-gray-200 bg-surface">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-[18px] py-3.5 text-left"
      >
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <FolderGit2 size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold">连接设置 · CNB</div>
          <div className="truncate text-[11.5px] text-gray-400">
            {configured
              ? `已配置 · ${cfg.orgs!.length} 个组织 · 令牌已保存`
              : '填写访问令牌并选择要展示的组织'}
          </div>
        </div>
        {configured &&
          (authed === false ? (
            <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-bold text-warn">
              待授权
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-bold text-ok">
              <Lock size={12} /> 已加密存储
            </span>
          ))}
        <ChevronRight
          size={16}
          className="shrink-0 text-gray-400 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        />
      </button>

      {open && (
        <div className="border-t border-gray-100 px-[18px] py-4">
          <Banner tone="info">
            访问令牌在 CNB「个人设置 → 访问令牌」创建（只读 repo 权限即可）。令牌随保险箱
            AES-GCM 加密存储，仅在你授权 api.cnb.cool 后联网，CNB 之外没人能读到。
          </Banner>

          <div className="mt-3">
            <Label>访问令牌（Bearer）</Label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="粘贴 CNB 访问令牌"
                  className="pr-9 font-mono"
                />
                <button
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  title={showToken ? '隐藏' : '显示'}
                >
                  {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <Button variant="outline" disabled={busy} onClick={testAndList}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{' '}
                测试并拉取组织
              </Button>
            </div>
          </div>

          {authed === false && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2">
              <span className="flex-1 text-[12px] text-warn">需授权访问 api.cnb.cool 域名后才能联网</span>
              <Button variant="subtle" onClick={authorize}>
                授权访问
              </Button>
            </div>
          )}

          {groups && groups.length > 0 && (
            <div className="mt-3">
              <Label>选择要展示的组织</Label>
              <div className="flex flex-col gap-1.5">
                {groups.map((g) => (
                  <label
                    key={g.path}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2 hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(g.path)}
                      onChange={() => toggle(g.path)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-semibold text-gray-800">
                        {g.name}
                        <span className="ml-1.5 font-mono text-[10.5px] font-normal text-gray-400">
                          {g.path}
                        </span>
                      </div>
                      {g.description && (
                        <div className="truncate text-[11px] text-gray-400">{g.description}</div>
                      )}
                    </div>
                    {typeof g.repoCount === 'number' && (
                      <span className="shrink-0 text-[10.5px] text-gray-400">{g.repoCount} 仓库</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {msg && (
            <div className="mt-3">
              <Banner tone={msg.tone}>{msg.text}</Banner>
            </div>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <Button disabled={busy} onClick={save}>
              {busy && <Loader2 size={14} className="animate-spin" />} 保存配置
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------- 仓库浏览：左侧子组导航 + 右侧仓库网格 ---------------------------
// 把「组织 → 子组 → 项目 → 仓库」从纵向手风琴改成 master-detail：左栏紧凑列出全部子组
// （多组织时按组织分节），右栏展示选中子组的仓库（按项目分节、多列密集网格），充分用横向空间。
function RepoBrowser({
  orgs,
  results,
  filterRepo,
  filtering,
  onCopy,
  onOpen,
}: {
  orgs: string[];
  results: Record<string, OrgResult>;
  filterRepo: (r: CnbRepo) => boolean;
  filtering: boolean;
  onCopy: (text: string, what: string) => void;
  onOpen: (url: string) => void;
}) {
  // 跨组织拍平为「子组」列表，每项带稳定 key（org::子组段）。
  const groups = useMemo(() => {
    const out: Array<{ key: string; org: string; node: RepoGroupNode }> = [];
    for (const org of orgs) {
      const repos = results[org]?.repos;
      if (!repos) continue;
      for (const node of buildRepoTree(org, repos.filter(filterRepo))) {
        out.push({ key: `${org}::${node.key}`, org, node });
      }
    }
    return out;
  }, [orgs, results, filterRepo]);

  const [sel, setSel] = useState<string | null>(null);
  const activeKey = sel && groups.some((g) => g.key === sel) ? sel : (groups[0]?.key ?? null);
  const active = groups.find((g) => g.key === activeKey) ?? null;

  const errorOrgs = orgs.filter((o) => results[o]?.error);
  const anyRepos = orgs.some((o) => results[o]?.repos);
  const stillLoading = orgs.some((o) => results[o]?.loading && !results[o]?.repos);
  const multiOrg = orgs.length > 1;

  if (!anyRepos && stillLoading) {
    return (
      <div className="flex items-center gap-2 rounded-[14px] border border-gray-200 bg-surface px-4 py-6 text-sm text-gray-400">
        <Loader2 size={15} className="animate-spin" /> 正在拉取仓库…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {errorOrgs.map((o) => (
        <Banner key={o} tone="error">
          拉取 {o} 失败：{results[o]?.error}
        </Banner>
      ))}

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
          {filtering ? '没有匹配的仓库' : '所选组织下没有仓库'}
        </p>
      ) : (
        <div className="flex gap-4">
          {/* 左：子组导航 */}
          <div className="sticky top-0 max-h-[80vh] w-[244px] shrink-0 self-start overflow-auto rounded-[14px] border border-gray-200 bg-surface p-2">
            {multiOrg ? (
              orgs.map((org) => {
                const gs = groups.filter((g) => g.org === org);
                if (!gs.length) return null;
                return (
                  <div key={org} className="mb-1.5 last:mb-0">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[10.5px] font-bold uppercase tracking-wide text-gray-400">
                      <FolderGit2 size={12} /> {org}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {gs.map((g) => (
                        <GroupNavItem
                          key={g.key}
                          node={g.node}
                          active={g.key === activeKey}
                          onClick={() => setSel(g.key)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex flex-col gap-0.5">
                {groups.map((g) => (
                  <GroupNavItem
                    key={g.key}
                    node={g.node}
                    active={g.key === activeKey}
                    onClick={() => setSel(g.key)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 右：选中子组的仓库 */}
          <div className="min-w-0 flex-1">
            {active && (
              <GroupDetail
                org={active.org}
                node={active.node}
                multiOrg={multiOrg}
                onCopy={onCopy}
                onOpen={onOpen}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 左栏子组项：名称 + 仓库数；选中态高亮。
function GroupNavItem({
  node,
  active,
  onClick,
}: {
  node: RepoGroupNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={node.name}
      className={cx(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
        active ? 'bg-pribg text-prid' : 'text-gray-700 hover:bg-gray-50',
      )}
    >
      <FolderGit2 size={14} className={cx('shrink-0', active ? 'text-prid' : 'text-gray-400')} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{node.name}</span>
      <span
        className={cx(
          'shrink-0 rounded-full px-1.5 text-[10px] font-semibold',
          active ? 'bg-surface/70 text-prid' : 'bg-gray-100 text-gray-400',
        )}
      >
        {node.repoCount}
      </span>
    </button>
  );
}

// 右栏明细：标题 + 按项目分节的多列仓库网格。
function GroupDetail({
  org,
  node,
  multiOrg,
  onCopy,
  onOpen,
}: {
  org: string;
  node: RepoGroupNode;
  multiOrg: boolean;
  onCopy: (text: string, what: string) => void;
  onOpen: (url: string) => void;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {multiOrg && <span className="font-mono text-[11.5px] text-gray-400">{org} /</span>}
        <FolderGit2 size={16} className="text-brand-600" />
        <span className="text-[15px] font-bold text-gray-800">{node.name}</span>
        <span className="text-[11.5px] text-gray-400">
          {node.projects.length} 项目 · {node.repoCount} 仓库
        </span>
      </div>
      <div className="flex flex-col gap-4">
        {node.projects.map((p) => (
          <div key={p.key}>
            {p.name !== ROOT_PROJECT && (
              <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-gray-500">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" />
                <span className="shrink-0">{p.name}</span>
                <span className="truncate font-mono text-[10px] font-normal text-gray-400">{p.key}</span>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {p.repos.map((r) => (
                <RepoCard key={r.id} repo={r} onCopy={onCopy} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// --------------------------- 仓库卡片 ---------------------------
function RepoCard({
  repo,
  onCopy,
  onOpen,
}: {
  repo: CnbRepo;
  onCopy: (text: string, what: string) => void;
  onOpen: (url: string) => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-gray-50/60 p-3 transition hover:border-brand-300 hover:bg-surface">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-gray-800">{repo.name}</span>
            {repo.visibility && repo.visibility !== 'public' && (
              <span className="shrink-0 rounded bg-gray-200/70 px-1 text-[9px] font-semibold text-gray-500">
                {visLabel(repo.visibility)}
              </span>
            )}
          </div>
          <div className="truncate text-[10.5px] text-gray-400">
            {repo.description || '—'}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2.5 text-[10.5px] text-gray-400">
        {repo.language && (
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-brand-400" />
            {repo.language}
          </span>
        )}
        {typeof repo.stars === 'number' && repo.stars > 0 && (
          <span className="flex items-center gap-0.5">
            <Star size={11} /> {repo.stars}
          </span>
        )}
        {typeof repo.forks === 'number' && repo.forks > 0 && (
          <span className="flex items-center gap-0.5">
            <GitFork size={11} /> {repo.forks}
          </span>
        )}
        {typeof repo.openIssues === 'number' && repo.openIssues > 0 && (
          <span className="flex items-center gap-0.5">
            <CircleDot size={11} /> {repo.openIssues}
          </span>
        )}
        {repo.lastUpdatedAt && (
          <span className="ml-auto shrink-0">{relTime(repo.lastUpdatedAt)}</span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-1 border-t border-gray-100 pt-2">
        <button
          onClick={() => repo.webUrl && onOpen(repo.webUrl)}
          disabled={!repo.webUrl}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-brand-600 hover:bg-brand-50 disabled:opacity-40"
        >
          <ExternalLink size={12} /> 打开
        </button>
        <button
          onClick={() => onCopy(cnbCloneUrl(repo), '仓库地址')}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100"
          title="复制仓库地址"
        >
          <Copy size={12} /> 地址
        </button>
        <button
          onClick={() => onCopy(cnbCloneCommand(repo), 'git clone 命令')}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100"
          title="复制 git clone 命令"
        >
          <Terminal size={12} /> clone
        </button>
        <span className="ml-auto truncate font-mono text-[9.5px] text-gray-300" title={repo.path}>
          {repo.path}
        </span>
      </div>
    </div>
  );
}

function visLabel(v: string): string {
  return v === 'private' ? '私有' : v === 'secret' ? '隐藏' : v === 'public' ? '公开' : v;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

// ---------------------------------------------------------------------------
// cnb.cool 页内改造（无 token）：在「代码仓库」tab 内【就地接管】原生那份平铺、
// 每页 20 条、无限滚动的列表，替换成「子组织 → 项目 → 仓库」两栏 IDE 式分组视图，
// 让仓库读起来像按项目组织的；并提供三路快速定位项目：左侧项目树、全局搜索、
// ⌘K/“/” 命令面板。直接复用你已登录的会话（同源请求自动带 cookie），无需令牌。
//
// 取数：GET cnb.cool/{org}/-/repos?descendant=all&page_size=100（Accept: application/json）
//       → 仓库 JSON 数组（dto.Repos4User 形状），cookie 鉴权。buildRepoTree 分组。
//
// 嵌入与健壮性：软替换（display:none 隐藏原生列表+工具条，不删 DOM）+ 单一 shadow
// host 插到其前；MutationObserver 守护重挂 + Next.js SPA 路由监听；离开 repos 路由
// 复原原生。提供「分组视图 | 原生列表」开关；定位失败时降级为右下角浮动入口。
//
// 注意：走的是网站自用同源接口/DOM，非公开 OpenAPI，cnb 改版可能失效；失效时可用
// 扩展内「代码仓库」整页（官方 api.cnb.cool + 令牌，更稳）。
// ---------------------------------------------------------------------------
import {
  buildRepoTree,
  cnbCloneCommand,
  cnbCloneUrl,
  mapCnbRepo,
  type CnbRepo,
  type RepoGroupNode,
} from '@/lib/cnb';

const PAGE_SIZE = 100;
const MAX_PAGES = 60;
const CACHE_TTL = 10 * 60 * 1000;
const RESERVED_FIRST = new Set([
  'explore', 'login', 'signup', 'signin', 'logout', 'settings', 'dashboard',
  'notifications', 'search', 'help', 'about', 'pricing', 'docs', 'marketplace',
  'u', 'users', 'cnb', 'api', 'assets', '-',
]);

export default defineContentScript({
  matches: ['https://cnb.cool/*'],
  runAt: 'document_idle',
  main() {
    // WXT 打包里的内置 logger 是空操作，崩溃不会进控制台，这里兜底上报真实错误。
    try {
      installRouteHooks();
      scheduleReconcile();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[项目环境管家] CNB 脚本启动失败：', e);
    }
  },
});

// ===========================================================================
// 路由 / 视图判定
// ===========================================================================
function pathSegs(): string[] {
  return location.pathname.split('/').filter(Boolean);
}
/** 顶层组织 slug；非组织作用域返回 null。 */
function detectOrg(): string | null {
  const segs = pathSegs();
  if (segs.length === 0) return null;
  const org = segs[0]!;
  if (RESERVED_FIRST.has(org.toLowerCase())) return null;
  return org;
}
/** 是否在「代码仓库」列表路由 /{org}/-/repos。 */
function isReposRoute(): boolean {
  const s = pathSegs();
  return s.length >= 3 && s[1] === '-' && s[2] === 'repos';
}

// ===========================================================================
// 数据：同源 JSON 接口（无 token），按 org 缓存
// ===========================================================================
const dataCache = new Map<string, { at: number; repos: CnbRepo[] }>();

async function fetchRepoPage(org: string, page: number): Promise<unknown[]> {
  const u = new URL(`${location.origin}/${encodeURIComponent(org)}/-/repos`);
  u.searchParams.set('page', String(page));
  u.searchParams.set('page_size', String(PAGE_SIZE));
  u.searchParams.set('descendant', 'all');
  u.searchParams.set('order_by', 'last_updated_at');
  u.searchParams.set('desc', 'true');
  const res = await fetch(u.toString(), {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`无法读取仓库列表（HTTP ${res.status}）`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? data : [];
}

async function loadRepos(org: string, onProgress: (n: number) => void): Promise<CnbRepo[]> {
  const cached = dataCache.get(org);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.repos;
  const repos: CnbRepo[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const list = await fetchRepoPage(org, page);
    if (list.length === 0) break;
    for (const raw of list) {
      const r = mapCnbRepo(raw);
      if (r.path && !seen.has(r.path)) {
        seen.add(r.path);
        repos.push(r);
      }
    }
    onProgress(repos.length);
    if (list.length < PAGE_SIZE) break;
  }
  dataCache.set(org, { at: Date.now(), repos });
  return repos;
}

// ===========================================================================
// 视图状态（按 org 记忆到 sessionStorage）
// ===========================================================================
interface ViewState {
  query: string;
  chip: string | null; // 选中的子组织 key（null = 全部）
  sort: 'recent' | 'name' | 'count';
  expanded: Record<string, boolean>; // 子组织 key -> 展开
  mode: 'grouped' | 'native';
}
function defaultView(): ViewState {
  return { query: '', chip: null, sort: 'recent', expanded: {}, mode: 'grouped' };
}
function loadView(org: string): ViewState {
  try {
    const raw = sessionStorage.getItem('pem:cnb:view:' + org);
    if (raw) return { ...defaultView(), ...(JSON.parse(raw) as Partial<ViewState>) };
  } catch {
    /* ignore */
  }
  return defaultView();
}
function saveView(org: string, v: ViewState) {
  try {
    sessionStorage.setItem('pem:cnb:view:' + org, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

// ===========================================================================
// 全局运行态
// ===========================================================================
interface Cur {
  org: string;
  repos: CnbRepo[];
  groups: RepoGroupNode[];
  view: ViewState;
  // DOM 引用
  shadow: ShadowRoot;
  navTree: HTMLElement;
  content: HTMLElement;
  crumb: HTMLElement;
  countEl: HTMLElement;
  chipsEl: HTMLElement;
  searchInput: HTMLInputElement;
  cmdk: HTMLElement;
  spy?: IntersectionObserver;
  // 命令面板候选
  cmdkItems: FlatItem[];
  cmdkActive: number;
  loading: boolean;
}
let cur: Cur | null = null;

// 接管态：被隐藏的原生节点、host 引用
let host: HTMLDivElement | null = null;
const hiddenNative = new Set<HTMLElement>();
let bodyObserver: MutationObserver | null = null;
let reconcileQueued = false;
let lastPath = '';
let missCount = 0; // 连续找不到原生列表的次数（用于决定降级 FAB）
let pageMode: 'none' | 'inline' | 'fab' = 'none'; // 当前页面形态，避免在非 repos 页反复 teardown 弄坏浮层状态

// ===========================================================================
// 原生列表定位（结构特征启发式）
// ===========================================================================
function isRepoHref(org: string, href: string): boolean {
  return href.startsWith('/' + org + '/') && !href.includes('/-/') && href.split('/').filter(Boolean).length >= 3;
}
const isVisible = (el: HTMLElement) => el.offsetParent !== null || el.getClientRects().length > 0;
const looksToolbar = (el: Element) =>
  !!el.querySelector('input') || /全部|当前组织|归档|最近更新|知识库/.test(el.textContent || '');

/**
 * 返回当前【可见】的原生仓库列表网格 + 其前面的工具条兄弟。
 * 只认可见网格：一旦被我们 display:none，便返回 null（即「已接管」信号），
 * 从而避免与 React 重绘拉锯。跳过 shadow DOM 内部（我们自己的视图）。
 */
function resolveNative(org: string): { grid: HTMLElement; toolbars: HTMLElement[] } | null {
  let best: HTMLElement | null = null;
  let bestN = 0;
  document.querySelectorAll<HTMLElement>('div,ul,section').forEach((el) => {
    if (el.getRootNode() !== document) return; // 跳过 shadow DOM
    if (!isVisible(el)) return; // 只在「可见」候选里挑：避免选中已被我们隐藏的旧网格而误判已接管
    let c = 0;
    for (const ch of Array.from(el.children)) {
      const a = ch.querySelector?.('a');
      if (a && Array.from(ch.querySelectorAll('a')).some((x) => isRepoHref(org, x.getAttribute('href') || ''))) c++;
    }
    if (c > bestN) {
      bestN = c;
      best = el;
    }
  });
  if (!best || bestN < 3) return null; // 没有可见的原生网格 → 已接管或尚未渲染
  const grid = best as HTMLElement;
  const toolbars: HTMLElement[] = [];
  let p = grid.previousElementSibling as HTMLElement | null;
  while (p && looksToolbar(p)) {
    toolbars.unshift(p);
    p = p.previousElementSibling as HTMLElement | null;
  }
  return { grid, toolbars };
}

// ===========================================================================
// 挂载 / 还原（幂等）
// ===========================================================================
// 用内联 !important 隐藏：压过 cnb 的 Tailwind v4 @layer 规则，且 React 不重绘这些
// 节点（实测），故 display 能稳定保持。
function hideNative(grid: HTMLElement, toolbars: HTMLElement[]) {
  for (const el of [...toolbars, grid]) {
    if (el && el.style.getPropertyValue('display') !== 'none') {
      el.style.setProperty('display', 'none', 'important');
      hiddenNative.add(el);
    }
  }
}
function restoreNative() {
  for (const el of hiddenNative) el.style.removeProperty('display');
  hiddenNative.clear();
}

function withObserverPaused(fn: () => void) {
  bodyObserver?.disconnect();
  try {
    fn();
  } finally {
    bodyObserver?.observe(document.body, { childList: true, subtree: true });
  }
}

function ensureHost(org: string) {
  if (!host) {
    host = document.createElement('div');
    host.id = '__pem_cnb_repos__';
    host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    host.shadowRoot!.appendChild(style);
  }
  host.dataset.org = org;
}

/** 内容主体的稳定容器（语义类名，跨 SPA 渲染稳定）；用于原生列表还没渲染时也能立即落位。 */
function resolveStableMount(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.cnb-layout-container-header-body') ||
    document.querySelector<HTMLElement>('main') ||
    null
  );
}

/** 幂等核心：根据当前路由/视图，保证接管态正确（抗 React 重绘）。 */
function ensureMounted() {
  const org = detectOrg();
  if (!org) {
    if (pageMode !== 'none') {
      teardown();
      removeFab();
      pageMode = 'none';
    }
    missCount = 0;
    return;
  }
  if (!isReposRoute()) {
    // 组织内其它页（概览 / 子组织 / 仓库详情…）：不内联接管，但常驻右下角浮动入口
    if (pageMode !== 'fab') {
      teardown(); // 只在切入时清理一次内联 host，避免反复 teardown 弄坏浮层 cur
      pageMode = 'fab';
    }
    mountFab(org); // 幂等
    missCount = 0;
    return;
  }

  // 「代码仓库」路由：内联接管
  if (pageMode !== 'inline') {
    removeFab();
    pageMode = 'inline';
  }
  const view = cur && cur.org === org ? cur.view : loadView(org);
  const native = resolveNative(org); // 仅返回「可见」的原生列表；被我们隐藏后为 null
  const container = resolveStableMount();
  const takenOver = !!(host && host.isConnected && cur && cur.org === org);

  // 既无原生列表、也无稳定容器、也未接管 → 等待；连续多次仍无 → 降级浮动入口
  if (!native && !container && !takenOver) {
    if (++missCount >= 8) mountFab(org);
    return;
  }
  missCount = 0;
  removeFab();

  withObserverPaused(() => {
    ensureHost(org);
    // host 只插一次（避免移动抖动）：优先原生工具条前，否则稳定容器首部（原生还没渲染时也能立即出现）
    if (!host!.isConnected) {
      if (native) {
        const anchor = native.toolbars[0] || native.grid;
        anchor.parentElement!.insertBefore(host!, anchor);
      } else if (container) {
        container.insertBefore(host!, container.firstChild);
      }
    }
    host!.style.display = '';
    if (view.mode === 'native') restoreNative();
    else if (native) hideNative(native.grid, native.toolbars);
  });

  // 构建/复用视图外壳（React 重绘只重定位 host，不重建 shadow）；缓存命中时秒出
  const shadow = host!.shadowRoot!;
  const fresh = !cur || cur.org !== org || cur.shadow !== shadow || !shadow.querySelector('.ide');
  if (fresh) buildShell(org, view, shadow);
  shadow.querySelector('.ide')?.classList.toggle('collapsed', view.mode === 'native');
  if (view.mode === 'grouped' && cur && cur.repos.length === 0 && !cur.loading) void hydrate(org);
}

function teardown() {
  withObserverPaused(() => {
    restoreNative();
    if (host) host.remove();
  });
  cur?.spy?.disconnect();
  cur = null;
}

// ===========================================================================
// UI：外壳（两栏 IDE）
// ===========================================================================
function buildShell(org: string, view: ViewState, shadow: ShadowRoot) {
  shadow.querySelector('.ide')?.remove();
  shadow.querySelector('.fallback-overlay')?.remove();

  const ide = el('div', 'ide');
  ide.innerHTML = `
    <div class="toolbar">
      <div class="tb-title"><span class="folder">${ICON_FOLDER}</span><b>${esc(org)}</b><span class="count muted"></span></div>
      <div class="tb-search">
        <span class="si">${ICON_SEARCH}</span>
        <input class="search" placeholder="搜索项目 / 仓库 / 路径   ⌘K" />
        <div class="cmdk"></div>
      </div>
      <select class="sort" title="排序">
        <option value="recent">最近更新</option>
        <option value="count">仓库数</option>
        <option value="name">名称</option>
      </select>
      <button class="tb-btn expand" title="展开 / 折叠全部">全部展开</button>
      <div class="seg">
        <button class="seg-b on" data-mode="grouped">分组</button>
        <button class="seg-b" data-mode="native">原生</button>
      </div>
    </div>
    <div class="chips"></div>
    <div class="body">
      <aside class="nav">
        <div class="nav-top">
          <input class="nav-filter" placeholder="过滤项目 / 子组织" />
        </div>
        <div class="tree"></div>
      </aside>
      <main class="content">
        <div class="crumb muted"></div>
        <div class="list"></div>
      </main>
    </div>
    <button class="totop" title="回到顶部">${ICON_UP}</button>`;
  shadow.appendChild(ide);

  const searchInput = ide.querySelector<HTMLInputElement>('.search')!;
  const sortSel = ide.querySelector<HTMLSelectElement>('.sort')!;
  sortSel.value = view.sort;
  searchInput.value = view.query;

  cur = {
    org,
    repos: [],
    groups: [],
    view,
    shadow,
    navTree: ide.querySelector('.tree')!,
    content: ide.querySelector('.list')!,
    crumb: ide.querySelector('.crumb')!,
    countEl: ide.querySelector('.count')!,
    chipsEl: ide.querySelector('.chips')!,
    searchInput,
    cmdk: ide.querySelector('.cmdk')!,
    cmdkItems: [],
    cmdkActive: -1,
    loading: false,
  };

  // 事件
  searchInput.addEventListener('input', debounce(() => {
    setView({ query: searchInput.value });
    applyView();
    updateCmdk(searchInput.value);
  }, 80));
  searchInput.addEventListener('keydown', onSearchKey);
  sortSel.addEventListener('change', () => {
    setView({ sort: sortSel.value as ViewState['sort'] });
    applyView();
  });
  ide.querySelector('.nav-filter')!.addEventListener('input', debounce(() => renderNav(), 60));
  const expandBtn = ide.querySelector<HTMLButtonElement>('.expand')!;
  expandBtn.addEventListener('click', () => toggleExpandAll(expandBtn));
  ide.querySelectorAll<HTMLButtonElement>('.seg-b').forEach((b) =>
    b.addEventListener('click', () => switchMode(b.dataset.mode as ViewState['mode'])),
  );
  const totop = ide.querySelector<HTMLButtonElement>('.totop')!;
  const scroller = cur.content.parentElement!;
  scroller.addEventListener('scroll', () => {
    totop.classList.toggle('show', scroller.scrollTop > 600);
  });
  totop.addEventListener('click', () => scroller.scrollTo({ top: 0, behavior: 'smooth' }));

  // 全局键盘（⌘K / “/”）
  shadow.addEventListener('keydown', onShadowKey as EventListener);
}

function switchMode(mode: ViewState['mode']) {
  if (!cur) return;
  setView({ mode });
  cur.shadow.querySelectorAll<HTMLButtonElement>('.seg-b').forEach((b) =>
    b.classList.toggle('on', b.dataset.mode === mode),
  );
  ensureMounted();
}

async function hydrate(org: string) {
  if (!cur || cur.loading) return;
  cur.loading = true;
  cur.content.innerHTML = `<p class="loading">正在读取仓库…</p>`;
  try {
    const repos = await loadRepos(org, (n) => {
      const ld = cur?.content.querySelector('.loading');
      if (ld) ld.textContent = `正在读取仓库… 已获取 ${n} 个`;
    });
    if (!cur || cur.org !== org) return;
    cur.repos = repos;
    applyView();
  } catch (e) {
    if (cur) cur.content.innerHTML = `<p class="err">读取失败：${esc(e instanceof Error ? e.message : String(e))}</p>`;
  } finally {
    if (cur) cur.loading = false;
  }
}

// ===========================================================================
// 视图计算 + 渲染
// ===========================================================================
function setView(patch: Partial<ViewState>) {
  if (!cur) return;
  cur.view = { ...cur.view, ...patch };
  saveView(cur.org, cur.view);
}

function sortGroups(groups: RepoGroupNode[], sort: ViewState['sort']): RepoGroupNode[] {
  const gs = groups.map((g) => ({
    ...g,
    projects: g.projects.map((p) => ({ ...p, repos: sortRepos(p.repos, sort) })),
  }));
  if (sort === 'name') {
    gs.sort((a, b) => a.key.localeCompare(b.key));
    for (const g of gs) g.projects.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // recent / count：保留 buildRepoTree 的「子组织按仓库数倒序」，__root__ 末尾
    gs.sort((a, b) => (a.key === '__root__' ? 1 : b.key === '__root__' ? -1 : b.repoCount - a.repoCount));
  }
  return gs;
}
function sortRepos(repos: CnbRepo[], sort: ViewState['sort']): CnbRepo[] {
  const r = repos.slice();
  if (sort === 'name') r.sort((a, b) => a.name.localeCompare(b.name));
  else r.sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));
  return r;
}

/** 当前过滤后的分组（应用 chip + 搜索 + 排序）。 */
function computeGroups(): RepoGroupNode[] {
  if (!cur) return [];
  const q = cur.view.query.trim().toLowerCase();
  let repos = cur.repos;
  if (q) repos = repos.filter((r) => `${r.path} ${r.description ?? ''}`.toLowerCase().includes(q));
  let groups = buildRepoTree(cur.org, repos);
  if (cur.view.chip) groups = groups.filter((g) => g.key === cur!.view.chip);
  return sortGroups(groups, cur.view.sort);
}

function applyView() {
  if (!cur) return;
  cur.groups = computeGroups();
  renderChips();
  renderNav();
  renderContent();
  cur.cmdkItems = buildFlatIndex(cur.org, cur.repos);
}

function renderChips() {
  if (!cur) return;
  const all = buildRepoTree(cur.org, cur.repos);
  const total = cur.repos.length;
  const parts: string[] = [
    `<button class="chip ${cur.view.chip === null ? 'on' : ''}" data-k="">全部 <i>${total}</i></button>`,
  ];
  for (const g of all) {
    parts.push(
      `<button class="chip ${cur.view.chip === g.key ? 'on' : ''}" data-k="${esc(g.key)}">${esc(g.name)} <i>${g.repoCount}</i></button>`,
    );
  }
  cur.chipsEl.innerHTML = parts.join('');
  cur.chipsEl.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) =>
    b.addEventListener('click', () => {
      setView({ chip: b.dataset.k || null });
      applyView();
    }),
  );
}

function renderNav() {
  if (!cur) return;
  const filter = (cur.shadow.querySelector<HTMLInputElement>('.nav-filter')?.value || '').trim().toLowerCase();
  const groups = cur.groups;
  cur.navTree.innerHTML = '';
  const matchCount = { v: 0 };
  for (const g of groups) {
    const projs = g.projects.filter(
      (p) => !filter || g.name.toLowerCase().includes(filter) || p.name.toLowerCase().includes(filter) || p.key.toLowerCase().includes(filter),
    );
    if (filter && projs.length === 0 && !g.name.toLowerCase().includes(filter)) continue;
    const open = filter ? true : cur.view.expanded[g.key] ?? false;
    const gEl = el('div', 'tg');
    const head = el('div', 'tg-hd');
    head.innerHTML = `<span class="caret ${open ? 'open' : ''}">▸</span><span class="tg-name">${esc(g.name)}</span><span class="tg-n">${g.repoCount}</span>`;
    head.addEventListener('click', () => {
      const exp = { ...cur!.view.expanded, [g.key]: !(cur!.view.expanded[g.key] ?? false) };
      setView({ expanded: exp });
      renderNav();
    });
    gEl.appendChild(head);
    if (open) {
      const wrap = el('div', 'tg-bd');
      for (const p of projs) {
        matchCount.v++;
        const pEl = el('button', 'tp');
        pEl.dataset.target = 'pj-' + slug(p.key);
        pEl.innerHTML = `<span class="tp-name">${esc(p.name)}</span><span class="tp-n">${p.repos.length}</span>`;
        pEl.addEventListener('click', () => jumpToProject('pj-' + slug(p.key)));
        wrap.appendChild(pEl);
      }
      gEl.appendChild(wrap);
    }
    cur.navTree.appendChild(gEl);
  }
  if (cur.navTree.children.length === 0) cur.navTree.innerHTML = `<p class="muted nav-empty">无匹配</p>`;
}

function renderContent() {
  if (!cur) return;
  const groups = cur.groups;
  const shown = groups.reduce((n, g) => n + g.repoCount, 0);
  const projCount = groups.reduce((n, g) => n + g.projects.length, 0);
  const total = cur.repos.length;
  const subN = buildRepoTree(cur.org, cur.repos).length;
  cur.countEl.textContent =
    cur.view.query || cur.view.chip
      ? `· ${shown} / ${total} 仓库`
      : `· ${total} 仓库 · ${subN} 子组织 · ${projCount} 项目`;

  cur.content.innerHTML = '';
  if (groups.length === 0) {
    cur.content.innerHTML = `<p class="loading">没有匹配的仓库</p>`;
    return;
  }
  const filtering = !!cur.view.query;
  for (const g of groups) {
    const sec = el('section', 'grp');
    sec.id = 'so-' + slug(g.key);
    const sh = el('div', 'grp-hd');
    sh.innerHTML = `<b>${esc(g.name)}</b><span class="muted">${g.projects.length} 项目 · ${g.repoCount} 仓库</span>`;
    sec.appendChild(sh);
    for (const p of g.projects) {
      const block = el('div', 'proj');
      block.id = 'pj-' + slug(p.key);
      block.innerHTML = `<div class="proj-hd"><span class="dot"></span>${esc(p.name)}<span class="path">${esc(p.key)}</span></div>`;
      const grid = el('div', 'grid');
      for (const r of p.repos) grid.appendChild(repoCard(r, filtering ? cur.view.query.trim() : ''));
      block.appendChild(grid);
      sec.appendChild(block);
    }
    cur.content.appendChild(sec);
  }
  installSpy();
}

// ===========================================================================
// 找项目：左树跳转 + scrollspy + 命令面板
// ===========================================================================
function jumpToProject(id: string) {
  if (!cur) return;
  const target = cur.shadow.getElementById(id);
  if (!target) return;
  programmaticScroll = true;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.add('focus');
  setTimeout(() => target.classList.remove('focus'), 1200);
  setActiveNav(id);
  setTimeout(() => (programmaticScroll = false), 700);
}

let programmaticScroll = false;
function installSpy() {
  if (!cur) return;
  cur.spy?.disconnect();
  const blocks = Array.from(cur.content.querySelectorAll<HTMLElement>('.proj'));
  cur.spy = new IntersectionObserver(
    (entries) => {
      if (programmaticScroll) return;
      const top = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActiveNav(top.target.id, top.target);
    },
    { root: cur.content.parentElement, rootMargin: '0px 0px -70% 0px', threshold: 0 },
  );
  for (const b of blocks) cur.spy.observe(b);
}
function setActiveNav(id: string, block?: Element | null) {
  if (!cur) return;
  cur.navTree.querySelectorAll('.tp.active').forEach((e) => e.classList.remove('active'));
  const node = cur.navTree.querySelector<HTMLElement>(`.tp[data-target="${cssEsc(id)}"]`);
  if (node) {
    node.classList.add('active');
    node.scrollIntoView({ block: 'nearest' });
  }
  const el2 = block || cur.shadow.getElementById(id);
  if (el2) {
    const name = el2.querySelector('.proj-hd')?.childNodes[1]?.textContent?.trim() || '';
    const path = el2.querySelector('.proj-hd .path')?.textContent || '';
    cur.crumb.textContent = path ? `${path}` : name;
  }
}

function toggleExpandAll(btn: HTMLButtonElement) {
  if (!cur) return;
  const all = buildRepoTree(cur.org, cur.repos);
  const anyClosed = all.some((g) => !(cur!.view.expanded[g.key] ?? false));
  const exp: Record<string, boolean> = {};
  for (const g of all) exp[g.key] = anyClosed;
  setView({ expanded: exp });
  btn.textContent = anyClosed ? '全部折叠' : '全部展开';
  renderNav();
}

// --- 命令面板（搜索框驱动）-------------------------------------------------
interface FlatItem {
  kind: 'project' | 'repo';
  label: string;
  sub: string; // 面包屑
  targetId: string;
  url?: string;
  haystack: string;
}
function buildFlatIndex(org: string, repos: CnbRepo[]): FlatItem[] {
  const groups = buildRepoTree(org, repos);
  const items: FlatItem[] = [];
  for (const g of groups) {
    for (const p of g.projects) {
      items.push({
        kind: 'project',
        label: p.name,
        sub: `${g.name} › ${p.repos.length} 仓库`,
        targetId: 'pj-' + slug(p.key),
        haystack: `${p.name} ${p.key} ${g.name}`.toLowerCase(),
      });
      for (const r of p.repos) {
        items.push({
          kind: 'repo',
          label: r.name,
          sub: r.path,
          targetId: 'pj-' + slug(p.key),
          url: r.webUrl,
          haystack: `${r.path} ${r.description ?? ''}`.toLowerCase(),
        });
      }
    }
  }
  return items;
}
function fuzzyScore(q: string, h: string): number {
  if (!q) return 0;
  const i = h.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 70 - Math.min(40, i);
  // 子序列
  let qi = 0;
  for (let k = 0; k < h.length && qi < q.length; k++) if (h[k] === q[qi]) qi++;
  return qi === q.length ? 30 : -1;
}
function updateCmdk(query: string) {
  if (!cur) return;
  const q = query.trim().toLowerCase();
  if (!q) {
    cur.cmdk.classList.remove('show');
    cur.cmdk.innerHTML = '';
    cur.cmdkActive = -1;
    return;
  }
  const scored = cur.cmdkItems
    .map((it) => ({ it, s: it.kind === 'project' ? fuzzyScore(q, it.label.toLowerCase()) + 10 : fuzzyScore(q, it.haystack) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  if (scored.length === 0) {
    cur.cmdk.classList.remove('show');
    cur.cmdk.innerHTML = '';
    cur.cmdkActive = -1;
    return;
  }
  cur.cmdkActive = 0;
  cur.cmdk.innerHTML = scored
    .map(
      ({ it }, i) =>
        `<div class="cmdk-item ${i === 0 ? 'on' : ''}" data-id="${esc(it.targetId)}" data-url="${esc(it.url || '')}" data-kind="${it.kind}">
          <span class="ck-ic">${it.kind === 'project' ? ICON_FOLDER : ICON_REPO}</span>
          <span class="ck-main"><b>${esc(it.label)}</b><span class="ck-sub">${esc(it.sub)}</span></span>
          <span class="ck-tag">${it.kind === 'project' ? '项目' : '仓库'}</span>
        </div>`,
    )
    .join('');
  cur.cmdk.classList.add('show');
  cur.cmdk.querySelectorAll<HTMLElement>('.cmdk-item').forEach((node, i) => {
    node.addEventListener('mouseenter', () => setCmdkActive(i));
    node.addEventListener('mousedown', (e) => {
      e.preventDefault();
      activateCmdk(node);
    });
  });
}
function setCmdkActive(i: number) {
  if (!cur) return;
  const items = Array.from(cur.cmdk.querySelectorAll<HTMLElement>('.cmdk-item'));
  if (!items.length) return;
  cur.cmdkActive = (i + items.length) % items.length;
  items.forEach((n, k) => n.classList.toggle('on', k === cur!.cmdkActive));
  items[cur.cmdkActive]?.scrollIntoView({ block: 'nearest' });
}
function activateCmdk(node: HTMLElement) {
  const id = node.dataset.id || '';
  const url = node.dataset.url || '';
  const kind = node.dataset.kind || '';
  if (kind === 'repo' && url) {
    window.open(url, '_blank', 'noopener');
  } else {
    jumpToProject(id);
  }
  closeCmdk();
}
function closeCmdk() {
  if (!cur) return;
  cur.cmdk.classList.remove('show');
  cur.cmdk.innerHTML = '';
  cur.cmdkActive = -1;
}
function onSearchKey(e: KeyboardEvent) {
  if (!cur) return;
  const items = Array.from(cur.cmdk.querySelectorAll<HTMLElement>('.cmdk-item'));
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.length) setCmdkActive(cur.cmdkActive + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length) setCmdkActive(cur.cmdkActive - 1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const node = items[cur.cmdkActive] || items[0];
    if (node) activateCmdk(node);
  } else if (e.key === 'Escape') {
    if (cur.searchInput.value) {
      cur.searchInput.value = '';
      setView({ query: '' });
      applyView();
    }
    closeCmdk();
  }
}
function onShadowKey(e: KeyboardEvent) {
  if (!cur) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    cur.searchInput.focus();
    cur.searchInput.select();
  } else if (e.key === '/' && document.activeElement !== cur.searchInput) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      cur.searchInput.focus();
    }
  }
}

// ===========================================================================
// 仓库卡片
// ===========================================================================
function repoCard(r: CnbRepo, hl: string): HTMLElement {
  const card = el('div', 'card');
  const vis = r.visibility && r.visibility !== 'public' ? visLabel(r.visibility) : '';
  const meta: string[] = [];
  if (r.language) meta.push(`<span class="lang">●</span>${esc(r.language)}`);
  if (r.stars) meta.push(`★ ${r.stars}`);
  if (r.lastUpdatedAt) meta.push(relTime(r.lastUpdatedAt));
  card.innerHTML = `
    <div class="card-top">
      <a class="name" href="${esc(r.webUrl || '#')}" target="_blank" rel="noopener">${hl ? mark(r.name, hl) : esc(r.name)}</a>
      ${vis ? `<span class="badge">${esc(vis)}</span>` : ''}
    </div>
    <div class="desc">${esc(r.description || '—')}</div>
    <div class="meta">${meta.join('<span class="sep">·</span>')}</div>
    <div class="acts">
      <a class="act open" href="${esc(r.webUrl || '#')}" target="_blank" rel="noopener">打开</a>
      <button class="act copy" data-v="${esc(cnbCloneUrl(r))}">复制地址</button>
      <button class="act copy" data-v="${esc(cnbCloneCommand(r))}">复制 clone</button>
    </div>`;
  card.querySelectorAll<HTMLButtonElement>('.copy').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.getAttribute('data-v') || '';
      navigator.clipboard?.writeText(v).then(() => flashBtn(b, '已复制'), () => flashBtn(b, '复制失败'));
    }),
  );
  return card;
}
function flashBtn(b: HTMLButtonElement, text: string) {
  const old = b.textContent;
  b.textContent = text;
  b.classList.add('ok');
  setTimeout(() => {
    b.textContent = old;
    b.classList.remove('ok');
  }, 1200);
}

// ===========================================================================
// 降级：定位失败时的右下角浮动入口（打开全屏分组浮层）
// ===========================================================================
let fab: HTMLDivElement | null = null;
function mountFab(org: string) {
  if (fab) return;
  fab = document.createElement('div');
  fab.id = '__pem_cnb_fab__';
  const sh = fab.attachShadow({ mode: 'open' });
  const st = document.createElement('style');
  st.textContent = CSS;
  sh.appendChild(st);
  const btn = el('button', 'fab');
  btn.innerHTML = `${ICON_FOLDER}<span>按项目分组</span>`;
  btn.addEventListener('click', () => openFallbackOverlay(org, sh));
  sh.appendChild(btn);
  document.body.appendChild(fab);
}
function removeFab() {
  fab?.remove();
  fab = null;
}
async function openFallbackOverlay(org: string, shadow: ShadowRoot) {
  shadow.querySelector('.fallback-overlay')?.remove();
  // 先 buildShell（它会清掉旧的 .ide / .fallback-overlay），再把新建的浮层加进来，
  // 避免浮层刚加就被 buildShell 清掉。浮层里恒为分组视图（不折叠）。
  buildShell(org, { ...loadView(org), mode: 'grouped' }, shadow);
  const ide = shadow.querySelector('.ide');
  const ov = el('div', 'fallback-overlay');
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) close();
  });
  document.addEventListener('keydown', onKey);
  const panel = el('div', 'fb-panel');
  if (ide) panel.appendChild(ide);
  ov.appendChild(panel);
  shadow.appendChild(ov);
  void hydrate(org);
}

// ===========================================================================
// 观察器 / 路由
// ===========================================================================
function scheduleReconcile() {
  if (reconcileQueued) return;
  reconcileQueued = true;
  requestAnimationFrame(() => {
    setTimeout(() => {
      reconcileQueued = false;
      try {
        ensureMounted();
      } catch {
        /* ignore */
      }
    }, 120);
  });
}
function installRouteHooks() {
  // body 守护：被 React 重绘后重挂
  bodyObserver = new MutationObserver(() => scheduleReconcile());
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  // SPA 路由：包裹 pushState/replaceState
  const origPush = history.pushState.bind(history);
  history.pushState = (...args: Parameters<History['pushState']>) => {
    const r = origPush(...args);
    onRoute();
    return r;
  };
  const origReplace = history.replaceState.bind(history);
  history.replaceState = (...args: Parameters<History['replaceState']>) => {
    const r = origReplace(...args);
    onRoute();
    return r;
  };
  window.addEventListener('popstate', onRoute);
  // 兜底轮询
  setInterval(() => {
    if (location.pathname !== lastPath) onRoute();
  }, 600);
  lastPath = location.pathname;
}
function onRoute() {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  scheduleReconcile();
}

// ===========================================================================
// 工具
// ===========================================================================
function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function cssEsc(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
function mark(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}
function visLabel(v: string): string {
  return v === 'private' ? '私有' : v === 'secret' ? '隐藏' : v === 'public' ? '公开' : v;
}
function relTime(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo} 个月前` : `${Math.floor(mo / 12)} 年前`;
}
function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...a: never[]) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}

const ICON_FOLDER =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
const ICON_REPO =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a6 6 0 0 1-6 6H9"/></svg>';
const ICON_SEARCH =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_UP =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.muted { color: #94a3b8; font-weight: 400; }
.loading, .err { text-align: center; color: #94a3b8; font-size: 13px; padding: 40px 0; }
.err { color: #e11d48; }

/* 接管区外壳 */
.ide { position: relative; display: flex; flex-direction: column; border: 1px solid #e5e9ee; border-radius: 12px; background: #fff; overflow: hidden; margin: 4px 0 12px; }
.toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #eef1f4; }
.tb-title { display: flex; align-items: center; gap: 6px; font-size: 14px; color: #0f172a; white-space: nowrap; }
.tb-title .folder { color: #ff6200; display: inline-flex; }
.tb-title .count { font-size: 12px; }
.tb-search { position: relative; flex: 1; min-width: 180px; }
.tb-search .si { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #94a3b8; display: inline-flex; }
.search { width: 100%; height: 34px; padding: 0 12px 0 30px; border: 1px solid #d1d5db; border-radius: 9px; font-size: 13px; outline: none; }
.search:focus { border-color: #ff6200; box-shadow: 0 0 0 3px rgba(255,98,0,.12); }
.sort { height: 34px; border: 1px solid #d1d5db; border-radius: 9px; font-size: 12px; padding: 0 6px; color: #475569; background: #fff; }
.tb-btn { height: 34px; padding: 0 10px; border: 1px solid #d1d5db; border-radius: 9px; background: #fff; color: #475569; font-size: 12px; cursor: pointer; white-space: nowrap; }
.tb-btn:hover { background: #f8fafc; }
.seg { display: flex; border: 1px solid #d1d5db; border-radius: 9px; overflow: hidden; }
.seg-b { height: 34px; padding: 0 11px; border: none; background: #fff; color: #64748b; font-size: 12px; cursor: pointer; }
.seg-b.on { background: #ff6200; color: #fff; }

.ide.collapsed .chips, .ide.collapsed .body { display: none; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px 14px; border-bottom: 1px solid #eef1f4; max-height: 84px; overflow: auto; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border: 1px solid #e2e8f0; border-radius: 999px; background: #fff; color: #475569; font-size: 12px; cursor: pointer; }
.chip i { font-style: normal; color: #94a3b8; font-size: 11px; }
.chip:hover { border-color: #fdba74; }
.chip.on { background: #ff6200; color: #fff; border-color: #ff6200; }
.chip.on i { color: #ffd5ae; }

.body { display: grid; grid-template-columns: 244px 1fr; height: 74vh; min-height: 480px; }
.nav { border-right: 1px solid #eef1f4; background: #fbfcfd; display: flex; flex-direction: column; min-height: 0; }
.nav-top { padding: 10px; border-bottom: 1px solid #eef1f4; }
.nav-filter { width: 100%; height: 30px; padding: 0 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 12px; outline: none; }
.nav-filter:focus { border-color: #ff6200; }
.tree { flex: 1; overflow: auto; padding: 6px; }
.nav-empty { padding: 24px 0; font-size: 12px; }
.tg-hd { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.tg-hd:hover { background: #f1f5f9; }
.tg-hd .caret { color: #94a3b8; font-size: 11px; transition: transform .15s; display: inline-block; }
.tg-hd .caret.open { transform: rotate(90deg); }
.tg-name { flex: 1; font-size: 12.5px; font-weight: 700; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tg-n { font-size: 10.5px; color: #94a3b8; }
.tg-bd { padding: 2px 0 4px 14px; }
.tp { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; padding: 5px 8px; border: none; background: none; border-radius: 7px; cursor: pointer; }
.tp:hover { background: #eef2f6; }
.tp.active { background: #ffedd5; }
.tp-name { flex: 1; font-size: 12px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tp.active .tp-name { color: #d65200; font-weight: 600; }
.tp-n { font-size: 10px; color: #cbd5e1; }

.content { position: relative; overflow: auto; padding: 14px 16px; background: #fafbfc; min-height: 0; }
.crumb { position: sticky; top: -14px; z-index: 2; background: #fafbfc; padding: 2px 0 8px; font-size: 11px; font-family: ui-monospace, monospace; }
.grp { margin-bottom: 14px; }
.grp-hd { position: sticky; top: 12px; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-bottom: 6px; background: rgba(250,251,252,.92); backdrop-filter: blur(3px); border-radius: 7px; }
.grp-hd b { font-size: 13.5px; color: #0f172a; }
.grp-hd .muted { font-size: 11px; }
.proj { margin: 0 0 12px; scroll-margin-top: 44px; border-radius: 10px; }
.proj.focus { box-shadow: inset 3px 0 0 #ff6200; background: #fff7ed; }
.proj-hd { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: #64748b; margin: 4px 0 7px; padding-left: 6px; }
.proj-hd .dot { width: 6px; height: 6px; border-radius: 50%; background: #fb923c; }
.proj-hd .path { font-weight: 400; color: #cbd5e1; font-family: ui-monospace, monospace; font-size: 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(264px, 1fr)); gap: 8px; }
.card { border: 1px solid #e5e9ee; border-radius: 10px; padding: 9px 11px; background: #fff; transition: border-color .15s, box-shadow .15s; }
.card:hover { border-color: #fdba74; box-shadow: 0 4px 12px -6px rgba(255,98,0,.4); }
.card-top { display: flex; align-items: center; gap: 6px; }
.name { font-size: 13px; font-weight: 600; color: #d65200; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.name:hover { text-decoration: underline; }
.name mark { background: #fde68a; color: inherit; border-radius: 2px; }
.badge { font-size: 9px; font-weight: 600; color: #64748b; background: #f1f5f9; border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
.desc { font-size: 11px; color: #94a3b8; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: #94a3b8; margin-top: 6px; }
.meta .lang { color: #fb923c; }
.meta .sep { color: #e2e8f0; }
.acts { display: flex; gap: 6px; margin-top: 8px; border-top: 1px solid #f1f5f9; padding-top: 7px; }
.act { font-size: 11px; color: #475569; background: #f8fafc; border: 1px solid #eef1f4; border-radius: 7px; padding: 3px 8px; cursor: pointer; text-decoration: none; }
.act:hover { background: #f1f5f9; }
.act.open { color: #ff6200; }
.act.copy.ok { background: #ffedd5; color: #d65200; border-color: #fed7aa; }

.totop { position: absolute; right: 18px; bottom: 16px; z-index: 5; width: 36px; height: 36px; border-radius: 50%; border: 1px solid #e2e8f0; background: #fff; color: #ff6200; cursor: pointer; display: none; align-items: center; justify-content: center; box-shadow: 0 4px 14px -4px rgba(0,0,0,.25); }
.totop.show { display: inline-flex; }

/* 命令面板 */
.cmdk { position: absolute; left: 0; right: 0; top: 38px; z-index: 30; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: 0 16px 40px -10px rgba(0,0,0,.3); padding: 4px; display: none; max-height: 360px; overflow: auto; }
.cmdk.show { display: block; }
.cmdk-item { display: flex; align-items: center; gap: 9px; padding: 7px 9px; border-radius: 8px; cursor: pointer; }
.cmdk-item.on { background: #fff7ed; }
.ck-ic { color: #ff6200; display: inline-flex; }
.ck-main { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.ck-main b { font-size: 12.5px; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ck-sub { font-size: 10.5px; color: #94a3b8; font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ck-tag { font-size: 9.5px; color: #64748b; background: #f1f5f9; border-radius: 4px; padding: 1px 5px; }

/* 降级浮层 + FAB */
.fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: flex; align-items: center; gap: 7px; padding: 9px 14px; border: none; border-radius: 999px; cursor: pointer; background: #ff6200; color: #fff; font-size: 13px; font-weight: 600; box-shadow: 0 6px 20px -4px rgba(255,98,0,.5); }
.fab:hover { transform: translateY(-1px); }
.fallback-overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; padding: 24px; }
.fb-panel { width: min(1100px, 96vw); height: 88vh; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 24px 60px -12px rgba(0,0,0,.5); display: flex; flex-direction: column; }
.fb-panel .ide { border: none; border-radius: 0; margin: 0; flex: 1; min-height: 0; }
.fb-panel .body { height: auto; flex: 1; }
`;

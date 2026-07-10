import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Bell,
  BellOff,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogIn,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { LockScreen } from '@/components/LockScreen';
import { TotpBadge } from '@/components/TotpBadge';
import { Button, Input, cx } from '@/components/ui';
import { useVault } from '@/hooks/useVault';
import {
  fillCredentialsInPage,
  getOrigin,
  isSameSite,
  registrableDomain,
} from '@/lib/autofill';
import { copyWithAutoClear } from '@/lib/clipboard';
import { envSwitchTargets } from '@/lib/env-switch';
import { api } from '@/lib/messaging';
import { applyTheme, watchSystemTheme } from '@/lib/theme';
import { entryMatchesUrl, flatten, matchForUrl, search, type FlatEntry } from '@/lib/search';
import { getUsage, recordUse } from '@/lib/usage';
import type { CapturePending, EnvKind } from '@/lib/types';
import { allWorkspacesData } from '@/lib/workspace';
import { ENV_KIND_COLORS, ENV_KIND_LABELS, linkUrls, produce } from '@/lib/vault-ops';

const POPUP_RESULT_LIMIT = 30;

export default function App() {
  const vault = useVault();
  const { status, data, loading } = vault;

  const [tab, setTab] = useState<{ id?: number; url?: string; title?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState<CapturePending | null>(null);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [quickLinkId, setQuickLinkId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [selectedCaptureAccountId, setSelectedCaptureAccountId] = useState('');
  // 顶层没找到密码框、但登录表单在同主域的跨域 iframe 里时，引导一键授权该 iframe 域名后填充。
  const [needGrant, setNeedGrant] = useState<{ entry: FlatEntry; origin: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingNeedsLocation =
    pending?.kind === 'new' && !pending.targetLinkId && !(pending.saveTargets?.length);

  async function doSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.syncNow();
      flash('已同步');
    } catch (e) {
      flash('同步失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (status && !status.locked) {
      api.capturePending().then(setPending).catch(() => {});
      getUsage().then(setUsage).catch(() => {});
    }
  }, [status]);

  useEffect(() => {
    setSelectedCaptureAccountId(pending?.accountId || pending?.updateCandidates?.[0]?.accountId || '');
  }, [pending?.id, pending?.accountId, pending?.updateCandidates]);

  useEffect(() => {
    applyTheme(data?.settings.theme);
    return watchSystemTheme(() => data?.settings.theme);
  }, [data?.settings.theme]);

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => setTab(t ? { id: t.id, url: t.url, title: t.title } : null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!status || status.locked || !tab?.id || !tab.url || !getOrigin(tab.url)) return;
    browser.scripting
      .executeScript({
        target: { tabId: tab.id },
        files: ['/web-assist.js'],
      })
      .catch(() => {});
  }, [status, tab?.id, tab?.url]);

  const flash = (m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  const matched = useMemo(
    // 跨全部工作区匹配当前网站：工作区只用于展示分组，其它工作区存的账号也要在此可填。
    () => (data && tab?.url ? matchForUrl(allWorkspacesData(data), tab.url) : []),
    [data, tab],
  );
  const rawResults = useMemo(
    () => (data && query.trim() ? search(data, query) : []),
    [data, query],
  );
  const results = useMemo(() => rawResults.slice(0, POPUP_RESULT_LIMIT), [rawResults]);
  const hiddenResultCount = Math.max(0, rawResults.length - results.length);
  const envSwitch = useMemo(
    () => (data && tab?.url ? envSwitchTargets(data, tab.url) : null),
    [data, tab],
  );
  // 无当前站点匹配时(如新标签页)的兜底：收藏 + 最近使用,当作快捷启动器。
  // 收藏只展示「每个收藏链接一个代表账号」并限量，避免收藏的项目把整列账号刷屏。
  const favorites = useMemo(() => {
    if (!data) return [];
    const favIds = new Set(data.projects.filter((p) => p.favorite).map((p) => p.id));
    if (favIds.size === 0) return [];
    const seenLink = new Set<string>();
    const out: FlatEntry[] = [];
    for (const e of flatten(data)) {
      if (!favIds.has(e.projectId) || seenLink.has(e.linkId)) continue;
      seenLink.add(e.linkId);
      out.push(e);
      if (out.length >= 8) break;
    }
    return out;
  }, [data]);
  const recent = useMemo(() => {
    if (!data) return [];
    const exclude = new Set([
      ...matched.map((e) => e.accountId),
      ...favorites.map((e) => e.accountId),
    ]);
    return flatten(data)
      .filter((e) => usage[e.accountId] && !exclude.has(e.accountId))
      .sort((a, b) => usage[b.accountId]! - usage[a.accountId]!)
      .slice(0, 6);
  }, [data, usage, matched, favorites]);
  // 所有链接(扁平,带项目/环境路径标签),用于「把当前网址加入已有链接」。
  const allLinks = useMemo(() => {
    if (!data) return [];
    const out: { id: string; label: string }[] = [];
    for (const p of data.projects)
      for (const e of p.environments)
        for (const l of e.links) out.push({ id: l.id, label: `${p.name} / ${e.name} / ${l.name}` });
    return out;
  }, [data]);
  const pageOrigin = tab?.url ? getOrigin(tab.url) : null;
  // 只有 http(s) 网页能注入内容脚本读取输入；chrome:// / chrome-extension:// / file:// 等一律不行。
  const canCapture = !!pageOrigin;
  // 当前站点在按站点静默名单里：网页浮层不再自动弹填充/保存提示。
  const siteMuted =
    !!pageOrigin && (data?.settings.assistMutedOrigins ?? []).includes(pageOrigin);

  async function toggleSiteMute() {
    if (!data || !pageOrigin) return;
    try {
      await vault.save(
        produce(data, (d) => {
          const list = d.settings.assistMutedOrigins ?? [];
          d.settings.assistMutedOrigins = siteMuted
            ? list.filter((o) => o !== pageOrigin)
            : [...list, pageOrigin];
        }),
      );
      flash(siteMuted ? '已恢复此网站的自动提示' : '此网站不再自动弹出提示');
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    }
  }

  // 注入填充：site 非空时按「所有 frame + 同主域护栏」注入，使登录表单在同主域跨域 iframe
  // （如阿里云 passport.aliyun.com）里也能被填；site 为空时退回只填顶层 frame。聚合各 frame 结果。
  async function injectFill(tabId: number, entry: FlatEntry) {
    const site = siteOf(entry.url);
    const res = await browser.scripting.executeScript({
      target: site ? { tabId, allFrames: true } : { tabId },
      func: fillCredentialsInPage,
      // executeScript 的 args 必须可 JSON 序列化：undefined 会让整个调用直接报错
      //（Value is unserializable），缺省一律用空串表示。
      args: [
        entry.username,
        entry.password,
        data?.settings.autoSubmit === true,
        site || '',
        entry.tenant || '',
        entry.accountId || '',
      ],
    });
    const results = res
      .map((r) => r.result)
      .filter((r): r is NonNullable<typeof r> => Boolean(r));
    return {
      filled: results.find((r) => r.ok === true),
      iframe: results.find((r) => r.loginFrameOrigin)?.loginFrameOrigin,
      reason: results.find((r) => r.reason && r.reason !== 'frame-not-allowed')?.reason,
    };
  }

  async function applyFillOutcome(
    entry: FlatEntry,
    outcome: Awaited<ReturnType<typeof injectFill>>,
  ): Promise<boolean> {
    if (!outcome.filled) return false;
    await recordUse(entry.accountId);
    // 登记本次自动填充：登录捕获发现凭据与刚填的一致（未修改）时不再弹保存/更新提示。
    if (tab?.id && tab.url) {
      await api
        .markAutoFill(tab.id, tab.url, entry.username, entry.password, entry.tenant)
        .catch(() => {});
    }
    if (outcome.filled.submitSkipped && outcome.filled.reason) flash(outcome.filled.reason);
    else window.close();
    return true;
  }

  async function doFill(entry: FlatEntry) {
    if (!tab?.id || !tab.url) return;
    if (!entryMatchesUrl(entry, tab.url)) {
      flash('当前页面网址与该条目不一致，已阻止填充');
      return;
    }
    setNeedGrant(null);
    try {
      // 注入前以标签页「当前」URL 再复核一次 origin：popup 打开后页面可能已重定向，
      // 缓存的 tab.url 只能作 UI 提示，不能作安全边界（防 TOCTOU 跨源填充）。
      const liveTab = await browser.tabs.get(tab.id);
      if (!liveTab.url || !entryMatchesUrl(entry, liveTab.url)) {
        flash('当前页面网址已变化，已阻止填充');
        return;
      }
      const outcome = await injectFill(tab.id, entry);
      if (await applyFillOutcome(entry, outcome)) return;
      // 顶层没找到密码框，但检测到同主域的内嵌登录 iframe：引导一键授权该域名后再填。
      const entryOrigin = getOrigin(entry.url);
      if (outcome.iframe && entryOrigin && isSameSite(outcome.iframe, entryOrigin)) {
        setNeedGrant({ entry, origin: outcome.iframe });
        return;
      }
      flash(outcome.reason ?? '未能填充');
    } catch (e) {
      flash('填充失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // 授权内嵌登录 iframe 的域名后重试填充。permissions.request 需用户手势，故必须由按钮直接触发，
  // 且作为点击处理里的首个动作（不能放在 await 之后）。
  async function grantAndFill() {
    if (!needGrant || !tab?.id) return;
    const { entry, origin } = needGrant;
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: [origin + '/*'] });
    } catch {
      flash('授权请求失败');
      return;
    }
    if (!granted) {
      flash('未授权，无法填充内嵌登录框');
      return;
    }
    setNeedGrant(null);
    try {
      const live = await browser.tabs.get(tab.id);
      if (!live.url || !entryMatchesUrl(entry, live.url)) {
        flash('当前页面网址已变化，已阻止填充');
        return;
      }
      const outcome = await injectFill(tab.id, entry);
      if (await applyFillOutcome(entry, outcome)) return;
      flash(outcome.reason ?? '授权后仍未找到登录框');
    } catch (e) {
      flash('填充失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // 把当前页 origin 追加到某个已有链接的「更多网址」,使该地址今后可被识别填充。
  async function addCurrentToLink(linkId: string) {
    if (!data || !pageOrigin) return;
    const next = produce(data, (d) => {
      for (const p of d.projects)
        for (const e of p.environments)
          for (const l of e.links)
            if (l.id === linkId) {
              if (!linkUrls(l).some((u) => getOrigin(u) === pageOrigin)) {
                l.urls = [...(l.urls ?? []), pageOrigin + '/'];
              }
              l.updatedAt = Date.now();
            }
    });
    try {
      await vault.save(next);
      setQuickLinkId('');
      flash('已加入，当前页现在可填充了');
    } catch (e) {
      flash('保存失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function saveCurrentPage() {
    if (!tab?.url) return flash('无法读取当前标签页');
    const target =
      browser.runtime.getURL('/options.html') +
      `?capture=1&url=${encodeURIComponent(tab.url)}&title=${encodeURIComponent(tab.title ?? '')}`;
    await browser.tabs.create({ url: target });
    window.close();
  }

  async function captureCurrentInput() {
    if (!tab?.id) return flash('无法读取当前标签页');
    if (!canCapture) return flash('当前页面不支持捕获：浏览器内置页 / 扩展页无法读取内容');
    setCapturing(true);
    try {
      const injected = (await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectLoginInputInPage,
      })) as Array<{ result?: CaptureInputResult }>;
      const result = injected[0]?.result;
      if (!result?.ok) {
        flash(result?.reason ?? '没有找到可保存的登录输入');
        return;
      }
      const p = await api.captureManual(
        tab.id,
        result.url,
        result.username,
        result.password,
        tab.title,
        undefined,
        result.tenant,
      );
      if (!p) {
        flash('该登录已是最新，暂无需要保存的变化');
        return;
      }
      setPending(p);
      flash(p.kind === 'update' ? '检测到可更新的登录' : '检测到可保存的登录');
    } catch (e) {
      flash(captureErrorMessage(e));
    } finally {
      setCapturing(false);
    }
  }

  async function copy(text: string, what: string) {
    try {
      await copyWithAutoClear(text);
      flash(`${what}已复制（25 秒后自动清空）`);
    } catch {
      flash('复制失败，请手动复制');
    }
  }

  async function openLogin(entry: FlatEntry) {
    const origin = getOrigin(entry.url);
    if (!origin) return flash('链接地址不合法');
    const pattern = origin + '/*';
    try {
      // 已授权：popup 内直接打开并填充（不弹系统框，popup 不会被关）。
      if (await browser.permissions.contains({ origins: [pattern] })) {
        const r = await api.openAndFill(
          entry.url,
          entry.username,
          entry.password,
          data?.settings.autoSubmit === true,
          entry.tenant,
        );
        await recordUse(entry.accountId);
        if (r.reason) flash(r.reason);
        window.close();
        return;
      }
      // 未授权：跳设置页完成授权 + 打开填充，避免系统权限框关闭 popup 后还要再点一次。
      // 只传 accountId（不经 URL 传密码），设置页已解锁可查出明文。
      const target =
        browser.runtime.getURL('/options.html') +
        `?openlogin=1&account=${encodeURIComponent(entry.accountId)}&url=${encodeURIComponent(entry.url)}`;
      await browser.tabs.create({ url: target });
      window.close();
    } catch (e) {
      flash('打开失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 w-[380px] items-center justify-center text-sm text-gray-400">
        加载中…
      </div>
    );
  }

  if (!status || status.locked) {
    return (
      <div className="w-[380px]">
        <LockScreen
          compact
          initialized={status?.initialized ?? false}
          hasBiometric={status?.hasBiometric}
          onUnlock={vault.unlock}
          onCreate={vault.create}
          onBioUnlock={async () => {
            // popup 里不能跑 WebAuthn（指纹弹窗会让 popup 关闭），改为打开设置页解锁。
            await browser.runtime.openOptionsPage();
            window.close();
          }}
        />
      </div>
    );
  }

  return (
    <div className="relative flex w-[380px] flex-col bg-gray-50">
      {/* header */}
      <div className="flex items-center gap-2.5 border-b border-gray-200 bg-surface px-4 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-brand-600 text-white">
          <ShieldCheck size={14} />
        </span>
        <span className="text-[13px] font-bold text-gray-900">项目环境管家</span>
        <div className="ml-auto flex items-center gap-1">
          {status?.syncEnabled && (
            <button
              title="立即同步"
              onClick={doSync}
              disabled={syncing}
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
            </button>
          )}
          <button
            title="管理全部"
            onClick={() => browser.runtime.openOptionsPage()}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
          >
            <Settings size={16} />
          </button>
          <button
            title="锁定"
            onClick={() => vault.lock()}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
          >
            <Lock size={16} />
          </button>
        </div>
      </div>

      {pending && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-2.5 text-xs">
          <div className="mb-1.5 text-amber-800">
            检测到在 <b>{hostOf(pending.origin)}</b>{' '}
            {pending.authProvider ? `使用 ${pending.authProvider} 的第三方登录` : '的登录/注册'}
            {pending.kind === 'update'
              ? `，更新「${pending.linkName ?? ''}」的${pending.authProvider ? '登录方式' : '密码'}？`
              : pendingNeedsLocation
                ? `${pending.authProvider ? '' : `（${pending.username || '无用户名'}）`}，选择项目后保存？`
                : `${pending.authProvider ? '' : `（${pending.username || '无用户名'}）`}，保存到保险箱？`}
            {pending.kind === 'new' && pending.updateCandidates?.length
              ? ' 也可以更新已有账号。'
              : ''}
            {pending.totp ? ' 已检测到二次验证密钥，会一起保存。' : ''}
          </div>
          {pending.kind === 'new' && pending.updateCandidates?.length ? (
            <select
              value={selectedCaptureAccountId}
              onChange={(e) => setSelectedCaptureAccountId(e.target.value)}
              className="mb-2 w-full rounded-lg border border-amber-200 bg-surface px-2 py-1.5 text-xs text-amber-900 outline-none"
            >
              {pending.updateCandidates.map((c) => (
                <option key={c.accountId} value={c.accountId}>
                  {(c.accountLabel || c.linkName || '已保存账号') + ' · ' + (c.username || '无用户名')}
                </option>
              ))}
            </select>
          ) : null}
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                try {
                  if (pendingNeedsLocation) {
                    await api.captureEditSave(pending.id);
                    window.close();
                    return;
                  }
                  await api.captureSave(pending.id, undefined, {
                    username: pending.username,
                    accountLabel: pending.accountLabel,
                    targetLinkId: pending.targetLinkId || pending.saveTargets?.[0]?.linkId,
                  });
                  setPending(null);
                  await vault.reload();
                  flash('已保存到保险箱');
                } catch (e) {
                  flash('保存失败：' + (e instanceof Error ? e.message : String(e)));
                }
              }}
            >
              {pending.kind === 'update' ? '更新' : pendingNeedsLocation ? '选择位置' : '保存'}
            </Button>
            {pending.kind === 'new' && pending.updateCandidates?.[0] && (
              <Button
                variant="subtle"
                onClick={async () => {
                  try {
                    await api.captureSave(pending.id, selectedCaptureAccountId, {
                      username: pending.username,
                      accountLabel: pending.accountLabel,
                    });
                    setPending(null);
                    await vault.reload();
                    flash('已更新保险箱');
                  } catch (e) {
                    flash('更新失败：' + (e instanceof Error ? e.message : String(e)));
                  }
                }}
              >
                更新已有
              </Button>
            )}
            <Button
              variant="subtle"
              onClick={async () => {
                try {
                  await api.captureDismiss(pending.id);
                  setPending(null);
                } catch (e) {
                  flash('忽略失败：' + (e instanceof Error ? e.message : String(e)));
                }
              }}
            >
              忽略
            </Button>
          </div>
        </div>
      )}

      {/* search */}
      <div className="border-b border-gray-200 bg-surface px-3 py-2">
        <div className="relative">
          <Search
            size={15}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目 / 环境 / 链接 / 账号"
            className="pl-8"
          />
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto overscroll-contain p-3 [scrollbar-gutter:stable]">
        {query.trim() ? (
          <Section
            title={`搜索结果（${rawResults.length}${hiddenResultCount ? `，显示前 ${POPUP_RESULT_LIMIT}` : ''}）`}
          >
            {results.length === 0 ? (
              <Empty text="没有匹配的条目" />
            ) : (
              <>
                {results.map((e) => (
                  <Row
                    key={e.accountId}
                    entry={e}
                    canFill={!!tab?.url && entryMatchesUrl(e, tab.url)}
                    onFill={doFill}
                    onCopy={copy}
                    onOpenLogin={openLogin}
                  />
                ))}
                {hiddenResultCount > 0 && <MoreHint count={hiddenResultCount} />}
              </>
            )}
          </Section>
        ) : (
          <>
            {matched.length > 0 ? (
              <Section title={`当前网站（${matched.length}）`}>
                {matched.map((e) => (
                  <Row
                    key={e.accountId}
                    entry={e}
                    canFill
                    highlight
                    onFill={doFill}
                    onCopy={copy}
                    onOpenLogin={openLogin}
                  />
                ))}
              </Section>
            ) : favorites.length > 0 || recent.length > 0 ? (
              <div className="flex flex-col gap-3">
                {favorites.length > 0 && (
                  <Section title={`收藏（${favorites.length}）`}>
                    {favorites.map((e) => (
                      <Row
                        key={e.accountId}
                        entry={e}
                        canFill={!!tab?.url && entryMatchesUrl(e, tab.url)}
                        onFill={doFill}
                        onCopy={copy}
                        onOpenLogin={openLogin}
                      />
                    ))}
                  </Section>
                )}
                {recent.length > 0 && (
                  <Section title={`最近使用（${recent.length}）`}>
                    {recent.map((e) => (
                      <Row
                        key={e.accountId}
                        entry={e}
                        canFill={!!tab?.url && entryMatchesUrl(e, tab.url)}
                        onFill={doFill}
                        onCopy={copy}
                        onOpenLogin={openLogin}
                      />
                    ))}
                  </Section>
                )}
              </div>
            ) : (
              <Section title="当前网站">
                <Empty
                  text={tab?.url ? '当前页面没有匹配的账号' : '无法读取当前标签页'}
                />
              </Section>
            )}

            {matched.length === 0 && pageOrigin && allLinks.length > 0 && (
              <div className="mt-3 rounded-xl border border-dashed border-gray-200 bg-surface p-3">
                <div className="mb-1.5 text-xs text-gray-500">
                  当前网址 <b>{hostOf(pageOrigin)}</b> 还没收录。它是某个已存系统的
                  <b>另一个访问地址</b>吗？加入后即可在此填充：
                </div>
                <div className="flex gap-2">
                  <select
                    value={quickLinkId}
                    onChange={(e) => setQuickLinkId(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-brand-500"
                  >
                    <option value="">选择已有链接…</option>
                    {allLinks.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="subtle"
                    disabled={!quickLinkId}
                    onClick={() => addCurrentToLink(quickLinkId)}
                  >
                    加入
                  </Button>
                </div>
              </div>
            )}

            {envSwitch && (
              <div className="mt-3">
                <Section title={`环境切换 · ${envSwitch.linkName}`}>
                  <div className="flex flex-wrap gap-2">
                    {envSwitch.targets.map((t) => {
                      const kind = t.envKind as EnvKind;
                      const label = ENV_KIND_LABELS[kind] ?? t.envName;
                      return (
                        <button
                          key={t.envId}
                          onClick={() => browser.tabs.create({ url: t.targetUrl })}
                          className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-surface px-2.5 py-1.5 text-xs hover:border-brand-300"
                        >
                          <span
                            className={cx(
                              'rounded px-1.5 py-0.5 text-[10px] font-medium',
                              ENV_KIND_COLORS[kind] ?? ENV_KIND_COLORS.other,
                            )}
                          >
                            {label}
                          </span>
                          {t.envName !== label && t.envName}
                        </button>
                      );
                    })}
                  </div>
                </Section>
              </div>
            )}

          </>
        )}
      </div>

      {!query.trim() && (
        <div className="shrink-0 border-t border-gray-200 bg-surface p-3">
          <div className="grid grid-cols-2 gap-2">
            {tab?.url && (
              <Button
                variant="subtle"
                className="h-10 min-w-0 whitespace-nowrap px-2 text-[13px]"
                disabled={capturing || !canCapture}
                onClick={captureCurrentInput}
                title={
                  canCapture
                    ? '手动读取当前页面已填写的用户名和密码，用于自动提示未出现时兜底'
                    : '当前页面（浏览器内置页 / 扩展页 / 商店页）无法读取内容，不支持捕获'
                }
              >
                <KeyRound size={15} /> 手动捕获
              </Button>
            )}
            {tab?.url && (
              <Button
                variant="subtle"
                className="h-10 min-w-0 whitespace-nowrap px-2 text-[13px]"
                onClick={saveCurrentPage}
                title="只保存当前网页链接，可稍后在管理页补账号"
              >
                <Plus size={15} /> 保存当前页
              </Button>
            )}
            {pageOrigin && data && (
              <Button
                variant="subtle"
                className="h-9 min-w-0 whitespace-nowrap px-2 text-[13px]"
                onClick={toggleSiteMute}
                title={
                  siteMuted
                    ? '此网站当前不弹自动提示，点击恢复'
                    : '在此网站不再自动弹出填充和保存提示（弹窗里仍可手动填充/捕获）'
                }
              >
                {siteMuted ? <Bell size={15} /> : <BellOff size={15} />}
                {siteMuted ? '恢复本站提示' : '关闭本站提示'}
              </Button>
            )}
            <Button
              variant="ghost"
              className={cx(
                'h-9 min-w-0 whitespace-nowrap px-2 text-[13px]',
                pageOrigin && data ? '' : 'col-span-2',
              )}
              onClick={() => browser.runtime.openOptionsPage()}
            >
              管理全部
            </Button>
          </div>
        </div>
      )}

      {needGrant && (
        <div className="absolute inset-x-0 bottom-3 mx-auto w-[92%] rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs shadow-lg">
          <div className="mb-2 text-amber-800">
            登录框在内嵌页 <b>{hostOf(needGrant.origin)}</b> 里（与当前站点同主域）。授权该地址后即可填充。
          </div>
          <div className="flex gap-2">
            <Button className="h-7 flex-1 px-2 py-1 text-xs" onClick={grantAndFill}>
              授权并填充
            </Button>
            <Button
              variant="subtle"
              className="h-7 px-2 py-1 text-xs"
              onClick={() => setNeedGrant(null)}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {toast && !needGrant && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-lg bg-neutral-800/95 px-3 py-1.5 text-xs text-white">
          {toast}
        </div>
      )}
    </div>
  );
}

/** 把 executeScript 在受限页面上抛出的英文报错翻译成中文提示；其余错误保留原文。 */
function captureErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/cannot access|must request permission|extension manifest|chrome:\/\//i.test(msg)) {
    return '当前页面不支持捕获：这类页面（商店 / 浏览器内置页 / 扩展页）不允许读取内容';
  }
  return '捕获失败：' + msg;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** 取条目网址的可注册域(eTLD+1)，作为跨 frame 填充的同主域护栏；无法解析时返回空串（退回只填顶层）。 */
function siteOf(url: string): string {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}

type CaptureInputResult =
  | { ok: true; url: string; username: string; password: string; tenant?: string }
  | { ok: false; reason: string };

function collectLoginInputInPage(): CaptureInputResult {
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const readRememberedUsername = (maxAgeMs = 90_000): string => {
    try {
      const raw = sessionStorage.getItem('pemLastLoginUsername');
      if (!raw) return '';
      const saved = JSON.parse(raw) as { origin?: string; value?: string; ts?: number };
      const age = Date.now() - Number(saved.ts ?? 0);
      if (saved.origin !== location.origin || age > 10 * 60_000)
        return '';
      if (age > maxAgeMs) return '';
      return typeof saved.value === 'string' ? saved.value : '';
    } catch {
      return '';
    }
  };

  const pw = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((el) => el.value && visible(el))[0];
  if (!pw?.value) return { ok: false, reason: '页面上没有已填写的密码框' };

  const scope = pw.form ?? document;
  const allCandidates = Array.from(
    scope.querySelectorAll<HTMLInputElement>(
      'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[inputmode="numeric"], input:not([type])',
    ),
  ).filter((el) => el.type !== 'password' && el.value && visible(el));

  // 租户 / 企业 / 域字段单独收集，不当作用户名。
  const tenantRe = /(tenant|租户|企业|公司|单位|机构|组织|域名|域账号|登录域|domain|company|corp\b|\borg)/i;
  const isTenantField = (el: HTMLElement): boolean =>
    tenantRe.test(
      [
        (el as HTMLInputElement).name ?? '',
        el.id,
        (el as HTMLInputElement).autocomplete ?? '',
        (el as HTMLInputElement).placeholder ?? '',
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('title') ?? '',
        el.closest('label')?.textContent ?? '',
      ]
        .join(' ')
        .toLowerCase(),
    );
  // 单位 / 租户为下拉框的系统：取选中项的 value。
  const tenantSelect = Array.from(scope.querySelectorAll('select')).find(
    (el) => el.value && visible(el) && isTenantField(el),
  );
  const tenant = allCandidates.find(isTenantField)?.value || tenantSelect?.value || undefined;
  const candidates = allCandidates.filter((el) => !isTenantField(el));

  let username = '';
  for (const el of candidates) {
    if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) username = el.value;
  }
  if (!username && candidates[0]) username = candidates[0].value;
  if (!username) username = readRememberedUsername();

  return {
    ok: true,
    url: location.href,
    username,
    password: pw.value,
    tenant,
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 px-1 text-xs font-medium text-gray-400">{title}</div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400">
      {text}
    </div>
  );
}

function MoreHint({ count }: { count: number }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-surface px-3 py-2 text-center text-xs text-gray-400">
      还有 {count} 条，继续输入可缩小范围
    </div>
  );
}

function Row({
  entry,
  canFill,
  highlight,
  onFill,
  onCopy,
  onOpenLogin,
}: {
  entry: FlatEntry;
  canFill: boolean;
  highlight?: boolean;
  onFill: (e: FlatEntry) => void;
  onCopy: (text: string, what: string) => void;
  onOpenLogin: (e: FlatEntry) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div
      className={cx(
        'rounded-xl border bg-surface p-2.5',
        highlight ? 'border-brand-200 ring-1 ring-brand-100' : 'border-gray-200',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-gray-900">
              {entry.linkName || entry.projectName}
            </span>
            <span
              className={cx(
                'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                ENV_KIND_COLORS[entry.envKind as EnvKind] ?? ENV_KIND_COLORS.other,
              )}
            >
              {ENV_KIND_LABELS[entry.envKind as EnvKind] ?? entry.envName}
            </span>
            {entry.accountLabel && (
              <span className="truncate text-xs text-gray-400">· {entry.accountLabel}</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-gray-400">
            {entry.projectName} · {entry.envName}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canFill && (
            <ActionBtn title="填充到当前页" onClick={() => onFill(entry)} primary>
              <LogIn size={13} /> 填充
            </ActionBtn>
          )}
          {entry.url && (
            <ActionBtn title="打开并登录" onClick={() => onOpenLogin(entry)}>
              <ExternalLink size={13} /> 登录
            </ActionBtn>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <div className="min-w-0">
          <div className="truncate text-gray-700">{entry.username || '（无用户名）'}</div>
          <div className="truncate font-mono text-gray-500">
            {show ? entry.password : '••••••••'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconBtn title={show ? '隐藏' : '显示'} onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </IconBtn>
          <IconBtn title="复制用户名" onClick={() => onCopy(entry.username, '用户名')}>
            <Copy size={15} />
          </IconBtn>
          <IconBtn title="复制密码" onClick={() => onCopy(entry.password, '密码')}>
            <span className="text-[10px] font-bold">PW</span>
          </IconBtn>
          {entry.url && (
            <IconBtn
              title="只打开链接"
              onClick={() => browser.tabs.create({ url: entry.url })}
            >
              <ExternalLink size={15} />
            </IconBtn>
          )}
        </div>
      </div>

      {entry.totp && (
        <div className="mt-2">
          <TotpBadge secret={entry.totp} onCopy={(c) => onCopy(c, '验证码')} />
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  title,
  onClick,
  children,
  primary,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cx(
        'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-semibold transition',
        primary
          ? 'bg-brand-600 text-white hover:bg-brand-700'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
      )}
    >
      {children}
    </button>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
    >
      {children}
    </button>
  );
}

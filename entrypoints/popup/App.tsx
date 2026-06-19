import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  LogIn,
  Plus,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { LockScreen } from '@/components/LockScreen';
import { TotpBadge } from '@/components/TotpBadge';
import { Button, Input, cx } from '@/components/ui';
import { useVault } from '@/hooks/useVault';
import { fillCredentialsInPage, getOrigin, originsMatch } from '@/lib/autofill';
import { copyWithAutoClear } from '@/lib/clipboard';
import { envSwitchTargets } from '@/lib/env-switch';
import { api } from '@/lib/messaging';
import { matchForUrl, search, type FlatEntry } from '@/lib/search';
import type { CapturePending, EnvKind } from '@/lib/types';
import { ENV_KIND_COLORS, ENV_KIND_LABELS } from '@/lib/vault-ops';

export default function App() {
  const vault = useVault();
  const { status, data, loading } = vault;

  const [tab, setTab] = useState<{ id?: number; url?: string; title?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState<CapturePending | null>(null);

  useEffect(() => {
    if (status && !status.locked) api.capturePending().then(setPending).catch(() => {});
  }, [status]);

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => setTab(t ? { id: t.id, url: t.url, title: t.title } : null))
      .catch(() => {});
  }, []);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2200);
  };

  const matched = useMemo(
    () => (data && tab?.url ? matchForUrl(data, tab.url) : []),
    [data, tab],
  );
  const results = useMemo(
    () => (data && query.trim() ? search(data, query) : []),
    [data, query],
  );
  const envSwitch = useMemo(
    () => (data && tab?.url ? envSwitchTargets(data, tab.url) : null),
    [data, tab],
  );

  async function doFill(entry: FlatEntry) {
    if (!tab?.id || !tab.url) return;
    if (!originsMatch(entry.url, tab.url)) {
      flash('当前页面网址与该条目不一致，已阻止填充');
      return;
    }
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillCredentialsInPage,
        args: [entry.username, entry.password, data?.settings.autoSubmit !== false],
      });
      window.close();
    } catch (e) {
      flash('填充失败：' + (e instanceof Error ? e.message : String(e)));
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

  async function copy(text: string, what: string) {
    await copyWithAutoClear(text);
    flash(`${what}已复制（25 秒后自动清空）`);
  }

  async function openLogin(entry: FlatEntry) {
    const origin = getOrigin(entry.url);
    if (!origin) return flash('链接地址不合法');
    // 已授权则立即返回 true（无弹窗）；首次会弹权限请求，可能关闭 popup，再点一次即可。
    const granted = await browser.permissions.request({ origins: [origin + '/*'] });
    if (!granted) return flash('未授权访问该网站');
    try {
      const r = await api.openAndFill(
        entry.url,
        entry.username,
        entry.password,
        data?.settings.autoSubmit !== false,
      );
      if (!r.filled && r.reason) flash(r.reason);
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
    <div className="flex max-h-[560px] w-[380px] flex-col bg-gray-50">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2.5">
        <ShieldCheck size={18} className="text-brand-600" />
        <span className="text-sm font-semibold text-gray-900">项目环境管家</span>
        <div className="ml-auto flex items-center gap-1">
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
            检测到在 <b>{hostOf(pending.origin)}</b> 的登录
            {pending.kind === 'update'
              ? `，更新「${pending.linkName ?? ''}」的密码？`
              : `（${pending.username || '无用户名'}），保存到金库？`}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                await api.captureSave();
                setPending(null);
                await vault.reload();
                flash('已保存到金库');
              }}
            >
              {pending.kind === 'update' ? '更新' : '保存'}
            </Button>
            <Button
              variant="subtle"
              onClick={async () => {
                await api.captureDismiss();
                setPending(null);
              }}
            >
              忽略
            </Button>
          </div>
        </div>
      )}

      {/* search */}
      <div className="border-b border-gray-200 bg-white px-3 py-2">
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

      <div className="flex-1 overflow-auto p-3">
        {query.trim() ? (
          <Section title={`搜索结果（${results.length}）`}>
            {results.length === 0 ? (
              <Empty text="没有匹配的条目" />
            ) : (
              results.map((e) => (
                <Row
                  key={e.accountId}
                  entry={e}
                  canFill={!!tab?.url && originsMatch(e.url, tab.url)}
                  onFill={doFill}
                  onCopy={copy}
                  onOpenLogin={openLogin}
                />
              ))
            )}
          </Section>
        ) : (
          <>
            <Section title="当前网站">
              {matched.length === 0 ? (
                <Empty
                  text={
                    tab?.url
                      ? '当前页面没有匹配的账号'
                      : '无法读取当前标签页'
                  }
                />
              ) : (
                matched.map((e) => (
                  <Row
                    key={e.accountId}
                    entry={e}
                    canFill
                    highlight
                    onFill={doFill}
                    onCopy={copy}
                    onOpenLogin={openLogin}
                  />
                ))
              )}
            </Section>

            {envSwitch && (
              <div className="mt-3">
                <Section title={`环境切换 · ${envSwitch.linkName}`}>
                  <div className="flex flex-wrap gap-2">
                    {envSwitch.targets.map((t) => (
                      <button
                        key={t.envId}
                        onClick={() => browser.tabs.create({ url: t.targetUrl })}
                        className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs hover:border-brand-300"
                      >
                        <span
                          className={cx(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            ENV_KIND_COLORS[t.envKind as EnvKind] ?? ENV_KIND_COLORS.other,
                          )}
                        >
                          {ENV_KIND_LABELS[t.envKind as EnvKind] ?? t.envName}
                        </span>
                        {t.envName}
                      </button>
                    ))}
                  </div>
                </Section>
              </div>
            )}

            <div className="mt-3 flex flex-col gap-2">
              {tab?.url && (
                <Button variant="subtle" className="w-full" onClick={saveCurrentPage}>
                  <Plus size={15} /> 保存当前页到金库
                </Button>
              )}
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => browser.runtime.openOptionsPage()}
              >
                打开完整管理界面
              </Button>
            </div>
          </>
        )}
      </div>

      {toast && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit rounded-lg bg-gray-900/90 px-3 py-1.5 text-xs text-white">
          {toast}
        </div>
      )}
    </div>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
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
        'rounded-xl border bg-white p-3',
        highlight ? 'border-brand-200 ring-1 ring-brand-100' : 'border-gray-200',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-sm font-medium text-gray-900">
          {entry.linkName || entry.projectName}
        </span>
        <span
          className={cx(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
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
              title="打开链接"
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
      {canFill && (
        <Button className="mt-2 w-full" onClick={() => onFill(entry)}>
          <LogIn size={15} /> 填充到当前页
        </Button>
      )}
      {entry.url && (
        <Button variant="subtle" className="mt-1.5 w-full" onClick={() => onOpenLogin(entry)}>
          <ExternalLink size={15} /> 打开并登录
        </Button>
      )}
    </div>
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

import { browser } from 'wxt/browser';
import { fillCredentialsInPage, getOrigin } from '@/lib/autofill';
import { fromB64, toB64 } from '@/lib/crypto';
import { flatten, matchForUrl, search } from '@/lib/search';
import { buildExport, mergeVaults, parseImport } from '@/lib/import-export';
import type { Msg, MsgResponse, SyncStateResp } from '@/lib/messaging';
import { vaultBackend } from '@/lib/storage';
import { SyncClient, syncVault } from '@/lib/sync';
import type {
  BioEnrollmentPublic,
  CapturePending,
  PlatformLink,
  SyncState,
  VaultData,
  VaultStatus,
} from '@/lib/types';
import { linkUrls, newAccount, newEnvironment, newLink, newProject } from '@/lib/vault-ops';
import {
  createEncryptedVault,
  decryptVaultData,
  emptyVaultData,
  enrollBiometric,
  reencryptData,
  removeBioEnrollment,
  rewrapDEK,
  unwrapDEK,
  unwrapDEKWithPrf,
} from '@/lib/vault-core';

const SESSION_DEK = 'dek';
const SYNC_STATE_KEY = 'syncState';
const PENDING_KEY = 'pendingCapture';

// 全部仅存在于内存（SW 重启后从 session 恢复，浏览器关闭即丢失）。
let dek: Uint8Array | null = null;
let cachedData: VaultData | null = null;
let autoLockMinutes = 15;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let clipboardOffscreenReady = false;
let pendingCapture: CapturePending | null = null;

export default defineBackground(() => {
  browser.storage.session
    .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch(() => {});

  // 卸载时打开说明页：解释「卸载会清空本地数据」以及如何用同步/备份恢复。
  // 仅是事后告知（数据此时已被 Chrome 清除），帮助用户避免再次误删并指引恢复路径。
  browser.runtime.setUninstallURL?.('https://envmanager.yzs.ai/uninstall.html').catch(() => {});

  browser.idle.onStateChanged.addListener((state) => {
    if (autoLockMinutes > 0 && state !== 'active') lock();
  });

  // 右键菜单：在任意页面/链接上保存到保险箱。
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: 'save-to-vault',
      title: '保存到项目环境管家',
      contexts: ['page', 'link'],
    });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const url = info.linkUrl || info.pageUrl || tab?.url || '';
    const title = tab?.title || '';
    const target =
      browser.runtime.getURL('/options.html') +
      `?capture=1&url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`;
    browser.tabs.create({ url: target });
  });

  // 登录捕获内容脚本：只在已授权的站点动态注册。
  registerCapture();
  browser.permissions.onAdded.addListener(() => registerCapture());

  // 地址栏 "env" 关键字搜索。
  browser.omnibox.setDefaultSuggestion({ description: '搜索项目 / 环境 / 链接 / 账号…' });
  browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
    await ensureRestored();
    if (!cachedData) {
      suggest([{ content: '__locked__', description: '🔒 先解锁保险箱后再搜索' }]);
      return;
    }
    const hits = search(cachedData, text).slice(0, 8);
    suggest(
      hits.map((h) => ({
        content: `acc:${h.accountId}`,
        description:
          escapeXml(`${h.linkName} · ${h.envName} · ${h.username || '—'}`) +
          (h.url ? ` <url>${escapeXml(h.url)}</url>` : ''),
      })),
    );
  });
  browser.omnibox.onInputEntered.addListener(async (text) => {
    await ensureRestored();
    if (!cachedData) {
      browser.action.openPopup?.().catch(() => {});
      return;
    }
    const entry = text.startsWith('acc:')
      ? flatten(cachedData).find((e) => e.accountId === text.slice(4))
      : search(cachedData, text)[0];
    if (!entry?.url) return;
    await openAndFill(
      entry.url,
      entry.username,
      entry.password,
      cachedData.settings.autoSubmit === true,
    );
  });

  // 快捷键。
  browser.commands.onCommand.addListener(async (command) => {
    if (command === 'lock-vault') lock();
    else if (command === 'fill-current') await fillActiveTab();
  });

  browser.runtime.onMessage.addListener((msg: Msg | { type?: string }, sender) => {
    if (msg.type === 'offscreen:clipboardWrite') return false;
    return handle(msg as Msg, sender);
  });
});

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 快捷键「填充当前页」：唯一匹配则直接填，否则打开 popup 让用户选。 */
async function fillActiveTab(): Promise<void> {
  await ensureRestored();
  if (!cachedData) {
    browser.action.openPopup?.().catch(() => {});
    return;
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return;
  const matches = matchForUrl(cachedData, tab.url);
  if (matches.length === 1) {
    const m = matches[0]!;
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillCredentialsInPage,
      args: [m.username, m.password, cachedData.settings.autoSubmit === true],
    });
  } else {
    browser.action.openPopup?.().catch(() => {});
  }
}

/** 消息发送方的最小结构（来自 chrome.runtime.MessageSender）。 */
type MsgSender = { url?: string; origin?: string; tab?: { id?: number } };

async function handle(msg: Msg, sender?: MsgSender): Promise<MsgResponse<unknown>> {
  // 来源校验：除登录捕获（由内容脚本从网页发出）外，其余特权消息只接受扩展自身页面
  // （popup / options，chrome-extension://）发起，阻止被注入网页的脚本索取解密明文。
  const senderUrl = sender?.url ?? '';
  if ((senderUrl.startsWith('http://') || senderUrl.startsWith('https://')) && msg.type !== 'capture:login') {
    return { ok: false, error: '来源不可信' };
  }
  try {
    return { ok: true, data: await route(msg, sender) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function route(msg: Msg, sender?: MsgSender): Promise<unknown> {
  switch (msg.type) {
    case 'vault:status':
      return getStatus();

    case 'vault:create': {
      if (await vaultBackend.load()) throw new Error('保险箱已存在，请直接解锁');
      const data = emptyVaultData();
      if (msg.kdf) data.settings.kdf = msg.kdf;
      const { encrypted, dek: newDek } = await createEncryptedVault(
        data,
        msg.password,
        data.settings.kdf,
      );
      await vaultBackend.save(encrypted);
      await setUnlocked(newDek, data);
      return getStatus();
    }

    case 'vault:unlock': {
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('尚未创建保险箱');
      let newDek: Uint8Array;
      try {
        newDek = await unwrapDEK(enc, msg.password);
      } catch {
        throw new Error('主密码错误');
      }
      await setUnlocked(newDek, await decryptVaultData(enc, newDek));
      return getStatus();
    }

    case 'vault:lock':
      lock();
      return getStatus();

    case 'vault:get':
      return requireData();

    case 'vault:save': {
      await requireUnlocked();
      await persistData(msg.data);
      scheduleAutoSync();
      return;
    }

    case 'vault:changePassword': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('保险箱不存在');
      try {
        await unwrapDEK(enc, msg.current);
      } catch {
        throw new Error('当前主密码错误');
      }
      await vaultBackend.save(await rewrapDEK(enc, dek!, msg.next));
      return;
    }

    case 'vault:export': {
      const data = await requireData();
      // 可选导出范围：只导出选中的项目（projectIds 为空/缺省时导出全部）。
      const scoped =
        msg.projectIds && msg.projectIds.length
          ? { ...data, projects: data.projects.filter((p) => msg.projectIds!.includes(p.id)) }
          : data;
      return buildExport(scoped, msg.mode, msg.password);
    }

    case 'vault:import': {
      const data = await requireData();
      const incoming = await parseImport(msg.format, msg.content, msg.password);
      const { data: merged, imported } = mergeVaults(data, incoming, msg.mode);
      await persistData(merged);
      scheduleAutoSync();
      return { status: await getStatus(), imported };
    }

    case 'vault:reset':
      lock();
      await vaultBackend.clear();
      await browser.storage.local.remove(SYNC_STATE_KEY);
      return getStatus();

    case 'activity':
      resetLockTimer();
      return;

    case 'clipboard:clearLater':
      await scheduleClipboardClear(msg.clearMs);
      return;

    // ---------------- 生物识别 ----------------
    case 'vault:bioEnrollments': {
      const enc = await vaultBackend.load();
      const list: BioEnrollmentPublic[] = (enc?.bioEnrollments ?? []).map((e) => ({
        id: e.id,
        label: e.label,
        credentialId: e.credentialId,
        prfSalt: e.prfSalt,
      }));
      return list;
    }

    case 'vault:unlockWithPrf': {
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('尚未创建保险箱');
      let newDek: Uint8Array;
      try {
        newDek = await unwrapDEKWithPrf(enc, msg.enrollmentId, fromB64(msg.prfOutput));
      } catch {
        throw new Error('生物识别校验失败');
      }
      await setUnlocked(newDek, await decryptVaultData(enc, newDek));
      return getStatus();
    }

    case 'vault:enrollBio': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('保险箱不存在');
      const next = await enrollBiometric(enc, dek!, {
        label: msg.label,
        credentialId: msg.credentialId,
        prfSalt: msg.prfSalt,
        prfOutput: fromB64(msg.prfOutput),
      });
      await vaultBackend.save(next);
      return;
    }

    case 'vault:removeBio': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('保险箱不存在');
      await vaultBackend.save(removeBioEnrollment(enc, msg.enrollmentId));
      return;
    }

    // ---------------- 同步 ----------------
    case 'sync:configure': {
      const data = await requireData();
      // 先用 meta 验证服务器/令牌可达
      await new SyncClient(msg.serverUrl, msg.token).meta();
      data.settings.sync = { serverUrl: msg.serverUrl, token: msg.token, enabled: true };
      await persistData(data);
      await runSync();
      return syncStateResp();
    }

    case 'sync:now':
      await runSync();
      return syncStateResp();

    case 'sync:disable': {
      const data = await requireData();
      const cfg = data.settings.sync;
      if (cfg) {
        try {
          await new SyncClient(cfg.serverUrl, cfg.token).deleteRemote();
        } catch {
          /* 远端删除失败不阻断本地关闭 */
        }
      }
      delete data.settings.sync;
      await persistData(data);
      await browser.storage.local.remove(SYNC_STATE_KEY);
      return;
    }

    case 'sync:state':
      return syncStateResp();

    case 'vault:adopt': {
      const client = new SyncClient(msg.serverUrl, msg.token);
      const remote = await client.pull();
      if (!remote) throw new Error('服务器上没有可恢复的保险箱');
      await vaultBackend.save(remote);
      const meta = await client.meta();
      await saveSyncState({ serverRevision: meta.revision, lastSyncAt: Date.now() });
      lock(); // 用该保险箱的主密码重新解锁
      return getStatus();
    }

    case 'tab:openAndFill':
      return openAndFill(msg.url, msg.username, msg.password, msg.submit);

    case 'capture:login': {
      // 只信任 sender 的真实来源，丢弃消息体里可被伪造的 origin 字段；并要求 url 同源。
      const trusted = sender?.origin ?? getOrigin(sender?.url ?? '');
      if (!trusted || trusted !== getOrigin(msg.url)) return;
      await handleCaptureLogin(trusted, msg.url, msg.username, msg.password);
      return;
    }
    case 'capture:pending':
      return getPending();
    case 'capture:save':
      await applyCapture();
      return;
    case 'capture:dismiss':
      await clearPending();
      return;
  }
}

// --------------------------- 登录捕获 ---------------------------

async function registerCapture(): Promise<void> {
  try {
    const perms = await browser.permissions.getAll();
    const origins = (perms.origins ?? []).filter((o) => o.startsWith('http'));
    await browser.scripting.unregisterContentScripts({ ids: ['capture'] }).catch(() => {});
    if (origins.length === 0) return;
    await browser.scripting.registerContentScripts([
      {
        id: 'capture',
        js: ['capture.js'],
        matches: origins,
        runAt: 'document_idle',
      },
    ]);
  } catch (e) {
    console.warn('registerCapture failed:', e);
  }
}

async function handleCaptureLogin(
  origin: string,
  url: string,
  username: string,
  password: string,
): Promise<void> {
  await ensureRestored();
  if (!dek || !cachedData || !password) return; // 锁定时忽略

  let matchAccountId: string | undefined;
  let linkName: string | undefined;
  let exactSame = false;
  for (const proj of cachedData.projects) {
    for (const env of proj.environments) {
      for (const link of env.links) {
        if (!linkUrls(link).some((u) => getOrigin(u) === origin)) continue;
        for (const acc of link.accounts) {
          if (acc.username && username && acc.username.toLowerCase() === username.toLowerCase()) {
            matchAccountId = acc.id;
            linkName = link.name;
            if (acc.password === password) exactSame = true;
          }
        }
      }
    }
  }
  if (exactSame) return clearPending(); // 已是最新，无需提示
  if (matchAccountId) {
    await savePending({ kind: 'update', origin, url, username, password, accountId: matchAccountId, linkName });
  } else {
    await savePending({ kind: 'new', origin, url, username, password });
  }
}

async function applyCapture(): Promise<void> {
  await requireUnlocked();
  const p = await getPending();
  if (!p) return;
  const data = structuredClone(cachedData!);

  if (p.kind === 'update' && p.accountId) {
    for (const proj of data.projects)
      for (const env of proj.environments)
        for (const link of env.links)
          for (const acc of link.accounts)
            if (acc.id === p.accountId) {
              acc.password = p.password;
              acc.updatedAt = Date.now();
            }
  } else {
    let target: PlatformLink | null = null;
    for (const proj of data.projects)
      for (const env of proj.environments)
        for (const link of env.links)
          if (linkUrls(link).some((u) => getOrigin(u) === p.origin)) target = link;

    if (!target) {
      let proj = data.projects.find((x) => x.name === '捕获');
      if (!proj) {
        proj = newProject({ name: '捕获' });
        data.projects.push(proj);
      }
      let env = proj.environments[0];
      if (!env) {
        env = newEnvironment({ name: '默认', kind: 'other' });
        proj.environments.push(env);
      }
      let host = p.origin;
      try {
        host = new URL(p.url).host;
      } catch {
        /* keep origin */
      }
      target = newLink({ name: host, url: p.origin });
      env.links.push(target);
    }
    target.accounts.push(newAccount({ label: '捕获', username: p.username, password: p.password }));
  }

  await persistData(data);
  scheduleAutoSync();
  await clearPending();
}

async function savePending(p: CapturePending): Promise<void> {
  pendingCapture = p;
  await browser.storage.session.set({ [PENDING_KEY]: p });
  browser.action.setBadgeText({ text: '1' }).catch(() => {});
  browser.action.setBadgeBackgroundColor?.({ color: '#e11d48' }).catch(() => {});
}

async function clearPending(): Promise<void> {
  pendingCapture = null;
  await browser.storage.session.remove(PENDING_KEY);
  browser.action.setBadgeText({ text: '' }).catch(() => {});
}

async function getPending(): Promise<CapturePending | null> {
  if (pendingCapture) return pendingCapture;
  const s = await browser.storage.session.get(PENDING_KEY);
  pendingCapture = (s[PENDING_KEY] as CapturePending | undefined) ?? null;
  return pendingCapture;
}

/** 打开链接 -> 等加载完成 -> 校验最终 origin 与链接一致 -> 注入填充（可选自动提交）。 */
async function openAndFill(
  url: string,
  username: string,
  password: string,
  submit: boolean,
): Promise<{ filled: boolean; reason?: string }> {
  const targetOrigin = getOrigin(url);
  if (!targetOrigin) throw new Error('链接地址不合法');
  const tab = await browser.tabs.create({ url });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('无法打开标签页');

  await waitForTabComplete(tabId, 20_000);

  // 防重定向到别处后误填：以页面最终 origin 为准再校验一次。
  const finalTab = await browser.tabs.get(tabId);
  if (!finalTab.url || getOrigin(finalTab.url) !== targetOrigin) {
    return { filled: false, reason: '页面最终地址与链接不一致，已阻止填充' };
  }

  await browser.scripting.executeScript({
    target: { tabId },
    func: fillCredentialsInPage,
    args: [username, password, submit],
  });
  return { filled: true };
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('页面加载超时'));
    }, timeoutMs);
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

// --------------------------- 剪贴板清空 ---------------------------

async function scheduleClipboardClear(clearMs: number): Promise<void> {
  const delay = Math.min(Math.max(Math.floor(clearMs) || 0, 0), 5 * 60_000);
  if (delay <= 0) return;
  await ensureClipboardOffscreen();
  // 计时与清空都交给 offscreen 文档：它不像 service worker 那样会被约 30 秒空闲回收，
  // 即使 SW 在此期间被终止，到点后仍会可靠地清空剪贴板（替代 SW 内不可靠的 setTimeout）。
  await browser.runtime.sendMessage({ type: 'offscreen:clearAfter', delayMs: delay });
}

async function ensureClipboardOffscreen(): Promise<void> {
  const offscreen = (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
  if (!offscreen) throw new Error('当前浏览器不支持 offscreen document');
  if (clipboardOffscreenReady || (await hasClipboardOffscreen())) {
    clipboardOffscreenReady = true;
    return;
  }
  try {
    await offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Clear copied credentials from the clipboard after a short delay.',
    });
  } catch (e) {
    if (!/single offscreen|only.*offscreen/i.test(String(e))) throw e;
  }
  clipboardOffscreenReady = true;
}

async function hasClipboardOffscreen(): Promise<boolean> {
  const runtime = browser.runtime as unknown as RuntimeWithContexts;
  if (!runtime.getContexts) return false;
  const contexts = await runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

interface OffscreenApi {
  createDocument(opts: {
    url: string;
    reasons: string[];
    justification: string;
  }): Promise<void>;
}

interface RuntimeWithContexts {
  getContexts?: (opts: {
    contextTypes: string[];
    documentUrls?: string[];
  }) => Promise<unknown[]>;
}

// --------------------------- 状态 / 锁 ---------------------------

async function getStatus(): Promise<VaultStatus> {
  const enc = await vaultBackend.load();
  await ensureRestored();
  return {
    initialized: enc !== null,
    locked: dek === null,
    autoLockMinutes,
    hasBiometric: (enc?.bioEnrollments?.length ?? 0) > 0,
    syncEnabled: cachedData?.settings.sync?.enabled ?? false,
  };
}

async function setUnlocked(d: Uint8Array, data: VaultData): Promise<void> {
  dek = d;
  cachedData = data;
  autoLockMinutes = data.settings.autoLockMinutes ?? 15;
  await browser.storage.session.set({ [SESSION_DEK]: toB64(d) });
  applyAutoLock();
  resetLockTimer();
}

/** 重新加密并持久化数据；更新内存缓存。 */
async function persistData(data: VaultData): Promise<void> {
  const enc = await vaultBackend.load();
  if (!enc) throw new Error('保险箱不存在');
  await vaultBackend.save(await reencryptData(enc, data, dek!));
  cachedData = data;
  autoLockMinutes = data.settings.autoLockMinutes ?? 15;
  applyAutoLock();
  resetLockTimer();
}

function lock(): void {
  dek = null;
  cachedData = null;
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  browser.storage.session.remove(SESSION_DEK).catch(() => {});
}

async function ensureRestored(): Promise<void> {
  if (dek) return;
  const s = await browser.storage.session.get(SESSION_DEK);
  const b64 = s[SESSION_DEK] as string | undefined;
  if (!b64) return;
  const restored = fromB64(b64);
  const enc = await vaultBackend.load();
  if (!enc) return;
  try {
    cachedData = await decryptVaultData(enc, restored);
  } catch {
    await browser.storage.session.remove(SESSION_DEK);
    return;
  }
  dek = restored;
  autoLockMinutes = cachedData.settings.autoLockMinutes ?? 15;
  applyAutoLock();
}

async function requireUnlocked(): Promise<void> {
  await ensureRestored();
  if (!dek || !cachedData) throw new Error('保险箱已锁定');
}

async function requireData(): Promise<VaultData> {
  await requireUnlocked();
  return cachedData!;
}

function applyAutoLock(): void {
  if (autoLockMinutes > 0) {
    browser.idle.setDetectionInterval(Math.max(15, autoLockMinutes * 60));
  }
}

function resetLockTimer(): void {
  if (lockTimer) clearTimeout(lockTimer);
  if (autoLockMinutes > 0) lockTimer = setTimeout(lock, autoLockMinutes * 60_000);
}

// --------------------------- 同步辅助 ---------------------------

async function loadSyncState(): Promise<SyncState | null> {
  const r = await browser.storage.local.get(SYNC_STATE_KEY);
  return (r[SYNC_STATE_KEY] as SyncState | undefined) ?? null;
}

async function saveSyncState(s: SyncState): Promise<void> {
  await browser.storage.local.set({ [SYNC_STATE_KEY]: s });
}

async function syncStateResp(): Promise<SyncStateResp> {
  const cfg = cachedData?.settings.sync;
  return {
    config: cfg ? { serverUrl: cfg.serverUrl, enabled: cfg.enabled } : null,
    state: await loadSyncState(),
  };
}

async function runSync(): Promise<void> {
  await requireUnlocked();
  const cfg = cachedData!.settings.sync;
  if (!cfg?.enabled) throw new Error('同步未启用');
  const enc = await vaultBackend.load();
  if (!enc) throw new Error('保险箱不存在');

  const result = await syncVault(cfg, enc, dek!);
  if (result.mergedEncrypted) {
    await vaultBackend.save(result.mergedEncrypted);
    cachedData = await decryptVaultData(result.mergedEncrypted, dek!);
  }
  await saveSyncState({ serverRevision: result.serverRevision, lastSyncAt: Date.now() });
}

/** 本地保存后延迟自动同步（合并多次连续修改，失败只记录不打断）。 */
function scheduleAutoSync(): void {
  if (!cachedData?.settings.sync?.enabled) return;
  if (cachedData.settings.syncAuto === false) return; // 用户关闭了「修改后自动同步」
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    runSync().catch(async (e) => {
      const prev = (await loadSyncState()) ?? { serverRevision: 0 };
      await saveSyncState({
        ...prev,
        lastError: e instanceof Error ? e.message : String(e),
      });
    });
  }, 2500);
}

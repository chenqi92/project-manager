import { browser } from 'wxt/browser';
import {
  fillCredentialsInPage,
  fillTotpInPage,
  fillUsernameInPage,
  getOrigin,
  linkMatchesUrl,
  registrableDomain,
} from '@/lib/autofill';
import { fromB64, toB64 } from '@/lib/crypto';
import { flatten, matchForUrl, search } from '@/lib/search';
import { buildExport, mergeVaults, parseImport } from '@/lib/import-export';
import type { Msg, MsgResponse } from '@/lib/messaging';
import { authorizeDrive } from '@/lib/oauth';
import { vaultBackend } from '@/lib/storage';
import { hasSyncRelevantChange } from '@/lib/sync-change';
import { SyncClient } from '@/lib/sync';
import { generateTotp, parseTotp } from '@/lib/totp';
import {
  SyncEngineError,
  forcePullFromProvider,
  forcePushToProvider,
  migrateSyncSettings,
  providerFor,
  syncWithProvider,
  toTargetView,
} from '@/lib/sync-providers';
import { synologyLogin } from '@/lib/sync-providers/synology';
import { VAULT_LOCKED_MSG } from '@/lib/types';
import type {
  AssistEntry,
  AssistSnapshot,
  BioEnrollmentPublic,
  CapturePending,
  CaptureSaveTarget,
  CaptureSuccessSignals,
  CaptureUpdateCandidate,
  PlatformLink,
  SyncState,
  SyncStateMap,
  SyncTarget,
  SyncTargetView,
  VaultData,
  VaultSettings,
  VaultStatus,
} from '@/lib/types';
import {
  envTagName,
  linkUrls,
  newAccount,
  newEnvironment,
  newLink,
  newProject,
  normalizeVaultData,
} from '@/lib/vault-ops';
import { commitWorkspaceDraft, workspaceScopedData } from '@/lib/workspace';
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
const SYNC_STATE_KEY = 'syncState'; // 旧版单一自托管同步状态（迁移后仅用于清理）
const SYNC_MAP_KEY = 'syncStateMap'; // 按目标 id 的多端同步状态
const PENDING_KEY = 'pendingCapture';
const LOGIN_CANDIDATES_KEY = 'loginCaptureCandidates';
const LOGIN_CANDIDATE_TTL_MS = 5 * 60_000;
const AUTO_FILLS_KEY = 'recentAutoFills';
const AUTO_FILL_TTL_MS = 30 * 60_000;

// 全部仅存在于内存（SW 重启后从 session 恢复，浏览器关闭即丢失）。
let dek: Uint8Array | null = null;
let cachedData: VaultData | null = null;
let cachedSettingsFingerprint: string | null = null;
let autoLockMinutes = 15;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let clipboardOffscreenReady = false;
let pendingCaptures: Record<string, CapturePending> = {};
let loginCandidates: Record<string, LoginCaptureCandidate> = {};
let recentAutoFills: Record<string, RecentAutoFill> = {};
let foreignVaultPasswords: string[] = [];

type LoginCaptureCandidate = Pick<
  CapturePending,
  'origin' | 'url' | 'pageTitle' | 'username' | 'password' | 'tenant' | 'authProvider' | 'totp' | 'tabId'
> & {
  createdAt: number;
};

/** 最近一次由扩展执行的自动填充（按 tab+origin）：捕获到同样的凭据时不再提示保存/更新。 */
interface RecentAutoFill {
  origin: string;
  username: string;
  password: string;
  tenant?: string;
  tabId?: number;
  at: number;
}

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
  browser.runtime.onInstalled.addListener((details) => {
    browser.contextMenus.create({
      id: 'save-to-vault',
      title: '保存到项目环境管家',
      contexts: ['page', 'link'],
    });
    if (details.reason === 'install') {
      browser.tabs
        .create({ url: browser.runtime.getURL('/options.html?welcome=1') })
        .catch(() => browser.runtime.openOptionsPage());
    }
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const url = info.linkUrl || info.pageUrl || tab?.url || '';
    const title = tab?.title || '';
    const target =
      browser.runtime.getURL('/options.html') +
      `?capture=1&url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`;
    browser.tabs.create({ url: target });
  });

  // 登录捕获内容脚本：只在「保险箱内已有链接」且「用户已授权」的站点动态注册。
  // 同步/API/热榜等非登录站点即使有 host 权限，也不会被注册捕获脚本。
  refreshCaptureRegistration();
  browser.permissions.onAdded.addListener(() => refreshCaptureRegistration());
  browser.permissions.onRemoved.addListener(() => refreshCaptureRegistration());

  // 地址栏 "env" 关键字搜索。
  browser.omnibox.setDefaultSuggestion({ description: '搜索项目 / 环境 / 链接 / 账号…' });
  browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
    await ensureRestored();
    if (!cachedData) {
      suggest([{ content: '__locked__', description: '🔒 先解锁保险箱后再搜索' }]);
      return;
    }
    const activeData = workspaceScopedData(cachedData);
    const hits = search(activeData, text).slice(0, 8);
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
    const activeData = workspaceScopedData(cachedData);
    const entry = text.startsWith('acc:')
      ? flatten(activeData).find((e) => e.accountId === text.slice(4))
      : search(activeData, text)[0];
    if (!entry?.url) return;
    await openAndFill(
      entry.url,
      entry.username,
      entry.password,
      cachedData.settings.autoSubmit === true,
      entry.tenant,
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

function siteForFill(url: string): string {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}

/**
 * 注入凭据填充到所有 frame（带同主域护栏），并聚合各 frame 结果；site 为空时退回只填顶层 frame。
 * 使登录表单在「同主域跨域 iframe」（如阿里云 passport.aliyun.com 嵌在 account.aliyun.com）里也能被填。
 * 跨域 iframe 需扩展已获得该 iframe 域名的主机权限才会被注入（否则该 frame 被跳过）。
 */
async function injectCredentialFill(
  tabId: number,
  username: string,
  password: string,
  submit: boolean,
  url: string,
  tenant?: string,
): Promise<ReturnType<typeof fillCredentialsInPage>> {
  const site = siteForFill(url);
  const res = await browser.scripting.executeScript({
    target: site ? { tabId, allFrames: true } : { tabId },
    func: fillCredentialsInPage,
    args: [username, password, submit, site || undefined, tenant || undefined],
  });
  const results = res
    .map((r) => r.result)
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const merged =
    results.find((r) => r.ok === true) ??
    results.find((r) => r.reason && r.reason !== 'frame-not-allowed') ??
    results[0] ?? { ok: true };
  if (merged.ok === true) {
    await recordAutoFill(tabId, url, { username, password, tenant });
  }
  return merged;
}

/**
 * 登记一次由扩展执行的自动填充。登录捕获若发现提交的密码与刚填充的完全一致
 * （即用户没改动），就不再弹「更新账号 / 新建登录」提示。
 */
async function recordAutoFill(
  tabId: number | undefined,
  url: string,
  creds: { username: string; password: string; tenant?: string },
): Promise<void> {
  const origin = getOrigin(url);
  if (!origin || !creds.password) return;
  await ensureAutoFillsRestored();
  pruneAutoFills();
  recentAutoFills[pendingId(origin, tabId)] = {
    origin,
    username: creds.username,
    password: creds.password,
    tenant: creds.tenant,
    tabId,
    at: Date.now(),
  };
  await saveAutoFills();
}

function pruneAutoFills(): void {
  const cutoff = Date.now() - AUTO_FILL_TTL_MS;
  for (const [id, f] of Object.entries(recentAutoFills)) {
    if ((f.at ?? 0) < cutoff) delete recentAutoFills[id];
  }
}

async function ensureAutoFillsRestored(): Promise<void> {
  if (Object.keys(recentAutoFills).length > 0) return;
  const s = await browser.storage.session.get(AUTO_FILLS_KEY);
  recentAutoFills = (s[AUTO_FILLS_KEY] as Record<string, RecentAutoFill> | undefined) ?? {};
}

async function saveAutoFills(): Promise<void> {
  if (Object.keys(recentAutoFills).length > 0) {
    await browser.storage.session.set({ [AUTO_FILLS_KEY]: recentAutoFills });
  } else {
    await browser.storage.session.remove(AUTO_FILLS_KEY);
  }
}

/** 取该页面来源最近一次自动填充记录：优先同 tab，退回同源最新一条。 */
async function getRecentAutoFill(
  origin: string,
  tabId?: number,
): Promise<RecentAutoFill | null> {
  await ensureAutoFillsRestored();
  pruneAutoFills();
  const exact = recentAutoFills[pendingId(origin, tabId)];
  if (exact) return exact;
  const list = Object.values(recentAutoFills)
    .filter((f) => f.origin === origin)
    .sort((a, b) => b.at - a.at);
  if (tabId !== undefined) {
    const sameTab = list.find((f) => f.tabId === tabId);
    if (sameTab) return sameTab;
  }
  return list[0] ?? null;
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
  const matches = matchForUrl(workspaceScopedData(cachedData), tab.url);
  if (matches.length === 1) {
    const m = matches[0]!;
    await injectCredentialFill(
      tab.id,
      m.username,
      m.password,
      cachedData.settings.autoSubmit === true,
      m.url,
      m.tenant,
    );
  } else {
    browser.action.openPopup?.().catch(() => {});
  }
}

/** 消息发送方的最小结构（来自 chrome.runtime.MessageSender）。 */
type MsgSender = { url?: string; origin?: string; tab?: { id?: number } };

async function handle(msg: Msg, sender?: MsgSender): Promise<MsgResponse<unknown>> {
  // 来源校验：网页内容脚本只允许走捕获/助手消息；其它特权消息只接受扩展自身页面
  // （popup / options，chrome-extension://）发起，阻止被注入网页的脚本索取解密明文。
  const senderUrl = sender?.url ?? '';
  const pageMessage =
    msg.type === 'capture:candidate' ||
    msg.type === 'capture:successCheck' ||
    msg.type === 'capture:login' ||
    msg.type === 'capture:save' ||
    msg.type === 'capture:editSave' ||
    msg.type === 'capture:dismiss' ||
    msg.type === 'ui:openUnlock' ||
    msg.type === 'assist:matches' ||
    msg.type === 'assist:fillUsername' ||
    msg.type === 'assist:fill' ||
    msg.type === 'assist:fillTotp';
  if ((senderUrl.startsWith('http://') || senderUrl.startsWith('https://')) && !pageMessage) {
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
      const before = structuredClone(cachedData!);
      await persistData(msg.data);
      if (hasSyncRelevantChange(before, cachedData!)) scheduleAutoSync();
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
      const activeData = workspaceScopedData(data);
      const activeWorkspace = (data.workspaces ?? []).find((w) => w.id === data.activeWorkspaceId);
      const scoped =
        msg.projectIds && msg.projectIds.length
          ? {
              ...data,
              projects: activeData.projects.filter((p) => msg.projectIds!.includes(p.id)),
              settings: { ...data.settings, dashboard: activeWorkspace?.dashboard },
              workspaces: activeWorkspace
                ? [
                    {
                      ...activeWorkspace,
                      projects: activeData.projects.filter((p) => msg.projectIds!.includes(p.id)),
                    },
                  ]
                : undefined,
            }
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
      await unregisterAssistScripts();
      return getStatus();

    case 'activity':
      resetLockTimer();
      return;

    case 'clipboard:clearLater':
      await scheduleClipboardClear(msg.clearMs);
      return;

    case 'ui:openUnlock': {
      // 主密码只能在扩展自身安全上下文里输入（绝不能在网页注入的浮层里，页面可键盘记录/读取）。
      const encForBio = await vaultBackend.load();
      const hasBio = (encForBio?.bioEnrollments?.length ?? 0) > 0;
      if (hasBio) {
        // 已启用生物识别：WebAuthn 必须在持久页面里跑（popup 会因系统指纹弹窗失焦而关闭）。
        // 打开解锁标签页——LockScreen 挂载即自动触发 Touch ID，解锁成功后本页自请求关闭、回到原网页。
        await browser.tabs
          .create({ url: browser.runtime.getURL('/options.html?unlock=1') })
          .catch(() => browser.runtime.openOptionsPage());
      } else {
        // 无生物识别：弹出工具栏「小弹窗」输主密码——不整页跳转、网页读不到；不可用时回退开标签页。
        try {
          if (!browser.action.openPopup) throw new Error('no openPopup');
          await browser.action.openPopup();
        } catch {
          await browser.tabs
            .create({ url: browser.runtime.getURL('/options.html?unlock=1') })
            .catch(() => browser.runtime.openOptionsPage());
        }
      }
      return;
    }

    case 'ui:closeSelf':
      if (sender?.tab?.id != null) await browser.tabs.remove(sender.tab.id).catch(() => {});
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

    // ---------------- 多端同步 ----------------
    case 'sync:targets':
      return { targets: await listTargetViews(), autoSync: cachedData?.settings.syncAuto !== false };

    case 'sync:targetSave': {
      const data = await requireData();
      const targets = data.settings.syncTargets ?? (data.settings.syncTargets = []);
      const idx = targets.findIndex((t) => t.id === msg.target.id);
      const next = idx >= 0 ? mergeTargetSecrets(targets[idx]!, msg.target) : msg.target;
      if (idx >= 0) targets[idx] = next;
      else targets.push(next);
      await persistData(data);
      return { id: next.id, targets: await listTargetViews() };
    }

    case 'sync:targetRemove': {
      const data = await requireData();
      const targets = data.settings.syncTargets ?? [];
      const target = targets.find((t) => t.id === msg.id);
      if (target) {
        try {
          await providerFor(target).remove();
        } catch {
          /* 远端删除失败不阻断本地移除 */
        }
      }
      data.settings.syncTargets = targets.filter((t) => t.id !== msg.id);
      await persistData(data);
      await removeTargetState(msg.id);
      return { targets: await listTargetViews() };
    }

    case 'sync:targetPreflight':
      return providerFor(msg.target).preflight();

    case 'sync:listDir': {
      // 已保存目标用 id 取出含密钥的存储版本；编辑中的草稿直接用传入 target。
      const target = msg.id ? findTarget(msg.id) : msg.target;
      if (!target) throw new Error('缺少同步目标');
      const provider = providerFor(target);
      if (!provider.listDir) throw new Error('该类型暂不支持目录浏览');
      return { folders: await provider.listDir(msg.path) };
    }

    case 'sync:targetSync':
      return runTargetSync(findTarget(msg.id), {
        foreignPassword: msg.foreignPassword,
        confirmFirstPush: msg.confirmFirstPush,
      });

    case 'sync:targetPush': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('保险箱不存在');
      const target = findTarget(msg.id);
      try {
        const { tag } = await forcePushToProvider(providerFor(target), enc);
        await setTargetState(target.id, { lastSyncAt: Date.now(), remoteTag: tag, lastError: undefined });
      } catch (e) {
        await setTargetState(target.id, { lastError: errMsg(e) });
        throw e;
      }
      return;
    }

    case 'sync:targetPull': {
      await requireUnlocked();
      const enc = await vaultBackend.load();
      if (!enc) throw new Error('保险箱不存在');
      const target = findTarget(msg.id);
      try {
        const res = await forcePullFromProvider(providerFor(target), enc, dek!, {
          foreignPassword: msg.foreignPassword,
          foreignPasswords: syncForeignPasswordCandidates(msg.foreignPassword),
        });
        if (res.kind === 'foreign') return { foreign: true };
        rememberForeignPassword(msg.foreignPassword);
        if (res.kind === 'replaced') {
          await adoptSyncedVault(res.localEncrypted);
          await setTargetState(target.id, { lastSyncAt: Date.now(), remoteTag: res.tag, lastError: undefined });
        }
      } catch (e) {
        await setTargetState(target.id, { lastError: errMsg(e) });
        throw e;
      }
      return { foreign: false };
    }

    case 'sync:now':
      await syncAllEnabled();
      return;

    case 'sync:oauthAuthorize':
      return authorizeDrive(msg.driveType, msg.clientId, msg.clientSecret);

    case 'sync:synologyAuthorize': {
      // 用 OTP 登录群晖并申领受信设备令牌（did）；无 2FA 时 did 为空但登录已验证。
      const { did } = await synologyLogin(msg.baseUrl, {
        account: msg.account,
        password: msg.password,
        otpCode: msg.otpCode,
      });
      return { did: did ?? '' };
    }

    case 'sync:synologyRebind': {
      // 换设备/令牌失效后用已存的账号密码 + 新 OTP 重新申领 did，并持久化。
      await requireUnlocked();
      const data = await requireData();
      const target = (data.settings.syncTargets ?? []).find((x) => x.id === msg.id);
      if (!target) throw new Error('找不到该同步目标');
      const rec = target as unknown as {
        type: string;
        baseUrl?: string;
        account?: string;
        password?: string;
        did?: string;
      };
      if (rec.type !== 'synology') throw new Error('该目标不是群晖');
      const { did } = await synologyLogin(String(rec.baseUrl ?? ''), {
        account: String(rec.account ?? ''),
        password: String(rec.password ?? ''),
        otpCode: msg.otp,
      });
      rec.did = did ?? '';
      await persistData(data);
      return { ok: true };
    }

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
      return openAndFill(msg.url, msg.username, msg.password, msg.submit, msg.tenant);

    case 'capture:markAutoFill':
      // 仅扩展页面可发（pageMessage 白名单外）：popup 直填成功后登记，捕获时据此跳过提示。
      await recordAutoFill(msg.tabId, msg.url, {
        username: msg.username,
        password: msg.password,
        tenant: msg.tenant,
      });
      return;

    case 'assist:matches':
      return assistMatches(sender);

    case 'assist:fillUsername':
      return assistFillUsername(sender, msg.accountId, msg.submit === true);

    case 'assist:fill':
      return assistFill(sender, msg.accountId, msg.submit === true);

    case 'assist:fillTotp':
      return assistFillTotp(sender, msg.accountId, msg.submit === true);

    case 'capture:candidate': {
      const trusted = senderOrigin(sender);
      if (!trusted || trusted !== getOrigin(msg.url)) return;
      await handleCaptureCandidate(
        trusted,
        msg.url,
        msg.username,
        msg.password,
        sender?.tab?.id,
        msg.title,
        msg.totp,
        msg.authProvider,
        msg.tenant,
      );
      return;
    }
    case 'capture:successCheck': {
      const trusted = senderOrigin(sender);
      if (!trusted || trusted !== getOrigin(msg.url)) return null;
      return handleCaptureSuccessCheck(trusted, msg.url, msg.signals, sender?.tab?.id, msg.title);
    }
    case 'capture:login': {
      // 只信任 sender 的真实来源，丢弃消息体里可被伪造的 origin 字段；并要求 url 同源。
      const trusted = senderOrigin(sender);
      if (!trusted || trusted !== getOrigin(msg.url)) return;
      return handleCaptureLogin(
        trusted,
        msg.url,
        msg.username,
        msg.password,
        sender?.tab?.id,
        {},
        msg.title,
        msg.totp,
        msg.authProvider,
        msg.tenant,
      );
    }
    case 'capture:manual': {
      const origin = getOrigin(msg.url);
      if (!origin) throw new Error('当前网页地址不支持保存登录');
      if (msg.tabId !== undefined) {
        const tab = await browser.tabs.get(msg.tabId).catch(() => null);
        if (tab?.url && getOrigin(tab.url) !== origin) {
          throw new Error('当前网页已变化，请重新捕获');
        }
      }
      return handleCaptureLogin(
        origin,
        msg.url,
        msg.username,
        msg.password,
        msg.tabId,
        {
          allowUnknownOrigin: true,
        },
        msg.title,
        msg.totp,
        undefined,
        msg.tenant,
      );
    }
    case 'capture:pending':
      await requireUnlocked();
      return getPending(msg.id);
    case 'capture:save':
      await applyCapture(msg.id, senderOrigin(sender), sender?.tab?.id, msg.accountId, {
        username: msg.username,
        accountLabel: msg.accountLabel,
        targetLinkId: msg.targetLinkId,
        targetProjectId: msg.targetProjectId,
        newProjectName: msg.newProjectName,
        targetWorkspaceId: msg.targetWorkspaceId,
      });
      return;
    case 'capture:editSave':
      await openCaptureEditor(msg.id, senderOrigin(sender), sender?.tab?.id);
      return;
    case 'capture:dismiss':
      await clearPending(msg.id, senderOrigin(sender), sender?.tab?.id);
      return;
  }
}

// --------------------------- 网页内助手 / 登录捕获 ---------------------------

function senderOrigin(sender?: MsgSender): string | null {
  const raw = sender?.origin ?? '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return getOrigin(sender?.url ?? '');
}

function senderPageUrl(sender?: MsgSender): string | null {
  const origin = senderOrigin(sender);
  if (!origin) return null;
  if (sender?.url && getOrigin(sender.url) === origin) return sender.url;
  return `${origin}/`;
}

function toAssistEntry(e: ReturnType<typeof matchForUrl>[number]): AssistEntry {
  return {
    accountId: e.accountId,
    projectName: e.projectName,
    envName: e.envName,
    envKind: e.envKind as AssistEntry['envKind'],
    linkName: e.linkName,
    accountLabel: e.accountLabel,
    username: e.username,
    hasTotp: Boolean(e.totp),
  };
}

async function assistMatches(sender?: MsgSender): Promise<AssistSnapshot> {
  await ensureRestored();
  const origin = senderOrigin(sender) ?? '';
  const enabled =
    cachedData?.settings.webAssist !== false || cachedData?.settings.webAssistAllSites === true;
  if (!dek || !cachedData) {
    return { locked: true, enabled: false, origin, autoSubmit: false, theme: 'system', matches: [] };
  }
  const pageUrl = senderPageUrl(sender);
  const matches = enabled && pageUrl ? matchForUrl(workspaceScopedData(cachedData), pageUrl).map(toAssistEntry) : [];
  return {
    locked: false,
    enabled,
    origin,
    autoSubmit: cachedData.settings.autoSubmit === true,
    autoFlow: cachedData.settings.autoFlow !== false,
    theme: cachedData.settings.theme ?? 'system',
    capturePromptPlacement: cachedData.settings.capturePromptPlacement ?? 'top-right',
    matches,
  };
}

async function findAssistEntry(sender: MsgSender | undefined, accountId: string) {
  const data = await requireData();
  const pageUrl = senderPageUrl(sender);
  if (!pageUrl) throw new Error('无法确认当前网页来源');
  const entry = matchForUrl(workspaceScopedData(data), pageUrl).find((e) => e.accountId === accountId);
  if (!entry) throw new Error('该账号与当前网页来源不匹配，已阻止填充');
  const tabId = sender?.tab?.id;
  if (tabId === undefined) throw new Error('无法定位当前标签页');
  return { data, entry, tabId };
}

async function assistFillUsername(
  sender: MsgSender | undefined,
  accountId: string,
  submit: boolean,
): Promise<unknown> {
  const { entry, tabId } = await findAssistEntry(sender, accountId);
  const res = await browser.scripting.executeScript({
    target: { tabId },
    func: fillUsernameInPage,
    args: [entry.username, submit],
  });
  return res[0]?.result ?? { ok: true };
}

async function assistFill(
  sender: MsgSender | undefined,
  accountId: string,
  submit: boolean,
): Promise<unknown> {
  const { entry, tabId } = await findAssistEntry(sender, accountId);
  return injectCredentialFill(tabId, entry.username, entry.password, submit, entry.url, entry.tenant);
}

async function assistFillTotp(
  sender: MsgSender | undefined,
  accountId: string,
  submit: boolean,
): Promise<unknown> {
  const { entry, tabId } = await findAssistEntry(sender, accountId);
  if (!entry.totp) throw new Error('该账号没有 TOTP');
  const cfg = parseTotp(entry.totp);
  if (!cfg) throw new Error('TOTP 密钥无效');
  const { code } = await generateTotp(cfg, Date.now());
  const res = await browser.scripting.executeScript({
    target: { tabId },
    func: fillTotpInPage,
    args: [code, submit],
  });
  return res[0]?.result ?? { ok: true };
}

async function refreshCaptureRegistration(): Promise<void> {
  try {
    await ensureRestored();
    await registerCaptureForData(cachedData);
  } catch (e) {
    console.warn('refreshCaptureRegistration failed:', e);
  }
}

async function registerCaptureForData(data: VaultData | null): Promise<void> {
  try {
    if (!data) return;
    const activeData = workspaceScopedData(data);
    await unregisterAssistScripts();
    const perms = await browser.permissions.getAll();
    const granted = perms.origins ?? [];
    const knownOrigins = captureMatchPatterns(activeData).filter((pattern) =>
      hasOriginPermission(pattern, granted),
    );
    const assistEnabled =
      data.settings.webAssist !== false || data.settings.webAssistAllSites === true;
    const allSiteOrigins: string[] = [];
    if (data.settings.webAssistAllSites === true) {
      if (hasOriginPermission('https://*/*', granted)) allSiteOrigins.push('https://*/*');
      if (hasOriginPermission('http://*/*', granted)) allSiteOrigins.push('http://*/*');
    }
    const origins = [...new Set([...(assistEnabled ? allSiteOrigins : []), ...knownOrigins])];
    if (origins.length === 0) return;
    await browser.scripting.registerContentScripts([
      {
        id: assistEnabled ? 'web-assist' : 'capture',
        js: [assistEnabled ? 'web-assist.js' : 'capture.js'],
        matches: origins,
        runAt: 'document_idle',
      },
    ]);
  } catch (e) {
    console.warn('registerCapture failed:', e);
  }
}

function captureMatchPatterns(data: VaultData): string[] {
  const out = new Set<string>();
  for (const proj of data.projects)
    for (const env of proj.environments)
      for (const link of env.links)
        for (const url of linkUrls(link)) {
          const origin = getOrigin(url);
          if (origin) out.add(`${origin}/*`);
        }
  return [...out];
}

function hasOriginPermission(pattern: string, granted: string[]): boolean {
  if (granted.includes(pattern) || granted.includes('<all_urls>')) return true;
  if (pattern.startsWith('https://') && granted.includes('https://*/*')) return true;
  if (pattern.startsWith('http://') && granted.includes('http://*/*')) return true;
  return false;
}

async function handleCaptureCandidate(
  origin: string,
  url: string,
  username: string,
  password: string,
  tabId?: number,
  pageTitle?: string,
  rawTotp?: string,
  rawAuthProvider?: string,
  rawTenant?: string,
): Promise<void> {
  await ensureRestored();
  const authProvider = cleanAuthProvider(rawAuthProvider);
  const nextPassword = String(password ?? '');
  const nextUsername = cleanCaptureUsername(username, authProvider);
  const totp = normalizeCapturedTotp(rawTotp);
  if (!dek || !cachedData || (!nextPassword && !authProvider && !totp)) return;
  if (!captureAllowedForOrigin(cachedData, origin)) return;
  await ensureLoginCandidatesRestored();
  pruneLoginCandidates();
  loginCandidates[pendingId(origin, tabId)] = {
    origin,
    url,
    pageTitle: cleanCaptureTitle(pageTitle),
    username: nextUsername,
    password: nextPassword,
    tenant: cleanTenant(rawTenant),
    authProvider,
    totp,
    tabId,
    createdAt: Date.now(),
  };
  await saveLoginCandidates();
}

async function handleCaptureSuccessCheck(
  origin: string,
  url: string,
  signals: CaptureSuccessSignals,
  tabId?: number,
  pageTitle?: string,
): Promise<{
  pending: true;
  id?: string;
  kind: CapturePending['kind'];
  origin: string;
  username: string;
  linkName?: string;
} | null> {
  await ensureRestored();
  if (!dek || !cachedData) return null;
  await ensureLoginCandidatesRestored();
  pruneLoginCandidates();
  const candidate = getLoginCandidateForContext(origin, tabId);
  if (!candidate) {
    await saveLoginCandidates();
    return null;
  }
  if (candidate.origin !== origin || getOrigin(url) !== origin) return null;
  const totp = normalizeCapturedTotp(signals.totp) || candidate.totp;
  if (!loginSuccessLooksLikely(candidate, url, signals)) {
    if (totp && signals.visiblePasswordFields === 0) {
      candidate.totp = totp;
      candidate.createdAt = Date.now();
    }
    await saveLoginCandidates();
    return null;
  }

  delete loginCandidates[pendingId(candidate.origin, candidate.tabId)];
  await saveLoginCandidates();
  return handleCaptureLogin(
    candidate.origin,
    candidate.url,
    candidate.username,
    candidate.password,
    candidate.tabId,
    {},
    candidate.pageTitle || pageTitle,
    totp,
    candidate.authProvider,
    candidate.tenant,
  );
}

function captureAllowedForOrigin(data: VaultData, origin: string): boolean {
  if (data.settings.webAssistAllSites === true) return true;
  const activeData = workspaceScopedData(data);
  for (const proj of activeData.projects)
    for (const env of proj.environments)
      for (const link of env.links)
        if (linkUrls(link).some((u) => getOrigin(u) === origin)) return true;
  return false;
}

function captureSaveTargets(data: VaultData, pageUrl: string): CaptureSaveTarget[] {
  const out: CaptureSaveTarget[] = [];
  const activeData = workspaceScopedData(data);
  for (const proj of activeData.projects)
    for (const env of proj.environments)
      for (const link of env.links)
        if (linkMatchesUrl(link, pageUrl)) {
          const envKind = link.envKind ?? env.kind;
          out.push({
            projectId: proj.id,
            projectName: proj.name,
            envId: env.id,
            envName: envTagName(envKind, link.envName ?? env.name),
            linkId: link.id,
            linkName: link.name,
          });
        }
  return out;
}

function captureProjectTargets(data: VaultData): NonNullable<CapturePending['projectTargets']> {
  // 列出所有工作区的项目（带 workspaceId），让捕获浮层能先选工作区再选项目。
  const out: NonNullable<CapturePending['projectTargets']> = [];
  for (const ws of data.workspaces ?? []) {
    for (const proj of ws.projects) {
      out.push({ projectId: proj.id, projectName: proj.name, workspaceId: ws.id, workspaceName: ws.name });
    }
  }
  if (out.length) return out;
  return workspaceScopedData(data).projects.map((proj) => ({ projectId: proj.id, projectName: proj.name }));
}

function cleanAuthProvider(provider?: string): string | undefined {
  const clean = (provider ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 40) : undefined;
}

function cleanTenant(tenant?: string): string | undefined {
  const clean = (tenant ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 80) : undefined;
}

function providerAccountName(provider?: string): string {
  return provider ? `${provider} 登录` : '第三方登录';
}

function cleanCaptureUsername(username: string, authProvider?: string): string {
  const clean = (username ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 120) : authProvider ? providerAccountName(authProvider) : '';
}

function cleanCaptureTitle(title?: string): string | undefined {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  if (/^(登录|登陆|用户登录|login|sign in|signin)$/i.test(clean)) return undefined;
  return clean.slice(0, 80);
}

function normalizeCapturedTotp(raw?: string): string | undefined {
  const text = (raw ?? '').trim();
  if (!text) return undefined;
  const candidate = text.startsWith('otpauth://') ? text : text.replace(/[\s-]+/g, '');
  return parseTotp(candidate) ? candidate : undefined;
}

function captureLinkNameFrom(origin: string, url: string, pageTitle?: string): string {
  const title = cleanCaptureTitle(pageTitle);
  if (title) return title;
  try {
    return new URL(url).host || new URL(origin).host;
  } catch {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  }
}

async function unregisterAssistScripts(): Promise<void> {
  await browser.scripting.unregisterContentScripts({ ids: ['capture'] }).catch(() => {});
  await browser.scripting.unregisterContentScripts({ ids: ['web-assist'] }).catch(() => {});
}

function captureLinkName(p: CapturePending): string {
  return p.linkName || captureLinkNameFrom(p.origin, p.url, p.pageTitle);
}

function captureHostName(p: CapturePending): string {
  try {
    return new URL(p.url).host || new URL(p.origin).host;
  } catch {
    try {
      return new URL(p.origin).host;
    } catch {
      return p.origin;
    }
  }
}

function loginSuccessLooksLikely(
  candidate: LoginCaptureCandidate,
  currentUrl: string,
  signals: CaptureSuccessSignals,
): boolean {
  const age = Date.now() - candidate.createdAt;
  if (age < 450) return false;
  if (age > LOGIN_CANDIDATE_TTL_MS) return false;
  if (signals.visiblePasswordFields > 0 || signals.filledPasswordFields > 0) return false;
  if (normalizeCapturedTotp(signals.totp) && age >= 450) return true;

  const leftSubmitPage = normalizeCaptureUrl(candidate.url) !== normalizeCaptureUrl(currentUrl);
  if (signals.successHint) return true;
  if (leftSubmitPage) return true;

  // SPA 登录弹窗常常原地消失；等一会儿且没有 OTP 步骤时再认为通过。
  return age >= 2_500 && signals.visibleOtpFields === 0;
}

function normalizeCaptureUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function pruneLoginCandidates(): void {
  const cutoff = Date.now() - LOGIN_CANDIDATE_TTL_MS;
  for (const [id, c] of Object.entries(loginCandidates)) {
    if ((c.createdAt ?? 0) < cutoff) delete loginCandidates[id];
  }
}

function getLoginCandidateForContext(origin: string, tabId?: number): LoginCaptureCandidate | null {
  const id = pendingId(origin, tabId);
  if (loginCandidates[id]) return loginCandidates[id]!;
  const list = Object.values(loginCandidates)
    .filter((c) => c.origin === origin)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (tabId !== undefined) {
    const sameTab = list.find((c) => c.tabId === tabId);
    if (sameTab) return sameTab;
  }
  return list[0] ?? null;
}

async function ensureLoginCandidatesRestored(): Promise<void> {
  if (Object.keys(loginCandidates).length > 0) return;
  const s = await browser.storage.session.get(LOGIN_CANDIDATES_KEY);
  loginCandidates = (s[LOGIN_CANDIDATES_KEY] as Record<string, LoginCaptureCandidate> | undefined) ?? {};
}

async function saveLoginCandidates(): Promise<void> {
  pruneLoginCandidates();
  if (Object.keys(loginCandidates).length > 0) {
    await browser.storage.session.set({ [LOGIN_CANDIDATES_KEY]: loginCandidates });
  } else {
    await browser.storage.session.remove(LOGIN_CANDIDATES_KEY);
  }
}

async function handleCaptureLogin(
  origin: string,
  url: string,
  rawUsername: string,
  rawPassword: string,
  tabId?: number,
  opts: { allowUnknownOrigin?: boolean } = {},
  pageTitle?: string,
  rawTotp?: string,
  rawAuthProvider?: string,
  rawTenant?: string,
): Promise<{
  pending: true;
  id?: string;
  kind: CapturePending['kind'];
  origin: string;
  username: string;
  accountId?: string;
  linkName?: string;
  updateCandidates?: CaptureUpdateCandidate[];
  saveTargets?: CaptureSaveTarget[];
  projectTargets?: NonNullable<CapturePending['projectTargets']>;
  workspaces?: CapturePending['workspaces'];
  activeWorkspaceId?: string;
  accountLabel?: string;
  targetLinkId?: string;
  totp?: string;
  tenant?: string;
} | null> {
  await ensureRestored();
  const authProvider = cleanAuthProvider(rawAuthProvider);
  const password = String(rawPassword ?? '');
  const username = cleanCaptureUsername(rawUsername, authProvider);
  const totp = normalizeCapturedTotp(rawTotp);
  const tenant = cleanTenant(rawTenant);
  if (!dek || !cachedData || (!password && !authProvider && !totp)) return null; // 锁定时忽略

  // 自动填充抑制：提交的密码与扩展刚在该页面填充的完全一致（用户没改动），
  // 就不弹保存/更新提示——用户名匹配交给页面启发式时常有误差（掩码手机号 / 租户框等），
  // 密码逐字节一致已足够说明「这就是保险箱里那条凭据」。手动捕获（popup 兜底）不受此限制。
  if (!opts.allowUnknownOrigin && password) {
    const auto = await getRecentAutoFill(origin, tabId);
    if (auto && auto.password === password && (!tenant || (auto.tenant ?? '') === tenant)) {
      await clearPending(undefined, origin, tabId);
      return null;
    }
  }

  let matchAccountId: string | undefined;
  let linkName: string | undefined;
  let exactSame = false;
  let matchedKnownLink = false;
  const updateCandidates: CaptureUpdateCandidate[] = [];
  const saveTargets = captureSaveTargets(cachedData, url);
  const projectTargets = captureProjectTargets(cachedData);
  const captureWorkspaces = (cachedData.workspaces ?? []).map((w) => ({ id: w.id, name: w.name }));
  const activeWorkspaceId = cachedData.activeWorkspaceId;
  const cleanPageTitle = cleanCaptureTitle(pageTitle);
  const activeData = workspaceScopedData(cachedData);
  for (const proj of activeData.projects) {
    for (const env of proj.environments) {
      for (const link of env.links) {
        if (!linkMatchesUrl(link, url)) continue;
        matchedKnownLink = true;
        linkName = link.name;
        for (const acc of link.accounts) {
          updateCandidates.push({
            accountId: acc.id,
            accountLabel: acc.label,
            username: acc.username,
            linkName: link.name,
          });
          // 捕获到的租户与已存的不同才算变化；捕获不到租户（页面没这个字段）不算。
          const tenantSame = !tenant || (acc.tenant ?? '') === tenant;
          if (acc.username && username && acc.username.toLowerCase() === username.toLowerCase()) {
            matchAccountId = acc.id;
            if (acc.password === password && (!totp || acc.totp === totp) && tenantSame)
              exactSame = true;
          } else if (
            authProvider &&
            !acc.password &&
            [acc.label, acc.username]
              .filter(Boolean)
              .some((value) => value.toLowerCase().includes(authProvider.toLowerCase()))
          ) {
            matchAccountId = acc.id;
            if ((!totp || acc.totp === totp) && tenantSame) exactSame = true;
          }
        }
      }
    }
  }
  if (!matchedKnownLink && cachedData.settings.webAssistAllSites !== true) {
    if (!opts.allowUnknownOrigin) return null; // 默认不捕获保险箱外的任意授权站点
  }
  if (exactSame) {
    await clearPending(undefined, origin, tabId);
    return null; // 已是最新，无需提示
  }
  const suggestedLinkName = linkName || captureLinkNameFrom(origin, url, cleanPageTitle);
  let pending: CapturePending;
  if (matchAccountId) {
    pending = {
      kind: 'update',
      origin,
      url,
      pageTitle: cleanPageTitle,
      username,
      password,
      tenant,
      authProvider,
      totp,
      tabId,
      accountId: matchAccountId,
      linkName: suggestedLinkName,
      accountLabel: authProvider ? providerAccountName(authProvider) : undefined,
      updateCandidates: updateCandidates.slice(0, 8),
      saveTargets,
      projectTargets,
    };
  } else {
    pending = {
      kind: 'new',
      origin,
      url,
      pageTitle: cleanPageTitle,
      username,
      password,
      tenant,
      authProvider,
      totp,
      tabId,
      linkName: suggestedLinkName,
      accountLabel: authProvider ? providerAccountName(authProvider) : undefined,
      updateCandidates: updateCandidates.slice(0, 8),
      saveTargets,
      projectTargets,
      workspaces: captureWorkspaces,
      activeWorkspaceId,
      targetLinkId: saveTargets[0]?.linkId,
    };
  }
  const saved = await savePending(pending);
  return {
    pending: true,
    kind: saved.kind,
    origin: saved.origin,
    username: saved.username,
    accountId: saved.accountId,
    linkName: saved.linkName,
    id: saved.id,
    updateCandidates: saved.updateCandidates,
    saveTargets: saved.saveTargets,
    projectTargets: saved.projectTargets,
    workspaces: saved.workspaces,
    activeWorkspaceId: saved.activeWorkspaceId,
    accountLabel: saved.accountLabel,
    targetLinkId: saved.targetLinkId,
    totp: saved.totp,
    tenant: saved.tenant,
  };
}

async function applyCapture(
  id?: string,
  senderOrigin?: string | null,
  tabId?: number,
  updateAccountId?: string,
  edits: {
    username?: string;
    accountLabel?: string;
    targetLinkId?: string;
    targetProjectId?: string;
    newProjectName?: string;
    targetWorkspaceId?: string;
  } = {},
): Promise<void> {
  await requireUnlocked();
  const p = await getPendingForContext(id, senderOrigin, tabId);
  if (!p) return;
  if (senderOrigin && p.origin !== senderOrigin) throw new Error('保存来源与当前网页不一致');
  const data = structuredClone(cachedData!);
  const targetAccountId = updateAccountId || (p.kind === 'update' ? p.accountId : undefined);
  const nextUsername = (edits.username ?? p.username).trim();
  const nextLabel = (edits.accountLabel ?? p.accountLabel ?? '').trim();
  if (
    updateAccountId &&
    updateAccountId !== p.accountId &&
    !(p.updateCandidates ?? []).some((c) => c.accountId === updateAccountId)
  ) {
    throw new Error('该账号不是本次登录捕获的更新候选');
  }

  if (targetAccountId) {
    let updated = false;
    for (const proj of data.projects)
      for (const env of proj.environments)
        for (const link of env.links)
          for (const acc of link.accounts)
            if (acc.id === targetAccountId) {
              if (nextUsername) acc.username = nextUsername;
              if (nextLabel) acc.label = nextLabel;
              if (p.totp) acc.totp = p.totp;
              if (p.tenant) acc.tenant = p.tenant;
              if (p.password || !p.authProvider) acc.password = p.password;
              acc.updatedAt = Date.now();
              updated = true;
            }
    if (!updated) throw new Error('找不到要更新的账号');
  } else {
    let target: PlatformLink | null = null;
    let targetProject: VaultData['projects'][number] | null = null;
    let targetEnv: VaultData['projects'][number]['environments'][number] | null = null;
    if (edits.targetLinkId || p.targetLinkId) {
      const targetLinkId = edits.targetLinkId || p.targetLinkId;
      for (const proj of data.projects)
        for (const env of proj.environments)
          for (const link of env.links)
            if (link.id === targetLinkId && linkMatchesUrl(link, p.url)) {
              target = link;
              targetProject = proj;
              targetEnv = env;
            }
      if (!target) throw new Error('找不到要保存到的链接');
    }
    for (const proj of data.projects)
      for (const env of proj.environments)
        for (const link of env.links)
          if (!target && linkMatchesUrl(link, p.url)) {
            target = link;
            targetProject = proj;
            targetEnv = env;
          }

    if (!target && (edits.targetProjectId || edits.newProjectName !== undefined)) {
      // 保存到用户选中的工作区：非当前激活工作区则指向该工作区的 projects 数组。
      const targetProjects =
        edits.targetWorkspaceId && edits.targetWorkspaceId !== data.activeWorkspaceId
          ? (data.workspaces?.find((w) => w.id === edits.targetWorkspaceId)?.projects ?? data.projects)
          : data.projects;
      if (edits.targetProjectId) {
        targetProject = targetProjects.find((proj) => proj.id === edits.targetProjectId) ?? null;
        if (!targetProject) throw new Error('找不到要保存到的项目');
      } else {
        targetProject = newProject({ name: edits.newProjectName?.trim() || captureHostName(p) });
        targetProjects.push(targetProject);
      }

      targetEnv =
        targetProject.environments.find((env) => env.name === envTagName(env.kind, undefined)) ??
        targetProject.environments[0] ??
        null;
      if (!targetEnv) {
        targetEnv = newEnvironment({ name: envTagName('other', undefined), kind: 'other' });
        targetProject.environments.push(targetEnv);
      }

      target = newLink({
        name: captureLinkName(p),
        envKind: targetEnv.kind,
        envName: envTagName(targetEnv.kind, targetEnv.name),
        url: p.url || p.origin,
      });
      targetEnv.links.push(target);
    }

    if (!target) throw new Error('请选择保存项目或新建项目');
    const now = Date.now();
    target.accounts.push(
      newAccount({
        label: nextLabel,
        username: nextUsername,
        password: p.password,
        tenant: p.tenant,
        totp: p.totp,
      }),
    );
    target.updatedAt = now;
    if (targetEnv) targetEnv.updatedAt = now;
    if (targetProject) targetProject.updatedAt = now;
  }

  await persistData(data);
  scheduleAutoSync();
  await clearPending(p.id);
}

async function savePending(p: CapturePending): Promise<CapturePending> {
  const id = p.id ?? pendingId(p.origin, p.tabId);
  const next = { ...p, id, createdAt: Date.now() };
  pendingCaptures[id] = next;
  await browser.storage.session.set({ [PENDING_KEY]: pendingCaptures });
  browser.action.setBadgeText({ text: '1' }).catch(() => {});
  browser.action.setBadgeBackgroundColor?.({ color: '#e11d48' }).catch(() => {});
  return next;
}

async function clearPending(id?: string, origin?: string | null, tabId?: number): Promise<void> {
  await ensurePendingRestored();
  const p = await getPendingForContext(id, origin, tabId);
  if (!p?.id) return;
  delete pendingCaptures[p.id];
  if (Object.keys(pendingCaptures).length > 0) {
    await browser.storage.session.set({ [PENDING_KEY]: pendingCaptures });
    browser.action.setBadgeText({ text: String(Math.min(9, Object.keys(pendingCaptures).length)) }).catch(() => {});
  } else {
    await browser.storage.session.remove(PENDING_KEY);
    browser.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

async function getPending(id?: string): Promise<CapturePending | null> {
  await ensurePendingRestored();
  if (id) return pendingCaptures[id] ?? null;
  return latestPending();
}

async function getPendingForContext(
  id?: string,
  origin?: string | null,
  tabId?: number,
): Promise<CapturePending | null> {
  await ensurePendingRestored();
  if (id && pendingCaptures[id]) return pendingCaptures[id];
  const list = Object.values(pendingCaptures).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (origin && tabId !== undefined) {
    const exact = list.find((p) => p.origin === origin && p.tabId === tabId);
    if (exact) return exact;
  }
  if (origin) {
    const sameOrigin = list.find((p) => p.origin === origin);
    if (sameOrigin) return sameOrigin;
  }
  return list[0] ?? null;
}

function pendingId(origin: string, tabId?: number): string {
  return `${tabId ?? 'tab'}:${origin}`;
}

function latestPending(): CapturePending | null {
  const list = Object.values(pendingCaptures);
  if (list.length === 0) return null;
  return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
}

async function ensurePendingRestored(): Promise<void> {
  if (Object.keys(pendingCaptures).length > 0) return;
  const s = await browser.storage.session.get(PENDING_KEY);
  const stored = s[PENDING_KEY] as Record<string, CapturePending> | CapturePending | undefined;
  if (!stored) return;
  if ('origin' in stored) {
    const legacy = stored as CapturePending;
    pendingCaptures = { [legacy.id ?? pendingId(legacy.origin, legacy.tabId)]: legacy };
  } else {
    pendingCaptures = stored;
  }
}

async function openCaptureEditor(
  id?: string,
  origin?: string | null,
  tabId?: number,
): Promise<void> {
  const p = await getPendingForContext(id, origin, tabId);
  if (!p) throw new Error('没有可编辑的登录捕获');
  const url =
    browser.runtime.getURL('/options.html') +
    `?capturePending=${encodeURIComponent(p.id ?? '')}`;
  await browser.tabs.create({ url });
}

/** 打开链接 -> 等加载完成 -> 校验最终 origin 与链接一致 -> 注入填充（可选自动提交）。 */
async function openAndFill(
  url: string,
  username: string,
  password: string,
  submit: boolean,
  tenant?: string,
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

  const result = await injectCredentialFill(tabId, username, password, submit, url, tenant);
  if (result.ok === false) return { filled: false, reason: result.reason ?? '未能填充' };
  return { filled: true, reason: result.submitSkipped ? result.reason : undefined };
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
    syncEnabled: (cachedData?.settings.syncTargets ?? []).some((t) => t.enabled),
  };
}

async function setUnlocked(d: Uint8Array, data: VaultData): Promise<void> {
  dek = d;
  cachedData = data;
  foreignVaultPasswords = [];
  cachedSettingsFingerprint = settingsFingerprint(data.settings);
  autoLockMinutes = data.settings.autoLockMinutes ?? 15;
  await browser.storage.session.set({ [SESSION_DEK]: toB64(d) });
  applyAutoLock();
  resetLockTimer();
  // 一次性迁移旧的单一自托管同步配置 → syncTargets。
  let changed = migrateSyncSettings(data);
  changed = normalizeVaultData(data) || changed;
  if (changed) await persistData(data);
  await registerCaptureForData(data);
}

/** 重新加密并持久化数据；更新内存缓存。 */
async function persistData(data: VaultData): Promise<void> {
  const enc = await vaultBackend.load();
  if (!enc) throw new Error('保险箱不存在');
  commitWorkspaceDraft(data);
  normalizeVaultData(data);
  stampSettingsIfChanged(data);
  await vaultBackend.save(await reencryptData(enc, data, dek!));
  cachedData = data;
  cachedSettingsFingerprint = settingsFingerprint(data.settings);
  autoLockMinutes = data.settings.autoLockMinutes ?? 15;
  applyAutoLock();
  resetLockTimer();
  await registerCaptureForData(data);
}

function lock(): void {
  dek = null;
  cachedData = null;
  foreignVaultPasswords = [];
  cachedSettingsFingerprint = null;
  pendingCaptures = {};
  loginCandidates = {};
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  browser.storage.session.remove(SESSION_DEK).catch(() => {});
  browser.storage.session.remove(PENDING_KEY).catch(() => {});
  browser.storage.session.remove(LOGIN_CANDIDATES_KEY).catch(() => {});
  browser.action.setBadgeText({ text: '' }).catch(() => {});
  registerCaptureForData(null).catch(() => {});
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
  cachedSettingsFingerprint = settingsFingerprint(cachedData.settings);
  autoLockMinutes = cachedData.settings.autoLockMinutes ?? 15;
  applyAutoLock();
  let changed = migrateSyncSettings(cachedData);
  changed = normalizeVaultData(cachedData) || changed;
  if (changed) await persistData(cachedData);
}

async function requireUnlocked(): Promise<void> {
  await ensureRestored();
  if (!dek || !cachedData) throw new Error(VAULT_LOCKED_MSG);
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

function settingsFingerprint(settings: VaultSettings): string {
  const { dashboard: _dashboard, updatedAt: _updatedAt, ...rest } = settings;
  return JSON.stringify(rest);
}

function stampSettingsIfChanged(data: VaultData): void {
  const next = settingsFingerprint(data.settings);
  if (cachedSettingsFingerprint !== null && cachedSettingsFingerprint !== next) {
    data.settings.updatedAt = Date.now();
  }
}

async function adoptSyncedVault(enc: NonNullable<Awaited<ReturnType<typeof vaultBackend.load>>>): Promise<void> {
  await vaultBackend.save(enc);
  cachedData = await decryptVaultData(enc, dek!);
  cachedSettingsFingerprint = settingsFingerprint(cachedData.settings);
  autoLockMinutes = cachedData.settings.autoLockMinutes ?? 15;
  applyAutoLock();
  resetLockTimer();
  if (normalizeVaultData(cachedData)) {
    await persistData(cachedData);
    return;
  }
  await registerCaptureForData(cachedData);
}

// --------------------------- 同步辅助 ---------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 旧版单一自托管状态：仅 vault:adopt 仍写入，迁移后由 ensureRestored/getStatus 接管。
async function saveSyncState(s: SyncState): Promise<void> {
  await browser.storage.local.set({ [SYNC_STATE_KEY]: s });
}

async function loadSyncMap(): Promise<SyncStateMap> {
  const r = await browser.storage.local.get(SYNC_MAP_KEY);
  return (r[SYNC_MAP_KEY] as SyncStateMap | undefined) ?? {};
}

async function setTargetState(
  id: string,
  patch: Partial<SyncStateMap[string]>,
): Promise<void> {
  const map = await loadSyncMap();
  map[id] = { ...map[id], ...patch };
  await browser.storage.local.set({ [SYNC_MAP_KEY]: map });
}

async function removeTargetState(id: string): Promise<void> {
  const map = await loadSyncMap();
  delete map[id];
  await browser.storage.local.set({ [SYNC_MAP_KEY]: map });
}

async function listTargetViews(): Promise<SyncTargetView[]> {
  const targets = cachedData?.settings.syncTargets ?? [];
  const map = await loadSyncMap();
  return targets.map((t) => toTargetView(t, map));
}

function findTarget(id: string): SyncTarget {
  const t = cachedData?.settings.syncTargets?.find((x) => x.id === id);
  if (!t) throw new Error('找不到该同步目标');
  return t;
}

const SECRET_FIELDS = ['token', 'password', 'refreshToken', 'clientSecret', 'did'] as const;

/** 编辑保存时，UI 留空的密钥字段沿用旧值（避免每次编辑都要重输令牌）。 */
function mergeTargetSecrets(prev: SyncTarget, next: SyncTarget): SyncTarget {
  const merged = { ...next } as unknown as Record<string, unknown>;
  const old = prev as unknown as Record<string, unknown>;
  for (const f of SECRET_FIELDS) {
    if (f in merged && !merged[f] && old[f]) merged[f] = old[f];
  }
  return merged as unknown as SyncTarget;
}

/**
 * 对单个目标做双向合并同步。
 * - 异库未带密码 → 返回 {foreign:true} 供 UI 索要密码。
 * - 新目标首次同步且远端为空且未确认 → 返回 {emptyRemote:true} 供 UI 确认建立首次副本
 *   （避免本想拉取却把本地静默推到空路径）。两者都不写 lastError。
 */
async function runTargetSync(
  target: SyncTarget,
  opts: { foreignPassword?: string; confirmFirstPush?: boolean },
): Promise<{ foreign?: boolean; emptyRemote?: boolean }> {
  await requireUnlocked();
  const enc = await vaultBackend.load();
  if (!enc) throw new Error('保险箱不存在');
  const map = await loadSyncMap();
  const established = Boolean(map[target.id]?.remoteTag || map[target.id]?.lastSyncAt);
  try {
    const out = await syncWithProvider(providerFor(target), enc, dek!, {
      foreignPassword: opts.foreignPassword,
      foreignPasswords: syncForeignPasswordCandidates(opts.foreignPassword),
      guardEmptyPush: !established,
      confirmEmptyPush: opts.confirmFirstPush,
    });
    rememberForeignPassword(opts.foreignPassword);
    if (out.mergedEncrypted) {
      await adoptSyncedVault(out.mergedEncrypted);
    }
    await setTargetState(target.id, {
      lastSyncAt: Date.now(),
      remoteTag: out.tag,
      lastError: undefined,
    });
    return {};
  } catch (e) {
    if (e instanceof SyncEngineError && e.code === 'foreign_vault') return { foreign: true };
    if (e instanceof SyncEngineError && e.code === 'empty_remote') return { emptyRemote: true };
    await setTargetState(target.id, { lastError: errMsg(e) });
    throw e;
  }
}

function syncForeignPasswordCandidates(explicit?: string): string[] {
  const skip = explicit;
  return [...new Set(foreignVaultPasswords)]
    .map((p) => p ?? '')
    .filter((p) => p && p !== skip);
}

function rememberForeignPassword(password?: string): void {
  const pw = password;
  if (!pw || foreignVaultPasswords.includes(pw)) return;
  foreignVaultPasswords = [pw, ...foreignVaultPasswords].slice(0, 5);
}

/** 同步所有启用的目标；任一目标失败则抛出（汇总错误信息）。异库目标在此跳过并计入错误。 */
async function syncAllEnabled(): Promise<void> {
  await requireUnlocked();
  const targets = (cachedData?.settings.syncTargets ?? []).filter((t) => t.enabled);
  const errors: string[] = [];
  for (const t of targets) {
    try {
      const r = await runTargetSync(t, {});
      if (r.foreign) errors.push(`${t.label}：检测到另一个保险箱，请在设置里输入其主密码后同步`);
      if (r.emptyRemote)
        errors.push(`${t.label}：远端为空，请在该目标上点「双向同步」确认建立首次副本`);
    } catch (e) {
      errors.push(`${t.label}：${errMsg(e)}`);
    }
  }
  if (errors.length) throw new Error(errors.join('；'));
}

/** 本地保存后延迟自动同步（合并多次连续修改，失败只记录不打断）。 */
function scheduleAutoSync(): void {
  if (cachedData?.settings.syncAuto === false) return; // 用户关闭了「修改后自动同步」
  const targets = (cachedData?.settings.syncTargets ?? []).filter((t) => t.enabled);
  if (!targets.length) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void (async () => {
      for (const t of targets) {
        await runTargetSync(t, {}).catch(() => {
          /* runTargetSync 已记录 lastError，自动同步不打断 */
        });
      }
    })();
  }, 2500);
}

// 登录捕获后台链路的集成测试：用假 browser API 驱动真实的 background 消息路由，
// 覆盖「输错几次再输对」「纯密码表单」等真实登录时序。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStore = new Map<string, unknown>();
const sessionStore = new Map<string, unknown>();

function storageArea(store: Map<string, unknown>) {
  return {
    async get(keys?: string | string[] | Record<string, unknown>) {
      const out: Record<string, unknown> = {};
      const list =
        keys == null
          ? [...store.keys()]
          : typeof keys === 'string'
            ? [keys]
            : Array.isArray(keys)
              ? keys
              : Object.keys(keys);
      for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of ([] as string[]).concat(keys)) store.delete(k);
    },
    async setAccessLevel() {},
  };
}

const noopEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false };

let onMessageHandler:
  | ((msg: unknown, sender?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>)
  | null = null;

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: storageArea(localStore), session: storageArea(sessionStore) },
    runtime: {
      onMessage: {
        addListener: (fn: typeof onMessageHandler) => {
          onMessageHandler = fn;
        },
      },
      onInstalled: noopEvent,
      setUninstallURL: async () => {},
      getURL: (p: string) => `chrome-extension://test${p}`,
      openOptionsPage: async () => {},
      sendMessage: async () => {},
    },
    idle: { onStateChanged: noopEvent, setDetectionInterval: () => {} },
    contextMenus: { create: () => {}, onClicked: noopEvent },
    permissions: {
      getAll: async () => ({ origins: ['<all_urls>'], permissions: [] }),
      onAdded: noopEvent,
      onRemoved: noopEvent,
    },
    omnibox: {
      setDefaultSuggestion: () => {},
      onInputChanged: noopEvent,
      onInputEntered: noopEvent,
    },
    commands: { onCommand: noopEvent },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      openPopup: async () => {},
    },
    scripting: {
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
      executeScript: async () => [],
    },
    tabs: {
      create: async () => ({}),
      get: async () => ({}),
      query: async () => [],
      remove: async () => {},
      sendMessage: async () => {},
      onUpdated: noopEvent,
    },
  },
}));

let now = 10_000_000;

const ORIGIN = 'https://app.example.com';
const LOGIN_URL = `${ORIGIN}/login`;
const HOME_URL = `${ORIGIN}/home`;
const TAB = { id: 5 };
const pageSender = (url: string) => ({ url, origin: ORIGIN, tab: TAB });

async function sendMsg<T = unknown>(msg: Record<string, unknown>, sender?: unknown): Promise<T> {
  const res = await onMessageHandler!(msg, sender);
  if (!res.ok) throw new Error(res.error || '后台返回失败');
  return res.data as T;
}

const cleanSignals = {
  visiblePasswordFields: 0,
  filledPasswordFields: 0,
  visibleOtpFields: 0,
  successHint: false,
  totp: '',
};
const loginPageSignals = { ...cleanSignals, visiblePasswordFields: 1 };

async function candidate(password: string, username = '') {
  await sendMsg(
    {
      type: 'capture:candidate',
      origin: ORIGIN,
      url: LOGIN_URL,
      title: '登录',
      username,
      password,
    },
    pageSender(LOGIN_URL),
  );
}

async function successCheck(url: string, signals = cleanSignals) {
  return sendMsg<{
    pending?: boolean;
    id?: string;
    kind?: string;
    username?: string;
    accountId?: string;
  } | null>(
    { type: 'capture:successCheck', origin: ORIGIN, url, title: '首页', signals },
    pageSender(url),
  );
}

async function setupVault(withAccount?: { username: string; password: string }) {
  const { emptyVaultData } = await import('@/lib/vault-core');
  const { newAccount, newEnvironment, newLink, newProject } = await import('@/lib/vault-ops');
  await sendMsg({
    type: 'vault:create',
    password: 'master-pass-1',
    kdf: { type: 'pbkdf2', iterations: 1000, hash: 'SHA-256' },
  });
  const data = emptyVaultData();
  const link = newLink({ name: '控制台', url: `${ORIGIN}/` });
  if (withAccount) link.accounts.push(newAccount(withAccount));
  const env = newEnvironment({ name: '生产', kind: 'prod', links: [link] });
  data.projects.push(newProject({ name: '示例项目', environments: [env] }));
  await sendMsg({ type: 'vault:save', data });
  return link.id;
}

async function vaultAccounts() {
  const data = await sendMsg<{
    projects: { environments: { links: { accounts: { username: string; password: string }[] }[] }[] }[];
  }>({ type: 'vault:get' });
  return data.projects.flatMap((p) =>
    p.environments.flatMap((e) => e.links.flatMap((l) => l.accounts)),
  );
}

beforeEach(async () => {
  vi.resetModules();
  localStore.clear();
  sessionStore.clear();
  onMessageHandler = null;
  now = 10_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  (globalThis as { defineBackground?: unknown }).defineBackground = (fn: () => void) => {
    fn();
  };
  await import('@/entrypoints/background');
  expect(onMessageHandler).toBeTruthy();
});

describe('登录捕获：输错密码后重试', () => {
  it('几次失败提交后输入正确密码，仍会弹出保存提示且密码是最后一次的', async () => {
    await setupVault();

    // 第一次输错：提交 → 回到登录页（密码框可见），不判定成功
    await candidate('wrong-1');
    now += 2_000;
    expect(await successCheck(LOGIN_URL, loginPageSignals)).toBeNull();

    // 第二次输错
    now += 40_000;
    await candidate('wrong-2');
    now += 2_000;
    expect(await successCheck(LOGIN_URL, loginPageSignals)).toBeNull();

    // 最后输对：跳转到无密码框的页面
    now += 40_000;
    await candidate('correct-pw', 'admin');
    now += 2_000;
    const res = await successCheck(HOME_URL);
    expect(res?.pending).toBe(true);
    expect(res?.kind).toBe('new');
    expect(res?.username).toBe('admin');

    await sendMsg(
      { type: 'capture:save', id: res!.id },
      pageSender(HOME_URL),
    );
    const accounts = await vaultAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.password).toBe('correct-pw');
  });
});

describe('登录捕获：提示的重新展示与关闭', () => {
  it('未处理的提示会随同源页面切换重新展示；浮层关闭后不再弹，但弹窗兜底仍可取到', async () => {
    await setupVault();

    await candidate('pw-1', 'admin');
    now += 2_000;
    const res = await successCheck(HOME_URL);
    expect(res?.pending).toBe(true);

    // 用户没处理就切到站内其它页面：按设计重新展示同一条提示
    now += 5_000;
    const again = await successCheck(`${ORIGIN}/settings`);
    expect(again?.pending).toBe(true);
    expect(again?.id).toBe(res!.id);

    // 用户点了浮层的「关闭」：后台标记后，后续页面不再重新展示
    await sendMsg(
      { type: 'capture:muteReprompt', id: res!.id },
      pageSender(`${ORIGIN}/settings`),
    );
    now += 5_000;
    expect(await successCheck(`${ORIGIN}/profile`)).toBeNull();
    now += 60_000;
    expect(await successCheck(`${ORIGIN}/orders`)).toBeNull();

    // 扩展弹窗兜底仍能取到这条待保存捕获
    const pending = await sendMsg<{ id?: string } | null>({ type: 'capture:pending' });
    expect(pending?.id).toBe(res!.id);

    // 之后一次新的真实登录（新候选）仍会正常提示
    now += 30_000;
    await candidate('pw-1', 'admin');
    now += 2_000;
    expect((await successCheck(HOME_URL))?.pending).toBe(true);
  });
});

describe('登录捕获：只有密码框的表单', () => {
  it('首次登录能以空用户名保存', async () => {
    await setupVault();

    await candidate('only-pw-1');
    now += 2_000;
    const res = await successCheck(HOME_URL);
    expect(res?.pending).toBe(true);
    expect(res?.kind).toBe('new');
    expect(res?.username).toBe('');

    await sendMsg({ type: 'capture:save', id: res!.id }, pageSender(HOME_URL));
    const accounts = await vaultAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.username).toBe('');
    expect(accounts[0]!.password).toBe('only-pw-1');
  });

  it('已保存过且密码未变时不再重复提示', async () => {
    await setupVault({ username: '', password: 'only-pw-1' });

    await candidate('only-pw-1');
    now += 2_000;
    expect(await successCheck(HOME_URL)).toBeNull();
  });

  it('密码变化时提示更新已有的无用户名账号，而不是提示新建', async () => {
    await setupVault({ username: '', password: 'only-pw-1' });

    await candidate('only-pw-2');
    now += 2_000;
    const res = await successCheck(HOME_URL);
    expect(res?.pending).toBe(true);
    expect(res?.kind).toBe('update');
    expect(res?.accountId).toBeTruthy();

    await sendMsg({ type: 'capture:save', id: res!.id }, pageSender(HOME_URL));
    const accounts = await vaultAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.password).toBe('only-pw-2');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(resolve(process.cwd(), 'public/web-assist.js'), 'utf8');

let messages: any[] = [];
let now = 2_000_000;
let snapshotMatches: any[] = [];
let snapshotMuted = false;

const assistSnapshot = () => ({
  locked: false,
  enabled: true,
  muted: snapshotMuted,
  origin: location.origin,
  autoSubmit: false,
  theme: 'system',
  matches: snapshotMatches,
});

async function submitAndFlush(): Promise<void> {
  document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

async function clickAndFlush(selector: string): Promise<void> {
  document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

async function focusAndFlush(selector: string): Promise<void> {
  const el = document.querySelector(selector) as HTMLElement | null;
  el?.focus();
  el?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  await Promise.resolve();
  await Promise.resolve();
}

function latestCaptureCandidate() {
  return [...messages].reverse().find((msg) => msg.type === 'capture:candidate');
}

beforeAll(async () => {
  const chromeMock = {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((msg: any, done?: (res: unknown) => void) => {
        messages.push(msg);
        done?.({ ok: true, data: msg.type === 'assist:matches' ? assistSnapshot() : null });
      }),
    },
  };
  Object.defineProperty(window, 'chrome', { value: chromeMock, configurable: true });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  window.eval(script);
  await Promise.resolve();
});

beforeEach(() => {
  now += 5_000;
  messages = [];
  snapshotMatches = [];
  snapshotMuted = false;
  document.body.innerHTML = '';
  sessionStorage.clear();
  (window as any).BarcodeDetector = undefined;
  Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const hidden =
      this.style.display === 'none' ||
      this.hidden ||
      this.style.visibility === 'hidden';
    const w = hidden ? 0 : 120;
    const h = hidden ? 0 : 24;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});

describe('web-assist.js login credential capture', () => {
  it('sends the current numeric account instead of a cached previous account', async () => {
    sessionStorage.setItem(
      'pemLastLoginUsername',
      JSON.stringify({ origin: location.origin, value: 'old-user', ts: Date.now() }),
    );
    document.body.innerHTML = `
      <form>
        <input type="number" name="phone" value="13800138000" />
        <input type="password" name="password" value="pw-new" />
      </form>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.username).toBe('13800138000');
  });

  it('captures the tenant field separately from the username', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="tenant" placeholder="租户编码" value="acme" />
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
      </form>`;

    await submitAndFlush();

    const candidate = latestCaptureCandidate();
    expect(candidate?.username).toBe('admin');
    expect(candidate?.tenant).toBe('acme');
  });

  it('does not send plain base32 login QR tokens as TOTP', async () => {
    (window as any).BarcodeDetector = class {
      async detect() {
        return [{ rawValue: 'JBSWY3DPEHPK3PXP' }];
      }
    };
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
        <canvas></canvas>
      </form>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.totp).toBeFalsy();
  });

  it('sends the credentials immediately even when QR scanning never finishes', async () => {
    (window as any).BarcodeDetector = class {
      detect() {
        return new Promise(() => {});
      }
    };
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
        <canvas></canvas>
      </form>`;

    await submitAndFlush();

    const candidate = latestCaptureCandidate();
    expect(candidate?.password).toBe('pw-new');
    expect(candidate?.totp).toBeFalsy();
  });

  it('sends a follow-up candidate carrying the TOTP secret after scanning', async () => {
    (window as any).BarcodeDetector = class {
      async detect() {
        return [{ rawValue: 'otpauth://totp/Acme:admin?secret=JBSWY3DPEHPK3PXP&period=30' }];
      }
    };
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
        <canvas></canvas>
      </form>`;

    await submitAndFlush();

    const candidates = messages.filter((m) => m.type === 'capture:candidate');
    expect(candidates.length).toBe(2);
    expect(candidates[0].totp).toBeFalsy();
    expect(candidates[1].password).toBe('pw-new');
    expect(candidates[1].totp).toContain('otpauth://totp/Acme:admin');
  });

  it('captures federated login clicks without a password field', async () => {
    document.body.innerHTML = `<button type="button">Sign in with Google</button>`;

    await clickAndFlush('button');

    expect(latestCaptureCandidate()).toMatchObject({
      username: 'Google 登录',
      password: '',
      authProvider: 'Google',
    });
  });

  it('does not treat a math captcha image url as TOTP', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
        <input type="text" name="calc" placeholder="请输入计算结果" />
        <img alt="图形验证码" src="/captcha?secret=ABCDEFGHJKMNPQRS2345&type=math" />
      </form>`;

    await submitAndFlush();

    const candidate = latestCaptureCandidate();
    expect(candidate?.username).toBe('admin');
    expect(candidate?.totp).toBeFalsy();
  });

  it('clears the auto-flow after submitting the password step so logout does not re-login', async () => {
    snapshotMatches = [
      {
        accountId: 'acc-1',
        projectName: 'Project',
        envName: 'Default',
        envKind: 'prod',
        linkName: 'Example',
        accountLabel: 'Admin',
        username: 'admin',
        hasTotp: false,
      },
    ];
    // 模拟：用户上一步点了「下一步」武装了流程（lastSurface=username），现在到了密码步。
    sessionStorage.setItem(
      'pemAutoFlow',
      JSON.stringify({
        accountId: 'acc-1',
        site: location.hostname,
        ts: Date.now(),
        step: 1,
        lastSurface: 'username',
        lastActionAt: Date.now() - 2000,
      }),
    );
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" />
      </form>`;

    await focusAndFlush('input[type="password"]');

    // 密码步被自动续填并提交
    expect(messages.find((m) => m.type === 'assist:fill' && m.submit === true)).toMatchObject({
      accountId: 'acc-1',
      submit: true,
    });
    // 关键：账号没存 TOTP，提交密码即完成登录 → 流程被清除，不再残留
    expect(sessionStorage.getItem('pemAutoFlow')).toBeNull();

    // 模拟注销后回到登录页：流程已清 → 不应再自动提交（避免死循环）
    messages = [];
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" />
      </form>`;
    await focusAndFlush('input[type="password"]');
    expect(messages.find((m) => m.type === 'assist:fill' && m.submit === true)).toBeUndefined();
  });

  it('auto fills TOTP when a single matched account owns the OTP field', async () => {
    snapshotMatches = [
      {
        accountId: 'acc-1',
        projectName: 'Project',
        envName: 'Default',
        envKind: 'prod',
        linkName: 'Example',
        accountLabel: 'Admin',
        username: 'admin',
        hasTotp: true,
      },
    ];
    document.body.innerHTML = `<input name="otp" autocomplete="one-time-code" />`;

    await focusAndFlush('input');

    expect(messages.find((msg) => msg.type === 'assist:fillTotp')).toMatchObject({
      accountId: 'acc-1',
      submit: false,
    });
  });

  it('does not auto-fill TOTP into an invite-code field', async () => {
    snapshotMatches = [demoMatch({ hasTotp: true })];
    document.body.innerHTML = `<input name="invite_code" placeholder="邀请码" maxlength="6" />`;

    await focusAndFlush('input');

    expect(messages.find((msg) => msg.type === 'assist:fillTotp')).toBeUndefined();
  });

  it('does not treat an author field as an OTP field', async () => {
    snapshotMatches = [demoMatch({ hasTotp: true })];
    document.body.innerHTML = `<input name="author" />`;

    await focusAndFlush('input');

    expect(messages.find((msg) => msg.type === 'assist:fillTotp')).toBeUndefined();
  });
});

const demoMatch = (extra: Record<string, unknown> = {}) => ({
  accountId: 'acc-1',
  projectName: 'Project',
  envName: 'Default',
  envKind: 'prod',
  linkName: 'Example',
  accountLabel: 'Admin',
  username: 'admin',
  hasTotp: false,
  ...extra,
});

describe('web-assist.js banner heuristics and per-site mute', () => {
  it('shows the banner on a login-looking form', async () => {
    snapshotMatches = [demoMatch()];
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" />
        <input type="password" name="password" />
        <button type="submit">登录</button>
      </form>`;

    await focusAndFlush('input[name="username"]');

    expect(document.getElementById('pem-web-assist')).toBeTruthy();
  });

  it('does not show the banner for an admin create-user dialog on a logged-in page', async () => {
    snapshotMatches = [demoMatch()];
    document.body.innerHTML = `
      <a href="/logout">退出登录</a>
      <div role="dialog">
        <h3>新增用户</h3>
        <form>
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="submit">确定</button>
        </form>
      </div>`;

    await focusAndFlush('input[name="username"]');

    expect(document.getElementById('pem-web-assist')).toBeNull();
  });

  it('suppresses every overlay when the snapshot says the site is muted', async () => {
    snapshotMuted = true;
    snapshotMatches = [demoMatch()];
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" />
        <input type="password" name="password" value="pw-1" />
        <button type="submit">登录</button>
      </form>`;

    await focusAndFlush('input[name="username"]');

    expect(document.getElementById('pem-web-assist')).toBeNull();
  });

  it('mute button sends assist:muteSite and removes the overlay', async () => {
    // 先让上一条测试可能遗留的浮层被销毁，确保本测试会重新 attachShadow。
    document.body.innerHTML = `<input name="plain" />`;
    await focusAndFlush('input[name="plain"]');

    const roots: ShadowRoot[] = [];
    const origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const root = origAttach.call(this, init);
      roots.push(root);
      return root;
    };
    try {
      snapshotMatches = [demoMatch()];
      document.body.innerHTML = `
        <form>
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="submit">登录</button>
        </form>`;
      await focusAndFlush('input[name="username"]');
      expect(document.getElementById('pem-web-assist')).toBeTruthy();

      const muteBtn = roots
        .map((r) => r.querySelector('[data-act="mute-site"]'))
        .find(Boolean) as HTMLElement | undefined;
      expect(muteBtn).toBeTruthy();
      muteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();

      expect(messages.find((msg) => msg.type === 'assist:muteSite')).toBeTruthy();
      expect(document.getElementById('pem-web-assist')).toBeNull();
    } finally {
      Element.prototype.attachShadow = origAttach;
    }
  });
});

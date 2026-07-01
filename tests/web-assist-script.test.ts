import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(resolve(process.cwd(), 'public/web-assist.js'), 'utf8');

let messages: any[] = [];
let now = 2_000_000;
let snapshotMatches: any[] = [];

const assistSnapshot = () => ({
  locked: false,
  enabled: true,
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

  it('captures federated login clicks without a password field', async () => {
    document.body.innerHTML = `<button type="button">Sign in with Google</button>`;

    await clickAndFlush('button');

    expect(latestCaptureCandidate()).toMatchObject({
      username: 'Google 登录',
      password: '',
      authProvider: 'Google',
    });
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
});

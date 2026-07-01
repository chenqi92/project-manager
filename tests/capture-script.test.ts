import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const script = readFileSync(resolve(process.cwd(), 'public/capture.js'), 'utf8');

let messages: any[] = [];
let now = 1_000_000;

async function submitAndFlush(): Promise<void> {
  document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
}

function latestCaptureCandidate() {
  return [...messages].reverse().find((msg) => msg.type === 'capture:candidate');
}

beforeAll(() => {
  const chromeMock = {
    runtime: {
      sendMessage: vi.fn((msg: any, done?: (res: unknown) => void) => {
        messages.push(msg);
        done?.({ ok: true, data: null });
      }),
    },
  };
  Object.defineProperty(window, 'chrome', { value: chromeMock, configurable: true });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  window.eval(script);
});

beforeEach(() => {
  now += 5_000;
  messages = [];
  document.body.innerHTML = '';
  sessionStorage.clear();
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

describe('capture.js login credential capture', () => {
  it('uses the current numeric account instead of a cached previous account', async () => {
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

  it('does not reuse an older cached username when the password page has no username field', async () => {
    sessionStorage.setItem(
      'pemLastLoginUsername',
      JSON.stringify({ origin: location.origin, value: 'old-user', ts: Date.now() - 120_000 }),
    );
    document.body.innerHTML = `
      <form>
        <input type="password" name="password" value="pw-new" />
      </form>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.username).toBe('');
  });
});

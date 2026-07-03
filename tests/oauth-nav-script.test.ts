// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&response_type=code" }
//
// 内容脚本跑在 IdP 授权页上时，应把当前地址通过 capture:oauthNav 报给 background
// （权威解析在 lib/federated-oauth，见 federated-oauth.test.ts）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const captureScript = readFileSync(resolve(process.cwd(), 'public/capture.js'), 'utf8');
const webAssistScript = readFileSync(resolve(process.cwd(), 'public/web-assist.js'), 'utf8');

let messages: any[] = [];
const armListeners: Array<(msg: unknown) => void> = [];

beforeAll(() => {
  const chromeMock = {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((msg: any, done?: (res: unknown) => void) => {
        messages.push(msg);
        done?.({ ok: true, data: null });
      }),
      onMessage: {
        addListener: vi.fn((fn: (msg: unknown) => void) => {
          armListeners.push(fn);
        }),
      },
    },
  };
  Object.defineProperty(window, 'chrome', { value: chromeMock, configurable: true });
});

describe('内容脚本在 IdP 授权页上报 capture:oauthNav', () => {
  it('capture.js 上报当前授权页地址，并监听后台的 armSuccess 通知', () => {
    messages = [];
    window.eval(captureScript);
    const nav = messages.find((m) => m.type === 'capture:oauthNav');
    expect(nav?.url).toBe(window.location.href);
    expect(armListeners.length).toBeGreaterThan(0);
  });

  it('web-assist.js 上报当前授权页地址', () => {
    messages = [];
    window.eval(webAssistScript);
    const nav = messages.find((m) => m.type === 'capture:oauthNav');
    expect(nav?.url).toBe(window.location.href);
  });
});

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
  await Promise.resolve();
  await Promise.resolve();
}

async function clickAndFlush(selector: string): Promise<void> {
  document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
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

  it('does not treat a company/tenant field next to the password as the username', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="text" name="companyCode" value="acme" />
        <input type="password" name="password" value="pw-new" />
      </form>`;

    await submitAndFlush();

    const candidate = latestCaptureCandidate();
    expect(candidate?.username).toBe('admin');
    expect(candidate?.tenant).toBe('acme');
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

  it('does not save a plain base32 login QR token as TOTP', async () => {
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

  it('keeps standard otpauth QR payloads as TOTP', async () => {
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

    expect(latestCaptureCandidate()?.totp).toContain('otpauth://totp/Acme:admin');
  });

  it('captures federated login clicks without a password field', async () => {
    document.body.innerHTML = `<a href="/auth/google">Continue with Google</a>`;

    await clickAndFlush('a');

    expect(latestCaptureCandidate()).toMatchObject({
      username: 'Google 登录',
      password: '',
      authProvider: 'Google',
    });
  });

  it('does not capture from an admin create-user dialog on a logged-in page', async () => {
    document.body.innerHTML = `
      <button type="button">退出登录</button>
      <div role="dialog">
        <h3>新增用户</h3>
        <form>
          <input type="text" name="username" value="new-user" />
          <input type="password" name="password" value="init-pw" />
          <button type="submit">确定</button>
        </form>
      </div>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()).toBeUndefined();
  });

  it('does not capture when clicking buttons on a logged-in page with a plain password field', async () => {
    document.body.innerHTML = `
      <a href="/logout">退出登录</a>
      <form>
        <input type="text" name="smtpHost" value="mail.example.com" />
        <input type="password" name="smtpPassword" value="smtp-pw" />
        <button type="button">保存配置</button>
      </form>`;

    await clickAndFlush('button');

    expect(latestCaptureCandidate()).toBeUndefined();
  });

  it('still captures from a change-password form while logged in', async () => {
    document.body.innerHTML = `
      <a href="/logout">退出登录</a>
      <form>
        <h3>修改密码</h3>
        <input type="password" name="old" placeholder="原密码" value="old-pw" />
        <input type="password" name="new" placeholder="新密码" value="new-pw" />
        <input type="password" name="confirm" placeholder="确认密码" value="new-pw" />
        <button type="submit">确定</button>
      </form>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.password).toBe('new-pw');
  });

  it('still captures a login form that sits on a page with generic admin words in the URL', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
        <button type="submit">登录</button>
      </form>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.password).toBe('pw-new');
  });

  it('skips federated capture for bind-account buttons on a logged-in page', async () => {
    document.body.innerHTML = `
      <a href="/logout">退出登录</a>
      <button type="button">绑定 GitHub 账号</button>`;

    await clickAndFlush('button');

    expect(latestCaptureCandidate()).toBeUndefined();
  });

  it('captures a numeric org-code tenant field (type=number, English name only)', async () => {
    document.body.innerHTML = `
      <form>
        <input type="number" name="orgCode" placeholder="编码" value="1024" />
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
      </form>`;

    await submitAndFlush();

    const candidate = latestCaptureCandidate();
    expect(candidate?.username).toBe('admin');
    expect(candidate?.tenant).toBe('1024');
  });

  it('captures a select-based tenant control', async () => {
    document.body.innerHTML = `
      <form>
        <select name="company">
          <option value="">请选择</option>
          <option value="acme" selected>Acme 公司</option>
        </select>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
      </form>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.tenant).toBe('acme');
  });

  it('captures a label-wrapped tenant input without tenant-ish attributes', async () => {
    document.body.innerHTML = `
      <form>
        <label>租户编码<input type="text" name="c1" value="t01" /></label>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
      </form>`;

    await submitAndFlush();

    const candidate = latestCaptureCandidate();
    expect(candidate?.tenant).toBe('t01');
    expect(candidate?.username).toBe('admin');
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

  it('ignores secret-labelled base32 text when the page has no authenticator context', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
      </form>
      <div>接口密钥 ABCDEFGHJKMNPQRS2345</div>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.totp).toBeFalsy();
  });

  it('keeps the setup key on a real authenticator enrollment page', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
      </form>
      <div>
        <h3>两步验证</h3>
        <p>无法扫描？将密钥手动输入到身份验证器：</p>
        <code>ABCD EFGH JKMN 2345</code>
      </div>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.totp).toBe('ABCDEFGHJKMN2345');
  });

  it('still ignores captcha urls even when the page mentions two-factor', async () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" value="admin" />
        <input type="password" name="password" value="pw-new" />
        <img alt="验证码" src="/captcha?secret=ABCDEFGHJKMNPQRS2345" />
      </form>
      <div>开启两步验证可保护账号安全</div>`;

    await submitAndFlush();

    expect(latestCaptureCandidate()?.totp).toBeFalsy();
  });
});

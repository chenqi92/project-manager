import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fillCredentialsInPage,
  fillTotpInPage,
  fillUsernameInPage,
  getOrigin,
  isSameSite,
  linkUrlMatches,
  originsMatch,
  registrableDomain,
} from '../lib/autofill';

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  // jsdom 不做布局，getBoundingClientRect 永远返回 0。按 inline 样式给出合理尺寸，
  // 让填充函数的「可见性过滤」逻辑可被测试（隐藏元素返回 0 尺寸）。
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

describe('originsMatch（防钓鱼的精确匹配）', () => {
  it('同 origin 匹配', () => {
    expect(originsMatch('https://a.com/login', 'https://a.com/dashboard')).toBe(true);
  });
  it('不同 scheme 不匹配', () => {
    expect(originsMatch('https://a.com', 'http://a.com')).toBe(false);
  });
  it('子域不放宽（关键反钓鱼）', () => {
    expect(originsMatch('https://a.com', 'https://evil.a.com')).toBe(false);
  });
  it('不同端口不匹配', () => {
    expect(originsMatch('https://a.com', 'https://a.com:8443')).toBe(false);
  });
  it('非法 URL 返回 null/不匹配', () => {
    expect(getOrigin('not a url')).toBe(null);
    expect(originsMatch('not a url', 'https://a.com')).toBe(false);
  });
});

describe('linkUrlMatches（链接级匹配方式）', () => {
  it('默认同源匹配会忽略路径', () => {
    expect(linkUrlMatches('https://a.com/admin/login', 'https://a.com/portal/login')).toBe(true);
  });

  it('路径前缀可区分同 origin 下的不同路径', () => {
    expect(linkUrlMatches('https://a.com/admin', 'https://a.com/admin/login', 'path-prefix')).toBe(true);
    expect(linkUrlMatches('https://a.com/admin/', 'https://a.com/admin', 'path-prefix')).toBe(true);
    expect(linkUrlMatches('https://a.com/admin', 'https://a.com/portal/login', 'path-prefix')).toBe(false);
    expect(linkUrlMatches('https://a.com/admin', 'https://a.com/admin2/login', 'path-prefix')).toBe(false);
  });

  it('路径前缀支持 hash 路由', () => {
    expect(linkUrlMatches('https://a.com/#/nas', 'https://a.com/#/nas/signin', 'path-prefix')).toBe(true);
    expect(linkUrlMatches('https://a.com/#/nas', 'https://a.com/#/git/signin', 'path-prefix')).toBe(false);
  });

  it('精确地址要求路径、参数和 hash 都一致', () => {
    expect(linkUrlMatches('https://a.com/login?site=1#/p', 'https://a.com/login?site=1#/p', 'exact-url')).toBe(true);
    expect(linkUrlMatches('https://a.com/login?site=1#/p', 'https://a.com/login?site=2#/p', 'exact-url')).toBe(false);
  });
});

describe('registrableDomain / isSameSite（同主域 iframe 填充判断）', () => {
  it('取 eTLD+1', () => {
    expect(registrableDomain('account.aliyun.com')).toBe('aliyun.com');
    expect(registrableDomain('passport.aliyun.com')).toBe('aliyun.com');
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('sub.example.com.cn')).toBe('example.com.cn');
  });
  it('IP / localhost 原样返回', () => {
    expect(registrableDomain('192.168.1.10')).toBe('192.168.1.10');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
  it('同主域同协议判定', () => {
    expect(isSameSite('https://account.aliyun.com', 'https://passport.aliyun.com')).toBe(true);
    expect(isSameSite('https://account.aliyun.com', 'http://passport.aliyun.com')).toBe(false);
    expect(isSameSite('https://aliyun.com', 'https://evil.com')).toBe(false);
  });
});

describe('fillCredentialsInPage', () => {
  it('跨 frame 护栏：site 与当前 frame 主机不同主域时拒填', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="user" />
        <input type="password" name="pass" />
      </form>`;
    const r = fillCredentialsInPage('alice', 'pw', false, 'aliyun.com');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('frame-not-allowed');
    expect((document.querySelector('input[name=pass]') as HTMLInputElement).value).toBe('');
  });

  it('跨 frame 护栏：site 与当前 frame 同主域时正常填充', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="user" />
        <input type="password" name="pass" />
      </form>`;
    const r = fillCredentialsInPage('alice', 'pw', false, registrableDomain(location.hostname));
    expect(r.ok).toBe(true);
    expect((document.querySelector('input[name=pass]') as HTMLInputElement).value).toBe('pw');
  });

  it('账号带租户时填进租户框，用户名不误填租户框（租户/用户名/密码布局）', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="tenantCode" placeholder="租户编码" />
        <input type="text" name="username" />
        <input type="password" name="pass" />
      </form>`;
    const r = fillCredentialsInPage('alice', 'pw', false, undefined, 'acme');
    expect(r.ok).toBe(true);
    expect((document.querySelector('input[name=tenantCode]') as HTMLInputElement).value).toBe('acme');
    expect((document.querySelector('input[name=username]') as HTMLInputElement).value).toBe('alice');
    expect((document.querySelector('input[name=pass]') as HTMLInputElement).value).toBe('pw');
  });

  it('用户名/租户/密码布局：用户名填进用户名框而不是紧邻密码框的租户框', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="loginName" />
        <input type="text" name="tenant" />
        <input type="password" name="pass" />
      </form>`;
    const r = fillCredentialsInPage('alice', 'pw', false);
    expect(r.ok).toBe(true);
    expect((document.querySelector('input[name=loginName]') as HTMLInputElement).value).toBe('alice');
    expect((document.querySelector('input[name=tenant]') as HTMLInputElement).value).toBe('');
  });

  it('没存租户值时不填租户框', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="tenant" />
        <input type="text" name="username" />
        <input type="password" name="pass" />
      </form>`;
    const r = fillCredentialsInPage('alice', 'pw', false);
    expect(r.ok).toBe(true);
    expect((document.querySelector('input[name=tenant]') as HTMLInputElement).value).toBe('');
    expect((document.querySelector('input[name=username]') as HTMLInputElement).value).toBe('alice');
  });

  it('顶层无密码框但有内嵌登录 iframe 时回报该 iframe origin', () => {
    document.body.innerHTML = `
      <div>
        <iframe id="alibaba-login-box" src="https://passport.aliyun.com/mini_login.htm"></iframe>
      </div>`;
    const r = fillCredentialsInPage('alice', 'pw', false);
    expect(r.ok).toBe(false);
    expect(r.loginFrameOrigin).toBe('https://passport.aliyun.com');
  });

  it('标准登录表单：填用户名+密码、派发 input 事件、不自动提交', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="user" />
        <input type="password" name="pass" />
        <button type="submit">登录</button>
      </form>`;
    const form = document.querySelector('form')!;
    const user = document.querySelector('input[name=user]') as HTMLInputElement;
    const pass = document.querySelector('input[name=pass]') as HTMLInputElement;
    let submitted = false;
    let userInput = 0;
    let passInput = 0;
    form.addEventListener('submit', (e) => {
      submitted = true;
      e.preventDefault();
    });
    user.addEventListener('input', () => userInput++);
    pass.addEventListener('input', () => passInput++);

    const r = fillCredentialsInPage('alice', 's3cret!');
    expect(r.ok).toBe(true);
    expect(user.value).toBe('alice');
    expect(pass.value).toBe('s3cret!');
    expect(userInput).toBeGreaterThan(0);
    expect(passInput).toBeGreaterThan(0);
    expect(submitted).toBe(false); // 关键：绝不自动提交
  });

  it('仅有密码框也能填', () => {
    document.body.innerHTML = `<form><input type="password" /></form>`;
    const r = fillCredentialsInPage('x', 'pw');
    expect(r.ok).toBe(true);
    expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe('pw');
  });

  it('页面没有密码框时返回失败', () => {
    document.body.innerHTML = `<form><input type="text" /></form>`;
    expect(fillCredentialsInPage('x', 'pw').ok).toBe(false);
  });

  it('跳过隐藏的诱饵密码框，只填可见的那个', () => {
    document.body.innerHTML = `
      <form>
        <input type="password" id="decoy" style="display:none" />
        <input type="text" id="user" />
        <input type="password" id="real" />
      </form>`;
    const r = fillCredentialsInPage('bob', 'pw2');
    expect(r.ok).toBe(true);
    expect((document.querySelector('#real') as HTMLInputElement).value).toBe('pw2');
    expect((document.querySelector('#decoy') as HTMLInputElement).value).toBe('');
    expect((document.querySelector('#user') as HTMLInputElement).value).toBe('bob');
  });

  it('选取密码框之前最近的文本类输入作为用户名', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="search" />
        <input type="email" id="email" />
        <input type="password" id="pw" />
      </form>`;
    fillCredentialsInPage('user@x.com', 'pw');
    expect((document.querySelector('#email') as HTMLInputElement).value).toBe('user@x.com');
    expect((document.querySelector('#search') as HTMLInputElement).value).toBe('');
  });

  it('有空验证码时点击登录只填充不提交，避免刷新清空账号密码', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" />
        <input type="password" name="password" />
        <input type="text" name="captcha" placeholder="验证码" />
        <button type="submit">登录</button>
      </form>`;
    const form = document.querySelector('form')!;
    let submitted = false;
    form.addEventListener('submit', (e) => {
      submitted = true;
      e.preventDefault();
    });

    const r = fillCredentialsInPage('alice', 'pw', true);

    expect(r.ok).toBe(true);
    expect(r.submitSkipped).toBe(true);
    expect(submitted).toBe(false);
    expect((document.querySelector('input[name=username]') as HTMLInputElement).value).toBe('alice');
    expect((document.querySelector('input[name=password]') as HTMLInputElement).value).toBe('pw');
    expect(document.activeElement).toBe(document.querySelector('input[name=captcha]'));
  });

  it('检测到验证码组件但没有验证码输入框时也不自动提交', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" name="username" />
        <input type="password" name="password" />
        <div class="geetest captcha-panel">请完成安全验证</div>
        <button type="submit">登录</button>
      </form>`;
    const form = document.querySelector('form')!;
    let submitted = false;
    form.addEventListener('submit', (e) => {
      submitted = true;
      e.preventDefault();
    });

    const r = fillCredentialsInPage('alice', 'pw', true);

    expect(r.ok).toBe(true);
    expect(r.submitSkipped).toBe(true);
    expect(submitted).toBe(false);
    expect((document.querySelector('input[name=username]') as HTMLInputElement).value).toBe('alice');
    expect((document.querySelector('input[name=password]') as HTMLInputElement).value).toBe('pw');
  });

  it('填充触发验证码组件后，延迟提交前会取消点击登录', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <form>
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="submit">登录</button>
        </form>`;
      const form = document.querySelector('form')!;
      const pass = document.querySelector('input[name=password]') as HTMLInputElement;
      const button = document.querySelector('button')!;
      let clicked = false;
      button.addEventListener('click', () => {
        clicked = true;
      });
      pass.addEventListener('input', () => {
        setTimeout(() => {
          const challenge = document.createElement('div');
          challenge.className = 'captcha-panel geetest';
          challenge.textContent = '请完成人机验证';
          form.appendChild(challenge);
        }, 50);
      });

      const r = fillCredentialsInPage('alice', 'pw', true);
      expect(r.ok).toBe(true);
      expect(r.submitted).toBe(true);

      await vi.advanceTimersByTimeAsync(200);

      expect(clicked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('真正自动提交前写入 pemAutoSubmitAt 标记（供网页内助手识别点击后才弹验证码的死循环）', async () => {
    vi.useFakeTimers();
    try {
      sessionStorage.removeItem('pemAutoSubmitAt');
      document.body.innerHTML = `
        <form>
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="submit">登录</button>
        </form>`;
      const form = document.querySelector('form')!;
      let clicked = false;
      form.querySelector('button')!.addEventListener('click', () => {
        clicked = true;
      });
      form.addEventListener('submit', (e) => e.preventDefault());

      const r = fillCredentialsInPage('alice', 'pw', true);
      expect(r.submitted).toBe(true);
      expect(sessionStorage.getItem('pemAutoSubmitAt')).toBeNull(); // 点击发生在延迟里，尚未写入

      await vi.advanceTimersByTimeAsync(200);

      expect(clicked).toBe(true);
      const stamp = JSON.parse(sessionStorage.getItem('pemAutoSubmitAt') || 'null');
      expect(stamp?.origin).toBe(location.origin);
      expect(typeof stamp?.ts).toBe('number');
    } finally {
      sessionStorage.removeItem('pemAutoSubmitAt');
      vi.useRealTimers();
    }
  });

  it('登录按钮是 type=button（element-ui 风格）时点击它本身、不触发原生表单提交导致刷新', async () => {
    vi.useFakeTimers();
    try {
      sessionStorage.removeItem('pemAutoSubmitAt');
      document.body.innerHTML = `
        <form>
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="button" class="el-button el-button--primary">登 录</button>
        </form>`;
      const form = document.querySelector('form')!;
      const btn = form.querySelector('button')!;
      let clicked = false;
      let nativeSubmit = false;
      btn.addEventListener('click', () => {
        clicked = true;
      });
      form.addEventListener('submit', (e) => {
        nativeSubmit = true;
        e.preventDefault();
      });

      const r = fillCredentialsInPage('alice', 'pw', true);
      expect(r.submitted).toBe(true);
      await vi.advanceTimersByTimeAsync(200);

      // 关键：点真正的登录按钮（触发站点自己的处理），而不是退回原生表单提交把整页刷掉。
      expect(clicked).toBe(true);
      expect(nativeSubmit).toBe(false);
    } finally {
      sessionStorage.removeItem('pemAutoSubmitAt');
      vi.useRealTimers();
    }
  });

  it('不会误点注册/忘记密码按钮', async () => {
    vi.useFakeTimers();
    try {
      sessionStorage.removeItem('pemAutoSubmitAt');
      document.body.innerHTML = `
        <form>
          <input type="text" name="username" />
          <input type="password" name="password" />
          <button type="button" class="reg">注册</button>
          <button type="button" class="forgot">忘记密码</button>
          <button type="button" class="el-button--primary">登 录</button>
        </form>`;
      const form = document.querySelector('form')!;
      const clicks: string[] = [];
      form.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => clicks.push(b.textContent!.trim())),
      );

      fillCredentialsInPage('alice', 'pw', true);
      await vi.advanceTimersByTimeAsync(200);

      expect(clicks).toEqual(['登 录']);
    } finally {
      sessionStorage.removeItem('pemAutoSubmitAt');
      vi.useRealTimers();
    }
  });
});

describe('fillUsernameInPage', () => {
  it('填充用户名/邮箱单步页面', () => {
    document.body.innerHTML = `
      <form>
        <input type="email" autocomplete="username" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    let inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);

    const r = fillUsernameInPage('alice@example.com');
    expect(r.ok).toBe(true);
    expect(input.value).toBe('alice@example.com');
    expect(inputEvents).toBeGreaterThan(0);
  });

  it('多个文本框时优先填当前聚焦字段', () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="query" placeholder="Search" />
        <input type="text" id="account" placeholder="Apple ID" />
      </form>`;
    const account = document.querySelector('#account') as HTMLInputElement;
    account.focus();

    const r = fillUsernameInPage('me@icloud.com');
    expect(r.ok).toBe(true);
    expect(account.value).toBe('me@icloud.com');
    expect((document.querySelector('#query') as HTMLInputElement).value).toBe('');
  });

  it('没有用户名字段时返回失败', () => {
    document.body.innerHTML = `<form><input type="password" /></form>`;
    expect(fillUsernameInPage('alice').ok).toBe(false);
  });

  it('多步登录第一步：下一步按钮是 type=button 时点击它前进、不触发原生提交', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <form>
          <input type="text" name="account" placeholder="账号" />
          <button type="button" class="el-button el-button--primary">下一步</button>
        </form>`;
      const btn = document.querySelector('button')!;
      let clicked = false;
      let nativeSubmit = false;
      btn.addEventListener('click', () => {
        clicked = true;
      });
      document.querySelector('form')!.addEventListener('submit', (e) => {
        nativeSubmit = true;
        e.preventDefault();
      });

      const r = fillUsernameInPage('alice', true);
      expect(r.ok).toBe(true);
      expect((document.querySelector('input[name=account]') as HTMLInputElement).value).toBe('alice');

      await vi.advanceTimersByTimeAsync(200);
      expect(clicked).toBe(true);
      expect(nativeSubmit).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fillTotpInPage', () => {
  it('填充标准 one-time-code 输入框', () => {
    document.body.innerHTML = `
      <form>
        <input autocomplete="one-time-code" inputmode="numeric" />
      </form>`;
    const input = document.querySelector('input') as HTMLInputElement;
    let inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);

    const r = fillTotpInPage('123456');
    expect(r.ok).toBe(true);
    expect(input.value).toBe('123456');
    expect(inputEvents).toBeGreaterThan(0);
  });

  it('填充分格验证码输入框', () => {
    document.body.innerHTML = `
      <form>
        <input maxlength="1" />
        <input maxlength="1" />
        <input maxlength="1" />
        <input maxlength="1" />
        <input maxlength="1" />
        <input maxlength="1" />
      </form>`;

    const r = fillTotpInPage('654321');
    expect(r.ok).toBe(true);
    expect(Array.from(document.querySelectorAll('input')).map((el) => el.value).join('')).toBe(
      '654321',
    );
  });

  it('没有验证码输入框时返回失败', () => {
    document.body.innerHTML = `<form><input type="text" name="search" /></form>`;
    expect(fillTotpInPage('123456').ok).toBe(false);
  });
});

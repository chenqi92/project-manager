import { beforeEach, describe, expect, it } from 'vitest';
import {
  fillCredentialsInPage,
  fillTotpInPage,
  fillUsernameInPage,
  getOrigin,
  originsMatch,
} from '../lib/autofill';

beforeEach(() => {
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

describe('fillCredentialsInPage', () => {
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

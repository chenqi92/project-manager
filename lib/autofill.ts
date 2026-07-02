// ---------------------------------------------------------------------------
// 填充安全：严格 origin 匹配 + 一次性注入的填充函数。
// 关键安全决策：
//  - 只在「页面 origin 与条目 URL 的 origin 完全一致」时才允许填充（scheme+host+port）。
//    绝不模糊匹配、绝不放宽到子域 / eTLD+1（这是真实世界里最常见的被钓鱼方式）。
//  - 选择哪个账号由用户在扩展自己的 UI(popup) 里点选，避免页面内注入选择器被点击劫持。
//  - 默认不自动提交；仅当用户在设置里显式开启时，才在填充后提交。
// ---------------------------------------------------------------------------

import type { LinkMatchMode, PlatformLink } from './types';

export function getOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    // 只认 http(s)：凭据填充/授权只对网页有意义，file:// chrome:// 等一律视为无效，
    // 避免后续对不可授权的 scheme 申请权限报错或误打开标签页。
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 精确 origin 匹配（scheme + host + port 全部一致）。 */
export function originsMatch(entryUrl: string, pageUrl: string): boolean {
  const a = getOrigin(entryUrl);
  const b = getOrigin(pageUrl);
  return a !== null && b !== null && a === b;
}

function parseHttpUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

function pathPrefixMatches(prefix: string, current: string): boolean {
  const cleanPrefix = normalizePrefix(prefix || '/');
  const cleanCurrent = normalizePrefix(current || '/');
  if (cleanPrefix === '/') return true;
  return cleanCurrent === cleanPrefix || cleanCurrent.startsWith(cleanPrefix + '/');
}

function normalizePrefix(value: string): string {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

/** 链接 URL 与页面 URL 的匹配。origin 为旧行为；路径模式用于同域同端口下区分多个系统。 */
export function linkUrlMatches(
  entryUrl: string,
  pageUrl: string,
  mode: LinkMatchMode = 'origin',
): boolean {
  const entry = parseHttpUrl(entryUrl);
  const page = parseHttpUrl(pageUrl);
  if (!entry || !page || entry.origin !== page.origin) return false;
  if (mode === 'origin') return true;
  if (mode === 'exact-url') {
    return entry.pathname === page.pathname && entry.search === page.search && entry.hash === page.hash;
  }
  const pathOk = pathPrefixMatches(entry.pathname, page.pathname);
  const hashOk = !entry.hash || pathPrefixMatches(entry.hash, page.hash);
  return pathOk && hashOk;
}

export function linkMatchesUrl(
  link: Pick<PlatformLink, 'url' | 'urls' | 'matchMode'>,
  pageUrl: string,
): string | null {
  const mode = link.matchMode ?? 'origin';
  return [link.url, ...(link.urls ?? [])]
    .map((u) => u.trim())
    .filter(Boolean)
    .find((url) => linkUrlMatches(url, pageUrl, mode)) ?? null;
}

export interface FillResult {
  ok: boolean;
  reason?: string;
  submitted?: boolean;
  submitSkipped?: boolean;
  /** 顶层没找到密码框、但检测到登录表单在某个跨域 iframe 里时，回报该 iframe 的 origin。 */
  loginFrameOrigin?: string;
}

/**
 * 取可注册域（eTLD+1）的粗略实现：处理常见的二级公共后缀（com.cn / co.uk 等）。
 * 没有内置公共后缀表，够「同主域 iframe 填充」判断用即可。IP / 含端口的主机原样返回。
 */
export function registrableDomain(host: string): string {
  const h = (host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h.includes(':') || /^\d+(\.\d+){3}$/.test(h) || h === 'localhost') return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const twoLevel = new Set([
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
    'com.hk', 'com.tw', 'com.sg', 'com.au', 'co.nz', 'co.jp', 'com.jp',
  ]);
  return twoLevel.has(parts.slice(-2).join('.'))
    ? parts.slice(-3).join('.')
    : parts.slice(-2).join('.');
}

/** 两个 origin 是否同主域（同协议 + 同 eTLD+1）。用于判断内嵌登录 iframe 是否可信。 */
export function isSameSite(originA: string, originB: string): boolean {
  try {
    const a = new URL(originA);
    const b = new URL(originB);
    return a.protocol === b.protocol && registrableDomain(a.hostname) === registrableDomain(b.hostname);
  } catch {
    return false;
  }
}

/**
 * 注入到目标页面执行的填充函数。必须自包含、不引用任何外部作用域
 * （会被 chrome.scripting.executeScript 序列化后在页面里运行）。
 * 只填值并派发 input/change 事件，不点击提交。
 * tenant：多租户系统登录页的租户 / 企业 / 域字段值（可选，账号存了才会填）。
 */
export function fillCredentialsInPage(
  username: string,
  password: string,
  submit = false,
  site?: string,
  tenant?: string,
): FillResult {
  // 跨 frame 注入（allFrames）时的同主域护栏：site 为「允许填充的可注册域(eTLD+1)」。
  // 只在当前 frame 的主机等于该域或其子域时才填，避免被一起注入的无关 iframe
  //（广告 / 统计 / 第三方登录）误填导致凭据泄露。site 为空表示单顶层填充（调用方已校验来源）。
  if (site) {
    const h = location.hostname.toLowerCase();
    if (h !== site && !h.endsWith('.' + site)) {
      return { ok: false, reason: 'frame-not-allowed' };
    }
  }
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none'
    );
  };

  const setValue = (el: HTMLInputElement, value: string): void => {
    const proto = Object.getPrototypeOf(el) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc?.set ? desc.set.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const fieldText = (el: HTMLInputElement): string =>
    [
      el.name,
      el.id,
      el.autocomplete,
      el.inputMode,
      el.placeholder,
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('data-testid') ?? '',
      el.getAttribute('title') ?? '',
      el.closest('label')?.textContent ?? '',
      el.parentElement?.textContent ?? '',
    ]
      .join(' ')
      .toLowerCase();

  const formHasCaptchaMedia = (root: ParentNode): boolean =>
    Array.from(root.querySelectorAll<HTMLElement>('img, canvas, svg')).some((el) => {
      const text = [
        el.id,
        el.className,
        el.getAttribute('src') ?? '',
        el.getAttribute('alt') ?? '',
        el.getAttribute('title') ?? '',
        el.getAttribute('aria-label') ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return /(captcha|verify|verification|code|验证码|校验码|图形码|图片验证码)/i.test(text);
    });

  const hasVerificationChallenge = (root: ParentNode): boolean => {
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[class], [id], [data-sitekey], [aria-label], [title], iframe, img, canvas, svg',
      ),
    ).filter(visible);
    if (
      nodes.some((el) => {
        const text = [
          el.id,
          el.className,
          el.getAttribute('name') ?? '',
          el.getAttribute('src') ?? '',
          el.getAttribute('alt') ?? '',
          el.getAttribute('title') ?? '',
          el.getAttribute('aria-label') ?? '',
          el.getAttribute('data-sitekey') ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return /(captcha|recaptcha|hcaptcha|turnstile|geetest|verify|verification|slider|swipe|slide|drag|验证码|校验码|图形码|滑块|滑动|拖动|拖拽|向右滑|人机验证|安全验证)/i.test(text);
      })
    )
      return true;
    const text = ((root as HTMLElement).textContent ?? '').slice(0, 1200).toLowerCase();
    return /(captcha|recaptcha|hcaptcha|turnstile|geetest|验证码|校验码|图形码|滑块|人机验证|安全验证)/i.test(text);
  };

  const isVerificationField = (
    el: HTMLInputElement,
    formScope: ParentNode,
    userEl: HTMLInputElement | null,
    passwordEl: HTMLInputElement,
  ): boolean => {
    if (el === userEl || el === passwordEl || !visible(el) || el.disabled || el.readOnly) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['password', 'hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return false;
    if (el.autocomplete === 'one-time-code') return true;
    const text = fieldText(el);
    if (/(captcha|verify|verification|auth.?code|security.?code|check.?code|\bcode\b|otp|totp|mfa|2fa|验证码|校验码|验证|动态码|图形码|图片验证码|短信码)/i.test(text))
      return true;
    const max = el.maxLength;
    const shortNumeric =
      (max > 0 && max <= 8) ||
      el.inputMode === 'numeric' ||
      type === 'number' ||
      type === 'tel';
    return shortNumeric && formHasCaptchaMedia(formScope);
  };

  // 找到「真正的登录按钮」并像用户一样点击它，触发站点自己的点击处理（弹验证码 / AJAX 登录）。
  // 很多组件库（如 element-ui）的登录按钮渲染成 <button type="button">，严格的提交选择器匹配不到，
  // 旧逻辑会退回 form.requestSubmit() 触发「原生表单提交→整页刷新」，恰好打断站点「点击后才弹滑动
  // 验证码」的处理而陷入死循环。这里优先按文案/类名定位登录按钮，匹配不到才退回严格选择器。
  const submitTarget = (formScope: ParentNode): HTMLElement | null => {
    const usable = (el: Element | null): el is HTMLElement =>
      !!el && visible(el) && !(el as HTMLButtonElement).disabled;
    const strict =
      Array.from(
        formScope.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"], button:not([type])',
        ),
      ).find(usable) ?? null;
    const loginRe = /(登\s*录|登\s*陆|sign\s*in|log\s*in|^\s*login\s*$|提交|确\s*定|continue|继续|下一步|next)/i;
    const negRe = /(注册|sign\s*up|register|忘记|忘記|forgot|找回|reset|重置|取消|cancel|扫码|二维码|第三方|其它|其他|切换|change)/i;
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const el of formScope.querySelectorAll<HTMLElement>(
      'button, input[type="button"], [role="button"], a',
    )) {
      if (!usable(el)) continue;
      const text = (
        (el as HTMLInputElement).value ||
        el.textContent ||
        el.getAttribute('aria-label') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text.length > 24 || negRe.test(text)) continue;
      let score = 0;
      if (loginRe.test(text)) score += 5;
      if (/(login|signin|sign-in|submit|primary|btn-login|loginbtn)/i.test(`${el.className} ${el.id}`))
        score += 3;
      if (el.tagName === 'BUTTON') score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    // 文案够明确（含「登录」类词）才点该按钮；否则退回严格提交按钮（可能为 null）。
    return bestScore >= 5 ? best : strict;
  };

  const pwFields = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[type="password"]:not([disabled]):not([readonly])',
    ),
  ).filter(visible);
  const pw = pwFields[0];
  if (!pw) {
    // 顶层文档没有密码框：登录表单很可能在跨域 iframe 里（如阿里云 passport.aliyun.com），
    // 注入到顶层 frame 看不到它。检测一下并给出可操作的提示，而不是笼统的「没找到」。
    const loginFrameOrigin = Array.from(document.querySelectorAll('iframe'))
      .filter((f) =>
        /(login|passport|sso|auth|signin|sign-in|havana|ulogin|account|oauth)/i.test(
          `${f.id} ${f.name} ${f.src}`,
        ),
      )
      .map((f) => {
        try {
          return new URL(f.src, location.href).origin;
        } catch {
          return '';
        }
      })
      .find((o) => o && o !== location.origin);
    return {
      ok: false,
      reason: loginFrameOrigin
        ? `登录框在内嵌网页（${loginFrameOrigin}）里`
        : '页面上没找到密码输入框',
      loginFrameOrigin: loginFrameOrigin || undefined,
    };
  }

  // 租户 / 企业 / 域字段：多租户系统在用户名之外的第三个输入框。
  // 用户名选择时要跳过它，避免把用户名填进租户框；账号存了租户值时才往里填。
  // 只看输入框自身属性与 label 文案（不看父容器整段文本），避免把普通用户名框误判成租户框。
  const tenantRe = /(tenant|租户|企业|公司|单位|机构|组织|域名|域账号|登录域|domain|company|corp\b)/i;
  const isTenantField = (el: HTMLInputElement): boolean =>
    tenantRe.test(
      [
        el.name,
        el.id,
        el.autocomplete,
        el.placeholder,
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('title') ?? '',
        el.closest('label')?.textContent ?? '',
      ]
        .join(' ')
        .toLowerCase(),
    );

  // 用户名框：同一表单内、密码框之前最近的一个文本/邮箱/电话输入框（跳过租户框）。
  let userField: HTMLInputElement | null = null;
  const scope = pw.form ?? document;
  const allCandidates = Array.from(
    scope.querySelectorAll<HTMLInputElement>(
      'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
    ),
  ).filter((el) => el.type !== 'password' && visible(el));
  const candidates = allCandidates.filter((el) => !isTenantField(el));
  for (const el of candidates) {
    const pos = el.compareDocumentPosition(pw);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) userField = el; // el 在 pw 之前
  }
  if (!userField && candidates.length > 0) userField = candidates[0]!;
  // 全部候选都像租户框时退回旧行为（宁可填错位置也别不填）。
  if (!userField && allCandidates.length > 0) userField = allCandidates[0]!;

  const tenantField = tenant
    ? allCandidates.find((el) => el !== userField && isTenantField(el)) ?? null
    : null;
  if (tenantField && tenant) setValue(tenantField, tenant);
  if (userField && username) setValue(userField, username);
  setValue(pw, password);

  if (submit) {
    const verification = Array.from(
      scope.querySelectorAll<HTMLInputElement>('input:not([disabled]):not([readonly])'),
    ).find((el) => isVerificationField(el, scope, userField, pw) && !el.value.trim());
    if (verification) {
      verification.focus();
      return {
        ok: true,
        submitSkipped: true,
        reason: '检测到验证码，已填充账号密码，请输入验证码后手动登录',
      };
    }
    if (hasVerificationChallenge(scope)) {
      (userField ?? pw).focus();
      return {
        ok: true,
        submitSkipped: true,
        reason: '检测到验证码/人机验证，已填充账号密码，请完成验证后手动登录',
      };
    }
    // 稍等让前端框架处理完 input 事件再提交，提高成功率。
    setTimeout(() => {
      const currentPw = pw.isConnected
        ? pw
        : Array.from(
            document.querySelectorAll<HTMLInputElement>(
              'input[type="password"]:not([disabled]):not([readonly])',
            ),
          ).filter(visible)[0] ?? pw;
      const formScope = currentPw.form ?? document;
      const currentUser = userField?.isConnected ? userField : null;
      const delayedVerification = Array.from(
        formScope.querySelectorAll<HTMLInputElement>('input:not([disabled]):not([readonly])'),
      ).find((el) => isVerificationField(el, formScope, currentUser, currentPw) && !el.value.trim());
      if (delayedVerification) {
        delayedVerification.focus();
        return;
      }
      if (hasVerificationChallenge(formScope)) {
        (currentUser ?? currentPw).focus();
        return;
      }
      // 记下「本次确实自动提交了」：若提交后页面仍停在登录页（被点击后才弹出的滑动验证码
      // / 二次校验拦下），网页内助手据此把该来源切回「只填充不自动提交」，避免反复刷新死循环。
      try {
        sessionStorage.setItem(
          'pemAutoSubmitAt',
          JSON.stringify({ origin: location.origin, ts: Date.now() }),
        );
      } catch {
        /* 忽略隐私模式下的 sessionStorage 失败 */
      }
      // 优先「像用户一样点击真正的登录按钮」，让站点自己的处理器接管（弹验证码 / 发 AJAX）；
      // 只有完全找不到按钮时才退回原生提交 / 回车，尽量不触发整页刷新。
      const target = submitTarget(formScope);
      if (target) {
        target.click();
      } else if (currentPw.form && typeof currentPw.form.requestSubmit === 'function') {
        currentPw.form.requestSubmit();
      } else {
        currentPw.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
        );
      }
    }, 180);
    return { ok: true, submitted: true };
  } else {
    pw.focus();
  }
  return { ok: true };
}

/** 注入到目标页面执行的用户名/账号单步填充函数。 */
export function fillUsernameInPage(username: string, submit = false): FillResult {
  const value = username.trim();
  if (!value) return { ok: false, reason: '用户名为空' };

  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none'
    );
  };

  const setValue = (el: HTMLInputElement, next: string): void => {
    const proto = Object.getPrototypeOf(el) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc?.set ? desc.set.call(el, next) : (el.value = next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[type="text"]:not([disabled]):not([readonly]), input[type="email"]:not([disabled]):not([readonly]), input[type="tel"]:not([disabled]):not([readonly]), input:not([type]):not([disabled]):not([readonly])',
    ),
  ).filter((el) => el.type !== 'password' && visible(el));

  const textOf = (el: HTMLInputElement): string =>
    [
      el.name,
      el.id,
      el.autocomplete,
      el.inputMode,
      el.placeholder,
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('data-testid') ?? '',
    ]
      .join(' ')
      .toLowerCase();

  const score = (el: HTMLInputElement): number => {
    const text = textOf(el);
    let n = 0;
    if (document.activeElement === el) n += 8;
    if (el.autocomplete === 'username' || el.autocomplete === 'email') n += 10;
    if (el.type === 'email') n += 6;
    if (/(user|username|email|account|login|phone|mobile|apple.?id|账号|账户|邮箱|邮件|手机|电话|用户名)/i.test(text)) n += 6;
    if (/(search|query|keyword|验证码|验证|code|otp|totp)/i.test(text)) n -= 8;
    return n;
  };

  const target = fields
    .map((el) => ({ el, score: score(el) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.el;

  if (!target) return { ok: false, reason: '页面上没找到用户名输入框' };
  setValue(target, value);
  if (submit) submitNear(target);
  else target.focus();
  return { ok: true };

  function submitNear(el: HTMLInputElement): void {
    setTimeout(() => {
      const scope: ParentNode = el.form ?? document;
      const target = stepButton(scope);
      if (target) target.click();
      else if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }, 180);
  }

  // 与 fillCredentialsInPage.submitTarget 同策略：优先点真正的「下一步/登录」按钮（含组件库渲染成
  // type=button 的按钮），匹配不到才退回原生提交——否则多步登录第一步（账号→下一步）无法前进。
  function stepButton(scope: ParentNode): HTMLElement | null {
    const usable = (x: Element | null): x is HTMLElement =>
      !!x && visible(x) && !(x as HTMLButtonElement).disabled;
    const strict =
      Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"], button:not([type])',
        ),
      ).find(usable) ?? null;
    const yes = /(登\s*录|登\s*陆|sign\s*in|log\s*in|^\s*login\s*$|提交|确\s*定|continue|继续|下一步|next)/i;
    const no = /(注册|sign\s*up|register|忘记|忘記|forgot|找回|reset|重置|取消|cancel|扫码|二维码|第三方|其它|其他|切换|change)/i;
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const x of scope.querySelectorAll<HTMLElement>(
      'button, input[type="button"], [role="button"], a',
    )) {
      if (!usable(x)) continue;
      const t = ((x as HTMLInputElement).value || x.textContent || x.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!t || t.length > 24 || no.test(t)) continue;
      let s = 0;
      if (yes.test(t)) s += 5;
      if (/(login|signin|sign-in|submit|primary|next|btn-login|loginbtn)/i.test(`${x.className} ${x.id}`))
        s += 3;
      if (x.tagName === 'BUTTON') s += 1;
      if (s > bestScore) {
        bestScore = s;
        best = x;
      }
    }
    return bestScore >= 5 ? best : strict;
  }
}

/** 注入到目标页面执行的 TOTP/OTP 填充函数。 */
export function fillTotpInPage(code: string, submit = false): FillResult {
  const value = code.trim();
  if (!value) return { ok: false, reason: '验证码为空' };

  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const s = getComputedStyle(el as HTMLElement);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.visibility !== 'hidden' &&
      s.display !== 'none'
    );
  };

  const setValue = (el: HTMLInputElement, next: string): void => {
    const proto = Object.getPrototypeOf(el) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc?.set ? desc.set.call(el, next) : (el.value = next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])',
    ),
  )
    .filter((el) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      return type !== 'password' && type !== 'hidden' && visible(el);
    })
    .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);

  const textOf = (el: HTMLInputElement): string =>
    [
      el.name,
      el.id,
      el.autocomplete,
      el.inputMode,
      el.placeholder,
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('data-testid') ?? '',
    ]
      .join(' ')
      .toLowerCase();

  const score = (el: HTMLInputElement): number => {
    const text = textOf(el);
    let n = 0;
    if (el.autocomplete === 'one-time-code') n += 10;
    if (el.inputMode === 'numeric' || el.type === 'tel' || el.type === 'number') n += 3;
    if (/(otp|totp|mfa|2fa|code|token|verify|verification|auth|验证码|验证|动态码)/i.test(text)) n += 6;
    if ((el.maxLength > 0 && el.maxLength <= 10) || (el.size > 0 && el.size <= 10)) n += 1;
    return n;
  };

  const single = inputs
    .map((el) => ({ el, score: score(el) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.el;

  if (single) {
    setValue(single, value);
    if (submit) submitNear(single);
    else single.focus();
    return { ok: true };
  }

  const boxes = inputs.filter((el) => {
    const max = el.maxLength;
    return (max === 1 || el.size === 1 || el.getAttribute('aria-label')?.match(/\d|digit/i)) && !el.value;
  });
  if (boxes.length >= value.length) {
    [...value].forEach((ch, i) => setValue(boxes[i]!, ch));
    const last = boxes[value.length - 1]!;
    if (submit) submitNear(last);
    else last.focus();
    return { ok: true };
  }

  return { ok: false, reason: '页面上没找到验证码输入框' };

  function submitNear(el: HTMLInputElement): void {
    setTimeout(() => {
      const scope: ParentNode = el.form ?? document;
      const target = stepButton(scope);
      if (target) target.click();
      else if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }, 180);
  }

  // 与 fillCredentialsInPage.submitTarget 同策略：优先点真正的「下一步/登录」按钮（含组件库渲染成
  // type=button 的按钮），匹配不到才退回原生提交——否则多步登录第一步（账号→下一步）无法前进。
  function stepButton(scope: ParentNode): HTMLElement | null {
    const usable = (x: Element | null): x is HTMLElement =>
      !!x && visible(x) && !(x as HTMLButtonElement).disabled;
    const strict =
      Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"], button:not([type])',
        ),
      ).find(usable) ?? null;
    const yes = /(登\s*录|登\s*陆|sign\s*in|log\s*in|^\s*login\s*$|提交|确\s*定|continue|继续|下一步|next)/i;
    const no = /(注册|sign\s*up|register|忘记|忘記|forgot|找回|reset|重置|取消|cancel|扫码|二维码|第三方|其它|其他|切换|change)/i;
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const x of scope.querySelectorAll<HTMLElement>(
      'button, input[type="button"], [role="button"], a',
    )) {
      if (!usable(x)) continue;
      const t = ((x as HTMLInputElement).value || x.textContent || x.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!t || t.length > 24 || no.test(t)) continue;
      let s = 0;
      if (yes.test(t)) s += 5;
      if (/(login|signin|sign-in|submit|primary|next|btn-login|loginbtn)/i.test(`${x.className} ${x.id}`))
        s += 3;
      if (x.tagName === 'BUTTON') s += 1;
      if (s > bestScore) {
        bestScore = s;
        best = x;
      }
    }
    return bestScore >= 5 ? best : strict;
  }
}

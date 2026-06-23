// ---------------------------------------------------------------------------
// 填充安全：严格 origin 匹配 + 一次性注入的填充函数。
// 关键安全决策：
//  - 只在「页面 origin 与条目 URL 的 origin 完全一致」时才允许填充（scheme+host+port）。
//    绝不模糊匹配、绝不放宽到子域 / eTLD+1（这是真实世界里最常见的被钓鱼方式）。
//  - 选择哪个账号由用户在扩展自己的 UI(popup) 里点选，避免页面内注入选择器被点击劫持。
//  - 默认不自动提交；仅当用户在设置里显式开启时，才在填充后提交。
// ---------------------------------------------------------------------------

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

export interface FillResult {
  ok: boolean;
  reason?: string;
}

/**
 * 注入到目标页面执行的填充函数。必须自包含、不引用任何外部作用域
 * （会被 chrome.scripting.executeScript 序列化后在页面里运行）。
 * 只填值并派发 input/change 事件，不点击提交。
 */
export function fillCredentialsInPage(
  username: string,
  password: string,
  submit = false,
): FillResult {
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

  const pwFields = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[type="password"]:not([disabled]):not([readonly])',
    ),
  ).filter(visible);
  const pw = pwFields[0];
  if (!pw) return { ok: false, reason: '页面上没找到密码输入框' };

  // 用户名框：同一表单内、密码框之前最近的一个文本/邮箱/电话输入框。
  let userField: HTMLInputElement | null = null;
  const scope = pw.form ?? document;
  const candidates = Array.from(
    scope.querySelectorAll<HTMLInputElement>(
      'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
    ),
  ).filter((el) => el.type !== 'password' && visible(el));
  for (const el of candidates) {
    const pos = el.compareDocumentPosition(pw);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) userField = el; // el 在 pw 之前
  }
  if (!userField && candidates.length > 0) userField = candidates[0]!;

  if (userField && username) setValue(userField, username);
  setValue(pw, password);

  if (submit) {
    // 稍等让前端框架处理完 input 事件再提交，提高成功率。
    setTimeout(() => {
      const form = pw.form;
      if (form) {
        const btn = form.querySelector<HTMLElement>(
          'button[type="submit"], input[type="submit"], button:not([type])',
        );
        if (btn) btn.click();
        else if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } else {
        pw.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
        );
      }
    }, 80);
  } else {
    pw.focus();
  }
  return { ok: true };
}

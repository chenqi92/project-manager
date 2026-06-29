// Web assist content script.
// Registered dynamically only after the user enables the feature and grants host access.
(() => {
  if (window.__PEM_WEB_ASSIST__) return;
  window.__PEM_WEB_ASSIST__ = true;

  let host = null;
  let root = null;
  let snapshot = null;
  let expanded = false;
  let dismissed = false;
  let capturePrompt = null;
  let refreshTimer = 0;
  let lastSent = 0;

  const send = (msg) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!res) return reject(new Error('后台无响应'));
          if (!res.ok) return reject(new Error(res.error || '操作失败'));
          resolve(res.data);
        });
      } catch (e) {
        reject(e);
      }
    });

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const passwordFields = () =>
    Array.from(document.querySelectorAll('input[type="password"]')).filter(
      (el) => el.value !== undefined && visible(el),
    );

  const usernameFields = () =>
    Array.from(
      document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
      ),
    ).filter((el) => {
      if (el.type === 'password' || !visible(el)) return false;
      const text = [
        el.name,
        el.id,
        el.autocomplete,
        el.inputMode,
        el.placeholder,
        el.getAttribute('aria-label') || '',
      ]
        .join(' ')
        .toLowerCase();
      if (/(search|query|keyword|验证码|验证|code|otp|totp)/i.test(text)) return false;
      return (
        document.activeElement === el ||
        el.type === 'email' ||
        el.autocomplete === 'username' ||
        el.autocomplete === 'email' ||
        /(user|username|email|account|login|phone|mobile|apple.?id|账号|账户|邮箱|邮件|手机|电话|用户名)/i.test(text)
      );
    });

  const otpFields = () =>
    Array.from(document.querySelectorAll('input:not([type="password"]):not([type="hidden"])')).filter((el) => {
      if (!visible(el)) return false;
      const text = [
        el.name,
        el.id,
        el.autocomplete,
        el.inputMode,
        el.placeholder,
        el.getAttribute('aria-label') || '',
      ]
        .join(' ')
        .toLowerCase();
      return (
        el.autocomplete === 'one-time-code' ||
        /(otp|totp|mfa|2fa|code|token|verify|verification|auth|验证码|验证|动态码)/i.test(text)
      );
    });

  const surfaceKind = () => {
    if (passwordFields().length > 0) return 'password';
    if (otpFields().length > 0) return 'otp';
    if (usernameFields().length > 0) return 'username';
    return 'none';
  };

  const preferredId = () => {
    try {
      return sessionStorage.getItem('pemAssistPreferredAccountId') || '';
    } catch {
      return '';
    }
  };

  const remember = (accountId) => {
    try {
      sessionStorage.setItem('pemAssistPreferredAccountId', accountId);
    } catch {
      /* ignore private/session storage failures */
    }
  };

  const sortMatches = (surface) => {
    if (!snapshot?.matches?.length) return;
    if (surface === 'otp') {
      snapshot.matches.sort((a, b) => (a.hasTotp === b.hasTotp ? 0 : a.hasTotp ? -1 : 1));
      return;
    }
    const preferred = preferredId();
    if (!preferred) return;
    snapshot.matches.sort((a, b) => (a.accountId === preferred ? -1 : b.accountId === preferred ? 1 : 0));
  };

  const ensureRoot = () => {
    if (root) return root;
    host = document.createElement('div');
    host.id = 'pem-web-assist';
    host.style.position = 'fixed';
    host.style.left = '0';
    host.style.right = '0';
    host.style.top = '12px';
    host.style.zIndex = '2147483647';
    host.style.display = 'flex';
    host.style.justifyContent = 'center';
    host.style.pointerEvents = 'none';
    root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    return root;
  };

  const destroy = () => {
    host?.remove();
    host = null;
    root = null;
  };

  const css = `
    :host { all: initial; }
    .wrap {
      pointer-events: auto;
      min-width: min(520px, calc(100vw - 24px));
      max-width: min(640px, calc(100vw - 24px));
      color: #111827;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      overflow: hidden;
      border: 1px solid rgba(37, 99, 235, .35);
      border-radius: 22px;
      background: rgba(255, 255, 255, .98);
      box-shadow: 0 16px 40px rgba(15, 23, 42, .18);
      backdrop-filter: blur(10px);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
    }
    .logo {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #fff;
      background: #0d9488;
      font-size: 14px;
      font-weight: 800;
      flex: 0 0 auto;
    }
    .text { min-width: 0; flex: 1; }
    .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 700;
      line-height: 18px;
    }
    .sub {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #6b7280;
      font-size: 12px;
      line-height: 16px;
    }
    .actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
    button {
      all: initial;
      box-sizing: border-box;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      padding: 0 10px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      user-select: none;
    }
    button.primary { background: #0d9488; color: #fff; }
    button.secondary { background: #eef2f7; color: #374151; }
    button.icon { width: 30px; padding: 0; color: #6b7280; background: transparent; }
    button:hover { filter: brightness(.96); }
    .list { border-top: 1px solid #eef2f7; padding: 4px; }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      border-radius: 12px;
      padding: 8px;
    }
    .item:hover { background: #f8fafc; }
    .tiny {
      height: 26px;
      border-radius: 8px;
      padding: 0 8px;
      font-size: 11px;
      background: #eef2f7;
      color: #374151;
    }
    .msg {
      border-top: 1px solid #eef2f7;
      padding: 8px 12px 10px;
      color: #0f766e;
      font-size: 12px;
      font-weight: 650;
    }
    .warn { color: #b45309; }
    @media (max-width: 520px) {
      .row { align-items: flex-start; }
      .actions { flex-wrap: wrap; justify-content: flex-end; max-width: 148px; }
      button { height: 28px; padding: 0 8px; }
    }
  `;

  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const labelFor = (e) => e.accountLabel || e.username || e.linkName || '账号';

  const render = (message, tone = 'info') => {
    const surface = surfaceKind();
    sortMatches(surface);
    const shouldShowMatches =
      !dismissed &&
      snapshot &&
      snapshot.enabled &&
      snapshot.matches.length > 0 &&
      (surface === 'password' ||
        surface === 'username' ||
        (surface === 'otp' && snapshot.matches.some((e) => e.hasTotp)));
    if (!capturePrompt && !shouldShowMatches) return destroy();

    const r = ensureRoot();
    const first = snapshot?.matches?.[0];
    const matchCount = snapshot?.matches?.length || 0;
    const title = capturePrompt
      ? capturePrompt.kind === 'update'
        ? `更新 ${capturePrompt.linkName || '已保存账号'} 的密码?`
        : `保存 ${capturePrompt.username || '这个账号'}?`
      : `${first.linkName || first.projectName} · ${labelFor(first)}`;
    const sub = capturePrompt
      ? `${hostOf(capturePrompt.origin)} · ${capturePrompt.username || '无用户名'}`
      : `${first.username || '无用户名'} · ${first.projectName} / ${first.envName}`;

    r.innerHTML = `
      <style>${css}</style>
      <div class="wrap">
        <div class="card">
          <div class="row">
            <div class="logo">${capturePrompt ? '+' : 'PM'}</div>
            <div class="text">
              <div class="title">${esc(title)}</div>
              <div class="sub">${esc(sub)}</div>
            </div>
            <div class="actions">
              ${
                capturePrompt
                  ? `<button class="primary" data-act="save-capture">${capturePrompt.kind === 'update' ? '更新' : '保存'}</button>
                     <button class="secondary" data-act="edit-capture">编辑</button>
                     <button class="secondary" data-act="dismiss-capture">忽略</button>`
                  : `${
                      surface === 'username'
                        ? `<button class="primary" data-act="fill-user" data-id="${esc(first.accountId)}">填账号</button>
                           <button class="secondary" data-act="continue-user" data-id="${esc(first.accountId)}">继续</button>`
                        : surface === 'otp'
                          ? first.hasTotp
                            ? `<button class="primary" data-act="totp" data-id="${esc(first.accountId)}">验证码</button>`
                            : ''
                          : `<button class="primary" data-act="fill" data-id="${esc(first.accountId)}">填充</button>
                             <button class="secondary" data-act="login" data-id="${esc(first.accountId)}">登录</button>
                             ${
                               first.hasTotp
                                 ? `<button class="secondary" data-act="totp" data-id="${esc(first.accountId)}">验证码</button>`
                                 : ''
                             }`
                    }
                     ${
                       matchCount > 1
                         ? `<button class="secondary" data-act="more">更多 ${matchCount}</button>`
                         : ''
                     }`
              }
              <button class="icon" data-act="close" aria-label="关闭">×</button>
            </div>
          </div>
          ${
            expanded && !capturePrompt
              ? `<div class="list">
                  ${snapshot.matches
                    .map(
                      (e) => `<div class="item">
                        <div class="logo">${esc((e.accountLabel || e.username || '?').slice(0, 1).toUpperCase())}</div>
                        <div class="text">
                          <div class="title">${esc(e.linkName || e.projectName)} · ${esc(labelFor(e))}</div>
                          <div class="sub">${esc(e.username || '无用户名')} · ${esc(e.envName)}</div>
                        </div>
                        ${
                          surface === 'username'
                            ? `<button class="tiny" data-act="fill-user" data-id="${esc(e.accountId)}">填账号</button>
                               <button class="tiny" data-act="continue-user" data-id="${esc(e.accountId)}">继续</button>`
                            : surface === 'otp'
                              ? e.hasTotp
                                ? `<button class="tiny" data-act="totp" data-id="${esc(e.accountId)}">验证码</button>`
                                : ''
                              : `<button class="tiny" data-act="fill" data-id="${esc(e.accountId)}">填充</button>
                                 <button class="tiny" data-act="login" data-id="${esc(e.accountId)}">登录</button>
                                 ${e.hasTotp ? `<button class="tiny" data-act="totp" data-id="${esc(e.accountId)}">验证码</button>` : ''}`
                        }
                      </div>`,
                    )
                    .join('')}
                </div>`
              : ''
          }
          ${message ? `<div class="msg ${tone === 'warn' ? 'warn' : ''}">${esc(message)}</div>` : ''}
        </div>
      </div>
    `;

    r.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void onAction(btn.dataset.act, btn.dataset.id);
      });
    });
  };

  const onAction = async (act, accountId) => {
    try {
      if (act === 'close') {
        dismissed = true;
        capturePrompt = null;
        destroy();
        return;
      }
      if (act === 'more') {
        expanded = !expanded;
        render();
        return;
      }
      if (act === 'save-capture') {
        await send({ type: 'capture:save', id: capturePrompt?.id });
        capturePrompt = null;
        await loadSnapshot();
        render('已保存到保险箱');
        setTimeout(scheduleRefresh, 1400);
        return;
      }
      if (act === 'edit-capture') {
        await send({ type: 'capture:editSave', id: capturePrompt?.id });
        render('已打开编辑保存');
        return;
      }
      if (act === 'dismiss-capture') {
        await send({ type: 'capture:dismiss', id: capturePrompt?.id });
        capturePrompt = null;
        render('已忽略');
        setTimeout(scheduleRefresh, 900);
        return;
      }
      if (act === 'fill-user' || act === 'continue-user') {
        remember(accountId);
        const res = await send({
          type: 'assist:fillUsername',
          accountId,
          submit: act === 'continue-user',
        });
        render(res?.ok === false ? res.reason || '未能填账号' : act === 'continue-user' ? '已填账号并继续' : '已填账号', res?.ok === false ? 'warn' : 'info');
        return;
      }
      if (act === 'fill' || act === 'login') {
        remember(accountId);
        const res = await send({ type: 'assist:fill', accountId, submit: act === 'login' });
        render(res?.ok === false ? res.reason || '未能填充' : act === 'login' ? '已填充并提交' : '已填充', res?.ok === false ? 'warn' : 'info');
        return;
      }
      if (act === 'totp') {
        remember(accountId);
        const res = await send({ type: 'assist:fillTotp', accountId, submit: false });
        render(res?.ok === false ? res.reason || '未能填验证码' : '验证码已填充', res?.ok === false ? 'warn' : 'info');
      }
    } catch (e) {
      render(e instanceof Error ? e.message : String(e), 'warn');
    }
  };

  const loadSnapshot = async () => {
    try {
      snapshot = await send({ type: 'assist:matches' });
    } catch {
      snapshot = null;
    }
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await loadSnapshot();
      render();
    }, 120);
  };

  const capture = async () => {
    const fields = passwordFields().filter((el) => el.value);
    const pw = fields[0];
    if (!pw || !pw.value) return;

    const scope = pw.form || document;
    const cands = Array.from(
      scope.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type])'),
    ).filter((el) => el.type !== 'password' && el.value && visible(el));

    let username = '';
    for (const el of cands) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) username = el.value;
    }
    if (!username && cands[0]) username = cands[0].value;

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    try {
      const res = await send({
        type: 'capture:login',
        origin: location.origin,
        url: location.href,
        username,
        password: pw.value,
      });
      if (res?.pending) {
        capturePrompt = res;
        dismissed = false;
        expanded = false;
        render();
      }
    } catch {
      // Ignore stale extension contexts or locked vaults.
    }
  };

  const soonCapture = () => setTimeout(() => void capture(), 0);

  const hostOf = (origin) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  };

  document.addEventListener('submit', soonCapture, true);
  document.addEventListener(
    'click',
    (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.includes(host)) return;
      const t = e.target;
      if (t && t.closest && t.closest('button, input[type="submit"], [role="button"]')) soonCapture();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') soonCapture();
    },
    true,
  );
  document.addEventListener('focusin', scheduleRefresh, true);

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'style', 'class', 'hidden', 'autocomplete', 'inputmode'],
  });

  void loadSnapshot().then(() => render());
})();

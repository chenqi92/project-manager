// 登录捕获内容脚本（纯 JS，放在 public/ 以免被 WXT 写进 manifest 的 host_permissions）。
// 只在用户授权过的站点由 background 通过 scripting.registerContentScripts 动态注册。
(() => {
  let lastSent = 0;
  let successCheckUntil = 0;
  let successTimer = 0;

  const CHECK_DELAYS = [650, 1600, 3200, 6000];

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const passwordFields = () =>
    Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);

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

  const hasSuccessHint = () =>
    Array.from(document.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]'))
      .slice(0, 220)
      .some((el) => {
        if (!visible(el)) return false;
        const text = [
          el.textContent || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('href') || '',
          el.value || '',
        ]
          .join(' ')
          .toLowerCase();
        return /(logout|log out|signout|sign out|退出|注销|登出)/i.test(text);
      });

  const successSignals = () => {
    const pws = passwordFields();
    return {
      visiblePasswordFields: pws.length,
      filledPasswordFields: pws.filter((el) => el.value).length,
      visibleOtpFields: otpFields().length,
      successHint: hasSuccessHint(),
    };
  };

  const send = (msg, done) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        if (done) done(res);
      });
    } catch {
      /* 扩展上下文失效时忽略 */
    }
  };

  const collectCredentials = () => {
    const pw = passwordFields().find((el) => el.value);
    if (!pw || !pw.value) return null;

    const scope = pw.form || document;
    const cands = Array.from(
      scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
      ),
    ).filter((el) => el.type !== 'password' && el.value && visible(el));

    let username = '';
    for (const el of cands) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) username = el.value;
    }
    if (!username && cands[0]) username = cands[0].value;

    return { username, password: pw.value };
  };

  const captureCandidate = () => {
    const creds = collectCredentials();
    if (!creds) return;

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    send({
      type: 'capture:candidate',
      origin: location.origin,
      url: location.href,
      username: creds.username,
      password: creds.password,
    });
  };

  const checkSuccess = () => {
    send({
      type: 'capture:successCheck',
      origin: location.origin,
      url: location.href,
      signals: successSignals(),
    });
  };

  const scheduleSuccessCheck = () => {
    if (Date.now() > successCheckUntil) return;
    clearTimeout(successTimer);
    successTimer = setTimeout(checkSuccess, 250);
  };

  const armSuccessChecks = (windowMs = 15_000) => {
    successCheckUntil = Math.max(successCheckUntil, Date.now() + windowMs);
    for (const delay of CHECK_DELAYS) setTimeout(checkSuccess, delay);
  };

  const loginAction = () => {
    armSuccessChecks();
    captureCandidate();
  };

  document.addEventListener('submit', loginAction, true);
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('button, input[type="submit"], [role="button"]')) loginAction();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') loginAction();
    },
    true,
  );

  new MutationObserver(scheduleSuccessCheck).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'style', 'class', 'hidden', 'autocomplete', 'inputmode'],
  });

  // 新页面加载时检查上一页提交留下的同源候选。
  armSuccessChecks(7000);
})();

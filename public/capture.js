// 登录捕获内容脚本（纯 JS，放在 public/ 以免被 WXT 写进 manifest 的 host_permissions）。
// 只在用户授权过的站点由 background 通过 scripting.registerContentScripts 动态注册。
(() => {
  let lastSent = 0;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const capture = () => {
    const pwFields = Array.from(
      document.querySelectorAll('input[type="password"]'),
    ).filter((el) => el.value && visible(el));
    const pw = pwFields[0];
    if (!pw || !pw.value) return;

    const scope = pw.form || document;
    const cands = Array.from(
      scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
      ),
    ).filter((el) => el.type !== 'password' && el.value);

    let username = '';
    for (const el of cands) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) username = el.value;
    }
    if (!username && cands[0]) username = cands[0].value;

    const now = Date.now();
    if (now - lastSent < 1500) return; // 去抖
    lastSent = now;

    try {
      chrome.runtime.sendMessage(
        {
          type: 'capture:login',
          origin: location.origin,
          url: location.href,
          username,
          password: pw.value,
        },
        () => void chrome.runtime.lastError,
      );
    } catch (e) {
      /* 扩展上下文失效时忽略 */
    }
  };

  const soon = () => setTimeout(capture, 0);

  document.addEventListener('submit', soon, true);
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('button, input[type="submit"], [role="button"]')) soon();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') soon();
    },
    true,
  );
})();

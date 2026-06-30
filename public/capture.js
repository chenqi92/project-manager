// 登录捕获内容脚本（纯 JS，放在 public/ 以免被 WXT 写进 manifest 的 host_permissions）。
// 只在用户授权过的站点由 background 通过 scripting.registerContentScripts 动态注册。
(() => {
  let lastSent = 0;
  let successCheckUntil = 0;
  let successTimer = 0;

  const CHECK_DELAYS = [650, 1600, 3200, 6000];
  const USERNAME_TTL_MS = 10 * 60_000;
  const USERNAME_CACHE_KEY = 'pemLastLoginUsername';

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const passwordFields = () =>
    Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);

  const LOGIN_PAGE_RE = /(login|signin|sign-in|auth|sso|oauth|cas|signup|sign-up|register|registration|create.?account|登录|登陆|认证|注册|创建账号|创建账户)/i;
  const LOGIN_ACTION_RE = /(login|sign in|signin|sign up|signup|register|create.?account|next|continue|submit|登录|登陆|注册|创建账号|创建账户|下一步|继续|确定|提交)/i;
  const SEARCH_CONTEXT_RE = /(search|query|keyword|filter|搜索|查询|筛选|过滤|重置|列表|创建时间|用户管理|部门|状态)/i;

  const fieldText = (el) =>
    [
      el.name,
      el.id,
      el.autocomplete,
      el.inputMode,
      el.placeholder,
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('role') || '',
    ]
      .join(' ')
      .toLowerCase();

  const fieldContextText = (el) => {
    const parts = [fieldText(el), document.title || '', location.href || ''];
    let cur = el;
    for (let i = 0; i < 4 && cur; i++) {
      cur = cur.parentElement;
      if (!cur) break;
      parts.push((cur.textContent || '').slice(0, 360));
      if (/^(form|main|section|article|aside)$/i.test(cur.tagName)) break;
    }
    return parts.join(' ').toLowerCase();
  };

  const looksLikeSearchFilter = (el) => {
    const text = fieldContextText(el);
    if (LOGIN_PAGE_RE.test(text) || LOGIN_ACTION_RE.test(text)) return false;
    if (el.type === 'search') return true;
    return SEARCH_CONTEXT_RE.test(text);
  };

  const usernameFields = () =>
    Array.from(
      document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="search"], input:not([type])',
      ),
    ).filter((el) => {
      if (el.type === 'password' || !visible(el)) return false;
      const text = fieldText(el);
      if (/(search|query|keyword|验证码|验证|code|otp|totp)/i.test(text)) return false;
      if (looksLikeSearchFilter(el)) return false;
      return (
        document.activeElement === el ||
        el.type === 'email' ||
        el.autocomplete === 'username' ||
        el.autocomplete === 'email' ||
        /(user|username|email|account|login|phone|mobile|apple.?id|账号|账户|邮箱|邮件|手机|电话|用户名)/i.test(text)
      );
    });

  const readRememberedUsername = () => {
    try {
      const raw = sessionStorage.getItem(USERNAME_CACHE_KEY);
      if (!raw) return '';
      const saved = JSON.parse(raw);
      if (saved?.origin !== location.origin || Date.now() - Number(saved.ts || 0) > USERNAME_TTL_MS) {
        sessionStorage.removeItem(USERNAME_CACHE_KEY);
        return '';
      }
      return typeof saved.value === 'string' ? saved.value : '';
    } catch {
      return '';
    }
  };

  const rememberUsername = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    try {
      sessionStorage.setItem(
        USERNAME_CACHE_KEY,
        JSON.stringify({ origin: location.origin, value: trimmed, ts: Date.now() }),
      );
    } catch {
      /* ignore private/session storage failures */
    }
  };

  const rememberVisibleUsername = () => {
    const fields = usernameFields().filter((el) => el.value && visible(el));
    const active = fields.find((el) => el === document.activeElement);
    const picked = active || fields[0];
    if (picked) rememberUsername(picked.value);
  };

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

  const passwordFieldText = (el) =>
    [
      el.name,
      el.id,
      el.autocomplete,
      el.placeholder,
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.closest('label')?.textContent || '',
      el.parentElement?.textContent || '',
    ]
      .join(' ')
      .toLowerCase();

  const pickPasswordField = () => {
    const fields = passwordFields().filter((el) => el.value);
    if (!fields.length) return null;
    const negRe = /(confirm|confirmation|repeat|retype|again|确认|重复|再次|二次|校验)/i;
    const oldRe = /(old|current|原密码|旧密码|当前密码)/i;
    return (
      fields.find((el) => {
        const text = passwordFieldText(el);
        return !negRe.test(text) && !oldRe.test(text);
      }) || fields[0]
    );
  };

  const cleanCandidateText = (raw) => {
    let out = String(raw || '').trim();
    for (let i = 0; i < 2; i += 1) {
      try {
        const decoded = decodeURIComponent(out);
        if (decoded === out) break;
        out = decoded;
      } catch {
        break;
      }
    }
    return out.trim();
  };

  const extractOtpauth = (raw) => {
    const text = cleanCandidateText(raw);
    const match = text.match(/otpauth:\/\/[^\s"'<>\\]+/i);
    return match ? match[0].replace(/[),.;]+$/, '') : '';
  };

  const extractBase32Secret = (raw) => {
    const text = cleanCandidateText(raw);
    if (
      !/(totp|otp|authenticator|verification|two.?factor|2fa|mfa|secret|setup.?key|security.?key|密钥|秘钥|验证器|身份验证|两步|二次验证|手动输入|无法扫描)/i.test(
        text,
      )
    )
      return '';
    const matches = text.toUpperCase().match(/[A-Z2-7](?:[A-Z2-7\s-]{14,}[A-Z2-7=])/g) || [];
    for (const m of matches) {
      const clean = m.replace(/[\s-]+/g, '');
      if (/^[A-Z2-7]+=*$/.test(clean) && clean.length >= 16 && /[2-7]/.test(clean)) return clean;
    }
    return '';
  };

  const extractPlainBase32Secret = (raw) => {
    const clean = cleanCandidateText(raw).replace(/[\s-]+/g, '').toUpperCase();
    return /^[A-Z2-7]+=*$/.test(clean) && clean.length >= 16 ? clean : '';
  };

  const extractTotpSecret = () => {
    const attrNames = [
      'href',
      'src',
      'value',
      'data-url',
      'data-uri',
      'data-otpauth',
      'data-secret',
      'aria-label',
      'title',
      'alt',
    ];
    for (const el of Array.from(document.querySelectorAll('a, img, canvas, svg, input, textarea, [data-secret], [data-otpauth], [data-url], [data-uri]'))) {
      if (!visible(el)) continue;
      for (const name of attrNames) {
        const value = name === 'value' ? el.value : el.getAttribute?.(name);
        const otpauth = extractOtpauth(value);
        if (otpauth) return otpauth;
        const base32 = extractBase32Secret(value);
        if (base32) return base32;
      }
    }
    for (const el of Array.from(document.querySelectorAll('main, form, section, article, aside, body'))) {
      if (!visible(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 4000);
      const otpauth = extractOtpauth(text);
      if (otpauth) return otpauth;
      const base32 = extractBase32Secret(text);
      if (base32) return base32;
    }
    return '';
  };

  const extractTotpSecretAsync = async () => {
    const direct = extractTotpSecret();
    if (direct) return direct;
    const Detector = window.BarcodeDetector;
    if (typeof Detector !== 'function') return '';
    let detector = null;
    try {
      detector = new Detector({ formats: ['qr_code'] });
    } catch {
      return '';
    }
    const nodes = Array.from(document.querySelectorAll('img, canvas, video')).filter(visible).slice(0, 8);
    for (const el of nodes) {
      try {
        if (el instanceof HTMLImageElement && !el.complete) continue;
        const codes = await detector.detect(el);
        for (const code of codes || []) {
          const raw = code.rawValue || '';
          const otpauth = extractOtpauth(raw);
          if (otpauth) return otpauth;
          const base32 = extractPlainBase32Secret(raw) || extractBase32Secret(raw);
          if (base32) return base32;
        }
      } catch {
        /* ignore QR images the browser refuses to inspect */
      }
    }
    return '';
  };

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

  const successSignals = async () => {
    const pws = passwordFields();
    return {
      visiblePasswordFields: pws.length,
      filledPasswordFields: pws.filter((el) => el.value).length,
      visibleOtpFields: otpFields().length,
      successHint: hasSuccessHint(),
      totp: await extractTotpSecretAsync(),
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

  const collectCredentials = async () => {
    rememberVisibleUsername();
    const pw = pickPasswordField();
    if (!pw || !pw.value) return null;

    const scope = pw.form || document;
    const cands = usernameFields().filter(
      (el) => (scope === document || scope.contains(el)) && el.value && visible(el),
    );

    let username = '';
    for (const el of cands) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) username = el.value;
    }
    if (!username && cands[0]) username = cands[0].value;
    if (!username) username = readRememberedUsername();
    if (username) rememberUsername(username);

    return { username, password: pw.value, totp: await extractTotpSecretAsync() };
  };

  const captureCandidate = async () => {
    const creds = await collectCredentials();
    if (!creds) return;

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    send({
      type: 'capture:candidate',
      origin: location.origin,
      url: location.href,
      title: document.title || '',
      username: creds.username,
      password: creds.password,
      totp: creds.totp,
    });
  };

  const checkSuccess = async () => {
    send({
      type: 'capture:successCheck',
      origin: location.origin,
      url: location.href,
      title: document.title || '',
      signals: await successSignals(),
    });
  };

  const scheduleSuccessCheck = () => {
    if (Date.now() > successCheckUntil) return;
    clearTimeout(successTimer);
    successTimer = setTimeout(() => void checkSuccess(), 250);
  };

  const armSuccessChecks = (windowMs = 15_000) => {
    successCheckUntil = Math.max(successCheckUntil, Date.now() + windowMs);
    for (const delay of CHECK_DELAYS) setTimeout(() => void checkSuccess(), delay);
  };

  const loginAction = () => {
    rememberVisibleUsername();
    armSuccessChecks();
    void captureCandidate();
  };

  document.addEventListener('input', rememberVisibleUsername, true);
  document.addEventListener('change', rememberVisibleUsername, true);
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
  rememberVisibleUsername();
  armSuccessChecks(7000);
})();

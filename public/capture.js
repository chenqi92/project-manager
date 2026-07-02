// 登录捕获内容脚本（纯 JS，放在 public/ 以免被 WXT 写进 manifest 的 host_permissions）。
// 只在用户授权过的站点由 background 通过 scripting.registerContentScripts 动态注册。
(() => {
  let lastSent = 0;
  let successCheckUntil = 0;
  let successTimer = 0;

  const CHECK_DELAYS = [650, 1600, 3200, 6000];
  const USERNAME_TTL_MS = 10 * 60_000;
  const USERNAME_CAPTURE_CACHE_MS = 90_000;
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
  const FEDERATED_ACTION_RE = /(sign\s*in|log\s*in|login|continue|connect|authorize|auth|sso|oauth|登录|登陆|继续|授权|绑定|关联)/i;
  const FEDERATED_PROVIDERS = [
    ['Google', /\bgoogle\b|谷歌/i],
    ['GitHub', /\bgithub\b/i],
    ['Microsoft', /\bmicrosoft\b|微软|office\s*365|azure/i],
    ['Apple', /\bapple\b|苹果/i],
    ['GitLab', /\bgitlab\b/i],
    ['Slack', /\bslack\b/i],
    ['Discord', /\bdiscord\b/i],
    ['Facebook', /\bfacebook\b|脸书/i],
    ['Twitter', /\btwitter\b|推特/i],
    ['WeChat', /\bwechat\b|微信/i],
    ['DingTalk', /\bdingtalk\b|钉钉/i],
    ['Feishu', /\bfeishu\b|\blark\b|飞书/i],
    ['QQ', /\bqq\b/i],
    ['Solana', /\bsolana\b/i],
  ];

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
        'input[type="text"], input[type="email"], input[type="tel"], input[type="search"], input[type="number"], input[inputmode="numeric"], input:not([type])',
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

  const actionText = (el) =>
    [
      el.textContent || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('href') || '',
      el.value || '',
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  const federatedProviderFromText = (text) => {
    const normalized = String(text || '');
    for (const [name, re] of FEDERATED_PROVIDERS) {
      if (re.test(normalized)) return name;
    }
    return '';
  };

  const federatedLoginAction = (target) => {
    const el = target?.closest?.('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (!el || !visible(el)) return null;
    const text = actionText(el);
    const provider = federatedProviderFromText(text);
    if (!provider || !FEDERATED_ACTION_RE.test(text)) return null;
    return { el, provider };
  };

  const providerAccountName = (provider) => (provider ? `${provider} 登录` : '第三方登录');

  const readRememberedUsername = (maxAgeMs = USERNAME_TTL_MS) => {
    try {
      const raw = sessionStorage.getItem(USERNAME_CACHE_KEY);
      if (!raw) return '';
      const saved = JSON.parse(raw);
      const age = Date.now() - Number(saved.ts || 0);
      if (saved?.origin !== location.origin || age > USERNAME_TTL_MS) {
        sessionStorage.removeItem(USERNAME_CACHE_KEY);
        return '';
      }
      if (age > maxAgeMs) return '';
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

  // 租户 / 企业 / 域字段：多租户登录页在用户名之外的第三个输入框。
  // 识别出来单独捕获，且不再被误当成用户名。
  const TENANT_RE = /(tenant|租户|企业|公司|单位|机构|组织|域名|域账号|登录域|domain|company|corp\b)/i;
  const isTenantField = (el) => TENANT_RE.test(fieldText(el));

  const tenantForPassword = (pw) => {
    const scope = pw.form || document;
    const field = Array.from(
      scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
      ),
    ).find((el) => el.type !== 'password' && el.value && visible(el) && isTenantField(el));
    return field ? field.value : '';
  };

  const captureUsernameFields = (scope) =>
    Array.from(
      scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="search"], input[type="number"], input[inputmode="numeric"], input:not([type])',
      ),
    ).filter((el) => {
      if (el.type === 'password' || !el.value || !visible(el)) return false;
      const text = fieldText(el);
      if (/(search|query|keyword|验证码|验证|code|otp|totp)/i.test(text)) return false;
      if (isTenantField(el)) return false;
      if (looksLikeSearchFilter(el)) return false;
      return true;
    });

  const usernameForPassword = (pw) => {
    const scope = pw.form || document;
    const fields = captureUsernameFields(scope);
    const active = fields.find((el) => el === document.activeElement);
    if (active) return active.value;

    const likely = new Set(usernameFields());
    let username = '';
    let likelyUsername = '';
    for (const el of fields) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) {
        username = el.value;
        if (likely.has(el)) likelyUsername = el.value;
      }
    }
    if (!username && fields[0]) username = fields[0].value;
    return likelyUsername || username || readRememberedUsername(USERNAME_CAPTURE_CACHE_MS);
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

  const TOTP_SETUP_CONTEXT_RE = /(totp|authenticator|two.?factor|2fa|mfa|setup.?key|secret|密钥|秘钥|验证器|两步|二次验证|手动输入|无法扫描)/i;
  const BASE32_SECRET_RE = /(?:[A-Z2-7]{4}[\s-]+){3,}[A-Z2-7]{4}=*|(?:[A-Z2-7]{8}[\s-]+)+[A-Z2-7]{8}=*|[A-Z2-7]{16,}=*/g;

  const extractOtpauth = (raw) => {
    const text = cleanCandidateText(raw);
    const match = text.match(/otpauth:\/\/[^\s"'<>\\]+/i);
    return match ? match[0].replace(/[),.;]+$/, '') : '';
  };

  const normalizeBase32Secret = (raw) => {
    const clean = cleanCandidateText(raw).replace(/[\s-]+/g, '').toUpperCase();
    return /^[A-Z2-7]+=*$/.test(clean) && clean.length >= 16 && /[2-7]/.test(clean)
      ? clean
      : '';
  };

  const extractBase32Secret = (raw) => {
    const text = cleanCandidateText(raw);
    if (!TOTP_SETUP_CONTEXT_RE.test(text)) return '';
    const matches = text.toUpperCase().match(BASE32_SECRET_RE) || [];
    for (const m of matches) {
      const clean = normalizeBase32Secret(m);
      if (clean) return clean;
    }
    return '';
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
    for (const el of Array.from(document.querySelectorAll('label, p, span, div, code, pre, kbd, strong, li'))) {
      if (!visible(el)) continue;
      const ownText = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const parentText = (el.parentElement?.textContent || '').replace(/\s+/g, ' ').trim();
      const text = ownText.length <= 600 ? ownText : parentText.length <= 900 ? parentText : '';
      if (!text) continue;
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
          const base32 = extractBase32Secret(raw);
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

    const username = usernameForPassword(pw);
    if (username) rememberUsername(username);

    return {
      username,
      password: pw.value,
      tenant: tenantForPassword(pw) || undefined,
      totp: await extractTotpSecretAsync(),
    };
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
      tenant: creds.tenant,
      totp: creds.totp,
    });
  };

  const captureFederatedCandidate = async (provider) => {
    const authProvider = String(provider || '').trim();
    if (!authProvider) return;

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    send({
      type: 'capture:candidate',
      origin: location.origin,
      url: location.href,
      title: document.title || '',
      username: providerAccountName(authProvider),
      password: '',
      authProvider,
      totp: await extractTotpSecretAsync(),
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

  const loginAction = (provider) => {
    rememberVisibleUsername();
    armSuccessChecks(provider ? 120_000 : 15_000);
    if (provider) void captureFederatedCandidate(provider);
    else void captureCandidate();
  };

  document.addEventListener('input', rememberVisibleUsername, true);
  document.addEventListener('change', rememberVisibleUsername, true);
  document.addEventListener('submit', () => loginAction(''), true);
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      const federated = federatedLoginAction(t);
      if (federated) {
        loginAction(federated.provider);
        return;
      }
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

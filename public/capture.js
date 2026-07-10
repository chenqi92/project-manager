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

  // auth(?!ors?\b) 放过 author/authors（博客、后台作者管理页）；cas 加词边界避免命中 cascade。
  const LOGIN_PAGE_RE = /(login|signin|sign-in|auth(?!ors?\b)|sso|oauth|openid|\bcas\b|passport|signup|sign-up|register|registration|create.?account|登录|登陆|认证|注册|创建账号|创建账户)/i;
  // 只保留明确的登录/注册动作词。确定/提交/下一步/next/continue/submit 这类词任何
  // CRUD 表单都有，曾把后台管理表单整体判成登录上下文（保存提示误弹的主因之一）。
  const LOGIN_ACTION_RE = /(login|log in|sign in|signin|sign up|signup|register|create.?account|登录|登陆|注册|创建账号|创建账户)/i;
  const SEARCH_CONTEXT_RE = /(search|query|keyword|filter|搜索|查询|筛选|过滤|重置|列表|创建时间|用户管理|部门|状态|新增|新建|添加|编辑|删除|导出|导入|批量|操作)/i;
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
    // 不再混入 document.title / location.href：后台管理系统的标题（「XX 管理平台」）和
    // URL（/admin/auth/users、?status=…）会让整页所有输入框的上下文都命中登录词，
    // 是表单被误判成登录的最大来源。页面级信号单独走 pageLoginContext()。
    const parts = [fieldText(el)];
    let cur = el;
    for (let i = 0; i < 4 && cur; i++) {
      cur = cur.parentElement;
      if (!cur) break;
      parts.push((cur.textContent || '').slice(0, 360));
      if (/^(form|main|section|article|aside)$/i.test(cur.tagName)) break;
    }
    return parts.join(' ').toLowerCase();
  };

  // 页面级登录上下文：只看标题、主机名、路径末段和 hash 路由末段。
  // 不看完整 URL —— 中间路径 / 查询串常带 auth、state 等误导词。
  const pageLoginContext = () => {
    const segs = (location.pathname || '').split('/').filter(Boolean);
    const hashSegs = (location.hash || '').split(/[/?]/).filter(Boolean);
    return LOGIN_PAGE_RE.test(
      `${document.title || ''} ${location.hostname || ''} ${segs[segs.length - 1] || ''} ${hashSegs[hashSegs.length - 1] || ''}`,
    );
  };

  const looksLikeSearchFilter = (el) => {
    const text = fieldContextText(el);
    if (LOGIN_PAGE_RE.test(text) || LOGIN_ACTION_RE.test(text) || pageLoginContext()) return false;
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

  const actionText = (el) => {
    const parts = [
      el.textContent || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('href') || '',
      el.value || '',
    ];
    // 纯图标按钮：提供商名往往只在 img 的 alt/title 或 svg 的 <title> 里。
    if (el.querySelectorAll) {
      for (const media of el.querySelectorAll('img[alt], img[title], svg title, [aria-label]')) {
        if (media.tagName.toLowerCase() === 'title') parts.push(media.textContent || '');
        else
          parts.push(
            media.getAttribute('alt') || '',
            media.getAttribute('title') || '',
            media.getAttribute('aria-label') || '',
          );
      }
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

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
  const TENANT_RE = /(tenant|租户|企业|公司|单位|机构|组织|域名|域账号|登录域|domain|company|corp\b|\borg)/i;
  const isTenantField = (el) =>
    TENANT_RE.test(`${fieldText(el)} ${(el.closest && el.closest('label')?.textContent) || ''}`);

  const tenantForPassword = (pw) => {
    const scope = pw.form || document;
    // 租户编码常是数字输入框（type=number / inputmode=numeric），一并纳入。
    const input = Array.from(
      scope.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[inputmode="numeric"], input:not([type])',
      ),
    ).find((el) => el.type !== 'password' && el.value && visible(el) && isTenantField(el));
    if (input) return input.value;
    // 单位 / 租户为下拉框的系统：取选中项的 value。
    const select = Array.from(scope.querySelectorAll('select')).find(
      (el) => el.value && visible(el) && isTenantField(el),
    );
    return select ? select.value : '';
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

  // OTP 识别拆成三层：强词直接算；code/token/verify 这类泛词（会命中邀请码、API token、
  // author 等）必须同时长得像短验证码输入框；明确的非 OTP「码」类字段整体排除。
  const OTP_STRONG_RE = /(otp|totp|\bmfa\b|\b2fa\b|one.?time|authenticator|验证码|校验码|动态码|动态口令|短信码|(verification|security|auth|sms|email)[\s_-]?code)/i;
  const OTP_WEAK_RE = /(code\b|token\b|verif|验证|口令)/i;
  const OTP_EXCLUDE_RE = /(invite|referr|promo|coupon|discount|gift|redeem|activation|serial|zip|postal|country|barcode|qrcode|邀请|推荐|优惠|折扣|兑换|激活|序列|卡密|区号|邮编|提取码|访问码|条码|二维码)/i;
  const otpNumericish = (el) =>
    el.inputMode === 'numeric' ||
    el.type === 'tel' ||
    el.type === 'number' ||
    (Number(el.maxLength) > 0 && Number(el.maxLength) <= 8);

  const otpFields = () =>
    Array.from(document.querySelectorAll('input:not([type="password"]):not([type="hidden"])')).filter((el) => {
      if (!visible(el)) return false;
      if (el.autocomplete === 'one-time-code') return true;
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
      if (OTP_EXCLUDE_RE.test(text)) return false;
      if (OTP_STRONG_RE.test(text)) return true;
      return OTP_WEAK_RE.test(text) && otpNumericish(el);
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

  // 修改/设置自己密码的上下文：即使已登录也要捕获（这是合法的「更新密码」场景）。
  const CHANGE_PW_CONTEXT_RE = /(修改密码|更改密码|重置密码|设置密码|找回密码|忘记密码|新密码|change.?password|reset.?password|update.?password|set.?password|new.?password|forgot)/i;
  // 管理后台替别人建号/改资料的表单：密码框不当作本人登录凭据。
  // 「创建账号/账户」不在此列——那是 LOGIN_PAGE_RE 里的注册场景。
  const NON_LOGIN_FORM_RE = /((新增|新建|添加|编辑|修改|邀请|创建)\s*(用户|成员|员工|人员|管理员)|(新增|新建|添加|编辑|修改|邀请)\s*(账号|账户)|用户管理|成员管理|账号管理|人员管理|(add|create|new|edit|invite)\s+(a\s+)?(user|member|employee|admin)|user\s+management)/i;

  // 密码框所在的弹窗容器 / 表单。优先弹窗：管理后台的「新增用户」标题通常在
  // dialog 里、form 外，取 form 作用域会漏掉这个关键判据。
  const passwordFormScope = (el) =>
    (el.closest &&
      el.closest('[role="dialog"], dialog, .modal, .el-dialog, .ant-modal, .arco-modal, .layui-layer')) ||
    el.form ||
    null;

  // 密码框是否属于「本人登录/注册/改密」而非后台 CRUD 表单：
  // 1. 改密上下文直接放行；2. 建号/资料类表单、含 textarea 或控件过多的表单排除；
  // 3. 字段周边有登录/注册文案放行；4. 其余按「页面是否已登录」判断——
  //    未登录页面上的密码框几乎都是登录/注册，已登录页面上的多是后台内部表单。
  const passwordLooksLoginRelated = (el) => {
    const ctx = fieldContextText(el);
    if (CHANGE_PW_CONTEXT_RE.test(ctx)) return true;
    const scope = passwordFormScope(el);
    if (scope) {
      if (NON_LOGIN_FORM_RE.test(`${ctx} ${(scope.textContent || '').slice(0, 600)}`)) return false;
      if (scope.querySelector('textarea')) return false;
      const controls = Array.from(scope.querySelectorAll('input, select')).filter(
        (c) => c.type !== 'hidden' && visible(c),
      );
      if (controls.length > 8) return false;
    } else if (NON_LOGIN_FORM_RE.test(ctx)) {
      return false;
    }
    if (LOGIN_PAGE_RE.test(ctx) || LOGIN_ACTION_RE.test(ctx) || pageLoginContext()) return true;
    return !pageLoggedIn();
  };

  const pickPasswordField = () => {
    const fields = passwordFields().filter((el) => el.value && passwordLooksLoginRelated(el));
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

  // 强 2FA 绑定上下文：出现这些词才认为页面在展示验证器密钥。
  const TOTP_SETUP_CONTEXT_RE = /(totp|authenticator|two.?factor|2fa|mfa|setup.?key|otp.?secret|验证器|两步验证|二次验证|双重验证|动态口令|谷歌验证|无法扫描)/i;
  // 弱上下文：secret / 密钥也大量出现在图形验证码地址、API 密钥表格等场景，
  // 需页面同时出现强上下文才作数。
  const TOTP_WEAK_CONTEXT_RE = /(secret|密钥|秘钥|手动输入)/i;
  // 图形 / 算式 / 滑动验证码：一次性人机校验，不是 TOTP，出现即排除。
  const CAPTCHA_CONTEXT_RE = /(captcha|图形验证|图片验证|滑动验证|拼图|算式|请计算|计算结果|看不清|换一张|点击刷新)/i;
  const BASE32_SECRET_RE = /(?:[A-Z2-7]{4}[\s-]+){3,}[A-Z2-7]{4}=*|(?:[A-Z2-7]{8}[\s-]+)+[A-Z2-7]{8}=*|[A-Z2-7]{16,}=*/g;

  let totpPageHint = false;
  let totpPageHintAt = 0;
  const pageTotpSetupContext = () => {
    const now = Date.now();
    if (now - totpPageHintAt < 2000) return totpPageHint;
    totpPageHintAt = now;
    const sample = `${document.title || ''} ${(document.body?.textContent || '').slice(0, 30000)}`;
    totpPageHint = TOTP_SETUP_CONTEXT_RE.test(sample);
    return totpPageHint;
  };

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
    if (CAPTCHA_CONTEXT_RE.test(text)) return '';
    if (
      !TOTP_SETUP_CONTEXT_RE.test(text) &&
      !(TOTP_WEAK_CONTEXT_RE.test(text) && pageTotpSetupContext())
    ) {
      return '';
    }
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

  // hasSuccessHint 要扫最多 220 个按钮（含布局读取），点击/回车都会走到 → 加 2 秒缓存。
  let loggedInHint = false;
  let loggedInHintAt = 0;
  const pageLoggedIn = () => {
    const now = Date.now();
    if (now - loggedInHintAt < 2000) return loggedInHint;
    loggedInHintAt = now;
    loggedInHint = hasSuccessHint();
    return loggedInHint;
  };

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

  const captureCandidate = async () => {
    rememberVisibleUsername();
    const pw = pickPasswordField();
    if (!pw || !pw.value) return;

    const username = usernameForPassword(pw);
    if (username) rememberUsername(username);

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    const candidate = {
      type: 'capture:candidate',
      origin: location.origin,
      url: location.href,
      title: document.title || '',
      username,
      password: pw.value,
      tenant: tenantForPassword(pw) || undefined,
    };
    // 先把凭据发出去：提交后页面随时可能跳转销毁本脚本，等 TOTP 扫描
    //（含 BarcodeDetector 逐图识别，可能数百毫秒）完成再发会整条丢失。
    send(candidate);
    const totp = await extractTotpSecretAsync();
    if (totp) send({ ...candidate, totp });
  };

  const captureFederatedCandidate = async (provider) => {
    const authProvider = String(provider || '').trim();
    if (!authProvider) return;

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    const candidate = {
      type: 'capture:candidate',
      origin: location.origin,
      url: location.href,
      title: document.title || '',
      username: providerAccountName(authProvider),
      password: '',
      authProvider,
    };
    send(candidate);
    const totp = await extractTotpSecretAsync();
    if (totp) send({ ...candidate, totp });
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

  // 疑似第三方登录授权页（OAuth / OIDC / CAS）：把地址报给 background 做权威解析，
  // 由它为发起登录的站点建立候选。这里只做零成本预筛，避免每个页面都发消息。
  const maybeReportOAuthNav = () => {
    try {
      if (window.top !== window) return; // 授权页都是顶层导航 / 弹窗
    } catch {
      return;
    }
    const q = location.search || '';
    if (q.length < 12) return;
    const hasClientId = /[?&](client_id|appid|app_id)=/i.test(q);
    const hasRedirect = /[?&](redirect_uri|redirect_url|redirect_to|oauth_callback|return_url|return_to)=/i.test(q);
    const casLike =
      /[?&]service=https?(%3a%2f%2f|:\/\/)/i.test(q) && /\/login\/?$/i.test(location.pathname);
    const googleLike =
      /(^|\.)accounts\.google\.com$/i.test(location.hostname) && /[?&](origin|continue|client_id)=/i.test(q);
    if (!(hasClientId && hasRedirect) && !casLike && !googleLike) return;
    send({ type: 'capture:oauthNav', url: location.href });
  };

  // 弹窗式第三方授权里站点页面不跳转：background 检测到授权页后，
  // 通知发起站点的标签页延长成功检测窗口，授权完成即可弹出保存提示。
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'capture:armSuccess') {
        armSuccessChecks(Math.min(Number(msg.windowMs) || 120_000, 300_000));
      }
    });
  } catch {
    /* 扩展上下文失效时忽略 */
  }

  document.addEventListener('input', rememberVisibleUsername, true);
  document.addEventListener('change', rememberVisibleUsername, true);
  document.addEventListener('submit', () => loginAction(''), true);
  document.addEventListener(
    'click',
    (e) => {
      // shadow DOM 里的点击会被重定位到宿主：用 composedPath 拿到真实目标。
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const t = path[0] && path[0].nodeType === 1 ? path[0] : e.target;
      // 已登录页面上的「绑定 GitHub / 关联微信」是账号绑定而不是登录，跳过第三方登录捕获。
      const federated = pageLoggedIn() ? null : federatedLoginAction(t);
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
  maybeReportOAuthNav();
})();

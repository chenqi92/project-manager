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
  let dismissedPendingKey = '';
  let capturePrompt = null;
  let captureMode = 'new';
  let selectedUpdateId = '';
  let captureDraft = null;
  let targetDropdownOpen = false;
  let workspaceDropdownOpen = false;
  let refreshTimer = 0;
  let lastSent = 0;
  let successCheckUntil = 0;
  let successTimer = 0;
  let lockedPrompt = false;
  let lockedCandidate = null;
  let unlockPoll = 0;
  let lastUnlockRetry = 0;
  let autoTotpBusy = false;
  let lastAutoTotp = { accountId: '', at: 0 };

  const CHECK_DELAYS = [650, 1600, 3200, 6000];
  const USERNAME_TTL_MS = 10 * 60_000;
  const USERNAME_CAPTURE_CACHE_MS = 90_000;
  const USERNAME_CACHE_KEY = 'pemLastLoginUsername';

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

  // 助手消息（匹配/填充）统一带上页面实时完整地址：后台据此做 path-prefix/exact-url 匹配，
  // 与登录捕获用的 location.href 保持一致，避免「访问不弹提示、保存却能合并」的不一致。
  const sendAssist = (msg) => send({ ...msg, url: location.href });

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const passwordFields = () =>
    Array.from(document.querySelectorAll('input[type="password"]')).filter(
      (el) => el.value !== undefined && visible(el),
    );

  // auth(?!ors?\b) 放过 author/authors（博客、后台作者管理页）；cas 加词边界避免命中 cascade。
  const LOGIN_PAGE_RE = /(login|signin|sign-in|auth(?!ors?\b)|sso|oauth|openid|\bcas\b|passport|signup|sign-up|register|registration|create.?account|登录|登陆|认证|注册|创建账号|创建账户)/i;
  // 只保留明确的登录/注册动作词。确定/提交/下一步/next/continue/submit 这类词任何
  // CRUD 表单都有，曾把后台管理表单整体判成登录上下文（保存/填充提示误弹的主因之一）。
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

  const fieldLoginContext = (el) => {
    const text = fieldContextText(el);
    return LOGIN_PAGE_RE.test(text) || LOGIN_ACTION_RE.test(text) || pageLoginContext();
  };

  const loginUsernameFields = () => {
    const fields = usernameFields().filter((el) => {
      if (el.autocomplete === 'username' || el.autocomplete === 'email' || el.type === 'email') return true;
      const text = fieldContextText(el);
      if (SEARCH_CONTEXT_RE.test(text) && !LOGIN_PAGE_RE.test(text)) return false;
      return fieldLoginContext(el);
    });
    // 已登录页面（有退出/注销入口）上的邮箱/用户名输入框多是资料、成员管理表单，
    // 不是登录第一步；除非该字段周边有明确的登录/注册文案。
    if (fields.length && pageLoggedIn()) return fields.filter(fieldLoginContext);
    return fields;
  };

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

  const loginPasswordFields = () => passwordFields().filter(passwordLooksLoginRelated);

  const pickPasswordField = () => {
    const fields = loginPasswordFields().filter((el) => el.value);
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
    // data:/blob: 资源（滑块验证码拼图、内嵌图片等）的 base64 里必然出现 16+ 位
    // A-Z2-7 连续串，且可能随机撞上 2fa/mfa 等上下文词（CAPTCHA 排除词在 base64 里
    // 反而永远不会出现）→ 按 URI 前缀整类排除；真实密钥不会以资源地址形式展示。
    if (/^(?:data|blob):/i.test(text)) return '';
    // 展示给人手动抄写的密钥都是短文本；超长文本只会是脚本或编码载荷。
    if (text.length > 2048) return '';
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

  // hasSuccessHint 要扫最多 220 个按钮（含布局读取），surfaceKind 每次渲染都会间接
  // 用到它 → 加 2 秒缓存（与 pageTotpSetupContext 同款）。
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

  const surfaceKind = () => {
    // 只有「像本人登录」的密码框才算登录页面：后台建号/资料表单的密码框不再触发横幅。
    if (loginPasswordFields().length > 0) return 'password';
    if (otpFields().length > 0) return 'otp';
    if (loginUsernameFields().length > 0) return 'username';
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

  // ---- 自动提交防循环 ----------------------------------------------------
  // 有些站点点了登录才弹出滑动验证码 / 二次校验：自动提交那一刻页面上还没有验证码元素，
  // 填充函数无从识别，点击后被拦下、页面刷新清空，再自动提交又被拦下 …… 形成死循环。
  // 这里记录每个来源是否「需手动完成验证后再提交」，命中后横幅只填充不再自动提交。
  const AUTO_SUBMIT_KEY = 'pemAutoSubmitAt';
  const MANUAL_SUBMIT_KEY = 'pemManualSubmitOrigins';

  const manualSubmitRequired = () => {
    try {
      const raw = sessionStorage.getItem(MANUAL_SUBMIT_KEY);
      return raw ? JSON.parse(raw).includes(location.origin) : false;
    } catch {
      return false;
    }
  };

  const markManualSubmit = () => {
    try {
      const list = JSON.parse(sessionStorage.getItem(MANUAL_SUBMIT_KEY) || '[]');
      if (!list.includes(location.origin)) {
        list.push(location.origin);
        sessionStorage.setItem(MANUAL_SUBMIT_KEY, JSON.stringify(list));
      }
    } catch {
      /* ignore private/session storage failures */
    }
  };

  const clearAutoSubmitMark = () => {
    try {
      sessionStorage.removeItem(AUTO_SUBMIT_KEY);
    } catch {
      /* ignore */
    }
  };

  // 页面上是否出现了可见的验证码 / 人机校验（滑块、图形码、geetest/recaptcha 等）。
  const CHALLENGE_RE =
    /(captcha|recaptcha|hcaptcha|turnstile|geetest|slider|swipe|slide|drag|验证码|校验码|图形码|滑块|滑动|拖动|拖拽|向右滑|人机验证|安全验证)/i;
  const verificationChallengeVisible = () =>
    Array.from(
      document.querySelectorAll(
        'iframe, img, canvas, svg, [class], [id], [aria-label], [title], [data-sitekey]',
      ),
    ).some((el) => {
      if (!visible(el)) return false;
      const t = [
        el.getAttribute('id') || '',
        el.getAttribute('class') || '',
        el.getAttribute('src') || '',
        el.getAttribute('alt') || '',
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('data-sitekey') || '',
      ]
        .join(' ')
        .toLowerCase();
      return CHALLENGE_RE.test(t);
    });

  // 自动提交后仍停留在带可见密码框的登录页、且页面上出现了验证码/人机校验 = 被「点击后才弹出的
  // 滑动验证码 / 二次校验」拦下。记下该来源，之后只填充不再自动提交，避免反复弹验证码 / 刷新。
  // 返回是否新标记了该来源（用于决定是否需要重渲染横幅）。
  const guardAutoSubmitLoop = () => {
    let stamp = null;
    try {
      stamp = JSON.parse(sessionStorage.getItem(AUTO_SUBMIT_KEY) || 'null');
    } catch {
      stamp = null;
    }
    if (!stamp || stamp.origin !== location.origin) return false;
    const age = Date.now() - Number(stamp.ts || 0);
    if (age > 8000) {
      clearAutoSubmitMark();
      return false;
    }
    if (age < 1500) return false; // 留出成功跳转离开登录页的时间，避免误判
    if (passwordFields().length === 0) return false; // 已离开登录页（含进入 OTP 步骤），不算失败
    if (!verificationChallengeVisible()) return false; // 没弹验证码/人机校验，多半只是登录耗时，不降级
    if (manualSubmitRequired()) {
      clearAutoSubmitMark();
      return false;
    }
    markManualSubmit();
    clearAutoSubmitMark();
    return true;
  };

  // ---- 多步登录自动续填（全自动串联）----------------------------------------
  // 用户在第一步点了「登录/下一步」后，记下「这是一次自动登录流程」；之后每出现新的一步
  //（账号→密码→验证码），在「同主域、无验证码、未超时/步数」时自动填充并前进，直到登录完成
  // 或被验证码/异常拦下。流程存在 sessionStorage 里，可跨「分步导航到不同 URL」延续。
  const FLOW_KEY = 'pemAutoFlow';
  const FLOW_TTL_MS = 90_000;
  const FLOW_MAX_STEPS = 6;
  const FLOW_MIN_GAP_MS = 900;

  // 取可注册域(eTLD+1)，用于「这一步是否还属于同一次登录流程」的同主域判断。
  const siteOf = (host) => {
    const h = (host || '').toLowerCase().replace(/\.$/, '');
    if (!h || h.includes(':') || /^\d+(\.\d+){3}$/.test(h) || h === 'localhost') return h;
    const p = h.split('.');
    if (p.length <= 2) return h;
    const two = new Set([
      'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
      'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
      'com.hk', 'com.tw', 'com.sg', 'com.au', 'co.nz', 'co.jp', 'com.jp',
    ]);
    return two.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
  };

  const autoFlowEnabled = () => snapshot?.autoFlow !== false;

  const clearFlow = () => {
    try {
      sessionStorage.removeItem(FLOW_KEY);
    } catch {
      /* ignore */
    }
  };
  const writeFlow = (f) => {
    try {
      sessionStorage.setItem(FLOW_KEY, JSON.stringify(f));
    } catch {
      /* ignore */
    }
  };
  const readFlow = () => {
    try {
      const f = JSON.parse(sessionStorage.getItem(FLOW_KEY) || 'null');
      if (!f) return null;
      if (Date.now() - Number(f.ts || 0) > FLOW_TTL_MS) {
        clearFlow();
        return null;
      }
      return f;
    } catch {
      return null;
    }
  };

  // 用户在某一步点了会前进的动作（登录/下一步）时武装流程。snapshot 此时已加载。
  const armAutoFlow = (accountId) => {
    if (!accountId || !autoFlowEnabled()) return;
    writeFlow({
      accountId,
      site: siteOf(location.hostname),
      ts: Date.now(),
      step: 1,
      lastSurface: surfaceKind(),
      lastActionAt: Date.now(),
    });
  };

  let flowBusy = false;
  let flowRetryTimer = 0;
  // 检测到新的一步就自动填充并前进。各处「快照刷新 / DOM 变动」后调用。
  const maybeAutoContinue = async () => {
    if (flowBusy) return;
    const flow = readFlow();
    if (!flow) return;
    if (dismissed || snapshot?.muted) {
      clearFlow();
      return;
    }
    if (siteOf(location.hostname) !== flow.site) {
      clearFlow(); // 跳到他站（非同主域），停止，避免把凭据自动填到意外的地方
      return;
    }
    if (Number(flow.step || 1) >= FLOW_MAX_STEPS) {
      clearFlow();
      return;
    }
    const sinceAction = Date.now() - Number(flow.lastActionAt || 0);
    if (sinceAction < FLOW_MIN_GAP_MS) {
      // 距上一步动作太近：下一步（如密码框）可能已经出现但落在最小间隔内被跳过。
      // 安排一次补检，避免 DOM 恰好在门槛前静止、之后再无触发导致停在这一步不前进。
      clearTimeout(flowRetryTimer);
      flowRetryTimer = setTimeout(() => void maybeAutoContinue(), FLOW_MIN_GAP_MS - sinceAction + 60);
      return;
    }

    if (hasSuccessHint()) {
      clearFlow(); // 出现「退出登录/注销」等 → 已登录，结束流程（避免误填登录后页面的输入框）
      return;
    }
    const surface = surfaceKind();
    if (surface === 'none') return;
    if (surface === flow.lastSurface) return; // 还停在同一步，别重复填
    // 出现验证码/人机校验，或该来源已被判定需手动 → 暂停自动续填，交给用户处理
    if (verificationChallengeVisible() || manualSubmitRequired()) return;
    // 当前页必须匹配到该账号（背景还会按精确 origin 再校验一次）
    if (!snapshot?.matches?.some((m) => m.accountId === flow.accountId)) return;

    flow.lastSurface = surface;
    flow.step = Number(flow.step || 1) + 1;
    flow.lastActionAt = Date.now();
    writeFlow(flow);

    flowBusy = true;
    try {
      if (surface === 'username') {
        await sendAssist({ type: 'assist:fillUsername', accountId: flow.accountId, submit: true });
      } else if (surface === 'password') {
        await sendAssist({ type: 'assist:fill', accountId: flow.accountId, submit: true });
        // 密码是多数登录的最后一步：账号没存 TOTP 时，提交密码即完成本次登录，
        // 立刻清掉流程，避免它残留到登录成功 / 注销回到登录页后再次自动登录（死循环）。
        const expectsOtp = snapshot.matches.some((m) => m.accountId === flow.accountId && m.hasTotp);
        if (!expectsOtp) clearFlow();
      } else if (surface === 'otp') {
        const hasTotp = snapshot.matches.some((m) => m.accountId === flow.accountId && m.hasTotp);
        if (!hasTotp) {
          clearFlow(); // 没存 TOTP（短信码等）→ 交给用户输入
          return;
        }
        await sendAssist({ type: 'assist:fillTotp', accountId: flow.accountId, submit: true });
        clearFlow(); // OTP 是最后一步，提交后结束流程，避免残留触发再次自动登录
      }
    } catch {
      clearFlow(); // 背景拒绝（来源不匹配等）→ 停止
    } finally {
      flowBusy = false;
    }
    if (!capturePrompt) render(); // 捕获弹窗编辑中不重建 DOM（同 scheduleRefresh）
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

  const focusedOtpField = () => {
    const active = document.activeElement;
    if (!active || active.tagName !== 'INPUT') return null;
    return otpFields().includes(active) ? active : null;
  };

  const focusedTotpMatch = () => {
    const matches = (snapshot?.matches || []).filter((m) => m.hasTotp);
    if (!matches.length) return null;
    const preferred = preferredId();
    if (preferred) {
      const chosen = matches.find((m) => m.accountId === preferred);
      if (chosen) return chosen;
    }
    return matches.length === 1 ? matches[0] : null;
  };

  const maybeAutoFillFocusedTotp = async () => {
    if (autoTotpBusy || dismissed || capturePrompt || snapshot?.locked || snapshot?.muted || !snapshot?.enabled)
      return;
    if (surfaceKind() !== 'otp') return;
    const field = focusedOtpField();
    if (!field || String(field.value || '').trim().length >= 6) return;
    const match = focusedTotpMatch();
    if (!match) return;
    const now = Date.now();
    if (lastAutoTotp.accountId === match.accountId && now - lastAutoTotp.at < 25_000) return;
    lastAutoTotp = { accountId: match.accountId, at: now };
    autoTotpBusy = true;
    try {
      await sendAssist({ type: 'assist:fillTotp', accountId: match.accountId, submit: false });
      remember(match.accountId);
      render('验证码已填充');
    } catch {
      // 聚焦自动填充不打断用户手动输入。
    } finally {
      autoTotpBusy = false;
    }
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
    // 浮层内的键鼠事件会被重定位到宿主元素继续冒泡进页面：大屏/地图类站点常有全局
    // keydown（快捷键 preventDefault）、mousedown/click（点击聚焦画布）处理器，会抢走
    // 焦点或吞掉输入。在 shadow root 上截断冒泡，浮层交互不影响页面，页面也收不到。
    for (const type of [
      'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change',
      'compositionstart', 'compositionupdate', 'compositionend',
      'paste', 'copy', 'cut',
      'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'contextmenu', 'wheel', 'touchstart', 'touchend',
    ]) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    document.documentElement.appendChild(host);
    return root;
  };

  const placeRoot = (modal) => {
    if (!host) return;
    const placement = snapshot?.capturePromptPlacement || 'top-right';
    host.style.top = modal ? '0' : '12px';
    host.style.bottom = modal ? '0' : '';
    host.style.alignItems = modal && placement === 'center' ? 'center' : 'flex-start';
    host.style.justifyContent = modal && placement === 'top-right' ? 'flex-end' : 'center';
    host.style.padding = modal ? '14px 18px' : '0';
    host.style.boxSizing = 'border-box';
    const modalWidth = capturePrompt
      ? placement === 'top-right'
        ? '430px'
        : '640px'
      : placement === 'top-right'
        ? '520px'
        : '720px';
    host.style.setProperty('--pem-modal-width', modalWidth);
  };

  const destroy = () => {
    clearInterval(unlockPoll);
    unlockPoll = 0;
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
    .modal {
      --pem-modal-bg: #202124;
      --pem-modal-text: #f8fafc;
      --pem-modal-muted: #94a3b8;
      --pem-modal-subtle: #cbd5e1;
      --pem-modal-border: rgba(148, 163, 184, .42);
      --pem-modal-shadow: rgba(0, 0, 0, .38);
      --pem-modal-inset: rgba(255, 255, 255, .05);
      --pem-panel-bg: rgba(15, 23, 42, .34);
      --pem-field-bg: rgba(15, 23, 42, .48);
      --pem-item-bg: rgba(255, 255, 255, .045);
      --pem-item-hover: rgba(255, 255, 255, .075);
      --pem-selected-bg: rgba(13, 110, 253, .22);
      --pem-selected-border: rgba(96, 165, 250, .55);
      --pem-seg-bg: #323334;
      --pem-seg-active-bg: #737373;
      --pem-secondary-bg: rgba(255, 255, 255, .08);
      --pem-radio-border: #737b89;
      --pem-scroll-thumb: rgba(148, 163, 184, .72);
      --pem-scroll-thumb-hover: rgba(203, 213, 225, .9);
      --pem-lock-bg: rgba(37, 99, 235, .28);
      --pem-lock-text: #bfdbfe;
      --pem-lock-muted: #dbeafe;
      --pem-lock-icon-bg: rgba(147, 197, 253, .2);
      --pem-lock-icon: #93c5fd;
      pointer-events: auto;
      width: min(var(--pem-modal-width, 760px), calc(100vw - 28px));
      max-height: min(720px, calc(100vh - 28px));
      overflow: hidden;
      border: 1px solid var(--pem-modal-border);
      border-radius: 18px;
      background: var(--pem-modal-bg);
      color: var(--pem-modal-text);
      box-shadow: 0 24px 70px var(--pem-modal-shadow), 0 0 0 1px var(--pem-modal-inset) inset;
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .modal.theme-light {
      --pem-modal-bg: rgba(255, 255, 255, .985);
      --pem-modal-text: #111827;
      --pem-modal-muted: #64748b;
      --pem-modal-subtle: #475569;
      --pem-modal-border: rgba(148, 163, 184, .34);
      --pem-modal-shadow: rgba(15, 23, 42, .18);
      --pem-modal-inset: rgba(255, 255, 255, .72);
      --pem-panel-bg: #f8fafc;
      --pem-field-bg: #f8fafc;
      --pem-item-bg: #f1f5f9;
      --pem-item-hover: #eaf0f8;
      --pem-selected-bg: rgba(13, 148, 136, .12);
      --pem-selected-border: rgba(20, 184, 166, .48);
      --pem-seg-bg: #eef2f7;
      --pem-seg-active-bg: #ffffff;
      --pem-secondary-bg: #f8fafc;
      --pem-radio-border: #94a3b8;
      --pem-scroll-thumb: rgba(100, 116, 139, .46);
      --pem-scroll-thumb-hover: rgba(71, 85, 105, .7);
      --pem-lock-bg: #eff6ff;
      --pem-lock-text: #1d4ed8;
      --pem-lock-muted: #475569;
      --pem-lock-icon-bg: #dbeafe;
      --pem-lock-icon: #2563eb;
      color-scheme: light;
    }
    .modal.theme-dark { color-scheme: dark; }
    .modal-head {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 20px 24px 16px;
    }
    .modal-title {
      flex: 1;
      font-size: 22px;
      line-height: 28px;
      font-weight: 800;
    }
    .modal-close {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      color: var(--pem-modal-subtle);
      background: transparent;
      font-size: 26px;
      padding: 0;
    }
    .modal-body {
      padding: 0 28px 18px;
      overflow: auto;
      max-height: min(560px, calc(100vh - 190px));
      scrollbar-width: thin;
      scrollbar-color: var(--pem-scroll-thumb) transparent;
    }
    .modal-body::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .modal-body::-webkit-scrollbar-track {
      background: transparent;
    }
    .modal-body::-webkit-scrollbar-thumb {
      border: 2px solid transparent;
      border-radius: 999px;
      background: var(--pem-scroll-thumb);
      background-clip: content-box;
    }
    .modal-body::-webkit-scrollbar-thumb:hover {
      background: var(--pem-scroll-thumb-hover);
      background-clip: content-box;
    }
    .seg {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      border-radius: 13px;
      background: var(--pem-seg-bg);
      padding: 4px;
      margin-bottom: 18px;
    }
    .seg button {
      height: 42px;
      border-radius: 10px;
      color: var(--pem-modal-muted);
      background: transparent;
      font-size: 15px;
    }
    .seg button.active {
      background: var(--pem-seg-active-bg);
      color: var(--pem-modal-text);
      box-shadow: 0 1px 0 rgba(255, 255, 255, .18) inset, 0 8px 22px rgba(0, 0, 0, .14);
    }
    .capture-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 14px;
      color: var(--pem-modal-subtle);
      font-size: 13px;
    }
    .pill {
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border-radius: 999px;
      background: rgba(20, 184, 166, .16);
      color: #99f6e4;
      padding: 5px 10px;
      font-weight: 700;
    }
    .modal.theme-light .pill {
      border: 1px solid rgba(13, 148, 136, .18);
      background: rgba(13, 148, 136, .1);
      color: #0f766e;
    }
    .capture-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .capture-item {
      display: grid;
      grid-template-columns: 44px 1fr 28px;
      align-items: center;
      gap: 12px;
      border: 1px solid transparent;
      border-radius: 14px;
      padding: 10px 12px;
      cursor: pointer;
    }
    .capture-item:hover { background: var(--pem-item-hover); }
    .capture-item.selected {
      border-color: var(--pem-selected-border);
      background: var(--pem-selected-bg);
    }
    .capture-avatar {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: #b7e4d4;
      color: #315b54;
      font-size: 16px;
      font-weight: 900;
    }
    .capture-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 16px;
      font-weight: 760;
      line-height: 21px;
    }
    .capture-user {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--pem-modal-muted);
      font-size: 13px;
      line-height: 18px;
    }
    .radio {
      width: 20px;
      height: 20px;
      border-radius: 999px;
      border: 2px solid var(--pem-radio-border);
      box-sizing: border-box;
    }
    .selected .radio {
      border: 6px solid #2680eb;
      background: #fff;
    }
    .new-box {
      border: 1px solid var(--pem-modal-border);
      border-radius: 14px;
      background: var(--pem-panel-bg);
      padding: 14px;
    }
    .new-row {
      display: grid;
      grid-template-columns: 92px 1fr;
      gap: 10px;
      padding: 6px 0;
      font-size: 13px;
    }
    .new-label { color: var(--pem-modal-muted); }
    .new-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--pem-modal-text);
      font-weight: 700;
    }
    .field-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin: 12px 0 14px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field label {
      color: var(--pem-modal-muted);
      font-size: 12px;
      font-weight: 700;
    }
    .field input, .field select {
      all: initial;
      box-sizing: border-box;
      width: 100%;
      height: 38px;
      border: 1px solid var(--pem-modal-border);
      border-radius: 11px;
      background: var(--pem-field-bg);
      color: var(--pem-modal-text);
      padding: 0 11px;
      font-family: inherit;
      font-size: 13px;
      /* all: initial 会把 UA 的 input cursor: text 重置为 auto，悬停 placeholder 时指针不显示 */
      cursor: text;
    }
    .field select option { color: #111827; background: #fff; }
    .field.wide { grid-column: 1 / -1; }
    .target-select {
      position: relative;
    }
    .target-trigger {
      all: initial;
      box-sizing: border-box;
      width: 100%;
      min-height: 46px;
      display: grid;
      grid-template-columns: 1fr 20px;
      align-items: center;
      gap: 10px;
      border: 1px solid var(--pem-modal-border);
      border-radius: 12px;
      background: var(--pem-panel-bg);
      color: var(--pem-modal-text);
      padding: 8px 10px;
      cursor: pointer;
      font-family: inherit;
    }
    .target-trigger:hover {
      border-color: var(--pem-selected-border);
      background: var(--pem-item-hover);
    }
    .target-caret {
      color: var(--pem-modal-muted);
      font-size: 15px;
      text-align: center;
    }
    .target-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin-top: 6px;
      overflow: visible;
      border: 1px solid var(--pem-modal-border);
      border-radius: 12px;
      background: var(--pem-modal-bg);
      padding: 6px;
      box-shadow: 0 0 0 1px var(--pem-modal-inset) inset;
    }
    .target-section {
      padding: 4px 6px 1px;
      color: var(--pem-modal-muted);
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: .02em;
    }
    .target-option {
      all: initial;
      box-sizing: border-box;
      width: 100%;
      min-height: 44px;
      display: grid;
      grid-template-columns: 1fr 18px;
      align-items: center;
      gap: 10px;
      border: 1px solid transparent;
      border-radius: 10px;
      background: var(--pem-item-bg);
      color: var(--pem-modal-text);
      padding: 8px 10px;
      cursor: pointer;
      font-family: inherit;
    }
    .target-option:hover {
      background: var(--pem-item-hover);
      border-color: var(--pem-modal-border);
    }
    .target-option.selected {
      background: var(--pem-selected-bg);
      border-color: var(--pem-selected-border);
    }
    .target-title {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--pem-modal-text);
      font-size: 12.5px;
      font-weight: 800;
      line-height: 17px;
    }
    .target-sub {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 1px;
      color: var(--pem-modal-muted);
      font-size: 11px;
      line-height: 15px;
    }
    .target-radio {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 2px solid var(--pem-radio-border);
      box-sizing: border-box;
    }
    .target-option.selected .target-radio {
      border: 5px solid #60a5fa;
      background: #fff;
    }
    .modal-foot {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      border-top: 1px solid var(--pem-modal-border);
      padding: 16px 28px 22px;
    }
    .modal-foot button {
      height: 40px;
      min-width: 82px;
      border-radius: 12px;
      font-size: 14px;
    }
    .modal-foot .primary { background: #0d6efd; }
    .modal-foot .secondary {
      background: var(--pem-secondary-bg);
      color: var(--pem-modal-text);
      border: 1px solid var(--pem-modal-border);
    }
    .modal-foot .mute-site {
      margin-right: auto;
      background: transparent;
      border-color: transparent;
      opacity: .72;
    }
    .modal-foot .mute-site:hover { opacity: 1; }
    .capture-modal {
      border-radius: 16px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, .32), 0 0 0 1px rgba(255, 255, 255, .06) inset;
    }
    .capture-modal .modal-head {
      gap: 10px;
      padding: 14px 16px 10px;
    }
    .capture-modal .logo {
      width: 30px;
      height: 30px;
      font-size: 12px;
    }
    .capture-modal .modal-title {
      font-size: 18px;
      line-height: 23px;
    }
    .capture-modal .modal-close {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      font-size: 22px;
    }
    .capture-modal .modal-body {
      padding: 0 16px 12px;
      max-height: min(500px, calc(100vh - 150px));
    }
    .capture-modal .seg {
      border-radius: 11px;
      margin-bottom: 12px;
      padding: 3px;
    }
    .capture-modal .seg button {
      height: 34px;
      border-radius: 9px;
      font-size: 13px;
    }
    .capture-modal .capture-meta {
      gap: 8px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .capture-modal .pill {
      max-width: 190px;
      padding: 4px 8px;
    }
    .capture-modal .field-grid {
      gap: 9px;
      margin: 8px 0 10px;
    }
    .capture-modal .field {
      gap: 5px;
    }
    .capture-modal .field label {
      font-size: 11px;
    }
    .capture-modal .field input,
    .capture-modal .field select {
      height: 34px;
      border-radius: 9px;
      padding: 0 10px;
      font-size: 12px;
    }
    .capture-modal .new-box {
      border-radius: 12px;
      padding: 9px 11px;
    }
    .capture-modal .new-row {
      grid-template-columns: 58px 1fr;
      gap: 8px;
      padding: 3px 0;
      font-size: 12px;
    }
    .capture-modal .capture-list {
      gap: 6px;
      margin-top: 6px;
    }
    .capture-modal .capture-item {
      grid-template-columns: 34px 1fr 22px;
      gap: 9px;
      border-radius: 12px;
      padding: 8px 10px;
    }
    .capture-modal .capture-avatar {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      font-size: 13px;
    }
    .capture-modal .capture-name {
      font-size: 13px;
      line-height: 18px;
    }
    .capture-modal .capture-user {
      font-size: 11.5px;
      line-height: 16px;
    }
    .capture-modal .radio {
      width: 16px;
      height: 16px;
    }
    .capture-modal .selected .radio {
      border-width: 5px;
    }
    .capture-modal .modal-foot {
      gap: 8px;
      padding: 10px 16px 14px;
    }
    .capture-modal .modal-foot button {
      height: 34px;
      min-width: 68px;
      border-radius: 10px;
      font-size: 13px;
    }
    .lock-panel {
      margin: 0 28px 18px;
      border-radius: 14px;
      background: var(--pem-lock-bg);
      padding: 18px 20px;
      color: var(--pem-lock-text);
    }
    .lock-line {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 16px;
      line-height: 24px;
      font-weight: 750;
    }
    .lock-icon {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: var(--pem-lock-icon-bg);
      color: var(--pem-lock-icon);
      font-size: 17px;
      flex: 0 0 auto;
    }
    .lock-help {
      margin: 10px 0 0 46px;
      color: var(--pem-lock-muted);
      font-size: 12px;
      line-height: 18px;
      opacity: .9;
    }
    .lock-actions {
      display: flex;
      gap: 10px;
      margin: 16px 0 0 46px;
    }
    .lock-actions button {
      height: 36px;
      border-radius: 10px;
      font-size: 13px;
    }
    .lock-actions .primary { background: #0d6efd; color: #fff; }
    .lock-actions .secondary {
      background: var(--pem-secondary-bg);
      color: var(--pem-modal-text);
    }
    @media (max-width: 520px) {
      .row { align-items: flex-start; }
      .actions { flex-wrap: wrap; justify-content: flex-end; max-width: 148px; }
      button { height: 28px; padding: 0 8px; }
      .modal-head { padding: 16px 16px 12px; }
      .modal-body { padding: 0 16px 14px; }
      .modal-foot { padding: 14px 16px 16px; }
      .modal-title { font-size: 19px; }
      .field-grid { grid-template-columns: 1fr; }
      .lock-panel { margin: 0 16px 16px; padding: 16px; }
      .lock-help, .lock-actions { margin-left: 0; }
      .lock-actions { flex-direction: column; }
    }
  `;

  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const labelFor = (e) => e.accountLabel || e.username || e.linkName || '账号';

  // 多租户系统：把租户 / 企业 / 域拼进副标题，跟在用户名后面。
  const tenantSuffix = (e) => (e && e.tenant ? ` · 租户 ${e.tenant}` : '');

  const modalThemeClass = () => {
    const setting = snapshot?.theme || 'system';
    const systemDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    return setting === 'dark' || (setting !== 'light' && systemDark) ? 'theme-dark' : 'theme-light';
  };

  const captureCandidates = () => {
    const list = capturePrompt?.updateCandidates || [];
    if (capturePrompt?.kind === 'update' && capturePrompt.accountId && !list.some((c) => c.accountId === capturePrompt.accountId)) {
      return [
        {
          accountId: capturePrompt.accountId,
          accountLabel: capturePrompt.linkName || '已保存账号',
          username: capturePrompt.username || '',
          linkName: capturePrompt.linkName || '已保存账号',
        },
        ...list,
      ];
    }
    return list;
  };

  const setCapturePrompt = (next) => {
    capturePrompt = next;
    const candidates = captureCandidates();
    selectedUpdateId = next?.accountId || candidates[0]?.accountId || '';
    captureMode = next?.kind === 'update' && selectedUpdateId ? 'update' : 'new';
    captureDraft = next
      ? {
          username: next.username || '',
          accountLabel: next.accountLabel || '',
          tenant: next.tenant || '',
          targetChoice: defaultCaptureTargetChoice(next),
          newProjectName: '',
          workspaceId: next.activeWorkspaceId || next.workspaces?.[0]?.id || '',
        }
      : null;
    dismissed = false;
    expanded = false;
    targetDropdownOpen = false;
    workspaceDropdownOpen = false;
  };

  const shortName = (s) => String(s || '?').trim().slice(0, 2).toLowerCase();

  const captureItemTitle = (c) => c.accountLabel || c.linkName || c.username || '已保存账号';

  const NEW_PROJECT_CHOICE = 'new-project';

  // 新建项目的默认名：background 从网页标题提取的站点名（如「5G移巡天穹」），
  // 无标题或纯「登录」类标题时退回网站 host（占位提示与留空保存取同一值）。
  const suggestedProjectName = () =>
    capturePrompt?.suggestedProjectName || hostOf(capturePrompt?.origin || '');

  const defaultCaptureTargetChoice = (prompt = capturePrompt) => {
    if (!prompt || prompt.kind !== 'new') return '';
    if (prompt.targetLinkId) return `link:${prompt.targetLinkId}`;
    if (prompt.saveTargets?.[0]) return `link:${prompt.saveTargets[0].linkId}`;
    return NEW_PROJECT_CHOICE;
  };

  const captureNeedsLocation = () =>
    capturePrompt?.kind === 'new' && !capturePrompt.targetLinkId && !(capturePrompt.saveTargets || []).length;

  const captureSaveTargetEdits = () => {
    if (!capturePrompt || captureMode !== 'new') return {};
    const ws = captureDraft?.workspaceId ? { targetWorkspaceId: captureDraft.workspaceId } : {};
    const choice = captureDraft?.targetChoice || defaultCaptureTargetChoice();
    if (choice.startsWith('link:')) return { targetLinkId: choice.slice(5) };
    if (choice.startsWith('project:')) return { ...ws, targetProjectId: choice.slice(8) };
    return { ...ws, newProjectName: captureDraft?.newProjectName || suggestedProjectName() };
  };

  const targetOption = (value, title, sub, selected) => `
    <button type="button" class="target-option ${selected ? 'selected' : ''}" data-act="choose-capture-target" data-id="${esc(value)}">
      <span>
        <span class="target-title">${esc(title)}</span>
        ${sub ? `<span class="target-sub">${esc(sub)}</span>` : ''}
      </span>
      <span class="target-radio"></span>
    </button>
  `;

  const targetLabel = (targets, projectTargets, targetChoice) => {
    if (targetChoice.startsWith('link:')) {
      const t = targets.find((x) => x.linkId === targetChoice.slice(5));
      if (t) return { title: `${t.projectName} / ${t.envName}`, sub: t.linkName };
    }
    if (targetChoice.startsWith('project:')) {
      const p = projectTargets.find((x) => x.projectId === targetChoice.slice(8));
      if (p) return { title: p.projectName, sub: `新建 ${hostOf(capturePrompt.origin)}` };
    }
    return { title: '+ 新建项目', sub: suggestedProjectName() };
  };

  const captureTargetSelect = (targets, projectTargets, targetChoice) => {
    const selected = targetLabel(targets, projectTargets, targetChoice);
    return `
      <div class="target-select">
        <button type="button" class="target-trigger" data-act="toggle-capture-target">
          <span>
            <span class="target-title">${esc(selected.title)}</span>
            ${selected.sub ? `<span class="target-sub">${esc(selected.sub)}</span>` : ''}
          </span>
          <span class="target-caret">${targetDropdownOpen ? '⌃' : '⌄'}</span>
        </button>
        ${
          targetDropdownOpen
            ? `<div class="target-list">
                ${
                  targets.length
                    ? `<div class="target-section">已有网站</div>${targets
                        .map((t) =>
                          targetOption(
                            `link:${t.linkId}`,
                            `${t.projectName} / ${t.envName}`,
                            t.linkName,
                            targetChoice === `link:${t.linkId}`,
                          ),
                        )
                        .join('')}`
                    : ''
                }
                ${
                  projectTargets.length
                    ? `<div class="target-section">项目中新建网站</div>${projectTargets
                        .map((p) =>
                          targetOption(
                            `project:${p.projectId}`,
                            p.projectName,
                            `新建 ${hostOf(capturePrompt.origin)}`,
                            targetChoice === `project:${p.projectId}`,
                          ),
                        )
                        .join('')}`
                    : ''
                }
                <div class="target-section">新项目</div>
                ${targetOption(NEW_PROJECT_CHOICE, '+ 新建项目', suggestedProjectName(), targetChoice === NEW_PROJECT_CHOICE)}
              </div>`
            : ''
        }
      </div>
    `;
  };

  // 工作区选择：复用「保存到」的自定义下拉样式与开合逻辑（原生 <select> 在浮层里会被
  // 重渲染打断、样式错位，故弃用）。
  const workspaceSelect = (workspaces, wsId) => {
    const current = workspaces.find((w) => w.id === wsId) || workspaces[0];
    return `
      <div class="target-select">
        <button type="button" class="target-trigger" data-act="toggle-workspace">
          <span>
            <span class="target-title">${esc(current?.name || '默认工作区')}</span>
          </span>
          <span class="target-caret">${workspaceDropdownOpen ? '⌃' : '⌄'}</span>
        </button>
        ${
          workspaceDropdownOpen
            ? `<div class="target-list">
                ${workspaces
                  .map(
                    (w) => `
                      <button type="button" class="target-option ${w.id === wsId ? 'selected' : ''}" data-act="choose-workspace" data-id="${esc(w.id)}">
                        <span><span class="target-title">${esc(w.name)}</span></span>
                        <span class="target-radio"></span>
                      </button>`,
                  )
                  .join('')}
              </div>`
            : ''
        }
      </div>
    `;
  };

  const render = (message, tone = 'info') => {
    guardAutoSubmitLoop();
    // 站点被静默：不弹任何浮层（横幅 / 锁定提示 / 保存提示）。扩展弹窗仍可手动填充/捕获。
    if (snapshot?.muted) return destroy();
    const surface = surfaceKind();
    sortMatches(surface);
    // 横幅的「登录」默认就点真正的登录按钮（无验证码直接登录；有滑动验证码/二次校验原地弹出，
    // 由用户完成）——和 1Password 一致。仅当该来源被防循环逻辑判定为「需手动完成验证」时，
    // 才退回只填充，避免对「点击后才弹验证码」的站点反复自动提交。
    // 注：设置里的「填充后自动登录」只约束 popup / 打开链接的被动填充，不再影响此处。
    const autoSubmit = !manualSubmitRequired();
    const hasLoginSurface = surface === 'password' || surface === 'username' || surface === 'otp';
    const shouldShowMatches =
      !dismissed &&
      snapshot &&
      snapshot.enabled &&
      snapshot.matches.length > 0 &&
      (surface === 'password' ||
        surface === 'username' ||
        (surface === 'otp' && snapshot.matches.some((e) => e.hasTotp)));
    const shouldShowLocked = snapshot?.locked && (lockedPrompt || (!dismissed && hasLoginSurface));
    if (!capturePrompt && !shouldShowMatches && !shouldShowLocked) return destroy();

    const r = ensureRoot();
    placeRoot(Boolean(capturePrompt || shouldShowLocked));
    const themeClass = modalThemeClass();
    if (shouldShowLocked) {
      const lockedTitle = lockedPrompt ? '保存账号' : '项目环境管家已锁定';
      const lockedText = lockedPrompt
        ? '要保存这次账号创建或登录，需先解锁项目环境管家。'
        : '当前页面可以使用项目环境管家，先解锁后即可填充登录。';
      const lockedHelp = lockedPrompt
        ? '解锁后回到当前页面，会自动尝试恢复保存提示；也可以在扩展弹窗里手动捕获当前输入。'
        : '解锁后刷新或回到当前页面，账号建议会自动出现。';
      r.innerHTML = `
        <style>${css}</style>
        <div class="modal ${themeClass}">
          <div class="modal-head">
            <div class="logo">PM</div>
            <div class="modal-title">${esc(lockedTitle)}</div>
            <button class="modal-close" data-act="close" aria-label="关闭">×</button>
          </div>
          <div class="lock-panel">
            <div class="lock-line">
              <span class="lock-icon">锁</span>
              <span>${esc(lockedText)}</span>
            </div>
            <div class="lock-help">
              ${esc(lockedHelp)}
            </div>
            <div class="lock-actions">
              <button class="primary" data-act="unlock-vault">解锁项目环境管家</button>
              <button class="secondary" data-act="close">稍后</button>
            </div>
          </div>
          ${message ? `<div class="msg ${tone === 'warn' ? 'warn' : ''}">${esc(message)}</div>` : ''}
        </div>
      `;
      r.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void onAction(btn.dataset.act, btn.dataset.id);
        });
      });
      return;
    }
    if (capturePrompt) {
      const candidates = captureCandidates();
      const canUpdate = candidates.length > 0;
      if (!canUpdate) captureMode = 'new';
      if (canUpdate && (!selectedUpdateId || !candidates.some((c) => c.accountId === selectedUpdateId))) {
        selectedUpdateId = candidates[0].accountId;
      }
      const mode = canUpdate ? captureMode : 'new';
      const selected = candidates.find((c) => c.accountId === selectedUpdateId) || candidates[0];
      const targets = capturePrompt.saveTargets || [];
      const allProjectTargets = capturePrompt.projectTargets || [];
      const workspaces = capturePrompt.workspaces || [];
      const draft = captureDraft || {
        username: capturePrompt.username || '',
        accountLabel: capturePrompt.accountLabel || '',
        tenant: capturePrompt.tenant || '',
        targetChoice: defaultCaptureTargetChoice(),
        newProjectName: '',
        workspaceId: capturePrompt.activeWorkspaceId || workspaces[0]?.id || '',
      };
      const draftTenant = (draft.tenant ?? capturePrompt.tenant ?? '').trim();
      const wsId = draft.workspaceId || capturePrompt.activeWorkspaceId || workspaces[0]?.id || '';
      // 按选中工作区筛选项目候选（旧数据无 workspaceId 时不过滤）。
      const projectTargets = allProjectTargets.filter((p) => !p.workspaceId || p.workspaceId === wsId);
      let targetChoice = draft.targetChoice || defaultCaptureTargetChoice();
      // 切换工作区后原选中项目不在该工作区 → 回退到「新建项目」。
      if (
        targetChoice.startsWith('project:') &&
        !projectTargets.some((p) => `project:${p.projectId}` === targetChoice)
      ) {
        targetChoice = NEW_PROJECT_CHOICE;
      }
      const selectedTarget = targetChoice.startsWith('link:')
        ? targets.find((t) => t.linkId === targetChoice.slice(5))
        : null;
      const selectedProject = targetChoice.startsWith('project:')
        ? projectTargets.find((p) => p.projectId === targetChoice.slice(8))
        : null;
      const newSaveLabel = selectedTarget
        ? `${selectedTarget.projectName} / ${selectedTarget.envName} / ${selectedTarget.linkName}`
        : selectedProject
          ? `${selectedProject.projectName} / 新建 ${hostOf(capturePrompt.origin)}`
          : `${(draft.newProjectName || suggestedProjectName()).trim()} / 默认`;
      r.innerHTML = `
        <style>${css}</style>
        <div class="modal capture-modal ${themeClass}">
          <div class="modal-head">
            <div class="logo">PM</div>
            <div class="modal-title">保存账号</div>
            <button class="modal-close" data-act="close" aria-label="关闭">×</button>
          </div>
          <div class="modal-body">
            ${
              canUpdate
                ? `<div class="seg">
                    <button data-act="capture-mode-new" class="${mode === 'new' ? 'active' : ''}">新建登录</button>
                    <button data-act="capture-mode-update" class="${mode === 'update' ? 'active' : ''}">更新现有</button>
                  </div>`
                : ''
            }
            <div class="capture-meta">
              <span class="pill">${esc(hostOf(capturePrompt.origin))}</span>
              <span>${esc(capturePrompt.username || '无用户名')}</span>
              ${capturePrompt.tenant ? `<span class="pill">租户 ${esc(capturePrompt.tenant)}</span>` : ''}
              ${capturePrompt.totp ? '<span class="pill">含二次验证</span>' : ''}
            </div>
            <div class="field-grid">
              <div class="field">
                <label>登录名称</label>
                <input data-field="accountLabel" value="${esc(draft.accountLabel || '')}" placeholder="${esc(hostOf(capturePrompt.origin))}" />
              </div>
              <div class="field">
                <label>用户名</label>
                <input data-field="username" value="${esc(draft.username || '')}" placeholder="用户名" />
              </div>
              ${
                capturePrompt.authProvider
                  ? ''
                  : `<div class="field">
                <label>租户 / 企业（可选）</label>
                <input data-field="tenant" value="${esc(draft.tenant || '')}" placeholder="多租户系统的租户编码" />
              </div>`
              }
              ${
                mode === 'new'
                  ? `${
                      workspaces.length > 1
                        ? `<div class="field wide">
                      <label>工作区</label>
                      ${workspaceSelect(workspaces, wsId)}
                    </div>`
                        : ''
                    }
                    <div class="field wide">
                      <label>保存到</label>
                      ${captureTargetSelect(targets, projectTargets, targetChoice)}
                    </div>
                    ${
                      targetChoice === NEW_PROJECT_CHOICE
                        ? `<div class="field wide">
                            <label>新项目名称</label>
                            <input data-field="newProjectName" value="${esc(draft.newProjectName || '')}" placeholder="${esc(suggestedProjectName())}" />
                          </div>`
                        : ''
                    }`
                  : ''
              }
            </div>
            ${
              mode === 'update'
                ? `<div class="capture-list">
                    ${candidates
                      .map(
                        (c) => `<div class="capture-item ${c.accountId === selectedUpdateId ? 'selected' : ''}" data-act="select-capture-update" data-id="${esc(c.accountId)}">
                          <div class="capture-avatar">${esc(shortName(c.accountLabel || c.linkName || c.username))}</div>
                          <div>
                            <div class="capture-name">${esc(captureItemTitle(c))}</div>
                            <div class="capture-user">${esc(c.username || '无用户名')} · ${esc(c.linkName || '当前网站')}</div>
                          </div>
                          <div class="radio"></div>
                        </div>`,
                      )
                      .join('')}
                  </div>`
                : `<div class="new-box">
                    <div class="new-row"><div class="new-label">网站</div><div class="new-value">${esc(hostOf(capturePrompt.origin))}</div></div>
                    ${capturePrompt.authProvider ? `<div class="new-row"><div class="new-label">登录方式</div><div class="new-value">${esc(capturePrompt.authProvider)} 第三方登录</div></div>` : `<div class="new-row"><div class="new-label">用户名</div><div class="new-value">${esc(capturePrompt.username || '无用户名')}</div></div>`}
                    ${draftTenant ? `<div class="new-row"><div class="new-label">租户</div><div class="new-value">${esc(draftTenant)}</div></div>` : ''}
                    ${capturePrompt.totp ? '<div class="new-row"><div class="new-label">二次验证</div><div class="new-value">已检测到 TOTP</div></div>' : ''}
                    <div class="new-row"><div class="new-label">保存到</div><div class="new-value">${esc(newSaveLabel)}</div></div>
                  </div>`
            }
          </div>
          <div class="modal-foot">
            <button class="secondary mute-site" data-act="mute-site" title="加入静默名单：在此网站不再自动弹出填充和保存提示（扩展弹窗仍可手动操作）">此网站不再提示</button>
            <button class="secondary" data-act="edit-capture">编辑</button>
            <button class="primary" data-act="confirm-capture" ${mode === 'update' && !selected ? 'disabled' : ''}>${mode === 'update' ? '更新' : '保存'}</button>
          </div>
          ${message ? `<div class="msg ${tone === 'warn' ? 'warn' : ''}">${esc(message)}</div>` : ''}
        </div>
      `;
      r.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void onAction(btn.dataset.act, btn.dataset.id);
        });
      });
      r.querySelectorAll('[data-field]').forEach((field) => {
        field.addEventListener('input', () => {
          captureDraft = {
            ...(captureDraft || {}),
            [field.dataset.field]: field.value,
          };
        });
        field.addEventListener('change', () => {
          captureDraft = {
            ...(captureDraft || {}),
            [field.dataset.field]: field.value,
          };
          if (field.dataset.field === 'targetChoice') render();
        });
      });
      return;
    }

    const first = snapshot?.matches?.[0];
    const matchCount = snapshot?.matches?.length || 0;
    const title = capturePrompt
      ? capturePrompt.kind === 'update'
        ? `更新 ${capturePrompt.linkName || '已保存账号'} 的${capturePrompt.authProvider ? '登录方式' : '密码'}?`
        : capturePrompt.authProvider
          ? `保存 ${capturePrompt.authProvider} 登录?`
          : `保存 ${capturePrompt.username || '这个账号'}?`
      : `${first.linkName || first.projectName} · ${labelFor(first)}`;
    const sub = capturePrompt
      ? capturePrompt.authProvider
        ? `${capturePrompt.authProvider} 被用于登录 ${hostOf(capturePrompt.origin)}`
        : `${hostOf(capturePrompt.origin)} · ${capturePrompt.username || '无用户名'}`
      : `${first.username || '无用户名'}${tenantSuffix(first)} · ${first.projectName} / ${first.envName}`;

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
                  ? `<button class="primary" data-act="save-capture">${capturePrompt.kind === 'update' ? '更新' : captureNeedsLocation() ? '选择位置' : '保存'}</button>
                     ${
                       capturePrompt.kind === 'new' && capturePrompt.updateCandidates?.length
                         ? `<button class="secondary" data-act="update-capture" data-id="${esc(capturePrompt.updateCandidates[0].accountId)}">更新已有</button>`
                         : ''
                     }
                     <button class="secondary" data-act="edit-capture">编辑</button>
                     <button class="secondary" data-act="dismiss-capture">忽略</button>`
                  : `${
                      surface === 'username'
                        ? `<button class="primary" data-act="${autoSubmit ? 'continue-user' : 'fill-user'}" data-id="${esc(first.accountId)}">${autoSubmit ? '登录' : '填充'}</button>`
                        : surface === 'otp'
                          ? first.hasTotp
                            ? `<button class="primary" data-act="totp" data-id="${esc(first.accountId)}">验证码</button>`
                            : ''
                          : `<button class="primary" data-act="${autoSubmit ? 'login' : 'fill'}" data-id="${esc(first.accountId)}">${autoSubmit ? '登录' : '填充'}</button>`
                    }
                     ${
                       matchCount > 1
                         ? `<button class="secondary" data-act="more">更多 ${matchCount}</button>`
                         : ''
                     }
                     <button class="secondary" data-act="mute-site" title="加入静默名单：在此网站不再自动弹出填充和保存提示（扩展弹窗仍可手动操作）">不再提示</button>`
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
                          <div class="sub">${esc(e.username || '无用户名')}${esc(tenantSuffix(e))} · ${esc(e.envName)}</div>
                        </div>
                        ${
                          surface === 'username'
                            ? `<button class="tiny" data-act="${autoSubmit ? 'continue-user' : 'fill-user'}" data-id="${esc(e.accountId)}">${autoSubmit ? '登录' : '填充'}</button>`
                            : surface === 'otp'
                              ? e.hasTotp
                                ? `<button class="tiny" data-act="totp" data-id="${esc(e.accountId)}">验证码</button>`
                                : ''
                              : `<button class="tiny" data-act="${autoSubmit ? 'login' : 'fill'}" data-id="${esc(e.accountId)}">${autoSubmit ? '登录' : '填充'}</button>`
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

  const retryLockedCandidate = async () => {
    if (!lockedCandidate || snapshot?.locked) return false;
    const now = Date.now();
    if (now - lastUnlockRetry < 1200) return false;
    lastUnlockRetry = now;
    const c = lockedCandidate;
    try {
      const res = await send({
        type: 'capture:login',
        origin: c.origin,
        url: c.url,
        title: c.title || document.title || '',
        username: c.username,
        password: c.password,
        tenant: c.tenant,
        totp: c.totp || extractTotpSecret(),
        authProvider: c.authProvider,
      });
      lockedPrompt = false;
      lockedCandidate = null;
      if (res?.pending) {
        setCapturePrompt(res);
        render();
      } else {
        render('已解锁，可继续使用项目环境管家');
        setTimeout(scheduleRefresh, 1200);
      }
      return true;
    } catch (e) {
      render(e instanceof Error ? e.message : String(e), 'warn');
      return true;
    }
  };

  const startUnlockPolling = () => {
    clearInterval(unlockPoll);
    const stopAt = Date.now() + 120_000;
    unlockPoll = setInterval(async () => {
      if (Date.now() > stopAt) {
        clearInterval(unlockPoll);
        unlockPoll = 0;
        return;
      }
      await loadSnapshot();
      if (!snapshot?.locked) {
        clearInterval(unlockPoll);
        unlockPoll = 0;
        const retried = await retryLockedCandidate();
        if (!retried) render();
      }
    }, 1500);
  };

  const onAction = async (act, accountId) => {
    try {
      if (act === 'close') {
        dismissed = true;
        // 只是本地关闭（后台的待处理捕获还在，弹窗里仍可保存）：
        // 记住这条提示，成功检测的重新展示不再打开它；新捕获（createdAt 不同）不受影响。
        if (capturePrompt?.id) {
          dismissedPendingKey = `${capturePrompt.id}:${capturePrompt.createdAt || 0}`;
          // 本地记忆会随页面跳转丢失：同时让后台标记这条捕获不再在后续页面重新展示。
          send({ type: 'capture:muteReprompt', id: capturePrompt.id }).catch(() => {});
        }
        capturePrompt = null;
        lockedPrompt = false;
        lockedCandidate = null;
        targetDropdownOpen = false;
        clearFlow(); // 用户关掉提示 → 停止自动续填
        destroy();
        return;
      }
      if (act === 'unlock-vault') {
        await send({ type: 'ui:openUnlock' });
        startUnlockPolling();
        render('已弹出解锁窗口，解锁后回到本页会自动填充');
        return;
      }
      if (act === 'mute-site') {
        // 后台把当前 origin 加入静默名单并清掉该站点的候选/待处理捕获。
        await send({ type: 'assist:muteSite' });
        dismissed = true;
        capturePrompt = null;
        lockedPrompt = false;
        lockedCandidate = null;
        targetDropdownOpen = false;
        clearFlow();
        await loadSnapshot();
        destroy();
        return;
      }
      if (act === 'more') {
        expanded = !expanded;
        render();
        return;
      }
      if (act === 'capture-mode-new') {
        captureMode = 'new';
        targetDropdownOpen = false;
        render();
        return;
      }
      if (act === 'capture-mode-update') {
        const candidates = captureCandidates();
        if (candidates.length > 0) {
          captureMode = 'update';
          selectedUpdateId = selectedUpdateId || candidates[0].accountId;
        }
        targetDropdownOpen = false;
        render();
        return;
      }
      if (act === 'select-capture-update') {
        selectedUpdateId = accountId || '';
        captureMode = 'update';
        render();
        return;
      }
      if (act === 'toggle-capture-target') {
        targetDropdownOpen = !targetDropdownOpen;
        workspaceDropdownOpen = false;
        render();
        return;
      }
      if (act === 'choose-capture-target') {
        captureDraft = {
          ...(captureDraft || {}),
          targetChoice: accountId || NEW_PROJECT_CHOICE,
        };
        targetDropdownOpen = false;
        render();
        return;
      }
      if (act === 'toggle-workspace') {
        workspaceDropdownOpen = !workspaceDropdownOpen;
        targetDropdownOpen = false;
        render();
        return;
      }
      if (act === 'choose-workspace') {
        captureDraft = {
          ...(captureDraft || {}),
          workspaceId: accountId || '',
        };
        workspaceDropdownOpen = false;
        render();
        return;
      }
      if (act === 'confirm-capture') {
        const accountIdToUpdate = captureMode === 'update' ? selectedUpdateId : undefined;
        await send({
          type: 'capture:save',
          id: capturePrompt?.id,
          accountId: accountIdToUpdate,
          username: captureDraft?.username,
          accountLabel: captureDraft?.accountLabel,
          tenant: capturePrompt?.authProvider ? undefined : captureDraft?.tenant,
          ...captureSaveTargetEdits(),
        });
        capturePrompt = null;
        captureDraft = null;
        targetDropdownOpen = false;
        await loadSnapshot();
        render(accountIdToUpdate ? '已更新保险箱' : '已保存到保险箱');
        setTimeout(scheduleRefresh, 1400);
        return;
      }
      if (act === 'save-capture') {
        if (captureNeedsLocation()) {
          expanded = true;
          render();
          return;
        }
        await send({ type: 'capture:save', id: capturePrompt?.id, ...captureSaveTargetEdits() });
        capturePrompt = null;
        captureDraft = null;
        targetDropdownOpen = false;
        await loadSnapshot();
        render('已保存到保险箱');
        setTimeout(scheduleRefresh, 1400);
        return;
      }
      if (act === 'update-capture') {
        await send({ type: 'capture:save', id: capturePrompt?.id, accountId });
        capturePrompt = null;
        await loadSnapshot();
        render('已更新保险箱');
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
        if (act === 'continue-user') armAutoFlow(accountId); // 点「下一步」即开启自动续填
        const res = await sendAssist({
          type: 'assist:fillUsername',
          accountId,
          submit: act === 'continue-user',
        });
        render(res?.ok === false ? res.reason || '未能填账号' : act === 'continue-user' ? '已填账号并继续' : '已填账号', res?.ok === false ? 'warn' : 'info');
        return;
      }
      if (act === 'fill' || act === 'login') {
        remember(accountId);
        if (act === 'login') {
          // 直接点「登录」= 一次用户主动发起的登录。先清掉任何遗留流程，仅当后续确实还有
          // 一步要自动续填（账号存了 TOTP → 密码后还有 OTP 步）才重新武装；纯密码单步登录
          // 武装了也无步可续，反而会把流程残留到注销回登录页后再次自动登录（死循环）。
          clearFlow();
          if (snapshot?.matches?.some((m) => m.accountId === accountId && m.hasTotp))
            armAutoFlow(accountId);
        }
        const res = await sendAssist({ type: 'assist:fill', accountId, submit: act === 'login' });
        const okMsg =
          act === 'login'
            ? '已填充并提交'
            : manualSubmitRequired()
              ? '已填充账号密码，请完成验证后点页面的登录按钮'
              : '已填充账号密码';
        render(
          res?.ok === false
            ? res.reason || '未能填充'
            : res?.submitSkipped
              ? res.reason || '检测到验证码，已填充账号密码'
              : okMsg,
          res?.ok === false || res?.submitSkipped ? 'warn' : 'info',
        );
        return;
      }
      if (act === 'totp') {
        remember(accountId);
        const res = await sendAssist({ type: 'assist:fillTotp', accountId, submit: false });
        render(res?.ok === false ? res.reason || '未能填验证码' : '验证码已填充', res?.ok === false ? 'warn' : 'info');
      }
    } catch (e) {
      render(e instanceof Error ? e.message : String(e), 'warn');
    }
  };

  const loadSnapshot = async () => {
    try {
      snapshot = await sendAssist({ type: 'assist:matches' });
    } catch {
      snapshot = null;
    }
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await loadSnapshot();
      const retried = await retryLockedCandidate();
      // 捕获弹窗打开期间禁止被动重渲染（focusin / 页面 DOM 变动 / 窗口焦点都走到这里）：
      // render() 整体重建 innerHTML，会销毁正在编辑的输入框，焦点随之丢失、无法输入。
      // 新捕获到来由 confirmCaptureSuccess 按 id+createdAt 判断后主动 render。
      if (!retried && !capturePrompt) render();
      await maybeAutoContinue();
      void maybeAutoFillFocusedTotp();
    }, 120);
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
      origin: location.origin,
      url: location.href,
      title: document.title || '',
      username,
      password: pw.value,
      tenant: tenantForPassword(pw) || undefined,
    };

    try {
      // 先把凭据发出去（后台锁定时会静默忽略）：提交后页面随时可能跳转销毁本脚本，
      // 等快照往返和 TOTP 扫描（含 BarcodeDetector 逐图识别）完成再发会整条丢失。
      send({ type: 'capture:candidate', ...candidate }).catch(() => {});
      await loadSnapshot();
      if (snapshot?.locked) {
        if (snapshot.muted) return; // 静默站点连「解锁后保存」的锁定提示也不弹
        lockedCandidate = candidate;
        lockedPrompt = true;
        dismissed = false;
        render();
        return;
      }
      const totp = await extractTotpSecretAsync();
      if (totp) {
        await send({ type: 'capture:candidate', ...candidate, totp });
      }
    } catch {
      // Ignore stale extension contexts or locked vaults.
    }
  };

  const captureFederatedCandidate = async (provider) => {
    const authProvider = String(provider || '').trim();
    if (!authProvider) return;

    const now = Date.now();
    if (now - lastSent < 1500) return;
    lastSent = now;

    const candidate = {
      origin: location.origin,
      url: location.href,
      title: document.title || '',
      username: providerAccountName(authProvider),
      password: '',
      authProvider,
    };

    try {
      send({ type: 'capture:candidate', ...candidate }).catch(() => {});
      armSuccessChecks(120_000);
      await loadSnapshot();
      if (snapshot?.locked) {
        if (snapshot.muted) return; // 静默站点连「解锁后保存」的锁定提示也不弹
        lockedCandidate = candidate;
        lockedPrompt = true;
        dismissed = false;
        render();
        return;
      }
      const totp = await extractTotpSecretAsync();
      if (totp) {
        await send({ type: 'capture:candidate', ...candidate, totp });
      }
    } catch {
      // Ignore stale extension contexts or locked vaults.
    }
  };

  const confirmCaptureSuccess = async () => {
    try {
      const res = await send({
        type: 'capture:successCheck',
        origin: location.origin,
        url: location.href,
        title: document.title || '',
        signals: await successSignals(),
      });
      if (!res?.pending) return;
      if (res.id && `${res.id}:${res.createdAt || 0}` === dismissedPendingKey) return;
      // 同一条提示已在展示：不重置浮层，避免清掉用户正在编辑的内容。
      if (
        res.id &&
        capturePrompt?.id === res.id &&
        (capturePrompt.createdAt || 0) === (res.createdAt || 0)
      ) {
        return;
      }
      setCapturePrompt(res);
      render();
    } catch {
      // Ignore stale extension contexts or locked vaults.
    }
  };

  const scheduleSuccessCheck = () => {
    if (Date.now() > successCheckUntil) return;
    clearTimeout(successTimer);
    successTimer = setTimeout(() => void confirmCaptureSuccess(), 250);
  };

  const armSuccessChecks = (windowMs = 15_000) => {
    successCheckUntil = Math.max(successCheckUntil, Date.now() + windowMs);
    for (const delay of CHECK_DELAYS) setTimeout(() => void confirmCaptureSuccess(), delay);
  };

  const soonCapture = () => {
    rememberVisibleUsername();
    armSuccessChecks();
    void captureCandidate();
  };

  const hostOf = (origin) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
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
    send({ type: 'capture:oauthNav', url: location.href }).catch(() => {});
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

  // 浮层（shadow DOM）里的事件会被重定位成宿主元素出现在 document 的捕获阶段监听里，
  // shadow 内部的 stopPropagation 拦不住捕获阶段：这里按 composedPath 显式排除。
  // 尤其 focusin → scheduleRefresh 曾在点击弹窗输入框 120ms 后重建 DOM，把焦点打丢。
  const fromAssistUi = (e) => {
    if (!host) return false;
    if (e.target === host) return true;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(host);
  };
  document.addEventListener(
    'submit',
    (e) => {
      if (!fromAssistUi(e)) soonCapture();
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.includes(host)) return;
      // shadow DOM 里的点击会被重定位到宿主：用 composedPath 拿到真实目标。
      const t = path[0] && path[0].nodeType === 1 ? path[0] : e.target;
      // 已登录页面上的「绑定 GitHub / 关联微信」是账号绑定而不是登录，跳过第三方登录捕获。
      const federated = pageLoggedIn() ? null : federatedLoginAction(t);
      if (federated) {
        rememberVisibleUsername();
        // 第三方授权（跳转 / 弹窗）耗时远超普通提交，把成功检测窗口拉长。
        armSuccessChecks(120_000);
        void captureFederatedCandidate(federated.provider);
        return;
      }
      if (t && t.closest && t.closest('button, input[type="submit"], [role="button"]')) soonCapture();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && !fromAssistUi(e)) soonCapture();
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (e) => {
      if (!fromAssistUi(e)) scheduleRefresh();
    },
    true,
  );
  document.addEventListener(
    'input',
    (e) => {
      if (!fromAssistUi(e)) rememberVisibleUsername();
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      if (!fromAssistUi(e)) rememberVisibleUsername();
    },
    true,
  );
  window.addEventListener('focus', scheduleRefresh);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh();
  });

  new MutationObserver(() => {
    scheduleRefresh();
    scheduleSuccessCheck();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'style', 'class', 'hidden', 'autocomplete', 'inputmode'],
  });

  // 新页面加载时检查上一页提交留下的同源候选。
  rememberVisibleUsername();
  armSuccessChecks(7000);
  maybeReportOAuthNav();
  void loadSnapshot().then(() => {
    render();
    void maybeAutoContinue();
    void maybeAutoFillFocusedTotp();
  });
  // 自动提交后若是整页刷新回到登录页（原生表单提交，之后没有 DOM 变动触发重渲染），
  // 用两次延迟检查兜底：跨过 1.5s 判定窗口后若仍在登录页，就标记该来源改为只填充。
  setTimeout(() => {
    if (guardAutoSubmitLoop() && !capturePrompt) render();
  }, 1800);
  setTimeout(() => {
    if (guardAutoSubmitLoop() && !capturePrompt) render();
  }, 3600);
})();

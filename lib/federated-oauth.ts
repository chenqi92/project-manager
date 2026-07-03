// ---------------------------------------------------------------------------
// 第三方登录（OAuth / OIDC / CAS）授权页识别。
//
// 「用 Google 登录 site.com」时浏览器一定会走一次 IdP 授权页导航，例如
//   https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=https%3A%2F%2Fsite.com%2Fcb
// 这条 URL 本身就同时说明了「哪个 IdP」与「登录哪个站点」，比在站点页面上猜
// 「使用 Google 登录」按钮可靠得多（图标按钮 / GIS iframe / shadow DOM 都探不到点击）。
//
// 内容脚本在疑似授权页上把 location.href 报给 background，这里做权威解析：
//   detectOAuthAuthorize(url) → { provider, clientOrigin, idpOrigin } | null
// background 再校验 sender 的真实来源 === idpOrigin，防止任意网页冒充 IdP。
// ---------------------------------------------------------------------------

export interface OAuthNavDetection {
  /** IdP 展示名：知名提供商用固定名（Google / GitHub…），其余用授权页主机名 */
  provider: string;
  /** 发起登录的站点 origin（从 redirect_uri 等参数还原） */
  clientOrigin: string;
  /** 授权页自身 origin，调用方必须用它与消息 sender 的真实来源比对 */
  idpOrigin: string;
}

interface IdpRule {
  provider: string;
  /** 匹配 url.hostname（已小写） */
  host: RegExp;
  /** 匹配 url.pathname */
  path: RegExp;
  /** 回跳参数候选；缺省用 REDIRECT_PARAMS */
  params?: string[];
  /** 从 URL 提炼更具体的提供商名（如 Auth0 的 connection=google-oauth2） */
  providerFromUrl?: (u: URL) => string | undefined;
}

/** 常见「回到发起站点」参数，按可信度排序。 */
const REDIRECT_PARAMS = ['redirect_uri', 'redirect_url', 'redirect_to', 'oauth_callback', 'return_url'];

/** 登录页把真正授权 URL 塞进的续跳参数（google v3/signin 的 continue、github /login 的 return_to）。 */
const NESTED_PARAMS = ['continue', 'return_to', 'redirect', 'next'];

/** 通用 OAuth2 / OIDC 授权端点（Auth0 / Okta / Keycloak / IdentityServer / 自建 SSO）。 */
const GENERIC_AUTHORIZE_PATH_RE =
  /(\/(authorize|authorization)\/?$)|(\/openid-connect\/auth\/?$)|(\/oauth2?\/(v[\d.]+\/)?auth\/?$)/i;

/** CAS 单点登录：/login?service=<绝对地址>（含 /cas/login）。 */
const CAS_PATH_RE = /(^|\/)login\/?$/i;

/** 归一化提供商 token（supabase 的 provider=google、firebase 的 providerId=google.com 等）。 */
const PROVIDER_TOKENS: Array<[RegExp, string]> = [
  [/google/i, 'Google'],
  [/github/i, 'GitHub'],
  [/gitlab/i, 'GitLab'],
  [/gitee/i, 'Gitee'],
  [/microsoft|azure|windowslive|live\b/i, 'Microsoft'],
  [/apple/i, 'Apple'],
  [/facebook/i, 'Facebook'],
  [/twitter/i, 'Twitter'],
  [/wechat|weixin/i, 'WeChat'],
  [/qq/i, 'QQ'],
  [/weibo/i, 'Weibo'],
  [/dingtalk/i, 'DingTalk'],
  [/feishu|lark/i, 'Feishu'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/linkedin/i, 'LinkedIn'],
  [/amazon/i, 'Amazon'],
  [/atlassian/i, 'Atlassian'],
];

export function providerLabelFromToken(raw?: string | null): string | undefined {
  const token = (raw ?? '').trim();
  if (!token) return undefined;
  for (const [re, label] of PROVIDER_TOKENS) if (re.test(token)) return label;
  return undefined;
}

const IDP_RULES: IdpRule[] = [
  {
    provider: 'Google',
    host: /^accounts\.google\.com$/,
    path: /^\/(o\/oauth2\/|signin\/oauth|gsi\/)/,
    // GIS 弹窗（/gsi/select）不带 redirect_uri，只带 origin=<站点 origin>
    params: [...REDIRECT_PARAMS, 'origin'],
  },
  { provider: 'GitHub', host: /^github\.com$/, path: /^\/login\/oauth\/authorize/ },
  {
    provider: 'Microsoft',
    host: /^(login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|login\.microsoft\.com)$/,
    path: /(\/oauth2\/(v2\.0\/)?authorize|^\/oauth20_authorize)/,
  },
  { provider: 'Apple', host: /^appleid\.apple\.com$/, path: /^\/auth\/(authorize|oauth)/ },
  { provider: 'GitLab', host: /^gitlab\.com$/, path: /^\/oauth\/authorize/ },
  { provider: 'Gitee', host: /^gitee\.com$/, path: /^\/oauth\/authorize/ },
  {
    provider: 'Slack',
    host: /^slack\.com$/,
    path: /^\/(oauth\/v2\/authorize|oauth\/authorize|openid\/connect\/authorize)/,
  },
  { provider: 'Discord', host: /^discord\.com$/, path: /^\/oauth2\/authorize/ },
  {
    provider: 'Facebook',
    host: /^(www|m|web)\.facebook\.com$/,
    path: /^\/(v[\d.]+\/)?dialog\/oauth/,
  },
  {
    provider: 'Twitter',
    host: /^(twitter\.com|x\.com|api\.twitter\.com)$/,
    path: /^\/(i\/oauth2\/authorize|oauth\/(authorize|authenticate))/,
  },
  { provider: 'LinkedIn', host: /^www\.linkedin\.com$/, path: /^\/oauth\/v2\/authorization/ },
  { provider: 'Amazon', host: /^(www\.amazon\.com|na\.account\.amazon\.com)$/, path: /^\/ap\/oa/ },
  {
    provider: 'WeChat',
    host: /^open\.weixin\.qq\.com$/,
    path: /^\/connect\/(qrconnect|oauth2\/authorize)/,
  },
  { provider: 'QQ', host: /^graph\.qq\.com$/, path: /^\/oauth2\.0\/(authorize|show)/ },
  { provider: 'Weibo', host: /^api\.weibo\.com$/, path: /^\/oauth2\/authorize/ },
  {
    provider: 'DingTalk',
    host: /^(login|oapi)\.dingtalk\.com$/,
    path: /^\/(oauth2\/auth|connect\/(qrconnect|oauth2\/sns_authorize))/,
  },
  {
    provider: 'Feishu',
    host: /^(passport|open|accounts)\.(feishu\.cn|larksuite\.com)$/,
    path: /(\/suite\/passport\/oauth\/authorize|\/open-apis\/authen\/v\d+\/(authorize|index))/,
  },
  {
    provider: 'Auth0',
    host: /(^|\.)auth0\.com$/,
    path: /^\/authorize/,
    providerFromUrl: (u) => providerLabelFromToken(u.searchParams.get('connection')),
  },
  {
    // Supabase 托管认证：/auth/v1/authorize?provider=google&redirect_to=<站点>
    provider: 'Supabase',
    host: /(^|\.)supabase\.(co|red)$/,
    path: /^\/auth\/v\d+\/authorize/,
    params: ['redirect_to', ...REDIRECT_PARAMS],
    providerFromUrl: (u) => providerLabelFromToken(u.searchParams.get('provider')),
  },
  {
    // Firebase 托管认证跳板页：/__/auth/handler?providerId=google.com&redirectUrl=<站点>
    provider: 'Firebase',
    host: /\.(firebaseapp\.com|web\.app)$/,
    path: /^\/__\/auth\/handler/,
    params: ['redirectUrl', ...REDIRECT_PARAMS],
    providerFromUrl: (u) => providerLabelFromToken(u.searchParams.get('providerId')),
  },
];

function parseHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** 回跳来源必须是「另一个」http(s) 站点；扩展自身的 chromiumapp.org 回调不算。 */
function validClientOrigin(client: URL, idp: URL): boolean {
  if (client.hostname === idp.hostname) return false;
  if (/\.chromiumapp\.org$/i.test(client.hostname)) return false;
  return true;
}

function clientOriginFromParams(u: URL, params: string[]): URL | null {
  for (const key of params) {
    const raw = u.searchParams.get(key);
    if (!raw) continue;
    const parsed = parseHttpUrl(raw);
    if (parsed) return parsed;
  }
  return null;
}

function detectDirect(u: URL, host: string): OAuthNavDetection | null {
  for (const rule of IDP_RULES) {
    if (!rule.host.test(host) || !rule.path.test(u.pathname)) continue;
    const client = clientOriginFromParams(u, rule.params ?? REDIRECT_PARAMS);
    if (!client || !validClientOrigin(client, u)) continue;
    const provider = rule.providerFromUrl?.(u) || rule.provider;
    return { provider, clientOrigin: client.origin, idpOrigin: u.origin };
  }

  if (GENERIC_AUTHORIZE_PATH_RE.test(u.pathname)) {
    const hasClientId = ['client_id', 'appid', 'app_id'].some((k) => u.searchParams.get(k));
    if (hasClientId) {
      const client = clientOriginFromParams(u, REDIRECT_PARAMS);
      if (client && validClientOrigin(client, u)) {
        return { provider: host, clientOrigin: client.origin, idpOrigin: u.origin };
      }
    }
  }

  if (CAS_PATH_RE.test(u.pathname)) {
    const service = u.searchParams.get('service');
    const client = service ? parseHttpUrl(service) : null;
    if (client && validClientOrigin(client, u)) {
      return { provider: host, clientOrigin: client.origin, idpOrigin: u.origin };
    }
  }

  return null;
}

/**
 * 判断一条顶层导航 URL 是否为「第三方登录授权页」，并还原发起站点。
 * 解析失败 / 缺少可信回跳参数 / 回跳指向 IdP 自身时返回 null。
 */
export function detectOAuthAuthorize(rawUrl: string, depth = 0): OAuthNavDetection | null {
  const u = parseHttpUrl(rawUrl);
  if (!u) return null;
  const host = u.hostname.toLowerCase();

  const direct = detectDirect(u, host);
  if (direct) return direct;

  if (depth >= 2) return null;
  // 嵌套续跳：授权 URL 302 到登录页后，原授权地址会留在 continue / return_to 里
  // （google 的 /v3/signin、github 的 /login?return_to=…）。只接受同主机的嵌套目标，
  // 防止任意页面借续跳参数把别站指认成 IdP。
  for (const key of NESTED_PARAMS) {
    const raw = u.searchParams.get(key);
    if (!raw) continue;
    let nested: URL;
    try {
      nested = new URL(raw, u.origin);
    } catch {
      continue;
    }
    if (nested.hostname.toLowerCase() !== host) continue;
    const det = detectOAuthAuthorize(nested.toString(), depth + 1);
    if (det) return { ...det, idpOrigin: u.origin };
  }
  return null;
}

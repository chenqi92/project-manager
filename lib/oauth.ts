// ---------------------------------------------------------------------------
// 网盘 OAuth：Authorization Code + PKCE，走 browser.identity.launchWebAuthFlow。
// client_id 由用户自带（自己在 Google/Microsoft 控制台注册）。
//  - OneDrive：Azure 注册为「移动和桌面应用程序」公共客户端，PKCE 无需 client_secret。
//  - Google Drive：必须用「Web 应用」客户端，且即便带 PKCE 也强制要 client_secret，故必传。
// 只取 refresh_token 长期保存（加密进保险箱），access_token 用时再换、仅存内存。
// ---------------------------------------------------------------------------
import { browser } from 'wxt/browser';
import { encodeUtf8, randomBytes, toB64 } from './crypto';

export type DriveKind = 'google-drive' | 'onedrive' | 'dropbox';

interface Endpoint {
  auth: string;
  token: string;
  scope: string;
  extraAuth: Record<string, string>;
}

const ENDPOINTS: Record<DriveKind, Endpoint> = {
  'google-drive': {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.appdata',
    extraAuth: { access_type: 'offline', prompt: 'consent' },
  },
  onedrive: {
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'Files.ReadWrite.AppFolder offline_access',
    extraAuth: { prompt: 'select_account' },
  },
  // Dropbox：注册为「App folder」访问类型的 scoped app，PKCE 公共客户端、无需 secret。
  // token_access_type=offline 才会返回 refresh_token。
  dropbox: {
    auth: 'https://www.dropbox.com/oauth2/authorize',
    token: 'https://api.dropboxapi.com/oauth2/token',
    scope: 'files.content.write files.content.read',
    extraAuth: { token_access_type: 'offline' },
  },
};

// Google「Web 应用」OAuth 的 client_id / client_secret 不写进源码（公开仓库会被
// 密钥扫描拦截、且 Google 可能自动吊销）。改为构建时从 .env 注入（WXT 暴露的
// import.meta.env.WXT_*，见 .env.example）；本地 .env 不入库。留空则回退到用户自带。
const oauthEnv = import.meta.env as unknown as Record<string, string | undefined>;
const ENV_GOOGLE_CLIENT_ID = oauthEnv.WXT_GOOGLE_CLIENT_ID ?? '';
const ENV_GOOGLE_CLIENT_SECRET = oauthEnv.WXT_GOOGLE_CLIENT_SECRET ?? '';

/**
 * 内置默认 client_id：填了的 provider 用户无需自填，留空则回退到用户自带。
 *  - dropbox / onedrive 是公共客户端（PKCE），client_id 非机密，可直接内置。
 *  - google-drive 的 id / secret 走 .env 注入（见上）。
 */
export const BUILTIN_OAUTH_CLIENT_ID: Partial<Record<DriveKind, string>> = {
  dropbox: 'z3ju32x275qszk8',
  onedrive: '2bec0c65-e8d2-4ff0-8ea5-1c5a7c0aa620',
  ...(ENV_GOOGLE_CLIENT_ID ? { 'google-drive': ENV_GOOGLE_CLIENT_ID } : {}),
};

/**
 * 内置 client_secret（仅 Google「Web 应用」客户端需要），由 .env 注入。
 * 注意：扩展分发后此值仍可被解包提取，等同公开——这是「零配置」与「机密性」的取舍；
 * 但至少不再把它提交进公开仓库。范围仅 drive.appdata（应用自己的隐藏目录）。
 */
export const BUILTIN_OAUTH_CLIENT_SECRET: Partial<Record<DriveKind, string>> = {
  ...(ENV_GOOGLE_CLIENT_SECRET ? { 'google-drive': ENV_GOOGLE_CLIENT_SECRET } : {}),
};

function base64url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(randomBytes(32));
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encodeUtf8(verifier) as unknown as BufferSource),
  );
  return { verifier, challenge: base64url(digest) };
}

interface OAuthErr {
  error?: string;
  error_description?: string;
}

/** 走交互式授权拿到 refresh_token；client_id 用户自带。 */
export async function authorizeDrive(
  type: DriveKind,
  clientId: string,
  clientSecret?: string,
): Promise<{ refreshToken: string }> {
  const ep = ENDPOINTS[type];
  const redirectUri = browser.identity.getRedirectURL();
  const { verifier, challenge } = await pkce();

  const url = new URL(ep.auth);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ep.scope);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(ep.extraAuth)) url.searchParams.set(k, v);

  const redirect = await browser.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive: true,
  });
  if (!redirect) throw new Error('授权已取消');

  const params = new URL(redirect).searchParams;
  const code = params.get('code');
  if (!code) {
    throw new Error(params.get('error_description') || params.get('error') || '未取得授权码');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const r = await fetch(ep.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = (await r.json()) as OAuthErr & { refresh_token?: string };
  if (!r.ok || !j.refresh_token) {
    throw new Error(j.error_description || j.error || '换取令牌失败（未返回 refresh_token）');
  }
  return { refreshToken: j.refresh_token };
}

/** 用 refresh_token 换取短期 access_token。 */
export async function refreshAccessToken(
  type: DriveKind,
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<{ accessToken: string; expiresInMs: number }> {
  const ep = ENDPOINTS[type];
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (type === 'onedrive') body.set('scope', ep.scope);
  if (clientSecret) body.set('client_secret', clientSecret);

  const r = await fetch(ep.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = (await r.json()) as OAuthErr & { access_token?: string; expires_in?: number };
  if (!r.ok || !j.access_token) {
    throw new Error(j.error_description || j.error || '刷新令牌失败，请重新授权');
  }
  return { accessToken: j.access_token, expiresInMs: (j.expires_in ?? 3600) * 1000 };
}

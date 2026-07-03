import { describe, expect, it } from 'vitest';
import { detectOAuthAuthorize } from '@/lib/federated-oauth';

const enc = encodeURIComponent;

describe('detectOAuthAuthorize：识别第三方登录授权页并还原发起站点', () => {
  it('Google OAuth 授权页（redirect_uri）', () => {
    const det = detectOAuthAuthorize(
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&redirect_uri=${enc('https://cloud.cerebras.ai/auth/callback')}&response_type=code&scope=email`,
    );
    expect(det).toMatchObject({
      provider: 'Google',
      clientOrigin: 'https://cloud.cerebras.ai',
      idpOrigin: 'https://accounts.google.com',
    });
  });

  it('Google GIS 弹窗（只有 origin 参数）', () => {
    const det = detectOAuthAuthorize(
      `https://accounts.google.com/gsi/select?client_id=abc&ux_mode=popup&origin=${enc('https://app.example.com')}`,
    );
    expect(det).toMatchObject({ provider: 'Google', clientOrigin: 'https://app.example.com' });
  });

  it('Google 登录页把授权地址嵌在 continue 里', () => {
    const authorize = `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}&response_type=code`;
    const det = detectOAuthAuthorize(
      `https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow&continue=${enc(authorize)}`,
    );
    expect(det).toMatchObject({
      provider: 'Google',
      clientOrigin: 'https://app.example.com',
      idpOrigin: 'https://accounts.google.com',
    });
  });

  it('GitHub 授权页与 /login?return_to= 嵌套（相对地址）', () => {
    const direct = detectOAuthAuthorize(
      `https://github.com/login/oauth/authorize?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}`,
    );
    expect(direct).toMatchObject({ provider: 'GitHub', clientOrigin: 'https://app.example.com' });

    const nested = detectOAuthAuthorize(
      `https://github.com/login?client_id=x&return_to=${enc(`/login/oauth/authorize?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}`)}`,
    );
    expect(nested).toMatchObject({ provider: 'GitHub', clientOrigin: 'https://app.example.com' });
  });

  it('Microsoft / Apple / 微信 / QQ', () => {
    expect(
      detectOAuthAuthorize(
        `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}&response_type=code`,
      ),
    ).toMatchObject({ provider: 'Microsoft', clientOrigin: 'https://app.example.com' });

    expect(
      detectOAuthAuthorize(
        `https://appleid.apple.com/auth/authorize?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}&response_type=code%20id_token`,
      ),
    ).toMatchObject({ provider: 'Apple', clientOrigin: 'https://app.example.com' });

    expect(
      detectOAuthAuthorize(
        `https://open.weixin.qq.com/connect/qrconnect?appid=wx123&redirect_uri=${enc('https://passport.example.com/wx/cb')}&response_type=code&scope=snsapi_login`,
      ),
    ).toMatchObject({ provider: 'WeChat', clientOrigin: 'https://passport.example.com' });

    expect(
      detectOAuthAuthorize(
        `https://graph.qq.com/oauth2.0/authorize?client_id=101&redirect_uri=${enc('https://app.example.com/qq/cb')}&response_type=code`,
      ),
    ).toMatchObject({ provider: 'QQ', clientOrigin: 'https://app.example.com' });
  });

  it('Auth0 用 connection 参数细化提供商；Supabase 用 provider 参数', () => {
    expect(
      detectOAuthAuthorize(
        `https://acme.auth0.com/authorize?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}&connection=google-oauth2&response_type=code`,
      ),
    ).toMatchObject({ provider: 'Google', clientOrigin: 'https://app.example.com' });

    expect(
      detectOAuthAuthorize(
        `https://xyzcompany.supabase.co/auth/v1/authorize?provider=github&redirect_to=${enc('https://app.example.com/dashboard')}`,
      ),
    ).toMatchObject({ provider: 'GitHub', clientOrigin: 'https://app.example.com' });
  });

  it('通用 OIDC 授权端点（Keycloak / Okta）：provider 用授权页主机名', () => {
    expect(
      detectOAuthAuthorize(
        `https://sso.corp.example/auth/realms/main/protocol/openid-connect/auth?client_id=portal&redirect_uri=${enc('https://portal.corp.example/cb')}&response_type=code`,
      ),
    ).toMatchObject({ provider: 'sso.corp.example', clientOrigin: 'https://portal.corp.example' });

    expect(
      detectOAuthAuthorize(
        `https://dev-1.okta.com/oauth2/default/v1/authorize?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}&response_type=code`,
      ),
    ).toMatchObject({ provider: 'dev-1.okta.com', clientOrigin: 'https://app.example.com' });
  });

  it('CAS：/cas/login?service=', () => {
    expect(
      detectOAuthAuthorize(
        `https://cas.corp.example/cas/login?service=${enc('https://oa.corp.example/portal')}`,
      ),
    ).toMatchObject({ provider: 'cas.corp.example', clientOrigin: 'https://oa.corp.example' });
  });

  it('拒绝：回跳指向 IdP 自身 / 非 http 回跳 / 扩展回调 / 普通页面 / 跨主机嵌套', () => {
    // 回跳指向 IdP 自身：站点用自己做 IdP，交给普通密码捕获
    expect(
      detectOAuthAuthorize(
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=${enc('https://accounts.google.com/self')}`,
      ),
    ).toBeNull();
    // App 自定义 scheme 回调（移动端流程）
    expect(
      detectOAuthAuthorize(
        `https://github.com/login/oauth/authorize?client_id=x&redirect_uri=${enc('com.example.app://cb')}`,
      ),
    ).toBeNull();
    // 扩展自身的 launchWebAuthFlow 回调
    expect(
      detectOAuthAuthorize(
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=${enc('https://abcdefg.chromiumapp.org/oauth')}`,
      ),
    ).toBeNull();
    // 路径不是授权端点
    expect(
      detectOAuthAuthorize(
        `https://example.com/pricing?client_id=1&redirect_uri=${enc('https://other.example.com/')}`,
      ),
    ).toBeNull();
    // 嵌套续跳指向别的主机：防止任意页面借 continue 指认他站为 IdP
    expect(
      detectOAuthAuthorize(
        `https://accounts.google.com/v3/signin/identifier?continue=${enc(`https://github.com/login/oauth/authorize?client_id=x&redirect_uri=${enc('https://app.example.com/cb')}`)}`,
      ),
    ).toBeNull();
  });
});

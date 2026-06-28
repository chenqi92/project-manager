import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// 版本号单一来源：读 package.json，避免 manifest 与 package.json 不一致。
// 发布时只改 package.json 的 version 即可。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

// 固定扩展 ID 的公钥（非机密）：让本地 dev / e2e 的 chrome-extension://<id> 与
// 「商店上架版」一致（ID = oiijkibofmpjgiojfidjagnndojplkdm），从而 WebAuthn RP ID 稳定、
// 且 OAuth 重定向 URI（https://<id>.chromiumapp.org/）本地与线上同一个。
// 此公钥即上架项的 CRX 公钥；首次上传商店不能带 key，用 STORE_BUILD=1 构建即去掉。
const EXT_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2GNVj5csTV9OvcVzMn4tzYW7rPvBZN2twUeZVe4fitMpD09sKzEDezOWIpndXL2b5VSj0nImWVfvP4YAf65HjwFhfiLoPWHvztViMr1RoANBF92N5uCJkVYDmYs3MNv2RZFJYJmn2rzQbv16THthLfTRzAv/tzRysuL4IRFKB3Z8V3xyZMvEOwNiLdCc+bKDUToD3tkhkqFbkyVwa1UD2fh1ktrs/S8bq9R9rlMO7gMK6JDSYK9PgjUF5DuAqryYlWYePVPbgYfnlxtX2ndis2v08REv9mOq9NhUEZ7bu5d/msMe98QLWfNEjbgbP1LeLANbfUAdPRFUD8SVmdPrkwIDAQAB';
const STORE_BUILD = process.env.STORE_BUILD === '1';

// WXT config. https://wxt.dev
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '项目环境管家',
    short_name: 'EnvManager',
    description:
      '安全存储并自动填充公司各项目 / 环境 / 平台的登录凭据。数据用主密码在本地端到端加密、仅存密文；可选的自托管同步也只传密文，服务器无法解密。',
    version: pkg.version,
    // 最小权限集：
    //  storage   - 保存加密金库（local）与内存密钥（session）
    //  activeTab      - 仅在用户点击扩展时临时获得当前标签页访问权，用于填充
    //  scripting      - 在用户授权的当前页注入一次性填充函数
    //  idle           - 空闲自动锁定
    //  offscreen      - popup 关闭后仍可清空剪贴板
    //  clipboardWrite - 复制密码后定时清空剪贴板
    // 不申请 <all_urls> / host_permissions，最大限度降低审核摩擦与攻击面。
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'idle',
      'contextMenus',
      'offscreen',
      'clipboardWrite',
      // identity - 网盘（Google Drive / OneDrive）同步走 launchWebAuthFlow 的 OAuth 授权
      'identity',
      // declarativeNetRequestWithHostAccess - 仅对「已授权主机」改请求头：去掉发往
      // 微软令牌端点(login.microsoftonline.com)的 Origin 头。否则微软对「移动和桌面」
      // 客户端的跨源令牌兑换报 AADSTS90023。规则见 public/rules/msft-oauth.json，
      // 仅作用于 XHR/fetch、不碰授权页导航，不读改任何网页内容。
      'declarativeNetRequestWithHostAccess',
    ],
    // 可选站点访问权：基础清单里不申请，由用户在运行时按需对单个来源授权
    // （chrome.permissions.request），审核更友好。两种场景会用到：
    //  - 自托管同步：对用户自己的服务器地址授权。
    //  - 「打开并登录」：对要打开并填充的环境链接所在站点授权。内网开发/测试环境
    //    常为明文 http（内网 IP / 主机名），故 http 不能只限 localhost。
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // 商店首发包（STORE_BUILD=1）不带 key；本地构建带 key 以固定 ID。
    ...(STORE_BUILD ? {} : { key: EXT_KEY }),
    action: { default_title: '项目环境管家' },
    // 地址栏输入 "env" + 空格 即可搜索金库。
    omnibox: { keyword: 'env' },
    // 快捷键（用户可在 chrome://extensions/shortcuts 改键）。
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+P' },
        description: '打开项目环境管家',
      },
      'lock-vault': {
        suggested_key: { default: 'Alt+Shift+L' },
        description: '锁定金库',
      },
      'fill-current': {
        suggested_key: { default: 'Alt+Shift+F' },
        description: '填充当前页',
      },
    },
    // 去掉发往微软令牌端点的 Origin 头（见上方 declarativeNetRequestWithHostAccess 注释）。
    declarative_net_request: {
      rule_resources: [{ id: 'msft_oauth_origin', enabled: true, path: 'rules/msft-oauth.json' }],
    },
    // 严格 CSP：禁止内联脚本与远程代码（MV3 默认已禁远程代码）。
    // 需 'wasm-unsafe-eval' 以允许 Argon2id（hash-wasm）在扩展页/SW 里运行 WebAssembly。
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});

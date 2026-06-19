import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// 固定扩展 ID 的公钥（非机密）：本地 dev / e2e 保持稳定的 chrome-extension://<id>，
// 即 WebAuthn 的 RP ID，避免重载后生物识别凭据失效。
// 首次上传到 Chrome 商店时不能带 key（商店会自己分配），用 STORE_BUILD=1 构建即可去掉。
const EXT_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnf9yn/JCMTch4zNKUigDrl0VbjuWlPb6X/BNtTHG/CwMVmUxK18LL/Ntb+jAPGwp5M7gJSOD6DgkDo1LIodQf3n9Dr2XkizT8WL1dJla1SIBN7kvjdt151tPnjqWt9PagNeePSl8nnB488ZJ6GN6l+Y8Lew2PXm1IA6jOai/edrUleA1yzjvVdYXjUfzuCdz4snjK1pTFRNBgws5DX+ClZ2EV3SFSSTgKzVQzBlW0/xjvKl3QIai9ssrpNg5Qr1q83PyaissR18fW84TC8fcXCYhdY1GmFZvCK3pvHkOAELmyhl8EomNjooYysj5sCfBEovqIKYrFUl1jukYvuTIfwIDAQAB';
const STORE_BUILD = process.env.STORE_BUILD === '1';

// WXT config. https://wxt.dev
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '项目环境管家',
    short_name: 'EnvManager',
    description:
      '安全存储并自动填充公司各项目 / 环境 / 平台的登录凭据。数据本地端到端加密，零知识，不上传服务器。',
    version: '0.1.0',
    // 最小权限集：
    //  storage   - 保存加密金库（local）与内存密钥（session）
    //  activeTab - 仅在用户点击扩展时临时获得当前标签页访问权，用于填充
    //  scripting - 在用户授权的当前页注入一次性填充函数
    //  idle      - 空闲自动锁定
    // 不申请 <all_urls> / host_permissions，最大限度降低审核摩擦与攻击面。
    permissions: ['storage', 'activeTab', 'scripting', 'idle', 'contextMenus'],
    // 自托管同步服务器的访问权限：基础清单里不申请，启用同步时由用户在运行时
    // 针对其自己的服务器地址授权（chrome.permissions.request），审核更友好。
    optional_host_permissions: ['https://*/*', 'http://localhost/*'],
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

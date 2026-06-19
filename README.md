# 项目环境管家（Project Env Manager）

一个用于管理公司多项目、多环境（开发 / 测试 / 预发 / 生产）、多平台链接与多账号密码的 Chrome 扩展。本地端到端加密、零知识，支持一键安全填充、生物识别解锁与自托管同步。

## 功能

- **多层级管理**：项目 → 环境 → 平台/链接 → 多个账号，一个链接可挂多个用户的账号密码。
- **零知识加密**：所有数据用主密码派生的密钥在本地加密后才落盘；落盘只有密文。
- **一键安全填充**：严格精确 origin 匹配（不放宽到子域）、账号选择器在扩展自己的 UI 里、绝不自动提交。
- **生物识别解锁**：Touch ID / Windows Hello（WebAuthn PRF）作为额外解锁方式，主密码始终保留作兜底。
- **自托管同步**：端到端加密同步到你自己的服务器（`server/`），服务器只存密文、无法解密；多设备共享同一金库，按 id + 时间戳 + 墓碑合并。
- **导入导出**：加密备份（推荐）、明文 JSON / CSV，支持从 Chrome、Bitwarden 的 CSV 迁移。
- **全局搜索**、密码生成器、空闲自动锁定。

## 技术栈

WXT · React 19 · TypeScript · Tailwind v4 · Web Crypto（AES-GCM）· hash-wasm（Argon2id）。后端：Hono · SQLite。

## 快速开始

```bash
npm install
npm run dev        # 启动开发模式，自动打开装好扩展的 Chrome（热更新）
# 或
npm run build      # 产物在 .output/chrome-mv3/
```

加载已构建的扩展：打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3/`。

## 安全模型

```
主密码 ──Argon2id──> KEK ──解开──> 随机金库密钥(DEK) ──AES-GCM──> 每条数据密文
                              (信封加密：改密只重包 DEK)
```

- **落盘只有密文**（`chrome.storage.local`）。即使别的程序读到磁盘文件，没有主密码也解不开。
- **密钥只在内存**（service worker + `chrome.storage.session`），浏览器关闭即清；空闲自动锁定。
- **扩展间/网页间隔离**：其它扩展、网页都读不到本扩展的存储。
- **填充安全**：精确 origin 匹配、账号选择在扩展 UI、不自动提交，规避钓鱼与页面注入点击劫持。
- **最小权限**：仅 `storage / activeTab / scripting / idle`，不申请 `<all_urls>`；同步服务器权限在启用时由用户运行时授权（`optional_host_permissions`）。

详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 生物识别（重要）

生物识别的 WebAuthn 流程**必须在 options 页/独立标签页里跑，不能在工具栏 popup 里**（系统指纹弹窗会让 popup 关闭从而中断）。因此：

- 在 popup 里点「生物识别解锁」会打开设置页完成验证。
- 在设置页里注册 / 解锁正常工作。
- 扩展用固定的 `key`（见 `wxt.config.ts`）保证 `chrome-extension://<id>`（即 WebAuthn 的 RP ID）在重载后不变，已注册的凭据不会失效。

## 自托管同步

见 [server/README.md](server/README.md)。零知识：服务器只存取不透明密文 blob，用 revision 做乐观并发，冲突时由客户端解密合并后重推。

## 测试

```bash
npm run compile        # TypeScript 类型检查
npm run test           # Vitest（填充逻辑 + 同步合并）
npm run build          # 构建
npm --prefix server test   # 服务端 API 冒烟
```

## 目录结构

```
entrypoints/        background(SW) / popup / options
lib/                crypto, vault-core, merge, sync, webauthn, import-export, autofill, ...
components/ hooks/   共享 UI 与 React hooks
server/             自托管零知识同步服务（Hono + SQLite）
tests/              Vitest 单测
docs/               隐私政策、上架素材、安全说明
```

## 上架与分发

这是凭据类工具，推荐 **unlisted（未公开列出）或企业强制安装**，而非公开上架。上架素材见 [docs/PRIVACY.md](docs/PRIVACY.md) 与 [docs/STORE.md](docs/STORE.md)。

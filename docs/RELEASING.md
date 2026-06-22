# 发布与自动更新

版本号单一来源是 `package.json` 的 `version`（`wxt.config.ts` 读取它写入 manifest）。

## 一句话流程

改 `package.json` 的 `version` → commit 推到 `main` → GitHub Actions（`.github/workflows/release.yml`）自动：

1. 构建两种包；
2. 建 GitHub Release，附**自分发包**（可下载、直接导入 Chrome）；
3. 若配置了商店密钥，把**商店包**上传到 Chrome 网上应用店并自动发布（仍走商店审核）。

也可在 **Actions → release → Run workflow** 手动触发当前版本。
`v<version>` 标签已存在时会跳过，不会重复发布。

## 两种包的区别

| 包 | 文件名 | key | 用途 |
|---|---|---|---|
| 自分发包 | `envmanager-<ver>-selfhost.zip` | 含（ID 稳定） | 下载解压后「加载已解压」装入 Chrome |
| 商店包 | `envmanager-<ver>-store.zip` | 去（商店分配 ID） | 上传 Chrome 网上应用店 |

`STORE_BUILD=1` 控制是否去掉 key（见 `wxt.config.ts`）。

## 安装自分发包（直接导入 Chrome）

1. 到本仓库 **Releases** 下载 `envmanager-<ver>-selfhost.zip`，解压到一个**固定**文件夹（别删）。
2. 打开 `chrome://extensions`，右上角开「开发者模式」。
3. 点「加载已解压的扩展程序」，选解压出的文件夹。

> Chrome 已禁止商店外直接安装 `.crx`，因此用「加载已解压」。更新时下载新版覆盖同一文件夹、在扩展页点「重新加载」即可；ID 不变。

## 启用「自动发布到 Chrome 网上应用店」需要的准备

只发 GitHub Release **不需要**任何密钥；要自动发到商店才需要下面这些。

### 1. 先手动上架一次

商店条目必须先存在：在 [Chrome 开发者后台](https://chrome.google.com/webstore/devconsole) 手动上传一次 `STORE_BUILD=1 npm run zip` 生成的商店包，填好商店信息，拿到 **Extension ID**。

### 2. 取得 Web Store API 凭据

参考官方文档 <https://developer.chrome.com/docs/webstore/using-api>：

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 新建项目，启用 **Chrome Web Store API**。
2. 配置 OAuth 同意屏幕，创建 **OAuth client ID（类型选 Desktop app）**，得到 `client_id` 与 `client_secret`。
3. 用该 client 走一次 OAuth 授权，换取 **refresh token**（文档里有 curl 步骤）。

### 3. 在 GitHub 配置 Secrets

仓库 **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：

| Secret | 值 |
|---|---|
| `CHROME_EXTENSION_ID` | 商店条目的扩展 ID |
| `CHROME_CLIENT_ID` | OAuth client_id |
| `CHROME_CLIENT_SECRET` | OAuth client_secret |
| `CHROME_REFRESH_TOKEN` | refresh token |

配齐后，下一次版本号变更推送就会自动上传并发布。未配齐时该步骤自动跳过，只发 GitHub Release。

## 注意

- 商店「自动发布」≠ 立即生效：上传后仍需 Chrome 审核，通过后才更新给用户。如需上传但不自动发布，去掉 workflow 里 `--auto-publish`。
- 工作流只用了官方 `actions/checkout`、`actions/setup-node` 和固定大版本的 `chrome-webstore-upload-cli@3`；如需更严的供应链可把它们 pin 到具体 commit SHA。

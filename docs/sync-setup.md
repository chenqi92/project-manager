# 多端同步配置指南

把加密保险箱（含凭据、Markdown 文档、待办）端到端加密同步到自托管服务器 / WebDAV / GitHub·GitLab 私有仓库 / Google Drive / OneDrive / 群晖 NAS。对方只存密文，没有主密码无法解密。

## 通用说明

- 配置入口：扩展 **设置 → 多端同步 → 添加同步目标**。
- 可同时配置**多个目标**，每个目标各自独立操作：
  - **同步**：双向合并（拉取远端 → 端到端合并 → 推回），日常用这个。
  - **强制推送**：用本地整体覆盖远端。
  - **强制拉取**：用远端整体覆盖本地。
- **异库合并**：若远端是用**不同主密码**加密的另一个保险箱，同步时会弹窗让你输入它的主密码，解密后三路合并到本地。
- 文档（Markdown）和待办本就在保险箱内，随整库密文一起同步，无需单独设置。
- 重新加载扩展时，Chrome 会提示接受新增的 `identity` 权限（网盘 OAuth 授权用）。
- 各后端的访问权限按需在保存/授权时由 Chrome 弹窗授予对应域名。

## 方式对比

| 方式 | 申请难度 | 需要 OAuth | 适合 |
|---|---|---|---|
| 自托管服务器 | 中（要部署） | 否 | 完全自控、多设备 |
| WebDAV | 低 | 否 | 已有 Nextcloud / 坚果云 / 群晖 WebDAV |
| GitHub / GitLab 私有仓库 | 低 | 否（用 PAT） | 有 Git 账号、想要版本历史 |
| Google Drive | 高（建 OAuth 应用） | 是 | 已用 Google 生态 |
| OneDrive | 高（Azure 注册） | 是 | 已用微软生态 |
| 群晖 Synology | 中 | 否（支持 OTP） | 自建群晖 NAS，账户开了两步验证 |

---

## 1. 自托管服务器

**适用**：愿意自己跑一台小服务（Node 或 Cloudflare Workers），数据完全自控。

### 部署（Node 版）

```bash
cd server
npm install
npm start          # 首次启动会打印一次性的 Token
```

- 数据库为空（第一次跑）时，控制台打印 `Token: <随机串>`，**整串复制保存**——这就是令牌（只打印这一次）。
- 想自己指定固定令牌：`SYNC_TOKEN=<你的强随机串> npm start`（仅在库里还没账号时生效）。
- 可选环境变量：`PORT`（默认 8787）、`DB_PATH`（默认 `vault.db`）、`SYNC_TOKEN`。
- 自检：访问 `http://localhost:8787/health` 应返回 `ok`。

### 生产环境

服务端只起明文 HTTP，**扩展只连 `https://`**（仅 `http://localhost` 例外），所以正式使用必须用 Nginx/Caddy 反向代理终止 TLS，把 `https://sync.example.com` 转发到内部 `http://127.0.0.1:8787`。

### 或用 Cloudflare Workers（天然 HTTPS，无需自备服务器）

```bash
cd server/cloudflare
npm install && npx wrangler login
npx wrangler d1 create envmanager_sync   # 把 database_id 填进 wrangler.toml
npm run db:init
npx wrangler secret put SYNC_TOKEN       # 这就是扩展里要填的令牌
npm run deploy                           # 得到 https://envmanager-sync.<子域>.workers.dev
```

### 扩展里填

| 字段 | 值 |
|---|---|
| 同步服务器地址 | 基础 URL，**不要带 `/v1`**（会自动补全）。反代后填 `https://sync.example.com`，Cloudflare 填 `https://xxx.workers.dev`，本地填 `http://localhost:8787` |
| 令牌 | 上面拿到的 Token |

多设备：同地址 + 同令牌 + 同主密码即可在各端解锁并自动合并。

**坑**：首次随机 Token 只打印一次，务必当场存好；`SYNC_TOKEN` 只在库里没账号时生效；地址别带 `/v1`（否则变成 `/v1/v1/vault` 404）；单个保险箱密文上限 5MB。

---

## 2. WebDAV（Nextcloud / 坚果云 / 群晖 WebDAV Server）

**适用**：已有支持 WebDAV 的网盘。

> ⚠️ **开了两步验证（2FA）的账户必须用「应用专用密码」，不能用登录密码**，否则一定认证失败 401。

### (a) Nextcloud

- **地址**：`https://你的域名/remote.php/dav/files/<用户名>/`（子目录安装则加子目录段）。可在网页端「文件」页左下角设置里直接复制。
- **应用密码**：头像 → 个人设置 → 安全 → 页面底部「设备与会话」→ 填名字 → 创建新应用密码（只显示一次）。

### (b) 坚果云

- **地址**：固定 `https://dav.jianguoyun.com/dav/`
- **应用密码**：网页端 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用 → 生成密码。
- 配额：免费版 600 请求/30 分钟（本扩展单文件低频读写，正常不触限）。

### (c) 群晖 WebDAV Server

- 套件中心安装 **WebDAV Server**（实用工具分类）→ 设置里开 HTTPS（默认端口 5006）。
- **地址**：`https://NAS地址:5006/<共享文件夹名>/`
- 在 控制面板 → 共享文件夹 → 编辑 → 权限，给该用户读写权限。
- 注：群晖自签证书可能导致 SSL 校验失败，建议用 Let's Encrypt 正式证书。

### 扩展里填

| 字段 | 值 |
|---|---|
| WebDAV 地址（到目录） | 上面各自的 URL（填到**目录**层，末尾斜杠可留） |
| 文件名 / 相对路径 | `vault.enc`（默认即可，只填文件名，不带前导 `/`） |
| 用户名 | 账号 |
| 密码 / 应用密码 | **应用专用密码**（非登录密码） |

并发控制走 ETag + If-Match，三家都支持。

---

## 3. GitHub 私有仓库（Personal Access Token）

**适用**：有 GitHub 账号、想顺带有版本历史。

> ⚠️ **务必用私有仓库**——公开仓库里的加密密文人人可下载、可离线爆破主密码。扩展保存前会自动检测，公开仓库需二次确认才放行。

### 步骤

1. 新建仓库，可见性选 **Private**。记下 owner（用户名/组织名）和 repo，默认分支 `main`。
2. 头像 → **Settings** → 左侧最底部 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
3. 填名称、过期时间；**Resource owner** 选你自己；**Repository access** 选 **Only select repositories** 只勾该仓库。
4. **Repository permissions → Contents 改为 Read and write**（Metadata 会自动变 Read-only，保留即可），其它全 No access。
5. **Generate token**，立刻复制（`github_pat_...`，只显示一次）。

> 兜底：classic token 勾父级 `repo` scope 也能用，但权限覆盖你所有私有仓库，能用 fine-grained 就别用 classic。组织仓库若开了 token 审批，需管理员在 Pending requests 里 Approve。

### 扩展里填

| 字段 | 值 |
|---|---|
| owner | GitHub 用户名或组织名 |
| repo | 仓库名 |
| branch | `main`（按仓库实际默认分支） |
| filePath | `vault.enc`（子目录写 `dir/vault.enc`，不带前导 `/`） |
| token | 上面复制的令牌 |

API：REST `Contents` API（GET/PUT `/repos/{owner}/{repo}/contents/{path}`），用 blob `sha` 做乐观并发。

---

## 4. GitLab 私有仓库（Personal Access Token）

**适用**：gitlab.com 或自建实例。同样**必须 Private**。

### 步骤

1. 新建项目，Visibility 选 **Private**，勾「Initialize repository with a README」确保有默认分支。记下命名空间（owner，群组下可能是多级 `group/subgroup`）和项目 slug（repo）。
2. 头像 → **Edit profile** → **Access** → **Personal access tokens** → Add new token。
3. **勾 `read_repository` + `write_repository`**（两个一起，才能既读又写；嫌麻烦可改单个 `api`，但权限更大）。**过期日必填**（默认 365 天，到期需重建）。
4. 生成并立刻复制（`glpat-...`）。

### 扩展里填

| 字段 | 值 |
|---|---|
| 命名空间/用户（owner） | 个人即用户名；群组填群组路径 |
| 仓库名（repo） | 项目 slug |
| 分支 | `main` |
| 文件路径 | `vault.enc` |
| 访问令牌 | `glpat-...` |
| 自建实例 API 地址 | **仅自建实例填** `https://gitlab.example.com/api/v4`；gitlab.com 留空 |

API：Repository Files API，用 `last_commit_id` 做乐观并发。

---

## 5. Google Drive（OAuth，需自建 client_id）

> ⚠️ **重要**：Google **必须用「Web 应用」客户端类型**（只有它能登记 HTTPS 重定向 URI），且**即便用 PKCE 也强制要 client_secret**（Google 的特例，偏离标准 PKCE）。扩展里 client_secret 对 Google 是**必填**。

### 步骤

1. 进 [console.cloud.google.com](https://console.cloud.google.com) → 顶部项目选择器 → 新建项目。
2. **API 和服务 → 启用 API 和服务 → 搜 Google Drive API → 启用**（不启用后续会 403）。
3. **OAuth 同意屏幕（新版整合进 Google Auth Platform）**：
   - **Branding**：填应用名、用户支持邮箱、开发者联系邮箱。
   - **Audience**：用户类型选 **External**；发布状态保持 **Testing**；在「测试用户」里加上你要授权的 Gmail。
   - **Data Access → 添加或移除范围 → 手动添加范围**，粘贴 `https://www.googleapis.com/auth/drive.appdata`（非敏感范围，不触发审核）。
4. **客户端 → 创建客户端 → 应用类型选「Web 应用」**（不要选桌面应用 / Chrome 扩展，它们填不了 HTTPS 重定向 URI）。
5. **已授权的重定向 URI** 填 **扩展 OAuth 表单顶部显示的那串** `https://<扩展ID>.chromiumapp.org/`（**含尾斜杠，一字不差**）。
6. 创建后弹窗里 **Client ID 和 Client secret 都复制保存**（secret 只完整显示这一次）。

### 扩展里填

| 字段 | 值 |
|---|---|
| 重定向 URI | 表单已显示，复制到第 5 步 |
| client_id | 第 6 步的 Client ID |
| client_secret | 第 6 步的 Client secret（**必填**） |
| 文件名 | `vault.enc` |

填完点「授权」，弹出 Google 登录授权页。密文存在 Drive 的 **appDataFolder 隐藏应用目录**。

**坑**：Testing 模式下 refresh_token 约 **7 天过期**，到期需重新授权；想长期免授权可把应用 **Publish 到 Production**（非敏感范围只需基础验证）。授权时会有「未验证应用」警告页，点「高级 → 继续」即可。扩展 ID 要先固定（本项目带固定 key，dev 下 ID 稳定）。

---

## 6. OneDrive（OAuth，Azure / Entra 注册）

> ⚠️ **重要**：重定向 URI **必须加在「移动和桌面应用程序」平台下，绝不能选 SPA**——SPA 平台会让 refresh_token **24 小时就过期**，破坏长期免登录同步。OneDrive 是公共客户端，**不需要 client_secret**。

### 步骤

1. 进 [entra.microsoft.com](https://entra.microsoft.com) → **标识 → 应用程序 → 应用注册 → 新注册**。
2. 名称随填；**支持的账户类型**选「**任何组织目录中的帐户和个人 Microsoft 帐户**」（对应 token 端点 `/common/`，个人+企业都能用）；重定向 URI 此页**先留空**，点注册。
3. **Overview** 页复制 **Application (client) ID**。
4. **管理 → 身份验证 → 添加平台 → 选「移动和桌面应用程序」**（**不要选 SPA**）→ 在「自定义重定向 URI」粘贴 `https://<扩展ID>.chromiumapp.org/`（含尾斜杠）→ 配置。
5. **API 权限 → 添加权限 → Microsoft Graph → 委托的权限**：勾 `Files.ReadWrite.AppFolder` 和 `offline_access`（个人账户在授权页自助同意，无需管理员）。

### 扩展里填

| 字段 | 值 |
|---|---|
| 重定向 URI | 表单已显示，复制到第 4 步 |
| client_id | 第 3 步的 Application (client) ID |
| client_secret | **留空**（公共客户端不需要） |
| 文件名 | `vault.enc` |

填完点「授权」。密文存在 OneDrive 的 **应用专属文件夹（approot）**。

---

## 7. 群晖 Synology NAS（FileStation API + OTP）

**适用**：自建群晖 NAS，尤其**账户开了两步验证（OTP）**。走 DSM FileStation Web API（不是 WebDAV），原生支持 OTP。

### 工作原理

首次用 **OTP 一次性码登录一次** → 群晖返回**受信设备令牌（did）** → 之后扩展用该令牌**自动免 OTP** 静默登录同步；令牌失效时再提示重输 OTP。

### 前置

- 在 控制面板 → 共享文件夹 → 编辑 → 权限，给同步用的 DSM 用户开放目标共享文件夹读写权限。
- 用 `/home` 路径需在控制面板启用「用户主目录」服务。
- DSM 默认 HTTPS 端口 5001。**建议用受信 HTTPS 证书**（自签证书会导致扩展 fetch 因证书不受信而连接失败）。

### 扩展里填

| 字段 | 值 |
|---|---|
| NAS 地址（含端口） | `https://nas.example.com:5001` |
| 文件路径 | `/home/vault.enc`（**以共享文件夹名开头**） |
| DSM 账户 / 密码 | 该用户的账号密码 |
| OTP 一次性码 | **仅开了两步验证、首次绑定时填**（6 位动态码），平时留空 |

填完点 **「登录并绑定设备」**：
- 开了 2FA：输入 OTP 后绑定，显示「已绑定，之后免 OTP」。
- 没开 2FA：直接显示「登录成功」，无需 OTP。

之后正常「同步」即可。若某天提示「设备令牌失效，请输入 OTP 重新绑定」，再编辑该目标、填一次 OTP 重新绑定。

### API 细节（实现参考）

- 入口 `/webapi/entry.cgi`；登录 `SYNO.API.Auth&version=6&method=login`，参数 `account`/`passwd`/`otp_code`/`enable_device_token=yes`/`device_id=<did>`/`format=sid`/`session=FileStation`；响应返回 `sid` 与 `did`。
- 错误码：`403`=需要 OTP、`404`=OTP 错误、`406`=强制要求 2FA。
- 上传 `SYNO.FileStation.Upload v2`（multipart），下载 `SYNO.FileStation.Download v2`，`SYNO.FileStation.List getinfo v2` 取 `mtime+size` 作并发 tag。

---

## 安全须知

- 所有同步都是**端到端加密**：保险箱用主密码在本地加密，各后端只看到不透明密文。
- Git 公开仓库会被拦截警示——密文公开即可被离线爆破，**只用私有仓库**。
- 网盘的 OAuth 令牌、Git PAT、群晖密码/设备令牌都随保险箱**加密存储**，不以明文落盘。

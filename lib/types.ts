// ---------------------------------------------------------------------------
// 数据模型：项目 → 环境 → 平台/链接 → 多个账号
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  /** 账号备注名，例如「管理员」「测试账号 A」，用于一个链接下区分多个账号 */
  label: string;
  username: string;
  password: string;
  note?: string;
  /** TOTP 两步验证：base32 密钥或 otpauth:// URI */
  totp?: string;
  createdAt: number;
  updatedAt: number;
}

/** 一个 Git 仓库地址（可选指定分支） */
export interface GitRepo {
  id: string;
  /** 克隆地址（https / ssh 均可） */
  url: string;
  /** 指定分支（可选） */
  branch?: string;
  /** 备注（可选），如「后端」「前端」 */
  label?: string;
}

/** 环境下的一个平台 / 入口链接（如「管理后台」「API 控制台」） */
export interface PlatformLink {
  id: string;
  name: string;
  /** 主网址 */
  url: string;
  /** 额外网址（同一平台的多区域/多域名）；匹配填充时主+额外都会比对 */
  urls?: string[];
  /** 关联的 Git 仓库（可一个或多个） */
  gitRepos?: GitRepo[];
  note?: string;
  accounts: Account[];
  updatedAt: number;
}

export type EnvKind = 'dev' | 'test' | 'staging' | 'prod' | 'other';

export interface Environment {
  id: string;
  name: string;
  kind: EnvKind;
  note?: string;
  /** 该环境关联的 Git 仓库（可一个或多个，含分支） */
  gitRepos?: GitRepo[];
  links: PlatformLink[];
  updatedAt: number;
}

/** 项目说明文档（Markdown 源文，支持代码 / mermaid 流程图渲染） */
export interface ProjectDoc {
  id: string;
  title: string;
  /** Markdown 源文 */
  content: string;
  updatedAt: number;
}

/** 备忘条目（项目内的待办 / 提醒） */
export interface MemoItem {
  id: string;
  text: string;
  done: boolean;
  /** 紧急：未完成时在浮动备忘里抖动标红提醒 */
  urgent?: boolean;
  /** 截止时间（epoch ms，可选）；逾期未完成会高亮提醒 */
  dueAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  color?: string;
  favorite?: boolean;
  tags?: string[];
  note?: string;
  /** 项目说明（一个或多个 Markdown 文档） */
  docs?: ProjectDoc[];
  /** 项目备忘（聚合到浮动备忘录） */
  memos?: MemoItem[];
  environments: Environment[];
  createdAt: number;
  updatedAt: number;
}

/** 删除墓碑：用于多设备同步时防止「已删除项被旧副本复活」 */
export interface Tombstone {
  id: string;
  deletedAt: number;
}

/** 自托管同步配置（随保险箱一起加密存储，并在设备间同步） */
export interface SyncConfig {
  serverUrl: string;
  token: string;
  enabled: boolean;
}

/** 同步的设备本地状态（不加密、不同步：只是整数 revision 与时间戳） */
export interface SyncState {
  serverRevision: number;
  lastSyncAt?: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// 多端同步：同一个保险箱可同时配置多个后端（自托管 / WebDAV / Git / 网盘），
// 每个目标各自独立推/拉。配置（含密钥）随保险箱一起加密存储并在设备间同步；
// 运行期的同步状态（tag/时间戳/错误）按目标 id 存在本地，不加密、不参与同步。
// ---------------------------------------------------------------------------

export type SyncTargetType =
  | 'self-hosted'
  | 'webdav'
  | 'github'
  | 'gitlab'
  | 'gitee'
  | 'google-drive'
  | 'onedrive'
  | 'dropbox'
  | 'synology';

interface SyncTargetCommon {
  /** 目标 id（创建时生成，作为本地同步状态 map 的键） */
  id: string;
  type: SyncTargetType;
  /** 用户自定义显示名 */
  label: string;
  /** 是否参与「同步全部」与修改后的自动同步 */
  enabled: boolean;
}

/** 自托管服务器：复用现有 /v1/vault 协议 */
export interface SelfHostedTarget extends SyncTargetCommon {
  type: 'self-hosted';
  serverUrl: string;
  token: string;
}

/** 通用 WebDAV（Nextcloud / 坚果云 / 群晖等） */
export interface WebDavTarget extends SyncTargetCommon {
  type: 'webdav';
  /** 目录或文件所在的基础 URL（不含文件名时与 filePath 拼接） */
  url: string;
  username: string;
  password: string;
  /** 保险箱密文文件名/相对路径，默认 vault.enc */
  filePath: string;
}

/** GitHub / GitLab 仓库（走各自的文件内容 API） */
export interface GitTarget extends SyncTargetCommon {
  type: 'github' | 'gitlab' | 'gitee';
  /** 自建实例的 API base，留空用官方默认 */
  apiBase?: string;
  /** GitHub: owner；GitLab: 命名空间（用于展示，实际用 projectId/owner+repo） */
  owner: string;
  repo: string;
  branch: string;
  /** 仓库内的密文文件路径，默认 vault.enc */
  filePath: string;
  /** Personal Access Token */
  token: string;
}

/** Google Drive / OneDrive / Dropbox：OAuth(PKCE)，client_id 由用户自带（或内置默认） */
export interface OAuthDriveTarget extends SyncTargetCommon {
  type: 'google-drive' | 'onedrive' | 'dropbox';
  clientId: string;
  /** Google：必填（Web 应用客户端即便用 PKCE 也强制要 client_secret）；OneDrive：留空（公共客户端） */
  clientSecret?: string;
  /** 授权后获得，用于离线刷新 access token */
  refreshToken?: string;
  /** Google Drive 文件 id（首次创建后缓存） */
  fileId?: string;
  /** 密文文件名，默认 vault.enc */
  fileName: string;
}

/** 群晖 NAS：走 DSM FileStation Web API，登录支持两步验证(OTP)+受信设备令牌 */
export interface SynologyTarget extends SyncTargetCommon {
  type: 'synology';
  /** DSM 地址，含协议与端口，如 https://nas.example.com:5001 */
  baseUrl: string;
  account: string;
  password: string;
  /** 受信设备令牌(did)：首次用 OTP 登录后获得，之后免 OTP 静默登录 */
  did?: string;
  /** 共享文件夹内的完整路径，须以共享文件夹名开头，如 /home/vault.enc */
  filePath: string;
}

export type SyncTarget =
  | SelfHostedTarget
  | WebDavTarget
  | GitTarget
  | OAuthDriveTarget
  | SynologyTarget;

/** 单个同步目标的设备本地运行状态（不加密、不同步） */
export interface TargetSyncState {
  lastSyncAt?: number;
  lastError?: string;
  /** 远端版本标识（ETag / blob sha / drive etag / revision 串），用于乐观并发 */
  remoteTag?: string;
}

/** 按目标 id 索引的本地同步状态 */
export type SyncStateMap = Record<string, TargetSyncState>;

/** 脱敏后的目标视图（发给 UI）：完整配置但密钥字段被清空，可直接回填到编辑器。 */
export interface SyncTargetView {
  /** 密钥（token/password/refreshToken/clientSecret）已被清空的目标配置 */
  target: SyncTarget;
  /** 给 UI 展示的目标位置摘要，如 owner/repo、服务器域名 */
  summary: string;
  /** OAuth 目标是否已完成授权（有 refreshToken） */
  authorized?: boolean;
  state: TargetSyncState | null;
}

/** 首页仪表盘卡片类型 */
export type DashWidgetType =
  | 'stats'
  | 'todos'
  | 'calendar'
  | 'launcher'
  | 'weather'
  | 'image'
  // 第一批数据磁贴：全部读解锁态内存明文、纯本地、不联网
  | 'clock'
  | 'search'
  | 'totp'
  | 'health'
  | 'recent'
  | 'repos'
  | 'tags'
  | 'doc'
  | 'changed'
  | 'backup'
  // 联网磁贴：需用户显式开启联网 + 授权数据源后才请求
  | 'hotlist'
  | 'stocks'
  // CNB 代码仓库：需配置访问令牌 + 授权 api.cnb.cool 后才请求
  | 'cnb';

export interface DashWidget {
  id: string;
  type: DashWidgetType;
  /** 起始列 0-based（自由定位；缺省时按数组顺序迁移生成） */
  x?: number;
  /** 起始行 0-based */
  y?: number;
  /** 占列数（1..基准列数） */
  w?: number;
  /** 占行数（≥1） */
  h?: number;
  /** @deprecated 旧版列宽，迁移用 */
  span?: number;
  /** 各卡片自有配置 */
  config?: {
    /** 自定义标题（覆盖默认标题） */
    label?: string;
    /** weather */
    city?: string;
    lat?: number;
    lon?: number;
    /** 温度单位：摄氏(默认) / 华氏 */
    unit?: 'c' | 'f';
    /** hotlist / stocks：数据源（内置预设 key 或 'custom'）+ 自定义 URL + 展示条数 */
    source?: string;
    sourceUrl?: string;
    count?: number;
    /** stocks：股票代码，逗号分隔（如 AAPL,600519.SS,0700.HK） */
    symbols?: string;
    /** image */
    dataUrl?: string;
    caption?: string;
    /** 数据绑定：限定到某项目 / 文档 / 标签 */
    projectId?: string;
    docId?: string;
    tag?: string;
    /** launcher / repos / recent：仅展示收藏项目 */
    onlyFavorite?: boolean;
    /** totp / health：默认是否揭示敏感内容（缺省遮蔽） */
    reveal?: boolean;
    /** 磁贴隐私显示：soft 轻度隐蔽，strong 悬停/聚焦前强模糊 */
    privacyMode?: 'off' | 'soft' | 'strong';
  };
}

/** 仪表盘外观（玻璃拟态 + 背景），随看板一起加密存储。 */
export interface DashAppearance {
  /** 背景类型；缺省 'gradient' */
  bg?: 'none' | 'gradient' | 'image';
  /** 预设渐变的 key（见 lib/dashboard.ts 的 GRADIENTS） */
  gradient?: string;
  /** 自上传背景图（dataURL，≤1.5MB，存进加密 vault） */
  imageDataUrl?: string;
  /** 磁贴不透明度 0-100（玻璃拟态强度），缺省 75 */
  tileOpacity?: number;
  /** 磁贴背景模糊 px，缺省 8 */
  tileBlur?: number;
}

/** 一个仪表盘看板（一组磁贴 + 自己的外观）。 */
export interface DashBoard {
  id: string;
  name: string;
  widgets: DashWidget[];
  appearance?: DashAppearance;
}

export interface DashboardConfig {
  /** @deprecated 旧版单看板布局；加载时迁移进 boards，新代码勿直接读 */
  widgets?: DashWidget[];
  /** 多看板（页签切换）；为空时由 widgets 迁移而来 */
  boards?: DashBoard[];
  /** 当前激活看板 id */
  activeBoardId?: string;
}

/** CNB（cnb.cool）代码仓库集成配置（随保险箱一起加密存储并在设备间同步） */
export interface CnbConfig {
  /** 访问令牌（Bearer），加密存储 */
  token?: string;
  /** 要展示的顶层组织 slug（如 njly2013），可多个 */
  orgs?: string[];
  /** API base，留空用默认 https://api.cnb.cool（自建实例可改） */
  apiBase?: string;
}

export interface VaultSettings {
  /** 设置更新时间：用于多端同步时决定首页布局/主题/同步目标等设置的胜者 */
  updatedAt?: number;
  /** 空闲多少分钟后自动锁定；0 表示不自动锁定（不推荐） */
  autoLockMinutes: number;
  kdf: KdfConfig;
  /** @deprecated 旧版单一自托管同步配置；加载时迁移进 syncTargets，新代码勿用 */
  sync?: SyncConfig;
  /** 多端同步目标（自托管 / WebDAV / Git / 网盘），可并存 */
  syncTargets?: SyncTarget[];
  /** 内容修改后是否自动同步；undefined 视为开启 */
  syncAuto?: boolean;
  /** 填充后是否自动提交直接登录；只有 true 才开启 */
  autoSubmit?: boolean;
  /** 主题；undefined 视为跟随系统 */
  theme?: 'light' | 'dark' | 'system';
  /** 首页仪表盘布局 */
  dashboard?: DashboardConfig;
  /** 首页天气卡片是否允许联网获取；默认关闭，仅在用户显式开启后才请求第三方天气服务 */
  weatherEnabled?: boolean;
  /** 是否已展示过首次创建后的备份引导（一次性强提示）；undefined 视为未展示 */
  onboardedBackup?: boolean;
  /** 上次成功导出加密备份的时间（epoch ms）；用于提醒久未备份 */
  lastBackupAt?: number;
  /** 备份提醒「稍后再说」的静默截止时间（epoch ms）；在此之前不再提醒 */
  backupSnoozeUntil?: number;
  /** 是否彻底隐藏右下角的待办悬浮窗；undefined / false 视为显示 */
  floatingMemoHidden?: boolean;
  /** CNB 代码仓库集成（访问令牌 + 要展示的组织） */
  cnb?: CnbConfig;
}

/** 解密后的保险箱明文数据（仅存在于内存中） */
export interface VaultData {
  version: number;
  projects: Project[];
  settings: VaultSettings;
  /** 删除墓碑，用于同步合并 */
  tombstones: Tombstone[];
}

// ---------------------------------------------------------------------------
// 加密相关
// ---------------------------------------------------------------------------

export type KdfConfig =
  | { type: 'argon2id'; memKiB: number; iterations: number; parallelism: number }
  | { type: 'pbkdf2'; iterations: number; hash: 'SHA-256' };

/** AES-GCM 密文：iv 与密文(含 128bit tag)均为 base64 */
export interface CipherText {
  iv: string;
  ct: string;
}

/**
 * 落盘的加密保险箱（信封加密）。
 *  - 主密码 --KDF--> KEK
 *  - KEK 解开 wrappedKey 得到随机 DEK
 *  - DEK 解密 data 得到 VaultData
 * 服务器 / 磁盘 / 其它程序只能看到这个结构，没有主密码无法还原任何明文。
 */
export interface EncryptedVault {
  /** 结构 schema 版本，便于未来迁移 */
  version: number;
  /** 保险箱身份 id，创建时生成、永不改变；同步时用来判断是否同一个保险箱 */
  vaultId: string;
  kdf: KdfConfig;
  /** KEK 派生用的盐（非机密） */
  salt: string;
  /** 被主密码 KEK 包裹的 DEK */
  wrappedKey: CipherText;
  /** 生物识别注册：每个授权器一份用 PRF 派生 KEK 包裹的同一个 DEK 副本 */
  bioEnrollments?: BioEnrollment[];
  /** 被 DEK 加密的 VaultData JSON */
  data: CipherText;
  updatedAt: number;
  /** 本地保存计数（与服务器 revision 无关） */
  revision: number;
}

/** 生物识别注册项（含密文，存于 EncryptedVault） */
export interface BioEnrollment {
  id: string;
  /** 设备 / 授权器名称 */
  label: string;
  /** WebAuthn 凭据 id（base64url） */
  credentialId: string;
  /** PRF 盐（base64，非机密，固定不变） */
  prfSalt: string;
  /** PRF 派生 KEK 包裹的 DEK */
  wrappedKey: CipherText;
  createdAt: number;
}

/** 非机密的注册信息，解锁页用它发起 WebAuthn 断言 */
export interface BioEnrollmentPublic {
  id: string;
  label: string;
  credentialId: string;
  prfSalt: string;
}

// ---------------------------------------------------------------------------
// 消息 / 状态
// ---------------------------------------------------------------------------

/** 保险箱已锁定时后台抛出的错误文案；UI 据此把「保存失败」转为跳转锁屏。 */
export const VAULT_LOCKED_MSG = '保险箱已锁定';

export interface VaultStatus {
  /** 是否已创建过保险箱（设置过主密码） */
  initialized: boolean;
  /** 当前是否处于锁定状态 */
  locked: boolean;
  autoLockMinutes: number;
  /** 是否已注册过生物识别解锁 */
  hasBiometric: boolean;
  /** 同步是否已启用 */
  syncEnabled: boolean;
}

/** 登录捕获：检测到一次登录后等待用户确认保存/更新 */
export interface CapturePending {
  kind: 'new' | 'update';
  origin: string;
  url: string;
  username: string;
  password: string;
  accountId?: string;
  /** 展示用：匹配到的链接名（update 时） */
  linkName?: string;
}

export type ExportMode = 'encrypted' | 'json' | 'csv';
export type ImportMode = 'merge' | 'replace';
export type ImportFormat =
  | 'encrypted'
  | 'json'
  | 'csv'
  | 'chrome-csv'
  | 'bitwarden-csv'
  | '1password-csv'
  | 'google-authenticator';

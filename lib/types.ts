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

export interface VaultSettings {
  /** 空闲多少分钟后自动锁定；0 表示不自动锁定（不推荐） */
  autoLockMinutes: number;
  kdf: KdfConfig;
  sync?: SyncConfig;
  /** 填充后是否自动提交直接登录；undefined 视为开启 */
  autoSubmit?: boolean;
  /** 主题；undefined 视为跟随系统 */
  theme?: 'light' | 'dark' | 'system';
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

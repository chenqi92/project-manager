# 安全模型

## 加密（零知识 / 信封加密）

```
主密码 ──Argon2id(m=19MiB,t=3,p=1)──> KEK
                                       │ 包裹
随机保险箱密钥 DEK(256bit) <─────────────┘
        │ AES-GCM-256（每条记录全新 96bit IV，128bit tag）
        ▼
      VaultData 密文
```

- **DEK** 随保险箱创建时随机生成，是真正加密数据的密钥。
- **KEK** 由主密码经 Argon2id 派生（浏览器无原生 Argon2 时回退 PBKDF2-600k），只用来包裹 DEK。
- **改主密码**只需用新 KEK 重新包裹同一个 DEK（O(1)），无需重新加密整库。
- 加密原语见 [lib/crypto.ts](../lib/crypto.ts)、信封逻辑见 [lib/vault-core.ts](../lib/vault-core.ts)。

## 密钥生命周期

- DEK 仅存于**内存**：service worker 变量 + `chrome.storage.session`（纯内存、不落盘、关浏览器即清，且设为 `TRUSTED_CONTEXTS`，content script 读不到）。
- 主密码、KEK、DEK **从不写入** `chrome.storage.local` / `IndexedDB` / `localStorage`。
- 空闲（`chrome.idle`）或超时自动锁定，清空内存密钥。

## 威胁模型：谁能/不能读到密码

| 主体 | 能否读到明文 | 说明 |
|---|---|---|
| 其它扩展 | ❌ | `chrome.storage` 按扩展隔离 |
| 网页 / 其它来源的 content script | ❌ | 隔离世界，读不到本扩展存储/变量 |
| 同步服务器运营者 | ❌ | 只存密文，零知识 |
| 拿到磁盘文件的本地程序/木马 | ❌（密文） | 落盘是密文，无主密码不可解 |
| 已解锁时做内存取证的本地攻击者 | ⚠️ | 解锁期间 DEK 在内存——靠全盘加密 + 系统账户卫生 + 自动锁定缓解 |
| 被填充的钓鱼/被攻陷页面 | ⚠️ | 故用精确 origin 匹配、不自动提交、选择器在扩展 UI 内 |

工作区、首页看板布局、项目说明文档、待办、链接补充字段和账号补充字段都属于同一个 `VaultData`，写盘和同步时统一加密。其它软件即使读取到浏览器本地存储或同步端文件，也只能看到 `EncryptedVault` 密文；但在保险箱已解锁期间，本机恶意软件仍可能通过内存取证或模拟用户操作攻击，这是本地密码管理器共同的边界。

## 填充安全

- **精确 origin 匹配**：scheme+host+port 完全一致才填，**不放宽到子域 / eTLD+1**（最常见的钓鱼面）。见 [lib/autofill.ts](../lib/autofill.ts)。
- **不自动提交**、需用户显式点击；账号选择器渲染在扩展自己的 UI（popup），不在页面 DOM 注入选择器，规避 DOM 点击劫持（DEF CON 33, 2025）。
- 填充函数为一次性注入、自包含，只在用户手势下经 `activeTab` 注入到当前页。

## 生物识别（WebAuthn PRF）

- Touch ID / Windows Hello 经 WebAuthn PRF（hmac-secret）派生 32 字节 secret，再经 HKDF-SHA256 得到一把 KEK，**额外**包裹同一个 DEK。
- **主密码始终保留作根**：丢失授权器不会锁死保险箱；每台设备各自注册一份包裹副本。
- 仪式必须在 options 页/独立标签页里进行（不能在 popup），RP ID 取扩展自身 origin。详见 [lib/webauthn.ts](../lib/webauthn.ts)。

## 同步合并

多设备共享同一保险箱（同一 DEK / `vaultId`）。合并在客户端解密后进行：工作区、项目、链接、账号、文档、待办按稳定 id 合并，逐项以 `updatedAt` 取较新者，删除用墓碑表达以防复活。服务器只用整数 revision 做乐观并发，绝不接触明文。见 [lib/merge.ts](../lib/merge.ts)、[lib/sync.ts](../lib/sync.ts)。

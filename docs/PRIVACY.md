# 隐私政策 / Privacy Policy

**生效日期：2026-06-19**

> 上架时请把本文件发布到一个**公开、无登录墙、HTTPS** 的地址（如 GitHub Pages / Cloudflare Pages），并把该 URL 填入 Chrome 开发者后台的 Privacy 标签页。下文据实填写，请勿与实际行为不一致。

「项目环境管家」是一个**本地优先、端到端加密**的凭据管理 Chrome 扩展。

## 1. 我们收集哪些数据

- 你创建的**凭据**：用户名、密码、链接地址、备注。
- 应用**设置 / 偏好**（如自动锁定时长、同步配置）。
- 我们**不收集**浏览历史、分析/遥测、IP 日志，也**没有任何数据被发送到开发者的服务器**——开发者不运营任何服务器，不接收任何用户数据。

## 2. 数据如何被使用

仅用于在你自己的设备上**存储、填充、管理你的凭据**，无其它用途。

## 3. 存储与加密

- 所有金库数据在写入磁盘前先在**本地加密**：AES-256-GCM，密钥由你的**主密码**经 Argon2id / PBKDF2 派生。主密码与派生密钥**永不离开你的设备**。
- 静态数据存于本地扩展存储（`chrome.storage.local`），明文凭据仅在金库解锁期间短暂存在于内存。

## 4. 可选的自托管同步

- 同步**默认关闭**，需手动开启。开启后，扩展只会把**已加密的金库（密文）**上传到**你自己配置并运营**的同步服务器。
- 所有同步流量走 HTTPS/TLS。服务器只存密文，**运营者无法解密**你的数据，对你的凭据与主密码零知识。
- 你可随时关闭同步并删除远端副本。

## 5. 数据共享与披露

我们**不出售、不共享、不向任何第三方转移**你的数据。无广告、无数据经纪、无分析合作方。**共享：无。**

## 6. 数据保留

数据在本地持续保存，直到你删除或卸载扩展。开启同步时，密文在你的服务器上保留，直到你在那里删除。卸载将清除本地数据。

## 7. 你的权利与控制

你可在扩展内随时**查看、编辑、导出、删除**全部数据，无需向我们提出请求。

## 8. 政策变更

任何实质性变更都会更新本页的「生效日期」。

## 9. 联系方式

如有疑问或数据相关请求，请联系：`<your-contact-email>`。

---

## Limited Use 声明（请同时放在主页/本页）

> The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements. All credential data is end-to-end encrypted on the user's device, is used solely to provide the extension's password-management function, is never sold or transferred to third parties, is never used for advertising, and is never read by the developer (the developer operates no servers; where optional sync is enabled, the operator stores only ciphertext).

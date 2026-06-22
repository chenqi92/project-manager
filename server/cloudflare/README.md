# Cloudflare Workers + D1 同步服务

`server/src`（Node + better-sqlite3）**不能**直接跑在 Cloudflare Workers 上（Workers 无 Node 原生模块 / 文件系统）。这里是等价的 Workers 版：业务逻辑相同，存储换成 **D1**（Cloudflare 的 SQLite）。

## 部署（约 5 步）

```bash
cd server/cloudflare
npm install
npx wrangler login

# 1) 建 D1 数据库，把输出里的 database_id 填进 wrangler.toml
npx wrangler d1 create envmanager_sync

# 2) 建表（远端）
npm run db:init           # = wrangler d1 execute envmanager_sync --remote --file=schema.sql

# 3) 设置同步 token（这就是扩展里要填的 Token，取个强随机串）
npx wrangler secret put SYNC_TOKEN

# 4) 部署
npm run deploy
```

部署后得到形如 `https://envmanager-sync.<你的子域>.workers.dev` 的地址。

## 在扩展里启用

设置 → 自托管同步：
- 服务器地址：上面的 `https://...workers.dev`
- 令牌：你在 `wrangler secret put SYNC_TOKEN` 设的值

首次请求会用该 token 自动建账号；之后多设备用**同一个地址 + token**，再用**同一主密码**解锁即可。

## 本地联调

```bash
npx wrangler dev          # 本地起 http://localhost:8787（用 --remote 则连真实 D1）
```
扩展允许 `http://localhost`，可直接填本地地址测试。

## 说明 / 限制

- 仍是零知识：D1 里只有密文 blob 与 revision，服务器看不到明文。
- PUT 用 revision 乐观锁。Workers + D1 的「读-改-写」之间无交互式事务，单用户场景足够；多端高并发若需强一致 CAS，可改用 **Durable Objects**。
- 想多账号：给每个 token 在 `accounts` 表插一行（`token_hash = sha256(token)`），或扩展自举逻辑。

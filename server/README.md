# 同步服务端（零知识）

端到端加密的自托管同步服务。**服务器只存取不透明的密文 blob**，永远看不到明文或密钥。

## 运行

```bash
cd server
npm install
npm start            # 默认监听 8787
```

首次启动会自动创建一个同步账号并打印 **Account ID** 与 **Token**，把 Token 复制到扩展的「设置 → 自托管同步」即可。

环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `8787` |
| `DB_PATH` | SQLite 文件路径 | `vault.db` |
| `SYNC_TOKEN` | 指定首个账号的固定 Token（否则随机生成） | — |

```bash
SYNC_TOKEN=your-strong-token DB_PATH=/data/vault.db PORT=8787 npm start
```

> 生产环境务必置于 **HTTPS** 反向代理（Nginx/Caddy）之后，并做限流。扩展只会连 `https://`（本地开发可用 `http://localhost`）。

## API

所有 `/v1/*` 需 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/vault/meta` | `{ exists, revision, updatedAt }`，便宜的轮询 |
| GET | `/v1/vault` | 拉取密文 EncryptedVault（404 表示空） |
| PUT | `/v1/vault` | body `{ baseRevision, vault }`；成功 `{ revision }`，过期返回 `409 { currentRevision, current }` |
| DELETE | `/v1/vault` | 删除远端副本 |

并发用 revision 乐观锁：客户端带上一次已知的 `baseRevision`，与服务器列 revision 不一致即 409，由客户端**解密双方 → 合并 → 重新加密 → 重推**。服务器绝不解析 `vault.data`。

## 部署到 Cloudflare Workers（可选）

`src/app.ts` 的 Hono 处理逻辑与运行时无关。迁移时只需把 `src/db.ts` 的 SQLite 换成 **D1**（同样的建表 SQL）或 **KV**（`account_id` 为 key），业务逻辑（鉴权、revision 校验、409）保持不变。需要强一致的 revision CAS 时优先用 D1 / Durable Objects 而非 KV。

## 多设备

第一台设备启用同步后，其它设备在解锁页选「从同步服务器恢复」，填入服务器地址 + Token 拉取保险箱，再用**同一个主密码**解锁，之后即按 id + 时间戳 + 墓碑自动合并。

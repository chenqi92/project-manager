// ---------------------------------------------------------------------------
// Cloudflare Workers + D1 版的零知识同步服务（与 Node 版 server/src 等价）。
// 只读写不透明密文 blob 与 revision，绝不解密。
// 账号自举：用 wrangler secret 配的 SYNC_TOKEN 首次请求时建账号，之后即用该 token。
// ---------------------------------------------------------------------------
import { Hono } from 'hono';

interface Env {
  DB: D1Database;
  /** 预共享 token（wrangler secret put SYNC_TOKEN）；首次用它请求会自动建账号。 */
  SYNC_TOKEN?: string;
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const app = new Hono<{ Bindings: Env; Variables: { accountId: string } }>();

app.get('/health', (c) => c.text('ok'));

app.use('/v1/*', async (c, next) => {
  const tok = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!tok) return c.json({ error: 'unauthorized' }, 401);
  const hash = await sha256hex(tok);
  let acct = await c.env.DB.prepare('SELECT account_id FROM accounts WHERE token_hash = ?')
    .bind(hash)
    .first<{ account_id: string }>();
  // 自举：配了 SYNC_TOKEN 且本次正是它，但还没账号 -> 建一个。
  if (!acct && c.env.SYNC_TOKEN && tok === c.env.SYNC_TOKEN) {
    const accountId = crypto.randomUUID();
    await c.env.DB.prepare('INSERT INTO accounts (account_id, token_hash, created_at) VALUES (?, ?, ?)')
      .bind(accountId, hash, Date.now())
      .run();
    acct = { account_id: accountId };
  }
  if (!acct) return c.json({ error: 'unauthorized' }, 401);
  c.set('accountId', acct.account_id);
  await next();
});

app.get('/v1/vault/meta', async (c) => {
  const v = await c.env.DB.prepare('SELECT revision, updated_at FROM vaults WHERE account_id = ?')
    .bind(c.get('accountId'))
    .first<{ revision: number; updated_at: number }>();
  return c.json({ exists: Boolean(v), revision: v?.revision ?? 0, updatedAt: v?.updated_at ?? null });
});

app.get('/v1/vault', async (c) => {
  const v = await c.env.DB.prepare('SELECT blob FROM vaults WHERE account_id = ?')
    .bind(c.get('accountId'))
    .first<{ blob: string }>();
  if (!v) return c.json({ error: 'empty' }, 404);
  return c.json(JSON.parse(v.blob));
});

app.put('/v1/vault', async (c) => {
  const accountId = c.get('accountId');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  const { baseRevision, vault } = (body ?? {}) as {
    baseRevision?: number;
    vault?: Record<string, unknown>;
  };
  if (typeof baseRevision !== 'number' || !vault) return c.json({ error: 'bad_request' }, 400);

  const cur = await c.env.DB.prepare('SELECT blob, revision FROM vaults WHERE account_id = ?')
    .bind(accountId)
    .first<{ blob: string; revision: number }>();
  const curRev = cur?.revision ?? 0;
  if (baseRevision !== curRev) {
    return c.json(
      { error: 'revision_conflict', currentRevision: curRev, current: cur ? JSON.parse(cur.blob) : null },
      409,
    );
  }
  const next = curRev + 1;
  await c.env.DB.prepare(
    `INSERT INTO vaults (account_id, blob, revision, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET blob = excluded.blob, revision = excluded.revision, updated_at = excluded.updated_at`,
  )
    .bind(accountId, JSON.stringify(vault), next, Date.now())
    .run();
  return c.json({ revision: next });
});

app.delete('/v1/vault', async (c) => {
  await c.env.DB.prepare('DELETE FROM vaults WHERE account_id = ?').bind(c.get('accountId')).run();
  return c.json({ ok: true });
});

export default app;

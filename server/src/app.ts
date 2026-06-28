import { Hono } from 'hono';
import type { Store } from './db';

type Env = { Variables: { accountId: string } };

/** 单个保险箱密文 blob 的大小上限（5 MB），防止单账号无限写入耗尽存储。 */
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_BLOB_BYTES + 64 * 1024;

async function readLimitedJson(req: Request): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: 'bad_json' | 'too_large' }
> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return { ok: false, status: 413, error: 'too_large' };
  }
  const body = req.body;
  if (!body) return { ok: false, status: 400, error: 'bad_json' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: 'too_large' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'bad_json' };
  }
}

/**
 * 零知识同步 API。
 *   GET  /v1/vault/meta  -> { exists, revision, updatedAt }   便宜的轮询
 *   GET  /v1/vault       -> EncryptedVault | 404              拉取
 *   PUT  /v1/vault       { baseRevision, vault } -> { revision } | 409 { current }  推送(乐观并发)
 *   DELETE /v1/vault     -> { ok }                            关闭同步并删除远端
 * 服务器只读写密文 blob 与 revision，绝不解密。
 */
export function createApp(store: Store): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/health', (c) => c.text('ok'));

  app.use('/v1/*', async (c, next) => {
    const tok = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!tok) return c.json({ error: 'unauthorized' }, 401);
    const acct = store.accountByToken(tok);
    if (!acct) return c.json({ error: 'unauthorized' }, 401);
    c.set('accountId', acct.account_id);
    await next();
  });

  app.get('/v1/vault/meta', (c) => {
    const v = store.getVault(c.get('accountId'));
    return c.json({
      exists: Boolean(v),
      revision: v?.revision ?? 0,
      updatedAt: v?.updated_at ?? null,
    });
  });

  app.get('/v1/vault', (c) => {
    const v = store.getVault(c.get('accountId'));
    if (!v) return c.json({ error: 'empty' }, 404);
    return c.json(JSON.parse(v.blob));
  });

  app.put('/v1/vault', async (c) => {
    const accountId = c.get('accountId');
    const parsed = await readLimitedJson(c.req.raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    const { baseRevision, vault } = (body ?? {}) as {
      baseRevision?: number;
      vault?: Record<string, unknown>;
    };
    if (typeof baseRevision !== 'number' || !vault) {
      return c.json({ error: 'bad_request' }, 400);
    }

    const cur = store.getVault(accountId);
    const curRev = cur?.revision ?? 0;
    if (baseRevision !== curRev) {
      // 乐观并发冲突：把当前密文 + 服务器 revision 回给客户端，由其解密合并后重推。
      return c.json(
        {
          error: 'revision_conflict',
          currentRevision: curRev,
          current: cur ? JSON.parse(cur.blob) : null,
        },
        409,
      );
    }

    // 服务器只用独立的列 revision 做并发令牌，绝不改写密文 blob 内部字段。
    const blob = JSON.stringify(vault);
    if (new TextEncoder().encode(blob).byteLength > MAX_BLOB_BYTES) {
      return c.json({ error: 'too_large' }, 413);
    }
    const next = curRev + 1;
    store.putVault(accountId, blob, next);
    return c.json({ revision: next });
  });

  app.delete('/v1/vault', (c) => {
    store.deleteVault(c.get('accountId'));
    return c.json({ ok: true });
  });

  return app;
}

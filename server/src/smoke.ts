// 服务端冒烟测试：直接用 app.fetch 驱动，无需开端口。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import { Store } from './db';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('FAIL: ' + msg);
}

const dir = mkdtempSync(join(tmpdir(), 'pem-sync-'));
const store = new Store(join(dir, 't.db'));
const { token } = store.createAccount('testtoken');
const app = createApp(store);

const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const base = 'http://x';
const vault = {
  version: 1,
  kdf: { type: 'argon2id' },
  salt: 's',
  wrappedKey: { iv: 'a', ct: 'b' },
  data: { iv: 'c', ct: 'd' },
  updatedAt: 0,
  revision: 0,
};

async function main(): Promise<void> {
  assert((await app.fetch(new Request(base + '/health'))).status === 200, 'health');
  assert((await app.fetch(new Request(base + '/v1/vault/meta'))).status === 401, '无 token 应 401');
  assert(
    (await app.fetch(new Request(base + '/v1/vault/meta', { headers: { Authorization: 'Bearer wrong' } }))).status === 401,
    '错误 token 应 401',
  );

  let r = await app.fetch(new Request(base + '/v1/vault/meta', { headers: H }));
  let j: any = await r.json();
  assert(j.exists === false && j.revision === 0, 'meta 空库');

  r = await app.fetch(new Request(base + '/v1/vault', { headers: H }));
  assert(r.status === 404, '空库 pull 应 404');

  r = await app.fetch(
    new Request(base + '/v1/vault', { method: 'PUT', headers: H, body: JSON.stringify({ baseRevision: 0, vault }) }),
  );
  j = await r.json();
  assert(r.status === 200 && j.revision === 1, '首次推送 -> rev 1');

  r = await app.fetch(
    new Request(base + '/v1/vault', { method: 'PUT', headers: H, body: JSON.stringify({ baseRevision: 0, vault }) }),
  );
  assert(r.status === 409, '过期 baseRevision 应 409');
  j = await r.json();
  assert(j.currentRevision === 1 && j.current.salt === 's', '409 应回传 currentRevision 与当前密文');

  r = await app.fetch(
    new Request(base + '/v1/vault', { method: 'PUT', headers: H, body: JSON.stringify({ baseRevision: 1, vault }) }),
  );
  j = await r.json();
  assert(j.revision === 2, '正确 baseRevision -> rev 2');

  r = await app.fetch(new Request(base + '/v1/vault', { headers: H }));
  j = await r.json();
  assert(j.salt === 's', 'pull 回原样密文（blob 内部字段不被服务器改写）');
  r = await app.fetch(new Request(base + '/v1/vault/meta', { headers: H }));
  j = await r.json();
  assert(j.revision === 2, 'meta 列 revision = 2');

  r = await app.fetch(new Request(base + '/v1/vault', { method: 'DELETE', headers: H }));
  assert(r.status === 200, 'delete ok');
  r = await app.fetch(new Request(base + '/v1/vault', { headers: H }));
  assert(r.status === 404, '删除后 pull 应 404');

  rmSync(dir, { recursive: true, force: true });
  console.log('✅ SERVER SMOKE TESTS PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

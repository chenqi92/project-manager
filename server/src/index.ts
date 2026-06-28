import { serve } from '@hono/node-server';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createApp } from './app';
import { Store } from './db';

const dbPath = process.env.DB_PATH ?? 'vault.db';
const store = new Store(dbPath);

function writeCredentialsFile(accountId: string, token: string): string {
  const target = resolve(
    process.env.SYNC_CREDENTIALS_PATH ?? resolve(dirname(resolve(dbPath)), 'sync-credentials.json'),
  );
  const ext = extname(target);
  const fallback = ext
    ? target.slice(0, -ext.length) + '-' + Date.now() + ext
    : target + '-' + Date.now();
  const payload = JSON.stringify(
    { accountId, token, createdAt: new Date().toISOString() },
    null,
    2,
  ) + '\n';

  for (const path of [target, fallback]) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, payload, { mode: 0o600, flag: 'wx' });
      chmodSync(path, 0o600);
      return path;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || path === fallback) throw e;
    }
  }
  return fallback;
}

// 首次运行自动创建一个同步账号，凭据写入本地受限权限文件（复制到扩展设置里）。
// 可用 SYNC_TOKEN 环境变量指定固定 token。
if (store.countAccounts() === 0) {
  const { accountId, token } = store.createAccount(process.env.SYNC_TOKEN);
  console.log('\n=== 已创建首个同步账号（复制到扩展「设置 → 同步」）===');
  console.log('  Account ID :', accountId);
  if (process.env.SYNC_TOKEN) {
    console.log('  Token      : 使用 SYNC_TOKEN 环境变量（不在日志中输出）');
  } else {
    console.log('  凭据文件   :', writeCredentialsFile(accountId, token));
  }
  console.log('====================================================\n');
}

const app = createApp(store);
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`同步服务已启动: http://localhost:${info.port}`);
  console.log('提示：生产环境务必置于 HTTPS 反向代理之后。');
});

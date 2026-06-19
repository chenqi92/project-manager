import { serve } from '@hono/node-server';
import { createApp } from './app';
import { Store } from './db';

const store = new Store(process.env.DB_PATH ?? 'vault.db');

// 首次运行自动创建一个同步账号并打印凭据（复制到扩展设置里）。
// 可用 SYNC_TOKEN 环境变量指定固定 token。
if (store.countAccounts() === 0) {
  const { accountId, token } = store.createAccount(process.env.SYNC_TOKEN);
  console.log('\n=== 已创建首个同步账号（复制到扩展「设置 → 同步」）===');
  console.log('  Account ID :', accountId);
  console.log('  Token      :', token);
  console.log('====================================================\n');
}

const app = createApp(store);
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`同步服务已启动: http://localhost:${info.port}`);
  console.log('提示：生产环境务必置于 HTTPS 反向代理之后。');
});

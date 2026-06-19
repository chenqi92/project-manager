// 真机 e2e：用 puppeteer-core 驱动本机 Chrome，加载未打包扩展，跑完整流程并截图。
// 运行：node scripts/e2e.mjs
import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** 由 manifest.key（公钥 DER 的 base64）推导扩展固定 ID。 */
function extIdFromManifestKey(extDir) {
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  const der = Buffer.from(manifest.key, 'base64');
  const hex = createHash('sha256').update(der).digest().subarray(0, 16).toString('hex');
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// 优先用 CHROME_BIN（如 Chrome for Testing），否则回退系统 Chrome。
// 注意：Chrome 137+ 稳定版已移除 --load-extension，自动化需用 Chrome for Testing。
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = resolve('.output/chrome-mv3');
const SHOTS = '/tmp/pem-e2e';
const MASTER = 'Test-master-123';

mkdirSync(SHOTS, { recursive: true });
const userDataDir = mkdtempSync(join(tmpdir(), 'pem-e2e-'));
const results = [];
const errors = [];
const ok = (m) => { results.push('✅ ' + m); console.log('✅ ' + m); };
const fail = (m) => { results.push('❌ ' + m); console.log('❌ ' + m); };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickText(page, text, sel = 'button') {
  await page.waitForFunction(
    (t, s) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(t)),
    { timeout: 10000 },
    text,
    sel,
  );
  const done = await page.evaluate(
    (t, s) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
      if (el) { el.click(); return true; }
      return false;
    },
    text,
    sel,
  );
  if (!done) throw new Error('未找到可点击元素: ' + text);
}

async function typeP(page, placeholder, value) {
  const sel = `input[placeholder="${placeholder}"]`;
  await page.waitForSelector(sel, { timeout: 10000 });
  await page.click(sel);
  await page.type(sel, value, { delay: 10 });
}

async function waitText(page, text) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 12000 }, text);
}

async function waitGone(page, placeholder) {
  await page.waitForFunction(
    (s) => !document.querySelector(s),
    { timeout: 10000 },
    `input[placeholder="${placeholder}"]`,
  );
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir,
  defaultViewport: { width: 1280, height: 820 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    // Chrome 126+ 默认禁用了 --load-extension 命令行开关，需显式关掉该限制。
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  // 扩展 ID 由固定 key 推导（不依赖 SW target 可见性）。
  const extId = extIdFromManifestKey(EXT);
  await wait(1500); // 给扩展加载一点时间

  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });

  // 1. 打开 options，创建主密码
  await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'domcontentloaded' });
  try {
    await waitText(page, '创建主密码');
  } catch {
    console.log('options 页内容:', (await page.evaluate(() => document.body.innerText)).slice(0, 200));
    console.log('targets:');
    for (const t of browser.targets()) console.log(`  [${t.type()}] ${t.url()}`);
    throw new Error(`扩展似乎未加载（ID=${extId}）`);
  }
  ok(`扩展已加载，ID=${extId}`);
  await page.screenshot({ path: join(SHOTS, '01-create.png') });
  await typeP(page, '主密码', MASTER);
  await typeP(page, '再次输入', MASTER);
  await clickText(page, '创建并解锁');
  await waitText(page, '新建项目');
  ok('创建主密码并进入主界面');
  await page.screenshot({ path: join(SHOTS, '02-empty.png') });

  // 2. 新建项目
  await clickText(page, '新建项目');
  await typeP(page, '例如：电商平台', '支付平台');
  await clickText(page, '保存');
  await waitGone(page, '例如：电商平台');
  await waitText(page, '支付平台');
  ok('新建项目「支付平台」');

  // 3. 新建环境
  await clickText(page, '新建环境');
  await typeP(page, '例如：开发环境', '生产环境');
  await clickText(page, '保存');
  await waitGone(page, '例如：开发环境');
  await waitText(page, '生产环境');
  ok('新建环境「生产环境」');

  // 4. 新建链接
  await clickText(page, '链接');
  await typeP(page, '例如：管理后台', '管理后台');
  await typeP(page, 'https://admin.example.com', 'https://admin.test.local/login');
  await clickText(page, '保存');
  await waitGone(page, '例如：管理后台');
  await waitText(page, '管理后台');
  ok('新建链接「管理后台」');

  // 5. 新建账号（label 用 placeholder，username/password 用 Tab 切换）
  await clickText(page, '账号');
  await typeP(page, '例如：管理员 / 测试账号', '管理员');
  await page.keyboard.press('Tab');
  await page.keyboard.type('admin', { delay: 10 });
  await page.keyboard.press('Tab');
  await page.keyboard.type('p@ssw0rd!', { delay: 10 });
  await typeP(page, 'base32 密钥 或 otpauth://...', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  await clickText(page, '保存');
  await waitGone(page, '例如：管理员 / 测试账号');
  await waitText(page, 'admin');
  ok('新建账号「管理员 / admin」');

  await page.waitForSelector('button[title="复制验证码"]', { timeout: 5000 });
  ok('TOTP 验证码已实时生成');
  await page.screenshot({ path: join(SHOTS, '03-filled.png') });

  // 6. 锁定 -> 解锁，验证数据持久化（真实 chrome.storage 加密往返）
  await clickText(page, '锁定');
  await waitText(page, '解锁保险箱');
  ok('已锁定');
  await page.screenshot({ path: join(SHOTS, '04-locked.png') });
  await typeP(page, '主密码', MASTER);
  await clickText(page, '解锁');
  await waitText(page, '支付平台');
  await waitText(page, 'admin');
  ok('解锁后数据完好（真实加密存储往返通过）');
  await page.screenshot({ path: join(SHOTS, '05-after-unlock.png') });

  // 7. 错误主密码应被拒
  await clickText(page, '锁定');
  await waitText(page, '解锁保险箱');
  await typeP(page, '主密码', 'wrong-password');
  await clickText(page, '解锁');
  await waitText(page, '主密码错误');
  ok('错误主密码被正确拒绝');
  // 用正确密码恢复
  await page.$eval('input[placeholder="主密码"]', (el) => (el.value = ''));
  await typeP(page, '主密码', MASTER);
  await clickText(page, '解锁');
  await waitText(page, '支付平台');

  // 8. 密码健康审计面板
  await clickText(page, '审计');
  await waitText(page, '密码健康审计');
  await waitText(page, '弱密码');
  ok('密码健康审计面板正常');
  await page.keyboard.press('Escape');

  // 8b. 深色模式渲染
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await wait(300);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: join(SHOTS, '07-dark.png') });
  ok(`深色模式渲染（body bg=${bg}）`);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // 9. popup 渲染 + 运行时错误检查
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => errors.push('popup pageerror: ' + e.message));
  popup.on('console', (m) => {
    if (m.type() === 'error') errors.push('popup console.error: ' + m.text());
  });
  await popup.setViewport({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await wait(800);
  await popup.screenshot({ path: join(SHOTS, '06-popup.png') });
  ok('popup 正常渲染');

  if (errors.length === 0) ok('全程无运行时 console / page 错误');
  else fail(`捕获到 ${errors.length} 条运行时错误`);
} catch (e) {
  fail('流程异常: ' + (e?.message ?? e));
} finally {
  console.log('\n==== E2E 结果 ====');
  results.forEach((r) => console.log(r));
  if (errors.length) {
    console.log('\n---- 运行时错误 ----');
    errors.forEach((e) => console.log('  ' + e));
  }
  console.log('\n截图目录:', SHOTS);
  await browser.close();
  rmSync(userDataDir, { recursive: true, force: true });
  const failed = results.some((r) => r.startsWith('❌'));
  process.exit(failed ? 1 : 0);
}

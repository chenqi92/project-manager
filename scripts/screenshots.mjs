// 生成商店上架用截图（1280x800，浅色 + 深色）。先 npm run build（带 key 的本地包）。
import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = resolve('.output/chrome-mv3');
const OUT = resolve('screenshots');
const MASTER = 'Demo-master-123';

mkdirSync(OUT, { recursive: true });

function extId() {
  const m = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
  const hex = createHash('sha256').update(Buffer.from(m.key, 'base64')).digest().subarray(0, 16).toString('hex');
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickText(page, text, sel = 'button') {
  await page.waitForFunction(
    (t, s) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(t)),
    { timeout: 10000 },
    text,
    sel,
  );
  await page.evaluate(
    (t, s) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t))?.click(),
    text,
    sel,
  );
}
async function typeP(page, ph, val) {
  const sel = `input[placeholder="${ph}"]`;
  await page.waitForSelector(sel, { timeout: 10000 });
  await page.click(sel);
  await page.type(sel, val, { delay: 6 });
}
async function waitGone(page, ph) {
  await page.waitForFunction((s) => !document.querySelector(s), { timeout: 10000 }, `input[placeholder="${ph}"]`);
}
async function waitText(page, t) {
  await page.waitForFunction((x) => document.body.innerText.includes(x), { timeout: 12000 }, t);
}

async function clickInEnv(page, envName, btnText) {
  await page.evaluate(
    (env, btn) => {
      const sec = [...document.querySelectorAll('section')].find((s) =>
        s.textContent.includes(env),
      );
      [...(sec?.querySelectorAll('button') ?? [])].find((e) => e.textContent.includes(btn))?.click();
    },
    envName,
    btnText,
  );
}
async function addEnv(page, name, kind) {
  await clickText(page, '新建环境');
  await typeP(page, '例如：开发环境', name);
  if (kind) await page.select('select', kind).catch(() => {});
  await clickText(page, '保存');
  await waitGone(page, '例如：开发环境');
  await waitText(page, name);
}
async function addLink(page, envName, name, url) {
  await clickInEnv(page, envName, '链接');
  await typeP(page, '例如：管理后台', name);
  await typeP(page, 'https://admin.example.com', url);
  await clickText(page, '保存');
  await waitGone(page, '例如：管理后台');
}
async function addAccount(page, envName, label, user, pass, totp) {
  await clickInEnv(page, envName, '账号');
  await typeP(page, '例如：管理员 / 测试账号', label);
  await page.keyboard.press('Tab');
  await page.keyboard.type(user, { delay: 6 });
  await page.keyboard.press('Tab');
  await page.keyboard.type(pass, { delay: 6 });
  if (totp) await typeP(page, 'base32 密钥 或 otpauth://...', totp);
  await clickText(page, '保存');
  await waitGone(page, '例如：管理员 / 测试账号');
}

const userDataDir = mkdtempSync(join(tmpdir(), 'pem-shot-'));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir,
  defaultViewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const id = extId();
  await wait(1500);
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded' });

  await typeP(page, '主密码', MASTER);
  await typeP(page, '再次输入', MASTER);
  await clickText(page, '创建并解锁');
  await waitText(page, '新建项目');

  await clickText(page, '新建项目');
  await typeP(page, '例如：电商平台', '电商平台');
  await clickText(page, '保存');
  await waitGone(page, '例如：电商平台');
  await waitText(page, '电商平台');

  await addEnv(page, '生产环境', 'prod');
  await addLink(page, '生产环境', '管理后台', 'https://admin.shop.com');
  await addAccount(page, '生产环境', '管理员', 'admin', 'S#cure-pw-2026', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  await addAccount(page, '生产环境', '运维', 'ops', 'Ops-pw-9912');

  await addEnv(page, '开发环境', 'dev');
  await addLink(page, '开发环境', '管理后台', 'https://admin-dev.shop.com');
  await addAccount(page, '开发环境', '开发账号', 'dev', 'dev-1234');

  await wait(600);
  await page.screenshot({ path: join(OUT, 'store-1-light.png') });
  console.log('saved store-1-light.png');

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await wait(400);
  await page.screenshot({ path: join(OUT, 'store-2-dark.png') });
  console.log('saved store-2-dark.png');
} finally {
  await browser.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

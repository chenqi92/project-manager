import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = process.env.PEM_STRESS_OUT_DIR || '/tmp/project-env-manager-stress';
const OUT_JSON = join(OUT_DIR, 'project-env-manager-stress.json');
const OUT_SUMMARY = join(OUT_DIR, 'summary.json');

const WIDGET_ORDER = [
  'stats',
  'search',
  'launcher',
  'todos',
  'calendar',
  'clock',
  'totp',
  'health',
  'recent',
  'repos',
  'tags',
  'doc',
  'changed',
  'backup',
  'weather',
  'image',
];
const ENV_KINDS = ['dev', 'test', 'staging', 'prod', 'other'];
const ENV_NAMES = {
  dev: '开发环境',
  test: '测试环境',
  staging: '预发环境',
  prod: '生产环境',
  other: '灰度环境',
};
const LINK_NAMES = [
  '管理后台',
  '开放 API',
  '运营控制台',
  '监控面板',
  '任务调度',
  '数据看板',
  '客服工作台',
  '文件服务',
];
const ROLES = ['管理员', '运维', '开发', '测试'];
const TAGS = [
  '核心',
  '支付',
  '内部',
  '高频',
  '生产',
  '数据',
  '移动端',
  '低代码',
  '供应链',
  '客服',
  '权限',
  'AI',
];
const COLORS = ['#0d9488', '#2563eb', '#7c3aed', '#e11d48', '#ea580c', '#16a34a', '#0891b2', '#4f46e5'];
const DEFAULT_KDF = { type: 'argon2id', memKiB: 19456, iterations: 3, parallelism: 1 };
const BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const NOW = Date.now();

const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((x) => x.startsWith(prefix));
  if (inline) return Number(inline.slice(prefix.length));
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  return fallback;
};

const opts = {
  projects: arg('projects', 64),
  envs: arg('envs', 5),
  links: arg('links', 8),
  accounts: arg('accounts', 4),
  docs: arg('docs', 4),
  memos: arg('memos', 12),
};
const shouldOpen = process.argv.includes('--open');

function id(prefix, ...parts) {
  return `${prefix}-${parts.map((p) => String(p).padStart(4, '0')).join('-')}`;
}

function ts(seed, spreadDays = 90) {
  return NOW - (seed % spreadDays) * 86400000 - (seed % 86400) * 1000;
}

function strongPassword(p, e, l, a) {
  if ((p + e + l + a) % 29 === 0) return '123456';
  if ((p + l + a) % 17 === 0) return 'Shared-Password-2026!';
  if ((p + e + a) % 19 === 0) return 'shortpw';
  return `S!${String(p).padStart(2, '0')}r${e}${l}${a}-Env#${(p * 97 + e * 31 + l * 7 + a) % 100000}`;
}

function gitRepo(label, p, e, l = 0) {
  const repo = `project-${String(p).padStart(3, '0')}-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return {
    id: id('repo', p, e, l),
    url: `https://git.example.test/platform/${repo}.git`,
    branch: e % 4 === 3 ? 'release/2026-q3' : e % 4 === 2 ? 'staging' : e % 4 === 1 ? 'test' : 'main',
    label,
  };
}

function markdownDoc(projectName, p, d) {
  return [
    `# ${projectName} 压测说明 ${d}`,
    '',
    `这是自动生成的项目说明文档，用来测试 Markdown、目录、代码块和长文滚动。项目索引 ${p}，文档索引 ${d}。`,
    '',
    '## 上线检查',
    '',
    '- 配置中心键值已校验',
    '- 数据库迁移已灰度执行',
    '- 监控告警和回滚预案已确认',
    '- 多环境入口地址已同步',
    '',
    '## Mermaid 流程',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[需求] --> B[开发]',
    '  B --> C[测试]',
    '  C --> D[预发验证]',
    '  D --> E[生产发布]',
    '```',
    '',
    '## API 样例',
    '',
    '```bash',
    `curl -H "X-Project: ${projectName}" https://api-${p}.example.test/v1/health`,
    '```',
    '',
    '## 长文本',
    '',
    Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段：这里填充一段用于滚动和搜索的说明文字，覆盖权限、告警、回滚、审计、备份与多端同步。`).join('\n\n'),
    '',
  ].join('\n');
}

function memoText(p, m) {
  const subjects = ['巡检生产证书', '回归登录流程', '补齐接口文档', '验证监控告警', '整理发布清单', '清理过期账号'];
  return `${subjects[m % subjects.length]} #P${String(p).padStart(3, '0')}-${String(m).padStart(2, '0')}`;
}

function makeProjects() {
  const projects = [];
  for (let p = 1; p <= opts.projects; p += 1) {
    const projectName = `压测项目 ${String(p).padStart(3, '0')}`;
    const project = {
      id: id('project', p),
      name: projectName,
      color: COLORS[p % COLORS.length],
      favorite: p % 3 === 0 || p <= 8,
      tags: [TAGS[p % TAGS.length], TAGS[(p + 3) % TAGS.length], TAGS[(p + 7) % TAGS.length]],
      note: `自动生成的压力测试项目 ${p}，覆盖多环境、多链接、多账号、文档和待办。`,
      docs: [],
      memos: [],
      environments: [],
      createdAt: ts(p, 240),
      updatedAt: ts(p * 3, 120),
    };

    for (let d = 1; d <= opts.docs; d += 1) {
      project.docs.push({
        id: id('doc', p, d),
        title: `${projectName} / 运维手册 ${d}`,
        content: markdownDoc(projectName, p, d),
        updatedAt: ts(p * 100 + d, 60),
      });
    }

    for (let m = 1; m <= opts.memos; m += 1) {
      const done = m % 7 === 0;
      const offset = (m % 9) - 3;
      project.memos.push({
        id: id('memo', p, m),
        text: memoText(p, m),
        done,
        urgent: !done && (m % 5 === 0 || offset < 0),
        dueAt: new Date(new Date(NOW).setHours(0, 0, 0, 0) + offset * 86400000).getTime(),
        createdAt: ts(p * 1000 + m, 45),
        updatedAt: ts(p * 1000 + m * 2, 30),
      });
    }

    for (let e = 0; e < opts.envs; e += 1) {
      const kind = ENV_KINDS[e % ENV_KINDS.length];
      const env = {
        id: id('env', p, e + 1),
        name: ENV_NAMES[kind],
        kind,
        note: `${projectName} 的${ENV_NAMES[kind]}，用于入口、账号和仓库压测。`,
        gitRepos: [gitRepo('后端服务', p, e), gitRepo('前端应用', p, e, 1)],
        links: [],
        updatedAt: ts(p * 10 + e, 80),
      };

      for (let l = 1; l <= opts.links; l += 1) {
        const host = `${kind}-${String(p).padStart(3, '0')}-${String(l).padStart(2, '0')}.example.test`;
        const link = {
          id: id('link', p, e + 1, l),
          name: LINK_NAMES[(l - 1) % LINK_NAMES.length],
          url: `https://${host}/login`,
          urls: [
            `http://10.${p % 255}.${e + 10}.${l + 20}:8080/login`,
            `https://alt-${host}/console`,
          ],
          gitRepos: l % 2 === 0 ? [gitRepo(`模块 ${l}`, p, e, l)] : undefined,
          note: `${projectName} ${ENV_NAMES[kind]} ${LINK_NAMES[(l - 1) % LINK_NAMES.length]} 入口。`,
          accounts: [],
          updatedAt: ts(p * 100 + e * 10 + l, 70),
        };

        for (let a = 1; a <= opts.accounts; a += 1) {
          const updatedAt = (p + e + l + a) % 13 === 0 ? NOW - 210 * 86400000 : ts(p * 10000 + e * 100 + l * 10 + a, 100);
          link.accounts.push({
            id: id('account', p, e + 1, l, a),
            label: ROLES[(a - 1) % ROLES.length],
            username: `${ROLES[(a - 1) % ROLES.length].toLowerCase()}_${String(p).padStart(3, '0')}_${kind}_${l}`,
            password: strongPassword(p, e, l, a),
            note: `压测账号 ${a}，用于搜索、审计、复制和打开登录。`,
            totp: a % 2 === 1 ? BASE32 : undefined,
            createdAt: ts(p * 10000 + e * 100 + l * 10 + a, 220),
            updatedAt,
          });
        }
        env.links.push(link);
      }
      project.environments.push(env);
    }
    projects.push(project);
  }
  return projects;
}

function widget(type, x, y, w, h, config = {}) {
  return {
    id: `widget-${type}-${x}-${y}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    x,
    y,
    w,
    h,
    ...(Object.keys(config).length ? { config } : {}),
  };
}

function imageDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#111827"/>
<rect x="40" y="44" width="560" height="272" rx="18" fill="#f8fafc"/>
<path d="M84 256 C160 140 220 198 286 112 S432 124 536 74" fill="none" stroke="#0d9488" stroke-width="12" stroke-linecap="round"/>
<g fill="#2563eb"><circle cx="138" cy="210" r="16"/><circle cx="290" cy="112" r="16"/><circle cx="446" cy="112" r="16"/></g>
<text x="72" y="88" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#111827">Stress Dashboard</text>
<text x="72" y="296" font-family="Arial, sans-serif" font-size="18" fill="#475569">projects / todos / docs / accounts</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function makeDashboard(projects) {
  const first = projects[0];
  const second = projects[1] ?? first;
  const firstDoc = first?.docs?.[0];
  return {
    activeBoardId: 'board-all-types',
    boards: [
      {
        id: 'board-all-types',
        name: '全类型压力',
        appearance: { bg: 'gradient', gradient: 'forest', tileOpacity: 82, tileBlur: 10 },
        widgets: [
          widget('stats', 0, 0, 4, 1, { label: '全库统计' }),
          widget('search', 0, 1, 4, 1, { label: '搜项目 / 环境 / 账号' }),
          widget('launcher', 0, 2, 4, 2, { label: '全部入口' }),
          widget('todos', 0, 4, 2, 2, { label: '待办压力池' }),
          widget('calendar', 2, 4, 2, 2, { label: '截止日历' }),
          widget('clock', 0, 6, 2, 1),
          widget('tags', 2, 6, 2, 1, { label: '项目标签' }),
          widget('totp', 0, 7, 2, 2, { label: '验证码墙', reveal: false }),
          widget('health', 2, 7, 2, 2),
          widget('recent', 0, 9, 2, 2),
          widget('repos', 2, 9, 2, 2, { label: 'Git 仓库' }),
          widget('doc', 0, 11, 2, 2, { label: '文档速览', projectId: first?.id, docId: firstDoc?.id }),
          widget('changed', 2, 11, 2, 2, { label: '近期改动' }),
          widget('backup', 0, 13, 2, 1),
          widget('weather', 2, 13, 1, 1, { city: '上海', lat: 31.2304, lon: 121.4737 }),
          widget('image', 3, 13, 1, 1, { dataUrl: imageDataUrl(), caption: '压测概览' }),
        ],
      },
      {
        id: 'board-favorites',
        name: '收藏聚合',
        appearance: { bg: 'gradient', gradient: 'mist', tileOpacity: 88, tileBlur: 6 },
        widgets: [
          widget('stats', 0, 0, 4, 1, { label: '收藏项目统计', onlyFavorite: true }),
          widget('launcher', 0, 1, 4, 2, { label: '收藏入口', onlyFavorite: true }),
          widget('repos', 0, 3, 2, 2, { label: '收藏仓库', onlyFavorite: true }),
          widget('totp', 2, 3, 2, 2, { label: '收藏验证码', onlyFavorite: true }),
          widget('doc', 0, 5, 2, 2, { projectId: second?.id, docId: second?.docs?.[0]?.id }),
          widget('changed', 2, 5, 2, 2, { onlyFavorite: true }),
        ],
      },
      {
        id: 'board-docs-todos',
        name: '文档待办',
        appearance: { bg: 'gradient', gradient: 'sunset', tileOpacity: 80, tileBlur: 12 },
        widgets: [
          widget('todos', 0, 0, 2, 3),
          widget('calendar', 2, 0, 2, 3),
          widget('doc', 0, 3, 2, 3, { projectId: first?.id, docId: first?.docs?.[1]?.id }),
          widget('doc', 2, 3, 2, 3, { projectId: second?.id, docId: second?.docs?.[1]?.id }),
          widget('tags', 0, 6, 2, 1),
          widget('backup', 2, 6, 2, 1),
        ],
      },
    ],
  };
}

function makeVaultData() {
  const projects = makeProjects();
  return {
    version: 1,
    projects,
    settings: {
      autoLockMinutes: 0,
      kdf: DEFAULT_KDF,
      syncAuto: false,
      autoSubmit: false,
      theme: 'light',
      dashboard: makeDashboard(projects),
      weatherEnabled: true,
      onboardedBackup: true,
      lastBackupAt: NOW - 2 * 86400000,
      syncTargets: [
        {
          id: 'stress-sync-localhost',
          type: 'self-hosted',
          label: '压测同步目标 (禁自动同步)',
          enabled: true,
          serverUrl: 'http://localhost:8787',
          token: 'stress-token-only-for-local-testing',
        },
      ],
    },
    tombstones: [],
  };
}

function summarize(data) {
  let envs = 0;
  let links = 0;
  let accounts = 0;
  let totp = 0;
  let repos = 0;
  let docs = 0;
  let memos = 0;
  let pendingMemos = 0;
  for (const p of data.projects) {
    docs += p.docs?.length ?? 0;
    memos += p.memos?.length ?? 0;
    pendingMemos += (p.memos ?? []).filter((m) => !m.done).length;
    for (const e of p.environments) {
      envs += 1;
      repos += e.gitRepos?.length ?? 0;
      for (const l of e.links) {
        links += 1;
        repos += l.gitRepos?.length ?? 0;
        accounts += l.accounts.length;
        totp += l.accounts.filter((a) => a.totp).length;
      }
    }
  }
  const widgets = data.settings.dashboard.boards.reduce((n, b) => n + b.widgets.length, 0);
  return {
    projects: data.projects.length,
    environments: envs,
    links,
    accounts,
    totp,
    gitRepos: repos,
    docs,
    memos,
    pendingMemos,
    boards: data.settings.dashboard.boards.length,
    widgets,
    widgetTypes: WIDGET_ORDER.length,
  };
}

function writeData(data, summary) {
  mkdirSync(OUT_DIR, { recursive: true });
  const payload = { format: 'project-env-manager.plain', exportedAt: NOW, data };
  writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));
}

const data = makeVaultData();
const summary = summarize(data);
writeData(data, summary);
console.log(JSON.stringify({ generated: OUT_JSON, summary: OUT_SUMMARY, ...summary }, null, 2));

if (shouldOpen) {
  console.log('自动操作 chrome-extension:// 页面在当前环境不可用；请在插件的「导入 / 导出」页选择上面的 JSON 文件导入。');
}

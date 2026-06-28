// @vitest-environment jsdom
// 首页渲染冒烟测试：在 jsdom 下挂载 Home + 全部磁贴，确保渲染不抛错、
// 关键文案出现。补足无法用 puppeteer 加载扩展（Chrome 过新封禁 --load-extension）的验证缺口。
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: { create: vi.fn(async () => {}) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
  },
}));

import React from 'react';

// jsdom 缺这些浏览器 API，磁贴 effect 会用到，补无操作 polyfill。
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
// 首页用 ResizeObserver 测网格宽度决定列数；jsdom clientWidth=0，这里上报固定宽度让磁贴渲染。
class FakeResizeObserver {
  cb: (entries: Array<{ contentRect: { width: number } }>) => void;
  constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
    this.cb = cb;
  }
  observe() {
    this.cb([{ contentRect: { width: 1200 } }]);
  }
  unobserve() {}
  disconnect() {}
}
const g = globalThis as Record<string, unknown>;
g.ResizeObserver = FakeResizeObserver;
g.IntersectionObserver ||= NoopObserver;
g.matchMedia ||= () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

import { Home } from '../entrypoints/options/Home';
import { DialogProvider } from '../components/Dialog';
import { newDashWidget } from '../lib/dashboard';
import { WIDGET_ORDER } from '../entrypoints/options/widgets/registry';
import type { VaultData } from '../lib/types';

function fixture(): VaultData {
  const now = Date.now();
  return {
    version: 1,
    tombstones: [],
    projects: [
      {
        id: 'p1',
        name: '电商平台',
        color: '#2563eb',
        favorite: true,
        tags: ['核心', '电商'],
        docs: [{ id: 'd1', title: '部署说明', content: '# 部署\n步骤一二三', updatedAt: now }],
        memos: [
          { id: 'm1', text: '续费证书', done: false, dueAt: now - 86400000, createdAt: now, updatedAt: now },
          { id: 'm2', text: '巡检', done: false, dueAt: now + 86400000, createdAt: now, updatedAt: now },
        ],
        environments: [
          {
            id: 'e1',
            name: '生产环境',
            kind: 'prod',
            gitRepos: [{ id: 'g1', url: 'https://git.example.com/shop.git', branch: 'main', label: '后端' }],
            links: [
              {
                id: 'l1',
                name: '管理后台',
                url: 'https://admin.shop.com',
                accounts: [
                  {
                    id: 'a1',
                    label: '管理员',
                    username: 'admin',
                    password: 'weak123',
                    totp: 'JBSWY3DPEHPK3PXP',
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
                updatedAt: now,
              },
            ],
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    settings: {
      autoLockMinutes: 10,
      kdf: { type: 'pbkdf2', iterations: 1, hash: 'SHA-256' },
      weatherEnabled: false,
      // 一个看板放下全部磁贴类型，逐个渲染一遍
      dashboard: {
        boards: [
          {
            id: 'b1',
            name: '默认',
            appearance: { bg: 'gradient', gradient: 'aurora' },
            widgets: WIDGET_ORDER.map((t, i) => ({ ...newDashWidget(t), x: (i % 2) * 2, y: Math.floor(i / 2) * 2 })),
          },
        ],
        activeBoardId: 'b1',
      },
    },
  };
}

function mount(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    cleanup: () =>
      act(() => {
        root.unmount();
      }),
  };
}

describe('Home 渲染冒烟', () => {
  it('挂载首页 + 全部磁贴不抛错，关键文案出现', () => {
    const props = {
      data: fixture(),
      onUpdate: vi.fn(async () => {}),
      syncEnabled: false,
      onOpenExport: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenCnb: vi.fn(),
      onCopy: vi.fn(),
      onOpenLogin: vi.fn(),
    };
    const { container, cleanup } = mount(
      <DialogProvider>
        <Home {...props} />
      </DialogProvider>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('编辑看板'); // 看板编辑入口（页面标题已上移到 App 顶栏）
    expect(text).toContain('快捷入口'); // launcher app 磁贴
    expect(text).toContain('密码健康度'); // audit widget
    expect(text).toContain('验证码墙'); // totp widget
    expect(text).toContain('Git 仓库'); // repos widget
    expect(text).toContain('近期改动'); // changed widget
    expect(text).toContain('备份 / 同步'); // backup widget
    expect(text).toContain('管理后台'); // 来自数据的链接名
    cleanup();
  });

  it('空看板显示占位提示', () => {
    const data = fixture();
    data.settings.dashboard = { boards: [{ id: 'b0', name: '空', widgets: [] }], activeBoardId: 'b0' };
    const props = {
      data,
      onUpdate: vi.fn(async () => {}),
      syncEnabled: false,
      onOpenExport: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenCnb: vi.fn(),
      onCopy: vi.fn(),
      onOpenLogin: vi.fn(),
    };
    const { container, cleanup } = mount(
      <DialogProvider>
        <Home {...props} />
      </DialogProvider>,
    );
    expect(container.textContent ?? '').toContain('还没有磁贴');
    cleanup();
  });
});

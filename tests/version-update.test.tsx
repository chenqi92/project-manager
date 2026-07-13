// @vitest-environment jsdom
import { act } from 'react';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSelf: vi.fn(),
  requestUpdateCheck: vi.fn(),
  reload: vi.fn(),
  openTab: vi.fn(),
  addUpdateListener: vi.fn(),
  removeUpdateListener: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    management: { getSelf: mocks.getSelf },
    runtime: {
      getManifest: () => ({ version: '1.1.1' }),
      requestUpdateCheck: mocks.requestUpdateCheck,
      reload: mocks.reload,
      onUpdateAvailable: {
        addListener: mocks.addUpdateListener,
        removeListener: mocks.removeUpdateListener,
      },
    },
    tabs: { create: mocks.openTab },
  },
}));

import { DialogProvider } from '../components/Dialog';
import { classifyUpdateChannel, VersionUpdate } from '../entrypoints/options/VersionUpdate';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<DialogProvider><VersionUpdate /></DialogProvider>));
  return {
    container,
    cleanup: () => act(() => root.unmount()),
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('VersionUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openTab.mockResolvedValue(undefined);
  });

  it('识别商店、托管和开发者模式安装', () => {
    expect(classifyUpdateChannel({ installType: 'development' })).toBe('manual');
    expect(
      classifyUpdateChannel({
        installType: 'normal',
        updateUrl: 'https://clients2.google.com/service/update2/crx',
      }),
    ).toBe('store');
    expect(
      classifyUpdateChannel({ installType: 'admin', updateUrl: 'https://updates.example.com/ext.xml' }),
    ).toBe('managed');
  });

  it('显示版本号，开发者模式打开最新版下载页', async () => {
    mocks.getSelf.mockResolvedValue({ installType: 'development' });
    const { container, cleanup } = mount();
    await settle();

    expect(container.textContent).toContain('v1.1.1');
    expect(container.textContent).toContain('开发者模式安装');
    const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes('下载最新版'));
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    expect(mocks.openTab).toHaveBeenCalledWith({
      url: 'https://github.com/chenqi92/project-manager/releases/latest',
    });
    cleanup();
  });

  it('商店安装版检查更新并显示待安装版本', async () => {
    mocks.getSelf.mockResolvedValue({
      installType: 'normal',
      updateUrl: 'https://clients2.google.com/service/update2/crx',
    });
    mocks.requestUpdateCheck.mockResolvedValue({ status: 'update_available', version: '1.2.0' });
    const { container, cleanup } = mount();
    await settle();

    const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes('检查更新'));
    await act(async () => button?.click());

    expect(mocks.requestUpdateCheck).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('发现新版本 v1.2.0');
    expect(container.textContent).toContain('重启并更新');
    cleanup();
  });
});

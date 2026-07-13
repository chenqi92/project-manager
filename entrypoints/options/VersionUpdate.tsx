import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Download, Layers, Loader2, RefreshCw, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui';
import { useDialog } from '@/components/Dialog';

const RELEASES_URL = 'https://github.com/chenqi92/project-manager/releases/latest';

type UpdateChannel = 'loading' | 'manual' | 'store' | 'managed';
type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'throttled' }
  | { kind: 'available'; version?: string }
  | { kind: 'error'; message: string };

interface SelfInfo {
  installType: string;
  updateUrl?: string;
}

export function classifyUpdateChannel(info: SelfInfo): Exclude<UpdateChannel, 'loading'> {
  if (info.installType === 'development' || !info.updateUrl) return 'manual';
  return info.updateUrl.includes('clients2.google.com') ? 'store' : 'managed';
}

export function VersionUpdate() {
  const { confirm } = useDialog();
  const manifest = browser.runtime.getManifest();
  const version = manifest.version;
  const [channel, setChannel] = useState<UpdateChannel>('loading');
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });

  useEffect(() => {
    let active = true;
    browser.management
      .getSelf()
      .then((info) => {
        if (active) setChannel(classifyUpdateChannel(info));
      })
      .catch(() => {
        // 极旧浏览器没有 management.getSelf 时，用安装清单里的 update_url 兜底。
        const updateUrl = manifest.update_url;
        if (active) {
          setChannel(
            updateUrl
              ? classifyUpdateChannel({ installType: 'normal', updateUrl })
              : 'manual',
          );
        }
      });

    const onUpdateAvailable = (details: { version: string }) => {
      if (active) setState({ kind: 'available', version: details.version });
    };
    browser.runtime.onUpdateAvailable.addListener(onUpdateAvailable);

    return () => {
      active = false;
      browser.runtime.onUpdateAvailable.removeListener(onUpdateAvailable);
    };
  }, [manifest.update_url]);

  const openLatestRelease = () => void browser.tabs.create({ url: RELEASES_URL }).catch(() => {});

  const restartToUpdate = async () => {
    const available = state.kind === 'available' ? state.version : undefined;
    const ok = await confirm({
      title: '重启并更新扩展',
      message: `新版${available ? ` v${available}` : ''}已经下载完成。重启扩展后会应用更新，本地保险箱数据不会被删除。`,
      confirmText: '重启并更新',
    });
    if (ok) browser.runtime.reload();
  };

  const checkForUpdate = async () => {
    if (channel === 'manual') {
      openLatestRelease();
      return;
    }
    if (state.kind === 'available') {
      await restartToUpdate();
      return;
    }

    setState({ kind: 'checking' });
    try {
      const result = await browser.runtime.requestUpdateCheck();
      if (result.status === 'update_available') {
        setState({ kind: 'available', version: result.version });
      } else if (result.status === 'throttled') {
        setState({ kind: 'throttled' });
      } else {
        setState({ kind: 'latest' });
      }
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : '检查更新失败，请稍后重试',
      });
    }
  };

  const isManual = channel === 'manual';
  const description = updateDescription(version, channel, state);
  const button = updateButton(channel, state);

  return (
    <div className="flex items-center gap-3 border-t border-gray-100 py-3.5">
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-brand-600 text-white">
        <Layers size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <span>项目环境管家</span>
          <span className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-gray-500">
            v{version}
          </span>
        </div>
        <div
          className={`mt-0.5 text-[11.5px] leading-snug ${state.kind === 'error' ? 'text-danger' : 'text-gray-400'}`}
        >
          {description}
        </div>
        {isManual && (
          <div className="mt-1 text-[10.5px] leading-snug text-amber-600">
            下载后请覆盖原安装目录，再到 chrome://extensions 点击“重新加载”；不要卸载，以免清除本地数据。
          </div>
        )}
      </div>
      <Button
        variant={state.kind === 'available' ? 'primary' : 'outline'}
        disabled={channel === 'loading' || state.kind === 'checking'}
        onClick={() => void checkForUpdate()}
        className="shrink-0"
      >
        {button.icon}
        {button.label}
      </Button>
    </div>
  );
}

function updateDescription(version: string, channel: UpdateChannel, state: UpdateState): string {
  if (channel === 'loading') return `当前版本 v${version} · 正在识别安装来源…`;
  if (channel === 'manual') return `当前版本 v${version} · 开发者模式安装，需手动下载更新`;
  if (state.kind === 'checking') return `当前版本 v${version} · 正在向 Chrome 查询更新…`;
  if (state.kind === 'latest') return `当前版本 v${version} · 已是最新版本`;
  if (state.kind === 'throttled') return `当前版本 v${version} · 检查过于频繁，请稍后重试；自动更新不受影响`;
  if (state.kind === 'available') {
    return `当前版本 v${version} · 发现新版本${state.version ? ` v${state.version}` : ''}，重启后生效`;
  }
  if (state.kind === 'error') return `当前版本 v${version} · ${state.message}`;
  return `当前版本 v${version} · ${channel === 'store' ? 'Chrome 商店' : '托管渠道'}会自动更新`;
}

function updateButton(
  channel: UpdateChannel,
  state: UpdateState,
): { icon: React.ReactNode; label: string } {
  if (channel === 'loading' || state.kind === 'checking') {
    return { icon: <Loader2 size={14} className="animate-spin" />, label: '检查中' };
  }
  if (channel === 'manual') {
    return { icon: <Download size={14} />, label: '下载最新版' };
  }
  if (state.kind === 'available') {
    return { icon: <RotateCw size={14} />, label: '重启并更新' };
  }
  return { icon: <RefreshCw size={14} />, label: state.kind === 'latest' ? '重新检查' : '检查更新' };
}

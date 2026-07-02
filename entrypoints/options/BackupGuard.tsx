import { useState } from 'react';
import { Cloud, Download, Globe2, KeyRound, ShieldAlert, Wifi } from 'lucide-react';
import { Banner, Button, Modal } from '@/components/ui';

/** 创建保险箱后的一次性强提示：本地数据无兜底，引导导出备份或开启同步。 */
export function BackupOnboardingModal({
  onExport,
  onEnableSync,
  onAck,
}: {
  onExport: () => void;
  onEnableSync: () => void;
  onAck: () => void;
}) {
  return (
    <Modal title="先给数据上一道保险" onClose={onAck}>
      <div className="flex flex-col gap-4 text-sm text-gray-700">
        <Banner tone="warn">
          你的数据<strong>只保存在本机、且端到端加密</strong>。若卸载扩展、重置浏览器或更换电脑，而
          <strong>没有备份、也没有开启同步</strong>，数据将<strong>永久丢失，作者也无法找回</strong>。
        </Banner>
        <p className="text-xs leading-relaxed text-gray-500">
          升级是自动的，<strong>无需卸载重装</strong>。建议二选一，给自己留个后路：
        </p>
        <div className="flex flex-col gap-2">
          <Button onClick={onExport}>
            <Download size={16} /> 导出一份加密备份
          </Button>
          <Button variant="subtle" onClick={onEnableSync}>
            <Cloud size={16} /> 开启云端同步（自托管）
          </Button>
          <Button variant="ghost" onClick={onAck}>
            我已了解，稍后再说
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 久未备份时在首页顶部显示的提醒条。 */
export function BackupReminder({
  onExport,
  onEnableSync,
  onSnooze,
}: {
  onExport: () => void;
  onEnableSync: () => void;
  onSnooze: () => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center">
      <ShieldAlert size={18} className="shrink-0 text-amber-600" />
      <div className="flex-1 text-xs leading-relaxed text-amber-800">
        你已经有一段时间没有备份了。数据仅存本机，<strong>卸载或换机且未备份会永久丢失</strong>。
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="subtle" onClick={onEnableSync}>
          <Cloud size={14} /> 开启同步
        </Button>
        <Button onClick={onExport}>
          <Download size={14} /> 立即备份
        </Button>
        <button onClick={onSnooze} className="text-xs text-amber-800 hover:underline">
          稍后
        </button>
      </div>
    </div>
  );
}

export function FeatureOnboardingModal({
  webAssist,
  webAssistAllSites,
  networkEnabled,
  onEnableAssist,
  onEnableAllSites,
  onEnableNetwork,
  onDone,
}: {
  webAssist: boolean;
  webAssistAllSites: boolean;
  networkEnabled: boolean;
  onEnableAssist: () => void | Promise<void>;
  onEnableAllSites: () => void | Promise<void>;
  onEnableNetwork: () => void | Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<'assist' | 'sites' | 'network' | null>(null);

  const run = async (key: 'assist' | 'sites' | 'network', fn: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="快速打开常用功能" onClose={() => !busy && onDone()}>
      <div className="flex flex-col gap-4 text-sm text-gray-700">
        <Banner tone="info">
          这几个是最常用的开关：「网页内账号提示」可直接开启；「新网站登录捕获」需要授权浏览器全站访问；「联网磁贴」开启后才会访问外部数据源。
        </Banner>
        <div className="flex flex-col gap-2.5">
          <FeatureSwitchRow
            icon={<KeyRound size={17} />}
            title="网页内账号提示"
            desc="在授权网站显示账号候选，并在登录成功后提示保存或更新。"
            enabled={webAssist}
            enabledLabel="已开启"
            actionLabel="开启"
            busy={busy === 'assist'}
            disabled={busy !== null}
            onAction={() => run('assist', onEnableAssist)}
          />
          <FeatureSwitchRow
            icon={<Globe2 size={17} />}
            title="新网站登录捕获"
            desc="首次登录新网站后提示保存，需要确认 http/https 全站访问权限。"
            enabled={webAssistAllSites}
            enabledLabel="已授权"
            actionLabel="授权开启"
            busy={busy === 'sites'}
            disabled={busy !== null}
            onAction={() => run('sites', onEnableAllSites)}
          />
          <FeatureSwitchRow
            icon={<Wifi size={17} />}
            title="联网磁贴"
            desc="天气、今日热榜、股票和联网工具会在开启后访问外部数据源。"
            enabled={networkEnabled}
            enabledLabel="已开启"
            actionLabel="开启"
            busy={busy === 'network'}
            disabled={busy !== null}
            onAction={() => run('network', onEnableNetwork)}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 pt-3">
          <Button variant="ghost" disabled={busy !== null} onClick={onDone}>
            稍后
          </Button>
          <Button disabled={busy !== null} onClick={onDone}>
            完成
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function FeatureSwitchRow({
  icon,
  title,
  desc,
  enabled,
  enabledLabel,
  actionLabel,
  busy,
  disabled,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  enabled: boolean;
  enabledLabel: string;
  actionLabel: string;
  busy: boolean;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-surface px-3.5 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-prid">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-bold text-gray-900">{title}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-gray-500">{desc}</div>
      </div>
      <Button
        variant={enabled ? 'outline' : 'subtle'}
        disabled={enabled || disabled}
        onClick={onAction}
        className="shrink-0"
      >
        {enabled ? enabledLabel : busy ? '处理中…' : actionLabel}
      </Button>
    </div>
  );
}

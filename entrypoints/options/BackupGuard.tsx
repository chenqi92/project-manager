import { Cloud, Download, ShieldAlert } from 'lucide-react';
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
        <button onClick={onSnooze} className="text-xs text-amber-700 hover:underline">
          稍后
        </button>
      </div>
    </div>
  );
}

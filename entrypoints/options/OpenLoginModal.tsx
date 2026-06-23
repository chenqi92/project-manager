import { useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { ExternalLink, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { getOrigin } from '@/lib/autofill';
import { api } from '@/lib/messaging';
import { flatten } from '@/lib/search';
import { recordUse } from '@/lib/usage';
import type { VaultData } from '@/lib/types';

/**
 * 「打开并登录」的授权中转页：从 popup 跳转而来。
 * popup 里首次申请站点权限会弹出系统权限框、从而关闭 popup，导致后续填充丢失、要再点一次。
 * 这里把授权 + 打开填充放到常驻的设置页完成，权限框关闭也不会销毁本页，一步到位。
 * 不经 URL 传密码：仅传 accountId，在已解锁的设置页内查出账号明文。
 */
export function OpenLoginModal({
  data,
  accountId,
  url,
  autoSubmit,
  onClose,
  onDone,
}: {
  data: VaultData;
  accountId: string;
  url: string;
  autoSubmit: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const entry = useMemo(
    () => flatten(data).find((e) => e.accountId === accountId) ?? null,
    [data, accountId],
  );
  const targetUrl = url || entry?.url || '';
  const origin = getOrigin(targetUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const proceed = async () => {
    if (!entry || !origin) return;
    setBusy(true);
    setError(null);
    try {
      // 必须在用户手势内首发，故 request 作为点击后的第一个 await。
      const granted = await browser.permissions.request({ origins: [origin + '/*'] });
      if (!granted) {
        setError('未授权访问该网站');
        setBusy(false);
        return;
      }
      const r = await api.openAndFill(targetUrl, entry.username, entry.password, autoSubmit);
      await recordUse(entry.accountId);
      if (!r.filled) {
        setError(r.reason ?? '未能完成填充，请重试');
        setBusy(false);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const host = origin ? hostOf(origin) : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck size={18} className="text-brand-600" />
          <h2 className="flex-1 text-base font-semibold text-gray-900">打开并登录</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        {!entry || !origin ? (
          <p className="text-sm text-gray-500">
            找不到该账号或链接地址不合法，可能数据已变更。请关闭后重试。
          </p>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              即将打开 <b className="text-gray-900">{host}</b> 并自动填充
              {entry.username ? <>「{entry.username}」</> : '该账号'}。
            </p>
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              首次需要你授权扩展访问该网站。点击下方按钮后会弹出系统权限框，授权后将自动继续。
            </p>
            {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="subtle" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button onClick={proceed} disabled={busy}>
                <ExternalLink size={15} /> {busy ? '处理中…' : '授权并登录'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

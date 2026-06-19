import { Banner, Modal, cx } from '@/components/ui';
import { ISSUE_LABELS, audit } from '@/lib/audit';
import type { VaultData } from '@/lib/types';

export function AuditModal({ data, onClose }: { data: VaultData; onClose: () => void }) {
  const report = audit(data);
  return (
    <Modal title="密码健康审计" onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-4 gap-2 text-center">
        <Stat n={report.total} label="账号" />
        <Stat n={report.weak} label="弱密码" tone="rose" />
        <Stat n={report.reused} label="重复使用" tone="amber" />
        <Stat n={report.old} label="超半年未改" tone="amber" />
      </div>

      {report.issues.length === 0 ? (
        <Banner tone="info">没有发现问题，密码状况良好。</Banner>
      ) : (
        <div className="flex max-h-[55vh] flex-col gap-1.5 overflow-auto">
          {report.issues.map((it) => (
            <div
              key={it.entry.accountId}
              className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {it.entry.linkName} · {it.entry.accountLabel || it.entry.username || '—'}
                </div>
                <div className="truncate text-xs text-gray-400">
                  {it.entry.projectName} · {it.entry.envName}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                {it.kinds.map((k) => (
                  <span
                    key={k}
                    className={cx(
                      'rounded px-1.5 py-0.5 text-[10px] font-medium',
                      k === 'weak' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700',
                    )}
                  >
                    {ISSUE_LABELS[k]}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] text-gray-400">审计全部在本地完成，密码不会离开本机。</p>
    </Modal>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: 'rose' | 'amber' }) {
  return (
    <div className="rounded-lg bg-gray-50 py-2">
      <div
        className={cx(
          'text-xl font-semibold',
          tone === 'rose' ? 'text-rose-600' : tone === 'amber' ? 'text-amber-600' : 'text-gray-800',
        )}
      >
        {n}
      </div>
      <div className="text-xs text-gray-400">{label}</div>
    </div>
  );
}

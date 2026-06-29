import { useState } from 'react';
import { AlertTriangle, Copy, ListChecks, RefreshCw, ShieldCheck } from 'lucide-react';
import { Modal, cx } from '@/components/ui';
import { ISSUE_LABELS, audit, type IssueKind } from '@/lib/audit';
import type { FlatEntry } from '@/lib/search';
import type { VaultData } from '@/lib/types';

const KIND_TONE: Record<IssueKind, { color: string; bg: string }> = {
  weak: { color: 'var(--color-danger)', bg: 'var(--color-dangerbg)' },
  reused: { color: 'var(--color-warn)', bg: 'var(--color-warnbg)' },
  old: { color: 'var(--color-gray-500)', bg: 'var(--color-gray-100)' },
};

export function AuditModal({
  data,
  onClose,
  embedded,
  onFix,
}: {
  data: VaultData;
  onClose: () => void;
  embedded?: boolean;
  onFix?: (entry: FlatEntry) => void;
}) {
  const report = audit(data);
  const [filter, setFilter] = useState<'all' | IssueKind>('all');
  const score = report.total === 0 ? 100 : Math.round((100 * (report.total - report.issues.length)) / report.total);
  const shown =
    filter === 'all' ? report.issues : report.issues.filter((i) => i.kinds.includes(filter));

  const body = (
    <div className="flex flex-col items-start gap-[18px] lg:flex-row">
      {/* main */}
      <div className="min-w-0 flex-1">
        <div className="mb-[18px] grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard n={score} label="健康评分" color="var(--color-ok)" />
          <StatCard n={report.weak} label="弱密码" color="var(--color-danger)" />
          <StatCard n={report.reused} label="重复使用" color="var(--color-warn)" />
          <StatCard n={report.old} label="超半年未更新" color="var(--color-gray-600)" />
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="text-[13px] font-bold">
            待处理问题 <span className="font-medium text-gray-400">{report.issues.length}</span>
          </div>
          <div className="flex-1" />
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
            全部
          </FilterChip>
          <FilterChip active={filter === 'weak'} onClick={() => setFilter('weak')}>
            弱密码 {report.weak}
          </FilterChip>
          <FilterChip active={filter === 'reused'} onClick={() => setFilter('reused')}>
            重复 {report.reused}
          </FilterChip>
          <FilterChip active={filter === 'old'} onClick={() => setFilter('old')}>
            陈旧 {report.old}
          </FilterChip>
        </div>

        <div className="overflow-hidden rounded-[13px] border border-gray-200 bg-surface">
          {shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400">没有待处理的问题 🎉</p>
          ) : (
            shown.map((i) => {
              const primary = i.kinds[0]!;
              const tone = KIND_TONE[primary];
              return (
                <div
                  key={i.entry.accountId}
                  className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0"
                >
                  <span
                    className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg"
                    style={{ background: tone.bg, color: tone.color }}
                  >
                    {primary === 'reused' ? <Copy size={15} /> : <AlertTriangle size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-semibold">
                      {i.kinds.map((k) => ISSUE_LABELS[k]).join(' · ')}
                    </div>
                    <div className="truncate text-[11px] text-gray-400">
                      {i.entry.projectName} · {i.entry.envName} · {i.entry.linkName} ·{' '}
                      {i.entry.username || '（无用户名）'}
                    </div>
                  </div>
                  <span
                    className="shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold"
                    style={{ background: tone.bg, color: tone.color }}
                  >
                    {ISSUE_LABELS[primary]}
                  </span>
                  {onFix && (
                    <button
                      onClick={() => onFix(i.entry)}
                      className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-brand-700"
                    >
                      去修复 →
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* aside */}
      <div className="flex w-full shrink-0 flex-col gap-3.5 lg:w-[300px]">
        <div className="rounded-[14px] border border-gray-200 bg-surface p-[18px]">
          <div
            className="mx-auto mb-4 flex h-[130px] w-[130px] items-center justify-center rounded-full"
            style={{
              background: `conic-gradient(var(--color-ok) ${score * 3.6}deg, var(--color-gray-200) ${score * 3.6}deg)`,
            }}
          >
            <div className="flex h-[102px] w-[102px] flex-col items-center justify-center rounded-full bg-surface">
              <span className="text-[36px] font-bold leading-none">{score}</span>
              <span className="mt-0.5 text-[11px] text-gray-400">健康评分</span>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <Legend color="var(--color-danger)" label="弱密码" n={report.weak} />
            <Legend color="var(--color-warn)" label="重复使用" n={report.reused} />
            <Legend color="#cbd1da" label="陈旧未更新" n={report.old} />
          </div>
        </div>

        <div className="rounded-[14px] border border-gray-200 bg-surface p-4">
          <div className="mb-3 text-[12.5px] font-bold">扫描信息</div>
          <div className="flex flex-col gap-2.5 text-[12px]">
            <Info label="覆盖账号" value={`${report.total} 个`} />
            <Info label="检测方式" value="本地 · 不外传" valueClass="text-ok" />
          </div>
        </div>

        <div className="rounded-[14px] border border-gray-200 bg-surface p-4">
          <div className="mb-3 text-[12.5px] font-bold">安全建议</div>
          <div className="flex flex-col gap-2.5">
            {[
              '为生产环境账号开启 2FA 二步验证',
              '用「工具」里的生成器替换重复复用的密码',
              '定期轮换超过 180 天未更新的凭据',
            ].map((t) => (
              <div key={t} className="flex gap-2.5">
                <ListChecks size={14} className="mt-0.5 shrink-0 text-brand-600" />
                <span className="text-[11.5px] leading-snug text-gray-600">{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex-1 overflow-auto p-6">{body}</div>
    );
  }
  return (
    <Modal title="安全审计" onClose={onClose} wide>
      {body}
    </Modal>
  );
}

function StatCard({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="rounded-[13px] border border-gray-200 bg-surface p-[15px]">
      <div className="text-[28px] font-bold leading-none" style={{ color }}>
        {n}
      </div>
      <div className="mt-1.5 text-[11.5px] text-gray-600">{label}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'rounded-full px-3 py-1 text-[11px] font-semibold',
        active ? 'bg-brand-600 text-white' : 'border border-gray-200 bg-surface text-gray-600 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

function Legend({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      <span className="flex-1 text-[12px] text-gray-600">{label}</span>
      <span className="text-[12px] font-bold">{n}</span>
    </div>
  );
}

function Info({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center">
      <span className="flex-1 text-gray-400">{label}</span>
      <span className={cx('font-semibold', valueClass)}>{value}</span>
    </div>
  );
}

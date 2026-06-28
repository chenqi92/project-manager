// ---------------------------------------------------------------------------
// 多端同步整页（对齐设计 691–760）：E2EE 横幅 + 自动同步开关 + 目标卡
// （状态 pill / 存放位置 / 更改目录 / 双向同步·强推·强拉·前往授权）。
// 复用既有同步逻辑（api.syncTarget*），目录选择走 DirectoryPicker。
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  Download,
  Folder,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { Banner, Button, Toggle, cx } from '@/components/ui';
import { useDialog } from '@/components/Dialog';
import { api } from '@/lib/messaging';
import type { SyncTarget, SyncTargetType, SyncTargetView, VaultData } from '@/lib/types';
import { produce } from '@/lib/vault-ops';
import { SyncTargetEditor } from './SyncTargetEditor';
import { DirectoryPicker } from './DirectoryPicker';

class SkipError extends Error {}

const TAG: Record<SyncTargetType, { tag: string; bg: string; color: string }> = {
  'self-hosted': { tag: 'SH', bg: '#eef1f4', color: '#5b6472' },
  webdav: { tag: 'WD', bg: '#e3f5f1', color: '#0d9488' },
  github: { tag: 'GH', bg: '#fff3e2', color: '#d97706' },
  gitlab: { tag: 'GL', bg: '#fff3e2', color: '#d97706' },
  'google-drive': { tag: 'GD', bg: '#e9f8ee', color: '#15a34a' },
  onedrive: { tag: 'OD', bg: '#e4f2fb', color: '#2c84c8' },
  dropbox: { tag: 'DB', bg: '#e4ecff', color: '#2563eb' },
  synology: { tag: 'NAS', bg: '#f3e8fd', color: '#9333ea' },
};

export function SyncPage({
  data,
  onSave,
  refresh,
  onBackToSettings,
}: {
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
  refresh: () => Promise<void>;
  onBackToSettings: () => void;
}) {
  const { confirm, prompt } = useDialog();
  const [views, setViews] = useState<SyncTargetView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ target?: SyncTarget; authorized?: boolean } | null>(null);
  const [picking, setPicking] = useState<SyncTarget | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const load = async () => setViews((await api.syncTargets()).targets);
  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function resolveForeign(call: (pw?: string) => Promise<{ foreign?: boolean }>) {
    const r = await call();
    if (!r.foreign) return;
    const pw = await prompt({
      title: '检测到另一个保险箱',
      message: '远端是用不同主密码加密的保险箱。输入它的主密码以解密并合并：',
      placeholder: '远端主密码',
    });
    if (!pw) return;
    await call(pw);
  }

  const run = async (id: string, fn: () => Promise<void>, okText: string) => {
    setMsg(null);
    setBusyId(id);
    try {
      await fn();
      await load();
      await refresh();
      setMsg({ tone: 'info', text: okText });
    } catch (e) {
      if (e instanceof SkipError) return;
      const m = e instanceof Error ? e.message : String(e);
      // 群晖换设备/受信令牌失效 → 需要重新两步验证：弹 OTP 重绑后自动重试本次操作。
      const isSyno = id !== '__all__' && views.find((v) => v.target.id === id)?.target.type === 'synology';
      if (isSyno && /两步验证|OTP|otp/i.test(m)) {
        const code = await prompt({
          title: '需要重新两步验证',
          message: '群晖在本设备的受信令牌已失效（常见于换设备）。输入 OTP 一次性码重新绑定后会自动重试：',
          placeholder: '6 位动态码',
        });
        if (code && code.trim()) {
          try {
            await api.syncSynologyRebind(id, code.trim());
            await fn();
            await load();
            await refresh();
            setMsg({ tone: 'info', text: '已重新绑定，' + okText });
            return;
          } catch (e2) {
            await load();
            setMsg({ tone: 'error', text: e2 instanceof Error ? e2.message : String(e2) });
            return;
          }
        }
      }
      await load();
      setMsg({ tone: 'error', text: m });
    } finally {
      setBusyId(null);
    }
  };

  const syncOne = (v: SyncTargetView) =>
    run(
      v.target.id,
      async () => {
        const call = (pw?: string, confirmFirstPush?: boolean) =>
          api.syncTargetSync(v.target.id, pw, confirmFirstPush);
        let r = await call();
        // 新目标首次同步且远端为空：确认后才把本地推上去建立副本（防止误推、盖过本想拉取的意图）。
        if (r.emptyRemote) {
          const ok = await confirm({
            title: '远端为空 · 首次同步',
            message: (
              <>
                「{v.target.label}」上还没有备份文件。首次同步会把本地整库（AES-GCM
                加密密文）推送上去建立副本。
                <br />
                <br />
                若你其实是想从远端<strong>拉取已有数据</strong>
                ：请点取消，先用「更改目录」指到正确位置，再点「强制拉取」。
              </>
            ),
            confirmText: '建立首次副本',
          });
          if (!ok) throw new SkipError();
          r = await call(undefined, true);
        }
        if (r.foreign) {
          const pw = await prompt({
            title: '检测到另一个保险箱',
            message: '远端是用不同主密码加密的保险箱。输入它的主密码以解密并合并：',
            placeholder: '远端主密码',
          });
          if (pw) await call(pw, true);
        }
      },
      '同步完成',
    ).catch(() => {});
  const pushOne = (v: SyncTargetView) =>
    run(
      v.target.id,
      async () => {
        if (
          !(await confirm({
            message: `用本地整库（项目 / 账号 / 文档 / 待办全部，AES-GCM 加密密文）覆盖「${v.target.label}」上的备份文件？只替换该单个密文文件，不会清空目录其它内容。`,
            danger: true,
            confirmText: '强制推送',
          }))
        )
          throw new SkipError();
        await api.syncTargetPush(v.target.id);
      },
      '已推送',
    ).catch(() => {});
  const pullOne = (v: SyncTargetView) =>
    run(
      v.target.id,
      async () => {
        if (
          !(await confirm({
            message: `用「${v.target.label}」上的加密备份整体覆盖本地全部数据（项目 / 账号 / 文档 / 待办）？本地当前数据会被替换。`,
            danger: true,
            confirmText: '强制拉取',
          }))
        )
          throw new SkipError();
        await resolveForeign((pw) => api.syncTargetPull(v.target.id, pw));
      },
      '已拉取',
    ).catch(() => {});
  const removeOne = (v: SyncTargetView) =>
    run(
      v.target.id,
      async () => {
        if (
          !(await confirm({
            message: `移除「${v.target.label}」并尝试删除其远端副本？本地数据保留。`,
            danger: true,
          }))
        )
          throw new SkipError();
        await api.syncTargetRemove(v.target.id);
      },
      '已移除',
    ).catch(() => {});

  const syncAll = () => run('__all__', () => api.syncNow(), '已同步全部');

  const applyDirectory = async (next: SyncTarget) => {
    setMsg(null);
    try {
      const { targets } = await api.syncTargetSave(next);
      setViews(targets);
      await refresh();
      setMsg({ tone: 'info', text: '存放位置已更新' });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const autoOn = data.settings.syncAuto !== false;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        {/* breadcrumb */}
        <div className="mb-3.5 flex items-center gap-2 text-xs text-gray-400">
          <span
            onClick={onBackToSettings}
            className="flex cursor-pointer items-center gap-1 hover:text-gray-600"
          >
            <ChevronLeft size={14} /> 设置
          </span>
          <span>/</span>
          <span className="font-semibold text-gray-700">多端同步</span>
        </div>

        {/* E2EE 横幅 + 自动同步 */}
        <div className="mb-[18px] flex items-center gap-3 rounded-xl border border-[#c7ecd3] bg-okbg px-4 py-3">
          <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-ok text-white">
            <Lock size={16} />
          </span>
          <div className="flex-1">
            <div className="text-[12.5px] font-semibold text-[#13683a]">
              端到端加密 · 服务器只能看到整库密文
            </div>
            <div className="text-[11px] text-[#2f7a52]">
              主密码派生密钥在本机加解密；任意目标都无法解密你的数据。
            </div>
          </div>
          <span className="text-[11.5px] text-gray-600">内容修改后自动同步</span>
          <Toggle
            checked={autoOn}
            onChange={() => onSave(produce(data, (d) => void (d.settings.syncAuto = !autoOn)))}
          />
        </div>

        <div className="mb-3 flex items-center">
          <div className="text-[13px] font-bold">
            同步目标 <span className="font-medium text-gray-400">{views.length}</span>
          </div>
          <div className="flex-1" />
          {views.some((v) => v.target.enabled) && (
            <Button variant="outline" disabled={busyId !== null} onClick={syncAll}>
              {busyId === '__all__' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}{' '}
              同步全部
            </Button>
          )}
        </div>

        {msg && (
          <div className="mb-3">
            <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {views.length === 0 && (
            <p className="rounded-xl border border-dashed border-gray-200 py-10 text-center text-sm text-gray-400">
              尚未配置任何同步目标
            </p>
          )}
          {views.map((v) => {
            const tag = TAG[v.target.type];
            const busy = busyId === v.target.id;
            const status =
              v.authorized === false
                ? { text: '待授权', color: 'var(--color-warn)', bg: 'var(--color-warnbg)' }
                : v.state?.lastError
                  ? { text: '错误', color: 'var(--color-danger)', bg: 'var(--color-dangerbg)' }
                  : v.state?.lastSyncAt
                    ? { text: '已同步', color: 'var(--color-ok)', bg: 'var(--color-okbg)' }
                    : { text: '未同步', color: 'var(--color-tx3, #969eaa)', bg: 'var(--color-gray-100)' };
            return (
              <div
                key={v.target.id}
                className="rounded-[14px] border border-gray-200 bg-surface p-[18px] shadow-[0_1px_2px_rgba(16,24,40,.04)]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] text-[13px] font-bold"
                    style={{ background: tag.bg, color: tag.color }}
                  >
                    {tag.tag}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-sm font-bold">{v.target.label}</span>
                      <span
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-bold"
                        style={{ color: status.color, background: status.bg }}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: status.color }}
                        />
                        {status.text}
                      </span>
                      {!v.target.enabled && (
                        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400">
                          已停用
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-gray-400">
                      {v.summary}
                      {v.state?.lastSyncAt
                        ? ` · 上次同步 ${new Date(v.state.lastSyncAt).toLocaleString()}`
                        : ''}
                    </div>
                    {v.state?.lastError && (
                      <div className="truncate text-[11px] text-danger">错误：{v.state.lastError}</div>
                    )}
                  </div>
                  <div className="relative shrink-0">
                    <button
                      onClick={() => setMenuId((m) => (m === v.target.id ? null : v.target.id))}
                      className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {menuId === v.target.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenuId(null)} />
                        <div className="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-xl border border-gray-200 bg-surface p-1 shadow-xl">
                          <MenuItem
                            onClick={() => {
                              setMenuId(null);
                              setEditing({ target: v.target, authorized: v.authorized });
                            }}
                          >
                            编辑
                          </MenuItem>
                          <MenuItem
                            danger
                            onClick={() => {
                              setMenuId(null);
                              removeOne(v);
                            }}
                          >
                            移除
                          </MenuItem>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* 存放位置 */}
                <div className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-gray-100 bg-gray-50 px-3 py-2.5">
                  <Folder size={15} className="shrink-0" style={{ color: tag.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] text-gray-400">存放位置</div>
                    <div className="truncate font-mono text-[12px] text-gray-800">{v.summary}</div>
                  </div>
                  <Button variant="outline" onClick={() => setPicking(v.target)}>
                    更改目录
                  </Button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => syncOne(v)}>
                    {busy ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}{' '}
                    双向同步
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => pushOne(v)}>
                    <Upload size={13} /> 强制推送
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => pullOne(v)}>
                    <Download size={13} /> 强制拉取
                  </Button>
                  <div className="flex-1" />
                  {v.authorized === false && (
                    <Button
                      className="!bg-warn"
                      onClick={() => setEditing({ target: v.target, authorized: v.authorized })}
                    >
                      前往授权
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3">
          <Button variant="outline" onClick={() => setEditing({})}>
            <Plus size={14} /> 添加同步目标
          </Button>
        </div>
      </div>

      {editing && (
        <SyncTargetEditor
          initial={editing.target}
          initialAuthorized={editing.authorized}
          onClose={() => setEditing(null)}
          onSaved={(targets) => {
            setViews(targets);
            refresh().catch(() => {});
          }}
        />
      )}
      {picking && (
        <DirectoryPicker
          target={picking}
          onClose={() => setPicking(null)}
          onApply={applyDirectory}
          browse={
            picking.type === 'synology'
              ? (segs) =>
                  api.syncListDir({ id: picking!.id, path: segs }).then((r) => r.folders.map((f) => f.name))
              : undefined
          }
        />
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12.5px] font-medium hover:bg-gray-100',
        danger ? 'text-danger' : 'text-gray-700',
      )}
    >
      {children}
    </button>
  );
}

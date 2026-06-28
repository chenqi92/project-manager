import { useEffect, useState } from 'react';
import { Fingerprint, Layers, Loader2, Palette, Plus, Trash2 } from 'lucide-react';
import {
  Banner,
  Button,
  Input,
  Label,
  Modal,
  SettingsCard,
  SettingsRow,
  Segmented,
  Toggle,
} from '@/components/ui';
import { useDialog } from '@/components/Dialog';
import { toB64 } from '@/lib/crypto';
import { api } from '@/lib/messaging';
import { applyTheme, type Theme } from '@/lib/theme';
import type { BioEnrollmentPublic, SyncTargetType, SyncTargetView, VaultData } from '@/lib/types';
import { produce } from '@/lib/vault-ops';
import { enrollBiometricCredential, isPlatformAuthAvailable } from '@/lib/webauthn';

const LOCK_OPTS = [0, 1, 5, 10, 15, 30, 60];
const lockLabel = (n: number) => (n <= 0 ? '不自动锁定' : `${n} 分钟`);

const PROVIDER_TAG: Record<SyncTargetType, { tag: string; bg: string; color: string }> = {
  'self-hosted': { tag: 'SH', bg: '#eef1f4', color: '#5b6472' },
  webdav: { tag: 'WD', bg: '#e3f5f1', color: '#0d9488' },
  github: { tag: 'GH', bg: '#fff3e2', color: '#d97706' },
  gitlab: { tag: 'GL', bg: '#fff3e2', color: '#d97706' },
  'google-drive': { tag: 'GD', bg: '#e9f8ee', color: '#15a34a' },
  onedrive: { tag: 'OD', bg: '#e4f2fb', color: '#2c84c8' },
  dropbox: { tag: 'DB', bg: '#e4ecff', color: '#2563eb' },
  synology: { tag: 'NAS', bg: '#f3e8fd', color: '#9333ea' },
};

export function Settings({
  data,
  onSave,
  onReset,
  refresh,
  onOpenSync,
  onOpenIO,
  onOpenCnb,
  onGoHome,
}: {
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
  onReset: () => Promise<void>;
  refresh: () => Promise<void>;
  onOpenSync: () => void;
  onOpenIO: () => void;
  onOpenCnb: () => void;
  onGoHome: () => void;
}) {
  const { confirm } = useDialog();
  const [pwOpen, setPwOpen] = useState(false);
  const [views, setViews] = useState<SyncTargetView[]>([]);
  useEffect(() => {
    api.syncTargets().then((r) => setViews(r.targets)).catch(() => {});
  }, []);

  const theme = (data.settings.theme ?? 'system') as Theme;
  const setTheme = async (v: Theme) => {
    applyTheme(v);
    await onSave(produce(data, (d) => void (d.settings.theme = v)));
  };
  const setSetting = (fn: (d: VaultData) => void) => onSave(produce(data, fn));

  const memoOn = data.settings.floatingMemoHidden !== true;
  const autoSubmit = data.settings.autoSubmit === true;
  const lockN = data.settings.autoLockMinutes ?? 10;

  const reset = async () => {
    if (
      !(await confirm({
        title: '清空保险箱',
        message:
          '确定要清空整个保险箱吗？此操作不可恢复，所有项目与账号都会被删除。建议先做加密备份导出。',
        danger: true,
        confirmText: '清空',
      }))
    )
      return;
    await onReset();
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto grid max-w-[1040px] grid-cols-1 items-start gap-[18px] lg:grid-cols-2">
        {/* LEFT */}
        <div className="flex flex-col gap-[18px]">
          <SettingsCard title="外观">
            <SettingsRow title="主题" desc="解锁前跟随系统，解锁后按此设置" first>
              <Segmented
                value={theme}
                onChange={(v) => setTheme(v)}
                options={[
                  { value: 'light', label: '明亮' },
                  { value: 'dark', label: '深色' },
                  { value: 'system', label: '跟随系统' },
                ]}
              />
            </SettingsRow>
            <SettingsRow
              title="浮动备忘小组件"
              desc="在右下角显示可拖动的待办悬浮窗"
            >
              <Toggle
                checked={memoOn}
                onChange={() => setSetting((d) => void (d.settings.floatingMemoHidden = memoOn))}
              />
            </SettingsRow>
            <SettingsRow
              title="联网磁贴"
              desc="天气 / 今日热榜 / 股票需联网到第三方；关闭则不发任何网络请求（默认关闭）"
            >
              <Toggle
                checked={data.settings.weatherEnabled === true}
                onChange={(v) => setSetting((d) => void (d.settings.weatherEnabled = v))}
              />
            </SettingsRow>
            <SettingsRow
              title="页面背景与个性化"
              desc="在首页「外观」里为看板选择预设渐变或上传自定义背景图"
            >
              <Button variant="outline" onClick={onGoHome}>
                <Palette size={14} /> 个性化…
              </Button>
            </SettingsRow>
          </SettingsCard>

          <SettingsCard title="安全">
            <SettingsRow title="主密码" desc="用于解锁并派生加密密钥，请使用强密码并妥善保管" first>
              <Button variant="outline" onClick={() => setPwOpen(true)}>
                修改主密码
              </Button>
            </SettingsRow>
            <SettingsRow title="空闲自动锁定" desc="无操作达到时长后自动锁定金库（0 = 不锁，不推荐）">
              <select
                value={lockN}
                onChange={(e) =>
                  setSetting((d) => void (d.settings.autoLockMinutes = Number(e.target.value)))
                }
                className="h-[34px] rounded-[9px] border border-gray-200 bg-surface px-3 text-[12.5px] font-semibold text-gray-800 outline-none focus:border-brand-500"
              >
                {LOCK_OPTS.map((n) => (
                  <option key={n} value={n}>
                    {lockLabel(n)}
                  </option>
                ))}
              </select>
            </SettingsRow>
            <SettingsRow
              title="填充后自动登录"
              desc="仅当 origin 完全一致时才会自动提交（默认关闭）"
            >
              <Toggle
                checked={autoSubmit}
                onChange={() => setSetting((d) => void (d.settings.autoSubmit = !autoSubmit))}
              />
            </SettingsRow>
            <BiometricRow refresh={refresh} />
          </SettingsCard>
        </div>

        {/* RIGHT */}
        <div className="flex flex-col gap-[18px]">
          <SettingsCard title="同步">
            <SettingsRow
              title="多端同步"
              desc={`${views.length} 个目标 · 端到端加密 · 内容修改后自动同步`}
              first
            >
              <Button variant="outline" onClick={onOpenSync}>
                管理目标 →
              </Button>
            </SettingsRow>
            {views.length > 0 && (
              <div className="flex flex-wrap gap-2 pb-3.5">
                {views.map((v) => {
                  const tg = PROVIDER_TAG[v.target.type];
                  return (
                    <span
                      key={v.target.id}
                      className="flex items-center gap-1.5 rounded-[9px] bg-gray-50 px-2.5 py-2"
                    >
                      <span
                        className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-[9px] font-bold"
                        style={{ background: tg.bg, color: tg.color }}
                      >
                        {tg.tag}
                      </span>
                      <span
                        className={
                          v.authorized === false ? 'text-[11px] text-warn' : 'text-[11px] text-gray-600'
                        }
                      >
                        {v.authorized === false ? '待授权' : v.state?.lastSyncAt ? '已同步' : '未同步'}
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
          </SettingsCard>

          <SettingsCard title="集成">
            <SettingsRow
              title="代码仓库（CNB）"
              desc={
                data.settings.cnb?.token
                  ? `已连接 · ${data.settings.cnb.orgs?.length ?? 0} 个组织 · 令牌加密存储`
                  : '从 cnb.cool 拉取仓库，按子组织/项目分组浏览'
              }
              first
            >
              <Button variant="outline" onClick={onOpenCnb}>
                {data.settings.cnb?.token ? '管理 →' : '去配置 →'}
              </Button>
            </SettingsRow>
          </SettingsCard>

          <SettingsCard title="数据安全">
            <div className="flex items-center gap-2.5 border-t border-gray-100 py-3.5">
              <Button variant="outline" className="flex-1" onClick={onOpenIO}>
                导出加密备份
              </Button>
              <Button variant="outline" className="flex-1" onClick={onOpenIO}>
                导入 / 迁移
              </Button>
            </div>
            <SettingsRow
              title="清空保险箱"
              titleClass="text-danger"
              desc="删除本机全部数据，此操作不可恢复，请先备份"
            >
              <Button variant="danger" onClick={reset}>
                清空…
              </Button>
            </SettingsRow>
          </SettingsCard>

          <SettingsCard title="关于">
            <div className="flex items-center gap-3 border-t border-gray-100 py-3.5">
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-brand-600 text-white">
                <Layers size={18} />
              </span>
              <div className="flex-1">
                <div className="text-[13px] font-semibold">项目环境管家</div>
                <div className="font-mono text-[11px] text-gray-400">
                  本地端到端加密 · 零知识 · 默认不联网
                </div>
              </div>
            </div>
          </SettingsCard>
        </div>
      </div>

      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
}

// --------------------------- 生物识别行 ---------------------------

function BiometricRow({ refresh }: { refresh: () => Promise<void> }) {
  const { confirm, prompt } = useDialog();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [list, setList] = useState<BioEnrollmentPublic[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const load = async () => setList(await api.bioEnrollments());
  useEffect(() => {
    isPlatformAuthAvailable().then(setAvailable);
    load();
  }, []);

  const enroll = async () => {
    setMsg(null);
    const guess =
      // @ts-expect-error userAgentData 在新版浏览器可用
      (navigator.userAgentData?.platform as string | undefined) || navigator.platform || '本设备';
    const label = await prompt({ title: '生物识别', message: '给这台设备/授权器起个名字', defaultValue: guess });
    if (!label) return;
    setBusy(true);
    try {
      const r = await enrollBiometricCredential();
      await api.enrollBio(label, r.credentialId, r.prfSalt, toB64(r.prfOutput));
      await load();
      await refresh();
      setMsg({ tone: 'info', text: '已添加生物识别解锁' });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ message: '移除该生物识别注册？', danger: true }))) return;
    setBusy(true);
    try {
      await api.removeBio(id);
      await load();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-gray-100 py-3.5">
      <div className="mb-2.5 flex items-center gap-3">
        <div className="flex-1">
          <div className="text-[13px] font-semibold">生物识别解锁</div>
          <div className="mt-0.5 text-[11.5px] text-gray-400">
            Touch ID / Windows Hello · 主密码始终保留作兜底
          </div>
        </div>
        {available && (
          <Button variant="outline" disabled={busy} onClick={enroll}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} 注册本设备
          </Button>
        )}
      </div>
      {available === false && (
        <Banner tone="warn">本设备没有可用的平台生物识别（或浏览器/系统版本过低）。</Banner>
      )}
      {list.length > 0 && (
        <div className="flex flex-col gap-2">
          {list.map((e) => (
            <div key={e.id} className="flex items-center gap-2.5 rounded-[9px] bg-gray-50 px-3 py-2.5">
              <Fingerprint size={16} className="text-brand-600" />
              <div className="flex-1 text-[12.5px] font-semibold">{e.label}</div>
              <button
                onClick={() => remove(e.id)}
                className="text-[11.5px] font-semibold text-danger hover:underline"
              >
                移除
              </button>
            </div>
          ))}
        </div>
      )}
      {msg && (
        <div className="mt-2">
          <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>
        </div>
      )}
    </div>
  );
}

// --------------------------- 改主密码 ---------------------------

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const change = async () => {
    setMsg(null);
    if (next.length < 8) return setMsg({ tone: 'error', text: '新主密码至少 8 位' });
    if (next !== next2) return setMsg({ tone: 'error', text: '两次输入不一致' });
    setBusy(true);
    try {
      await api.changePassword(cur, next);
      setMsg({ tone: 'info', text: '主密码已修改' });
      setCur('');
      setNext('');
      setNext2('');
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="修改主密码" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <Label>当前主密码</Label>
          <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </div>
        <div>
          <Label>新主密码</Label>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <Label>确认新主密码</Label>
          <Input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} />
        </div>
        {msg && <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={change}>
            {busy && <Loader2 size={14} className="animate-spin" />} 修改主密码
          </Button>
        </div>
      </div>
    </Modal>
  );
}

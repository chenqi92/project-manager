import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Cloud, Fingerprint, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Banner, Button, Input, Label, Modal, Select } from '@/components/ui';
import { useDialog } from '@/components/Dialog';
import { toB64 } from '@/lib/crypto';
import { api, type SyncStateResp } from '@/lib/messaging';
import { applyTheme, type Theme } from '@/lib/theme';
import type { BioEnrollmentPublic, VaultData } from '@/lib/types';
import { produce } from '@/lib/vault-ops';
import { enrollBiometricCredential, isPlatformAuthAvailable } from '@/lib/webauthn';

export function Settings({
  data,
  onClose,
  onSave,
  onReset,
  refresh,
}: {
  data: VaultData;
  onClose: () => void;
  onSave: (next: VaultData) => Promise<void>;
  onReset: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  return (
    <Modal title="设置" onClose={onClose} wide>
      <div className="flex flex-col gap-6">
        <AppearanceSection data={data} onSave={onSave} />
        <FillSection data={data} onSave={onSave} />
        <SyncSection data={data} onSave={onSave} refresh={refresh} />
        <BiometricSection refresh={refresh} />
        <AutoLockSection data={data} onSave={onSave} />
        <ChangePasswordSection />
        <DangerSection onReset={onReset} onClose={onClose} />
      </div>
    </Modal>
  );
}

// --------------------------- 同步 ---------------------------

function SyncSection({
  data,
  onSave,
  refresh,
}: {
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const { confirm } = useDialog();
  const [state, setState] = useState<SyncStateResp | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const load = async () => setState(await api.syncState());
  useEffect(() => {
    load();
  }, []);

  const enable = async () => {
    setMsg(null);
    if (!serverUrl.trim() || !token.trim()) return setMsg({ tone: 'error', text: '请填写服务器地址和令牌' });
    let origin: string;
    try {
      origin = new URL(serverUrl.trim()).origin;
    } catch {
      return setMsg({ tone: 'error', text: '服务器地址不合法' });
    }
    setBusy(true);
    try {
      const granted = await browser.permissions.request({ origins: [origin + '/*'] });
      if (!granted) throw new Error('未授予对该服务器的访问权限');
      await api.syncConfigure(serverUrl.trim(), token.trim());
      await load();
      await refresh();
      setMsg({ tone: 'info', text: '同步已启用' });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setMsg(null);
    setBusy(true);
    try {
      await api.syncNow();
      await load();
      setMsg({ tone: 'info', text: '同步完成' });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!(await confirm({ message: '关闭同步并删除服务器上的副本？本地数据保留。', danger: true }))) return;
    setBusy(true);
    try {
      await api.syncDisable();
      await load();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const enabled = state?.config?.enabled;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
        <Cloud size={16} /> 自托管同步
      </h3>
      <p className="text-xs text-gray-500">
        端到端加密同步到你自己的服务器；服务器只存密文，无法解密。多设备共享同一个保险箱。
      </p>

      {!enabled ? (
        <div className="flex flex-col gap-2">
          <Label>服务器地址</Label>
          <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://sync.example.com" />
          <Label>令牌（首次启动服务端时打印的 Token）</Label>
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token" />
          <Button disabled={busy} onClick={enable} className="self-start">
            {busy && <Loader2 size={14} className="animate-spin" />} 启用同步
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg bg-gray-50 p-3 text-xs">
          <div className="text-gray-600">服务器：{state?.config?.serverUrl}</div>
          <div className="text-gray-500">
            服务器 revision：{state?.state?.serverRevision ?? '—'}
            {state?.state?.lastSyncAt && (
              <> · 上次同步：{new Date(state.state.lastSyncAt).toLocaleString()}</>
            )}
          </div>
          {state?.state?.lastError && (
            <div className="text-rose-600">上次错误：{state.state.lastError}</div>
          )}
          <label className="mt-1 flex items-center gap-2 text-gray-600">
            <input
              type="checkbox"
              checked={data.settings.syncAuto !== false}
              onChange={() =>
                onSave(
                  produce(
                    data,
                    (d) => void (d.settings.syncAuto = !(data.settings.syncAuto !== false)),
                  ),
                )
              }
            />
            内容修改后自动同步（关闭则只手动同步）
          </label>
          <div className="mt-1 flex gap-2">
            <Button variant="subtle" disabled={busy} onClick={syncNow}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 立即同步
            </Button>
            <Button variant="danger" disabled={busy} onClick={disable}>
              关闭并删除远端
            </Button>
          </div>
        </div>
      )}
      {msg && <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>}
    </section>
  );
}

// --------------------------- 生物识别 ---------------------------

function BiometricSection({ refresh }: { refresh: () => Promise<void> }) {
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
    const label = await prompt({
      title: '生物识别',
      message: '给这台设备/授权器起个名字',
      defaultValue: guess,
    });
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
    <section className="flex flex-col gap-2 border-t border-gray-100 pt-5">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
        <Fingerprint size={16} /> 生物识别解锁（Touch ID / Windows Hello）
      </h3>
      <p className="text-xs text-gray-500">
        作为<strong>额外</strong>的解锁方式，主密码始终保留作兜底。每台设备需各自注册；
        丢失设备不会锁死保险箱。
      </p>

      {available === false && (
        <Banner tone="warn">本设备没有可用的平台生物识别（或浏览器/系统版本过低）。</Banner>
      )}

      {list.length > 0 && (
        <div className="flex flex-col gap-1">
          {list.map((e) => (
            <div
              key={e.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <Fingerprint size={14} className="text-brand-600" /> {e.label}
              </span>
              <button onClick={() => remove(e.id)} className="text-gray-400 hover:text-rose-600">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {available && (
        <Button variant="subtle" disabled={busy} onClick={enroll} className="self-start">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />}
          添加本设备的生物识别
        </Button>
      )}
      {msg && <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>}
    </section>
  );
}

// --------------------------- 外观 ---------------------------

function AppearanceSection({
  data,
  onSave,
}: {
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
}) {
  const theme = data.settings.theme ?? 'system';
  const change = async (value: Theme) => {
    applyTheme(value); // 立即生效
    await onSave(produce(data, (d) => void (d.settings.theme = value)));
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-gray-800">外观</h3>
      <Label>主题</Label>
      <Select
        value={theme}
        onChange={(e) => change(e.target.value as Theme)}
        className="w-40"
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </Select>
    </section>
  );
}

// --------------------------- 填充 ---------------------------

function FillSection({
  data,
  onSave,
}: {
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
}) {
  const autoSubmit = data.settings.autoSubmit === true;
  const toggle = async () => {
    await onSave(produce(data, (d) => void (d.settings.autoSubmit = !autoSubmit)));
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-gray-800">填充</h3>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={autoSubmit} onChange={toggle} />
        填充后自动提交（直接登录）
      </label>
      <p className="text-[11px] text-gray-400">
        关闭后只填账号密码、不自动提交，需你手动点登录。仅在网址 origin 完全一致的页面才会提交。
      </p>
    </section>
  );
}

// --------------------------- 自动锁定 ---------------------------

function AutoLockSection({
  data,
  onSave,
}: {
  data: VaultData;
  onSave: (next: VaultData) => Promise<void>;
}) {
  const [autoLock, setAutoLock] = useState(String(data.settings.autoLockMinutes));
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const n = Math.max(0, Math.floor(Number(autoLock) || 0));
    await onSave(produce(data, (d) => void (d.settings.autoLockMinutes = n)));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section className="flex flex-col gap-2 border-t border-gray-100 pt-5">
      <h3 className="text-sm font-semibold text-gray-800">自动锁定</h3>
      <Label>空闲多少分钟后自动锁定（0 = 不自动锁定，不推荐）</Label>
      <div className="flex items-center gap-2">
        <div className="w-28 shrink-0">
          <Input
            type="number"
            min={0}
            value={autoLock}
            onChange={(e) => setAutoLock(e.target.value)}
          />
        </div>
        <Button variant="subtle" className="shrink-0 whitespace-nowrap" onClick={save}>
          保存
        </Button>
        {saved && <span className="text-xs text-emerald-600">已保存</span>}
      </div>
    </section>
  );
}

// --------------------------- 改主密码 ---------------------------

function ChangePasswordSection() {
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
      setCur('');
      setNext('');
      setNext2('');
      setMsg({ tone: 'info', text: '主密码已修改' });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 border-t border-gray-100 pt-5">
      <h3 className="text-sm font-semibold text-gray-800">修改主密码</h3>
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
      <Button disabled={busy} onClick={change} className="self-start">
        修改主密码
      </Button>
      {msg && <Banner tone={msg.tone === 'error' ? 'error' : 'info'}>{msg.text}</Banner>}
    </section>
  );
}

// --------------------------- 危险操作 ---------------------------

function DangerSection({ onReset, onClose }: { onReset: () => Promise<void>; onClose: () => void }) {
  const { confirm } = useDialog();
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
    onClose();
  };

  return (
    <section className="flex flex-col gap-2 border-t border-gray-100 pt-5">
      <h3 className="text-sm font-semibold text-rose-700">危险操作</h3>
      <p className="text-xs text-gray-500">清空保险箱会删除全部本地数据且不可恢复。</p>
      <Button variant="danger" onClick={reset} className="self-start">
        清空整个保险箱
      </Button>
    </section>
  );
}

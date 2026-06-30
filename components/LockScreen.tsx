import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Fingerprint, KeyRound, Loader2, Lock } from 'lucide-react';
import { Banner, Button, Input, Label, cx } from './ui';

function PasswordField({
  value,
  onChange,
  placeholder,
  autoFocus,
  autoComplete,
  show,
  onToggleShow,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  autoComplete?: string;
  show: boolean;
  onToggleShow: () => void;
}) {
  return (
    <div className="flex h-[46px] items-center gap-2.5 rounded-[11px] border-[1.5px] border-gray-200 bg-gray-50 px-3.5 transition focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100">
      <Lock size={16} className="shrink-0 text-gray-400" />
      <input
        type={show ? 'text' : 'password'}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[15px] text-gray-900 outline-none placeholder:text-gray-400"
      />
      <button
        type="button"
        onClick={onToggleShow}
        className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        title={show ? '隐藏' : '显示'}
        aria-label={show ? '隐藏密码' : '显示密码'}
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

export function LockScreen({
  initialized,
  firstRun,
  compact,
  hasBiometric,
  onUnlock,
  onCreate,
  onBioUnlock,
  onAdopt,
}: {
  initialized: boolean;
  firstRun?: boolean;
  compact?: boolean;
  hasBiometric?: boolean;
  onUnlock: (password: string) => Promise<void>;
  onCreate: (password: string) => Promise<void>;
  /** 生物识别解锁。options 页直接跑 WebAuthn；popup 里应改为打开新标签页。 */
  onBioUnlock?: () => Promise<void>;
  /** 从同步服务器恢复保险箱（新设备）。 */
  onAdopt?: (serverUrl: string, token: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAdopt, setShowAdopt] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const autoBioTried = useRef(false);
  const creating = !initialized;
  const showFirstRunGuide = Boolean(firstRun && creating && !compact);
  const passwordLabel = creating ? '保险库密码' : '主密码';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!initialized) {
      if (pw.length < 8) return setErr('保险库密码至少 8 位');
      if (pw !== pw2) return setErr('两次输入不一致');
    } else if (!pw) {
      return setErr('请输入主密码');
    }
    setBusy(true);
    try {
      if (initialized) await onUnlock(pw);
      else await onCreate(pw);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runBio = async () => {
    if (!onBioUnlock) return;
    setErr(null);
    setBusy(true);
    try {
      await onBioUnlock();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(/取消|cancel|abort/i.test(msg) ? '已取消生物识别，可输入主密码解锁' : msg);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!initialized || compact || !hasBiometric || !onBioUnlock || autoBioTried.current) return;
    autoBioTried.current = true;
    void runBio();
  }, [initialized, compact, hasBiometric, onBioUnlock]);

  const runAdopt = async () => {
    if (!onAdopt) return;
    setErr(null);
    if (!serverUrl.trim() || !token.trim()) return setErr('请填写服务器地址和令牌');
    setBusy(true);
    try {
      await onAdopt(serverUrl.trim(), token.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const card = (
    <div
      className={cx(
        'flex flex-col',
        compact
          ? 'gap-3 p-5'
          : cx(
              showFirstRunGuide ? 'w-[420px]' : 'w-[360px]',
              'gap-0 rounded-[18px] bg-surface p-7 shadow-[0_30px_60px_-20px_rgba(20,26,40,.3),0_0_0_1px_rgba(20,26,40,.04)]',
            ),
      )}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex h-[54px] w-[54px] items-center justify-center rounded-[15px] bg-brand-600 text-white shadow-[0_10px_24px_-6px_rgba(13,148,136,.45)]">
          {initialized ? <KeyRound size={26} /> : <Lock size={26} />}
        </span>
        <div className="mt-2 text-lg font-bold text-gray-900">
          {initialized ? '欢迎回来' : firstRun ? '先创建保险库密码' : '创建保险箱'}
        </div>
        <div className="text-[12.5px] text-gray-400">
          {initialized
            ? hasBiometric
              ? '可用生物识别或主密码解锁保险箱'
              : '输入主密码解锁保险箱'
            : '保险库密码用于加密全部数据，本地派生、永不上传'}
        </div>
      </div>

      {showFirstRunGuide && (
        <div className="mt-5 rounded-[14px] border border-brand-100 bg-brand-50/70 p-3.5 text-left">
          <div className="text-[12px] font-bold text-brand-700">首次使用</div>
          <div className="mt-1 text-[12px] leading-5 text-gray-600">
            先设置一个只有你知道的保险库密码。创建后会进入管理页面，可继续新建项目、导入备份或开启同步。
          </div>
          <div className="mt-2 grid gap-1 text-[11.5px] font-medium text-gray-500">
            <div>1. 创建保险库密码</div>
            <div>2. 进入管理页添加项目和账号</div>
            <div>3. 后续登录网站时自动保存和填充</div>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        <div>
          {!initialized && <Label>{passwordLabel}</Label>}
          <PasswordField
            value={pw}
            onChange={setPw}
            placeholder={initialized ? '主密码' : '设置保险库密码'}
            autoFocus={!hasBiometric}
            autoComplete={initialized ? 'current-password' : 'new-password'}
            show={show}
            onToggleShow={() => setShow((s) => !s)}
          />
        </div>
        {!initialized && (
          <div>
            <Label>确认{passwordLabel}</Label>
            <PasswordField
              value={pw2}
              onChange={setPw2}
              placeholder="再次输入保险库密码"
              autoComplete="new-password"
              show={showConfirm}
              onToggleShow={() => setShowConfirm((s) => !s)}
            />
          </div>
        )}

        {err && <Banner tone="error">{err}</Banner>}
        {!initialized && (
          <Banner tone="warn">
            保险库密码无法找回。一旦遗忘，已加密的数据将<strong>永久无法解密</strong>
            。请务必牢记并定期做加密备份导出。
          </Banner>
        )}

        <button
          type="submit"
          disabled={busy}
          className="flex h-[46px] items-center justify-center gap-2 rounded-[11px] bg-brand-600 text-sm font-semibold text-white shadow-[0_6px_16px_-4px_rgba(13,148,136,.42)] hover:bg-brand-700 disabled:opacity-50"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {initialized ? '解锁' : '创建保险库并进入'}
        </button>
      </form>

      {initialized && hasBiometric && onBioUnlock && (
        <>
          <div className="my-4 flex items-center gap-2.5">
            <span className="h-px flex-1 bg-gray-200" />
            <span className="text-[11px] text-gray-400">或</span>
            <span className="h-px flex-1 bg-gray-200" />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={runBio}
            className="flex h-11 items-center justify-center gap-2.5 rounded-[11px] border-[1.5px] border-gray-200 bg-surface text-[13px] font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
          >
            <Fingerprint size={18} className="text-brand-600" />
            用生物识别解锁
            {compact && <span className="text-[11px] text-gray-400">（新标签页）</span>}
          </button>
        </>
      )}

      {!initialized && onAdopt && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          {!showAdopt ? (
            <button onClick={() => setShowAdopt(true)} className="text-xs font-semibold text-brand-600 hover:underline">
              已有同步保险箱？从同步服务器恢复 →
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <Label>同步服务器地址</Label>
              <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://sync.example.com" />
              <Label>令牌</Label>
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token" />
              <Button variant="outline" disabled={busy} onClick={runAdopt}>
                拉取并恢复
              </Button>
              <p className="text-[11px] text-gray-400">
                恢复后用该保险箱的主密码解锁。这会覆盖本机现有保险箱（如果有）。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (compact) return card;
  return <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">{card}</div>;
}

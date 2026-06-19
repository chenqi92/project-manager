import { useState } from 'react';
import { Fingerprint, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { Banner, Button, Input, Label } from './ui';

export function LockScreen({
  initialized,
  compact,
  hasBiometric,
  onUnlock,
  onCreate,
  onBioUnlock,
  onAdopt,
}: {
  initialized: boolean;
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAdopt, setShowAdopt] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!initialized) {
      if (pw.length < 8) return setErr('主密码至少 8 位');
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
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <div
      className={
        compact
          ? 'flex flex-col gap-4 p-5'
          : 'mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6'
      }
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white">
          {initialized ? <KeyRound size={24} /> : <ShieldCheck size={24} />}
        </div>
        <h1 className="text-lg font-semibold text-gray-900">
          {initialized ? '解锁保险箱' : '创建主密码'}
        </h1>
        <p className="text-xs text-gray-500">
          {initialized
            ? '输入主密码以解锁本地加密的凭据库'
            : '主密码用于加密全部数据，本地派生、永不上传'}
        </p>
      </div>

      {initialized && hasBiometric && onBioUnlock && (
        <Button variant="subtle" disabled={busy} onClick={runBio} className="w-full">
          <Fingerprint size={16} /> 使用生物识别解锁
          {compact && <span className="text-[11px] text-gray-400">（新标签页）</span>}
        </Button>
      )}

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div>
          <Label>主密码</Label>
          <Input
            type="password"
            autoFocus={!hasBiometric}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="主密码"
          />
        </div>
        {!initialized && (
          <div>
            <Label>确认主密码</Label>
            <Input
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              placeholder="再次输入"
            />
          </div>
        )}

        {err && <Banner tone="error">{err}</Banner>}

        {!initialized && (
          <Banner tone="warn">
            主密码无法找回。一旦遗忘，已加密的数据将<strong>永久无法解密</strong>
            。请务必牢记，并定期做加密备份导出。
          </Banner>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {busy && <Loader2 size={16} className="animate-spin" />}
          {initialized ? '解锁' : '创建并解锁'}
        </Button>
      </form>

      {!initialized && onAdopt && (
        <div className="border-t border-gray-100 pt-3">
          {!showAdopt ? (
            <button
              onClick={() => setShowAdopt(true)}
              className="text-xs text-brand-600 hover:underline"
            >
              已有同步保险箱？从同步服务器恢复 →
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <Label>同步服务器地址</Label>
              <Input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://sync.example.com"
              />
              <Label>令牌</Label>
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token" />
              <Button variant="subtle" disabled={busy} onClick={runAdopt}>
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
}

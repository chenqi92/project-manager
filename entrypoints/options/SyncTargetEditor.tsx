import { useState } from 'react';
import { browser } from 'wxt/browser';
import { Loader2 } from 'lucide-react';
import { Banner, Button, Input, Label, Modal, Select } from '@/components/ui';
import { useDialog } from '@/components/Dialog';
import { api } from '@/lib/messaging';
import { BUILTIN_OAUTH_CLIENT_ID, BUILTIN_OAUTH_CLIENT_SECRET } from '@/lib/oauth';
import { originsFor } from '@/lib/sync-providers';
import type { SyncTarget, SyncTargetType, SyncTargetView } from '@/lib/types';
import { DirectoryPicker } from './DirectoryPicker';

const TYPE_LABELS: Record<SyncTargetType, string> = {
  'self-hosted': '自托管服务器',
  webdav: 'WebDAV（Nextcloud / 坚果云等）',
  github: 'GitHub 仓库',
  gitlab: 'GitLab 仓库',
  'google-drive': 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  synology: '群晖 Synology NAS',
};

function defaultDraft(type: SyncTargetType): SyncTarget {
  const base = { id: crypto.randomUUID(), label: TYPE_LABELS[type], enabled: true };
  switch (type) {
    case 'self-hosted':
      return { ...base, type, serverUrl: '', token: '' };
    case 'webdav':
      return { ...base, type, url: '', username: '', password: '', filePath: 'vault.enc' };
    case 'github':
    case 'gitlab':
      return { ...base, type, owner: '', repo: '', branch: 'main', filePath: 'vault.enc', token: '' };
    case 'google-drive':
    case 'onedrive':
    case 'dropbox':
      return {
        ...base,
        type,
        clientId: BUILTIN_OAUTH_CLIENT_ID[type] ?? '',
        clientSecret: BUILTIN_OAUTH_CLIENT_SECRET[type],
        fileName: 'vault.enc',
      };
    case 'synology':
      return { ...base, type, baseUrl: '', account: '', password: '', filePath: '/home/vault.enc' };
  }
}

export function SyncTargetEditor({
  initial,
  initialAuthorized,
  onClose,
  onSaved,
}: {
  /** 编辑时传入脱敏后的目标；新增时不传 */
  initial?: SyncTarget;
  /** 编辑 OAuth 目标时是否已授权（refreshToken 已被脱敏，故单独传入） */
  initialAuthorized?: boolean;
  onClose: () => void;
  onSaved: (targets: SyncTargetView[]) => void;
}) {
  const { confirm } = useDialog();
  const editing = Boolean(initial);
  const [draft, setDraft] = useState<SyncTarget>(initial ?? defaultDraft('webdav'));
  const [busy, setBusy] = useState<'save' | 'auth' | 'test' | null>(null);
  const [authorized, setAuthorized] = useState(Boolean(initialAuthorized));
  const [otp, setOtp] = useState(''); // 群晖一次性码，仅用于绑定，不入库
  const [needOtp, setNeedOtp] = useState(false); // 服务器要求两步验证时才显示 OTP 输入
  const [showPicker, setShowPicker] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);

  const t = draft as unknown as Record<string, string | boolean | undefined>;
  const set = (key: string, value: string | boolean) =>
    setDraft(
      (prev) =>
        ({ ...(prev as unknown as Record<string, unknown>), [key]: value }) as unknown as SyncTarget,
    );

  const isOAuth =
    draft.type === 'google-drive' || draft.type === 'onedrive' || draft.type === 'dropbox';
  const isGoogle = draft.type === 'google-drive';
  const isSynology = draft.type === 'synology';
  const builtinId = BUILTIN_OAUTH_CLIENT_ID[draft.type as 'google-drive' | 'onedrive' | 'dropbox'];
  const builtinSecret =
    BUILTIN_OAUTH_CLIENT_SECRET[draft.type as 'google-drive' | 'onedrive' | 'dropbox'];
  const redirectUri = browser.identity?.getRedirectURL?.() ?? '';

  async function requestOrigins(): Promise<boolean> {
    const granted = await browser.permissions.request({ origins: originsFor(draft) });
    if (!granted) setMsg({ tone: 'error', text: '未授予对该服务的访问权限' });
    return granted;
  }

  async function authorize() {
    setMsg(null);
    if (!t.clientId) return setMsg({ tone: 'error', text: '请先填写 client_id' });
    // Google 的「Web 应用」客户端即便用 PKCE 也强制要 client_secret。
    if (isGoogle && !t.clientSecret) {
      return setMsg({ tone: 'error', text: 'Google 需要 client_secret，请先填写' });
    }
    setBusy('auth');
    try {
      if (!(await requestOrigins())) return;
      const { refreshToken } = await api.syncOAuthAuthorize(
        draft.type as 'google-drive' | 'onedrive' | 'dropbox',
        String(t.clientId),
        t.clientSecret ? String(t.clientSecret) : undefined,
      );
      set('refreshToken', refreshToken);
      setAuthorized(true);
      setMsg({ tone: 'info', text: '授权成功' });
    } catch (e) {
      setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  /** 群晖：账号密码登录；账户开了 2FA 会要求 OTP（自动弹出输入），带 OTP 绑定受信设备拿 did。 */
  async function synologyBind() {
    setMsg(null);
    if (!t.baseUrl || !t.account || !t.password) {
      return setMsg({ tone: 'error', text: '请先填写 NAS 地址、账户和密码' });
    }
    setBusy('auth');
    try {
      if (!(await requestOrigins())) return;
      const { did } = await api.syncSynologyAuthorize(
        String(t.baseUrl),
        String(t.account),
        String(t.password),
        otp.trim() || undefined,
      );
      set('did', did);
      setAuthorized(true);
      setNeedOtp(false);
      setOtp('');
      setMsg({ tone: 'info', text: did ? '已连接并绑定设备 ✓ 之后免 OTP' : '已连接 ✓（该账户未开两步验证）' });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // 服务器要求两步验证且还没填 OTP → 自动展开 OTP 输入，提示再点一次。
      if (/两步验证|OTP|otp/i.test(m) && !otp.trim()) {
        setNeedOtp(true);
        setMsg({ tone: 'warn', text: '该账户开启了两步验证：请输入 OTP 一次性码后，再次点「连接并绑定」。' });
      } else {
        setMsg({ tone: 'error', text: m });
      }
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setMsg(null);
    if (!t.label) return setMsg({ tone: 'error', text: '请填写名称' });
    if (isOAuth && !authorized) {
      return setMsg({ tone: 'error', text: '请先完成授权' });
    }
    if (isSynology && !authorized) {
      return setMsg({ tone: 'error', text: '请先点「连接并绑定」验证账户（2FA 账户需输入 OTP）' });
    }
    if (isGoogle && !t.clientSecret) {
      return setMsg({ tone: 'error', text: 'Google 需要填写 client_secret' });
    }
    setBusy('save');
    try {
      if (!(await requestOrigins())) return;
      // 预检：连通性 + Git 公开仓库警示
      const pf = await api.syncTargetPreflight(draft);
      if (pf.warnings.length) {
        const ok = await confirm({
          title: '安全警示',
          message: pf.warnings.join('\n'),
          confirmText: '仍要保存',
          danger: true,
        });
        if (!ok) return;
      }
      const { targets } = await api.syncTargetSave(draft);
      onSaved(targets);
      onClose();
    } catch (e) {
      setMsg({ tone: 'error', text: friendlyErr(e) });
    } finally {
      setBusy(null);
    }
  }

  function friendlyErr(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e);
    if (/otp/i.test(m))
      return '需要两步验证（OTP）：请填写 OTP 一次性码后点「登录并绑定设备」，绑定成功再测试 / 保存。';
    return m;
  }

  /** 测试连接：预检地址 + 凭据（群晖含 2FA 登录）；不改动任何数据。 */
  async function testConnection() {
    setMsg(null);
    setBusy('test');
    try {
      if (!(await requestOrigins())) return;
      const pf = await api.syncTargetPreflight(draft);
      setMsg(
        pf.warnings.length
          ? { tone: 'warn', text: '可连接，但有提示：' + pf.warnings.join('；') }
          : {
              tone: 'info',
              text:
                '连接正常 ✓ 地址与凭据可用' +
                (isSynology ? '（存放路径是否可写，需实际推送才能确认）' : ''),
            },
      );
    } catch (e) {
      setMsg({ tone: 'error', text: '连接失败：' + friendlyErr(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={editing ? '编辑同步目标' : '添加同步目标'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {!editing && (
          <div>
            <Label>类型</Label>
            <Select
              value={draft.type}
              onChange={(e) => setDraft(defaultDraft(e.target.value as SyncTargetType))}
            >
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div>
          <Label>名称</Label>
          <Input value={String(t.label ?? '')} onChange={(e) => set('label', e.target.value)} />
        </div>

        {draft.type === 'self-hosted' && (
          <>
            <Field label="服务器地址" v={t.serverUrl} on={(x) => set('serverUrl', x)} placeholder="https://sync.example.com" />
            <Secret label="令牌" v={t.token} on={(x) => set('token', x)} editing={editing} />
          </>
        )}

        {draft.type === 'webdav' && (
          <>
            <Field label="WebDAV 地址（到目录）" v={t.url} on={(x) => set('url', x)} placeholder="https://dav.example.com/remote.php/dav/files/me/" />
            <Field label="文件名 / 相对路径" v={t.filePath} on={(x) => set('filePath', x)} placeholder="vault.enc" />
            <Field label="用户名" v={t.username} on={(x) => set('username', x)} />
            <Secret label="密码 / 应用密码" v={t.password} on={(x) => set('password', x)} editing={editing} />
          </>
        )}

        {(draft.type === 'github' || draft.type === 'gitlab') && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label={draft.type === 'gitlab' ? '命名空间 / 用户' : 'owner'} v={t.owner} on={(x) => set('owner', x)} />
              <Field label="仓库名" v={t.repo} on={(x) => set('repo', x)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="分支" v={t.branch} on={(x) => set('branch', x)} placeholder="main" />
              <Field label="文件路径" v={t.filePath} on={(x) => set('filePath', x)} placeholder="vault.enc" />
            </div>
            <Secret label="访问令牌（PAT，需 repo / read_repository+write_repository 权限）" v={t.token} on={(x) => set('token', x)} editing={editing} />
            <Field label="自建实例 API 地址（可选）" v={t.apiBase} on={(x) => set('apiBase', x)} placeholder={draft.type === 'gitlab' ? 'https://gitlab.example.com/api/v4' : 'https://api.github.com'} />
            <Banner tone="warn">
              请使用<strong>私有</strong>仓库；公开仓库里的加密密文人人可下载、可离线爆破主密码。保存前会自动检测，公开仓库需二次确认。
            </Banner>
          </>
        )}

        {isOAuth && (
          <>
            {!builtinId && (
              <div>
                <Label>重定向 URI（复制到 Google / Azure 控制台登记，须一字不差含尾斜杠）</Label>
                <Input readOnly value={redirectUri} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
              </div>
            )}
            {builtinId ? (
              <Banner tone="info">已内置官方应用，无需填写 client_id / client_secret，直接点下方「授权」即可。</Banner>
            ) : (
              <Field label="client_id（在控制台自建 OAuth 应用获得）" v={t.clientId} on={(x) => set('clientId', x)} />
            )}
            {isGoogle && !builtinSecret && (
              <Secret label="client_secret（Google「Web 应用」客户端创建时获得，必填）" v={t.clientSecret} on={(x) => set('clientSecret', x)} editing={editing} />
            )}
            <Field label="文件名" v={t.fileName} on={(x) => set('fileName', x)} placeholder="vault.enc" />
            <Button variant="subtle" disabled={busy !== null} onClick={authorize} className="self-start">
              {busy === 'auth' && <Loader2 size={14} className="animate-spin" />}
              {authorized ? '重新授权' : '授权'}
            </Button>
            <p className="text-xs text-gray-500">
              {builtinId
                ? '已内置官方 OAuth 应用，无需自行注册：直接点「授权」用你的网盘账号登录即可；密文只存放在该网盘的「应用专属隐藏目录」，碰不到你其它文件。'
                : isGoogle
                  ? 'Google 需选「Web 应用」客户端类型、重定向 URI 填上方地址，并填 client_secret。授权后只保存可刷新令牌，密文存于 Drive 应用数据隐藏目录。'
                  : draft.type === 'dropbox'
                    ? 'Dropbox 在 App Console 建「Scoped app · App folder」，Permissions 勾选 files.content.read / files.content.write，OAuth2 Redirect URI 填上方地址；无需 secret（PKCE）。密文存于该应用专属文件夹。'
                    : 'OneDrive 在 Azure 注册时重定向 URI 要加在「移动和桌面应用程序」平台下（勿选 SPA），无需 client_secret。授权后密文存于 OneDrive 应用专属文件夹。'}
            </p>
          </>
        )}

        {isSynology && (
          <>
            <Field label="NAS 地址（含端口）" v={t.baseUrl} on={(x) => set('baseUrl', x)} placeholder="https://nas.example.com:5001" />
            <Field label="DSM 账户" v={t.account} on={(x) => set('account', x)} />
            <Secret label="DSM 密码" v={t.password} on={(x) => set('password', x)} editing={editing} />
            {needOtp && (
              <div>
                <Label>OTP 一次性码（两步验证）</Label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="6 位动态码"
                  autoFocus
                />
              </div>
            )}
            <Button variant="subtle" disabled={busy !== null} onClick={synologyBind} className="self-start">
              {busy === 'auth' && <Loader2 size={14} className="animate-spin" />}
              {authorized ? '重新连接 / 绑定' : '连接并绑定'}
            </Button>

            {/* 连接成功后才出现「选择存放目录」 */}
            {authorized ? (
              <div className="rounded-xl border border-gray-200 p-3">
                <Label>存放目录</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={String(t.filePath ?? '')}
                    placeholder="/home/vault.enc"
                    onChange={(e) => set('filePath', e.target.value)}
                  />
                  <Button
                    type="button"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => setShowPicker(true)}
                  >
                    浏览…
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  点「浏览…」从共享文件夹里逐层选择目录；也可直接填写文件路径。
                </p>
              </div>
            ) : (
              <p className="text-[11.5px] text-gray-400">
                先填账户密码点「连接并绑定」（账户开了两步验证会要求输入 OTP）；连接成功后再选择存放目录。
              </p>
            )}

            <p className="text-xs text-gray-500">
              走 DSM FileStation API。两步验证账户：输入 OTP 登录一次拿到受信设备令牌后即可长期免 OTP 自动同步；
              换设备或令牌失效时会提示重新做两步验证。NAS 建议用受信 HTTPS 证书，自签证书可能连接失败。
            </p>
          </>
        )}

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          启用（参与「同步全部」与修改后自动同步）
        </label>

        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

        <div className="mt-1 flex items-center gap-2">
          <Button variant="outline" disabled={busy !== null} onClick={testConnection}>
            {busy === 'test' && <Loader2 size={14} className="animate-spin" />} 测试连接
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy !== null} onClick={save}>
            {busy === 'save' && <Loader2 size={14} className="animate-spin" />} 保存
          </Button>
        </div>

        {showPicker && (
          <DirectoryPicker
            target={draft}
            onClose={() => setShowPicker(false)}
            onApply={(next) =>
              set('filePath', (next as unknown as { filePath?: string }).filePath ?? '')
            }
            browse={(segs) =>
              api.syncListDir({ target: draft, path: segs }).then((r) => r.folders.map((f) => f.name))
            }
          />
        )}
      </div>
    </Modal>
  );
}

function Field({
  label,
  v,
  on,
  placeholder,
}: {
  label: string;
  v: string | boolean | undefined;
  on: (x: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={typeof v === 'string' ? v : ''} placeholder={placeholder} onChange={(e) => on(e.target.value)} />
    </div>
  );
}

function Secret({
  label,
  v,
  on,
  editing,
}: {
  label: string;
  v: string | boolean | undefined;
  on: (x: string) => void;
  editing: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="password"
        value={typeof v === 'string' ? v : ''}
        placeholder={editing ? '留空表示沿用已保存的值' : ''}
        onChange={(e) => on(e.target.value)}
      />
    </div>
  );
}

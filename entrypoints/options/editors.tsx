import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Eye, EyeOff, GitBranch, Plus, QrCode, RefreshCw, Trash2 } from 'lucide-react';
import { Button, Input, Label, Modal, Select } from '@/components/ui';
import { decodeQrImage } from '@/lib/qr';
import type { Account, EnvKind, Environment, GitRepo, PlatformLink, Project } from '@/lib/types';
import { ENV_KIND_LABELS, newGitRepo } from '@/lib/vault-ops';

function genPassword(len = 20): string {
  const charset =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += charset[arr[i]! % charset.length];
  return out;
}

const FOOTER = 'mt-5 flex justify-end gap-2';

/** 清洗 Git 仓库列表：去空白、丢空 url；全空返回 undefined。 */
function cleanRepos(repos: GitRepo[]): GitRepo[] | undefined {
  const out = repos
    .map((r) => ({ ...r, url: r.url.trim(), branch: r.branch?.trim() || undefined }))
    .filter((r) => r.url);
  return out.length ? out : undefined;
}

/** Git 仓库编辑字段（链接 / 环境 共用）：可加多个，各自指定分支。 */
function GitReposField({
  repos,
  setRepos,
}: {
  repos: GitRepo[];
  setRepos: Dispatch<SetStateAction<GitRepo[]>>;
}) {
  const setRepo = (id: string, patch: Partial<GitRepo>) =>
    setRepos((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>Git 仓库（可选，可多个）</Label>
        <button
          type="button"
          onClick={() => setRepos((rs) => [...rs, newGitRepo()])}
          className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
        >
          <Plus size={13} /> 添加仓库
        </button>
      </div>
      {repos.length === 0 ? (
        <p className="mt-1 text-[11px] text-gray-400">关联代码仓库地址，可指定分支；展示处一键复制 git clone 命令。</p>
      ) : (
        <div className="mt-1 flex flex-col gap-1.5">
          {repos.map((r) => (
            <div key={r.id} className="flex items-center gap-1.5">
              <GitBranch size={14} className="shrink-0 text-gray-400" />
              <Input
                value={r.url}
                onChange={(e) => setRepo(r.id, { url: e.target.value })}
                placeholder="https://git.example.com/group/repo.git"
                className="min-w-0 flex-1 font-mono text-xs"
              />
              <div className="w-24 shrink-0">
                <Input
                  value={r.branch ?? ''}
                  onChange={(e) => setRepo(r.id, { branch: e.target.value })}
                  placeholder="分支"
                  className="font-mono text-xs"
                />
              </div>
              <button
                type="button"
                title="删除"
                onClick={() => setRepos((rs) => rs.filter((x) => x.id !== r.id))}
                className="shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectEditor({
  initial,
  onClose,
  onSave,
}: {
  initial?: Project;
  onClose: () => void;
  onSave: (v: { name: string; tags: string[]; note?: string }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [note, setNote] = useState(initial?.note ?? '');

  return (
    <Modal title={initial ? '编辑项目' : '新建项目'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <Label>项目名称</Label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：电商平台" />
        </div>
        <div>
          <Label>标签（逗号分隔，可选）</Label>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="内部, 重点" />
        </div>
        <div>
          <Label>备注（可选）</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className={FOOTER}>
        <Button variant="subtle" onClick={onClose}>取消</Button>
        <Button
          disabled={!name.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
              note: note.trim() || undefined,
            })
          }
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}

export function EnvEditor({
  initial,
  onClose,
  onSave,
}: {
  initial?: Environment;
  onClose: () => void;
  onSave: (v: { name: string; kind: EnvKind; note?: string; gitRepos?: GitRepo[] }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<EnvKind>(initial?.kind ?? 'dev');
  const [note, setNote] = useState(initial?.note ?? '');
  const [repos, setRepos] = useState<GitRepo[]>(initial?.gitRepos ?? []);

  return (
    <Modal title={initial ? '编辑环境' : '新建环境'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <Label>环境名称</Label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：开发环境" />
        </div>
        <div>
          <Label>类型</Label>
          <Select value={kind} onChange={(e) => setKind(e.target.value as EnvKind)}>
            {(Object.keys(ENV_KIND_LABELS) as EnvKind[]).map((k) => (
              <option key={k} value={k}>
                {ENV_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <GitReposField repos={repos} setRepos={setRepos} />
        <div>
          <Label>备注（可选）</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className={FOOTER}>
        <Button variant="subtle" onClick={onClose}>取消</Button>
        <Button
          disabled={!name.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              kind,
              note: note.trim() || undefined,
              gitRepos: cleanRepos(repos),
            })
          }
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}

export function LinkEditor({
  initial,
  location,
  onClose,
  onSave,
}: {
  initial?: PlatformLink;
  location?: {
    projects: Project[];
    projectId: string;
    envId: string;
  };
  onClose: () => void;
  onSave: (v: {
    name: string;
    url: string;
    note?: string;
    urls?: string[];
    gitRepos?: GitRepo[];
  }, location?: { projectId: string; envId: string }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [extraUrls, setExtraUrls] = useState((initial?.urls ?? []).join('\n'));
  const [note, setNote] = useState(initial?.note ?? '');
  const [repos, setRepos] = useState<GitRepo[]>(initial?.gitRepos ?? []);
  const [projectId, setProjectId] = useState(location?.projectId ?? '');
  const [envId, setEnvId] = useState(location?.envId ?? '');
  const selectedProject = location?.projects.find((p) => p.id === projectId);
  const envs = selectedProject?.environments ?? [];
  const selectedEnvId = envs.some((env) => env.id === envId) ? envId : '';
  const changeProject = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    const nextProject = location?.projects.find((p) => p.id === nextProjectId);
    setEnvId(nextProject?.environments[0]?.id ?? '');
  };

  return (
    <Modal title={initial ? '编辑链接' : '新建链接 / 平台'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {initial && location && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>所属项目</Label>
              <Select value={projectId} onChange={(e) => changeProject(e.target.value)}>
                {location.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>所属环境</Label>
              <Select
                value={selectedEnvId}
                onChange={(e) => setEnvId(e.target.value)}
                disabled={envs.length === 0}
              >
                {envs.length === 0 ? (
                  <option value="">自动创建默认环境</option>
                ) : (
                  envs.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.name}
                    </option>
                  ))
                )}
              </Select>
            </div>
          </div>
        )}
        <div>
          <Label>名称</Label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：管理后台" />
        </div>
        <div>
          <Label>主网址</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://admin.example.com" />
          <p className="mt-1 text-[11px] text-gray-400">
            匹配按 <b>origin（协议 + 域名/IP + 端口）</b>判断，<b>路径会被忽略</b>；http 与 https、不同端口都算不同站点。
            填 <code>http://1.2.3.4:8080/login</code> 与 <code>http://1.2.3.4:8080/</code> 完全等价。
          </p>
        </div>
        <div>
          <Label>更多网址（每行一个，可选）</Label>
          <textarea
            value={extraUrls}
            onChange={(e) => setExtraUrls(e.target.value)}
            rows={3}
            placeholder={'http://内网IP:端口/\nhttps://外网域名/'}
            className="w-full rounded-lg border border-gray-300 p-2 font-mono text-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <p className="mt-1 text-[11px] text-gray-400">
            同一系统的<b>其它访问地址</b>（不同 IP / 域名 / 端口）写这里。换路径无意义——要写就写不同的 origin。
          </p>
        </div>
        <GitReposField repos={repos} setRepos={setRepos} />
        <div>
          <Label>备注（可选）</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className={FOOTER}>
        <Button variant="subtle" onClick={onClose}>取消</Button>
        <Button
          disabled={!name.trim()}
          onClick={() => {
            const urls = extraUrls
              .split('\n')
              .map((u) => u.trim())
              .filter(Boolean);
            onSave({
              name: name.trim(),
              url: url.trim(),
              note: note.trim() || undefined,
              urls: urls.length ? urls : undefined,
              gitRepos: cleanRepos(repos),
            }, location ? { projectId, envId: selectedEnvId } : undefined);
          }}
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}

export function AccountEditor({
  initial,
  onClose,
  onSave,
}: {
  initial?: Account;
  onClose: () => void;
  onSave: (v: {
    label: string;
    username: string;
    password: string;
    note?: string;
    totp?: string;
  }) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState(initial?.password ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [totp, setTotp] = useState(initial?.totp ?? '');
  const [show, setShow] = useState(false);
  const [qrMsg, setQrMsg] = useState<string | null>(null);
  const qrInput = useRef<HTMLInputElement>(null);

  const importQr = async (file: File) => {
    setQrMsg(null);
    try {
      const text = (await decodeQrImage(file)).trim();
      if (text.startsWith('otpauth-migration://')) {
        setQrMsg('这是 Google Authenticator 批量迁移码，请用「导入/导出 → Google Authenticator」批量导入。');
      } else if (text.startsWith('otpauth://') || /^[A-Za-z2-7\s]{8,}=*$/.test(text)) {
        setTotp(text);
      } else {
        setQrMsg('二维码内容不是有效的 TOTP（需 otpauth:// 或 base32 密钥）。');
      }
    } catch (e) {
      setQrMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal title={initial ? '编辑账号' : '新建账号'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <Label>账号备注名（区分同一链接下的多个账号）</Label>
          <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：管理员 / 测试账号" />
        </div>
        <div>
          <Label>用户名</Label>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div>
          <Label>密码</Label>
          <div className="flex gap-1.5">
            <Input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono"
            />
            <Button variant="subtle" type="button" title="显示/隐藏" onClick={() => setShow((s) => !s)}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
            <Button variant="subtle" type="button" title="生成强密码" onClick={() => { setPassword(genPassword()); setShow(true); }}>
              <RefreshCw size={16} />
            </Button>
          </div>
        </div>
        <div>
          <Label>两步验证 TOTP（可选）</Label>
          <div className="flex gap-1.5">
            <Input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="base32 密钥 或 otpauth://..."
              className="font-mono"
            />
            <Button
              variant="subtle"
              type="button"
              title="从二维码图片导入"
              onClick={() => qrInput.current?.click()}
            >
              <QrCode size={16} />
            </Button>
            <input
              ref={qrInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) importQr(f);
              }}
            />
          </div>
          {qrMsg ? (
            <p className="mt-1 text-[11px] text-rose-600">{qrMsg}</p>
          ) : (
            <p className="mt-1 text-[11px] text-gray-400">
              已在 1Password 等工具里记录过?复制其 otpauth:// 或扫码图片即可导入。
            </p>
          )}
        </div>
        <div>
          <Label>备注（可选）</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className={FOOTER}>
        <Button variant="subtle" onClick={onClose}>取消</Button>
        <Button
          disabled={!label.trim() && !username.trim()}
          onClick={() =>
            onSave({
              label: label.trim(),
              username: username.trim(),
              password,
              note: note.trim() || undefined,
              totp: totp.trim() || undefined,
            })
          }
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { Button, Input, Label, Modal, Select } from '@/components/ui';
import type { Account, EnvKind, Environment, PlatformLink, Project } from '@/lib/types';
import { ENV_KIND_LABELS } from '@/lib/vault-ops';

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
  onSave: (v: { name: string; kind: EnvKind; note?: string }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<EnvKind>(initial?.kind ?? 'dev');
  const [note, setNote] = useState(initial?.note ?? '');

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
        <div>
          <Label>备注（可选）</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className={FOOTER}>
        <Button variant="subtle" onClick={onClose}>取消</Button>
        <Button
          disabled={!name.trim()}
          onClick={() => onSave({ name: name.trim(), kind, note: note.trim() || undefined })}
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}

export function LinkEditor({
  initial,
  onClose,
  onSave,
}: {
  initial?: PlatformLink;
  onClose: () => void;
  onSave: (v: { name: string; url: string; note?: string }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [note, setNote] = useState(initial?.note ?? '');

  return (
    <Modal title={initial ? '编辑链接' : '新建链接 / 平台'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <Label>名称</Label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：管理后台" />
        </div>
        <div>
          <Label>网址</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://admin.example.com" />
          <p className="mt-1 text-[11px] text-gray-400">
            填充只会在「页面网址与此处 origin 完全一致」时生效。
          </p>
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
          onClick={() => onSave({ name: name.trim(), url: url.trim(), note: note.trim() || undefined })}
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
  onSave: (v: { label: string; username: string; password: string; note?: string }) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState(initial?.password ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [show, setShow] = useState(false);

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
            })
          }
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}

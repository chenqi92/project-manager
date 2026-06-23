import { useEffect, useState } from 'react';
import { Banner, Button, Input, Label, Modal, Select } from '@/components/ui';
import type { EnvKind, VaultData } from '@/lib/types';
import {
  ENV_KIND_LABELS,
  newAccount,
  newEnvironment,
  newLink,
  newProject,
  produce,
} from '@/lib/vault-ops';

const NEW = '__new';

/** 把当前页/链接快速存入保险箱：选择或新建 项目 + 环境，可顺带存一个账号。 */
export function CaptureModal({
  data,
  initialUrl,
  initialTitle,
  onClose,
  onSave,
}: {
  data: VaultData;
  initialUrl: string;
  initialTitle: string;
  onClose: () => void;
  onSave: (next: VaultData) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(data.projects[0]?.id ?? NEW);
  const [newProjectName, setNewProjectName] = useState('');
  const [envId, setEnvId] = useState(NEW);
  const [newEnvName, setNewEnvName] = useState('');
  const [envKind, setEnvKind] = useState<EnvKind>('dev');
  const [linkName, setLinkName] = useState(initialTitle || '');
  const [url, setUrl] = useState(initialUrl);
  const [withAccount, setWithAccount] = useState(false);
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const project = data.projects.find((p) => p.id === projectId);

  // 切换项目时，默认选中其第一个环境（没有则新建）。
  useEffect(() => {
    const p = data.projects.find((x) => x.id === projectId);
    setEnvId(p?.environments[0]?.id ?? NEW);
  }, [projectId, data.projects]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const next = produce(data, (d) => {
        let proj =
          projectId === NEW ? undefined : d.projects.find((p) => p.id === projectId);
        if (!proj) {
          proj = newProject({ name: newProjectName.trim() || '未命名项目' });
          d.projects.push(proj);
        }
        let env = envId === NEW ? undefined : proj.environments.find((e) => e.id === envId);
        if (!env) {
          env = newEnvironment({ name: newEnvName.trim() || '默认', kind: envKind });
          proj.environments.push(env);
        }
        const link = newLink({ name: linkName.trim() || url.trim(), url: url.trim() });
        if (withAccount && (username.trim() || label.trim() || password)) {
          link.accounts.push(
            newAccount({ label: label.trim(), username: username.trim(), password }),
          );
        }
        env.links.push(link);
      });
      await onSave(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="保存到保险箱" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>项目</Label>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value={NEW}>+ 新建项目…</option>
            </Select>
            {projectId === NEW && (
              <Input
                className="mt-1.5"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="新项目名称"
              />
            )}
          </div>
          <div>
            <Label>环境</Label>
            <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>
              {(project?.environments ?? []).map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
              <option value={NEW}>+ 新建环境…</option>
            </Select>
            {envId === NEW && (
              <div className="mt-1.5 flex gap-1.5">
                <Input
                  value={newEnvName}
                  onChange={(e) => setNewEnvName(e.target.value)}
                  placeholder="新环境名称"
                />
                <Select
                  value={envKind}
                  onChange={(e) => setEnvKind(e.target.value as EnvKind)}
                  className="w-24"
                >
                  {(Object.keys(ENV_KIND_LABELS) as EnvKind[]).map((k) => (
                    <option key={k} value={k}>
                      {ENV_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        </div>

        <div>
          <Label>链接名称</Label>
          <Input value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="页面标题" />
        </div>
        <div>
          <Label>网址</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={withAccount}
            onChange={(e) => setWithAccount(e.target.checked)}
          />
          顺便存一个账号
        </label>
        {withAccount && (
          <div className="grid grid-cols-3 gap-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="账号备注名" />
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" />
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
            />
          </div>
        )}

        {!url.trim() && <Banner tone="warn">网址为空，仍可保存但无法用于填充。</Banner>}
        {err && <Banner tone="error">保存失败：{err}</Banner>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="subtle" onClick={onClose}>
          取消
        </Button>
        <Button disabled={busy || (!linkName.trim() && !url.trim())} onClick={save}>
          保存
        </Button>
      </div>
    </Modal>
  );
}

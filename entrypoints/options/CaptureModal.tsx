import { useEffect, useState } from 'react';
import { Banner, Button, Input, Label, Modal, Select } from '@/components/ui';
import type { EnvKind, VaultData } from '@/lib/types';
import {
  ENV_KIND_LABELS,
  envTagName,
  newAccount,
  newEnvironment,
  newLink,
  newProject,
  produce,
} from '@/lib/vault-ops';

const NEW = '__new';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function defaultLinkName(title: string, url: string): string {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  return cleanTitle || hostOf(url) || url.trim();
}

/** 把当前页/链接快速存入保险箱：选择或新建 项目 + 环境，可顺带存一个账号。 */
export function CaptureModal({
  data,
  initialUrl,
  initialTitle,
  initialUsername,
  initialPassword,
  initialTenant,
  initialTotp,
  initialAccountLabel,
  onClose,
  onSave,
}: {
  data: VaultData;
  initialUrl: string;
  initialTitle: string;
  initialUsername?: string;
  initialPassword?: string;
  initialTenant?: string;
  initialTotp?: string;
  initialAccountLabel?: string;
  onClose: () => void;
  onSave: (next: VaultData) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(data.projects[0]?.id ?? NEW);
  const [newProjectName, setNewProjectName] = useState('');
  const [envId, setEnvId] = useState(NEW);
  const [newEnvName, setNewEnvName] = useState('');
  const [envKind, setEnvKind] = useState<EnvKind>('dev');
  const [linkName, setLinkName] = useState(() => defaultLinkName(initialTitle, initialUrl));
  const [url, setUrl] = useState(initialUrl);
  const [withAccount, setWithAccount] = useState(
    Boolean(initialUsername || initialPassword || initialTenant || initialTotp || initialAccountLabel),
  );
  const [label, setLabel] = useState(initialAccountLabel ?? '');
  const [username, setUsername] = useState(initialUsername ?? '');
  const [tenant, setTenant] = useState(initialTenant ?? '');
  const [password, setPassword] = useState(initialPassword ?? '');
  const [totp, setTotp] = useState(initialTotp ?? '');
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
          env = newEnvironment({ name: envTagName(envKind, newEnvName), kind: envKind });
          proj.environments.push(env);
        }
        const link = newLink({
          name: linkName.trim() || defaultLinkName('', url),
          envKind: env.kind,
          envName: envTagName(env.kind, env.name),
          url: url.trim(),
        });
        if (withAccount && (username.trim() || label.trim() || password || totp.trim())) {
          link.accounts.push(
            newAccount({
              label: label.trim(),
              username: username.trim(),
              password,
              tenant: tenant.trim() || undefined,
              totp: totp.trim() || undefined,
            }),
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
                  {envTagName(env.kind, env.name)}
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
          <div className="grid grid-cols-2 gap-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="账号备注名" />
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" />
            <Input
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="租户 / 企业 / 域（可选）"
            />
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
            />
            <Input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="TOTP 密钥 / otpauth://（可选）"
              className="font-mono"
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

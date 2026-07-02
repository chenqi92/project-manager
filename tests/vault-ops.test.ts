// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  gitCloneCommand,
  newEnvironment,
  newGitRepo,
  newLink,
  newProject,
  normalizeVaultData,
} from '../lib/vault-ops';
import type { VaultData } from '../lib/types';

function vault(): VaultData {
  return {
    version: 1,
    projects: [],
    settings: { autoLockMinutes: 15, kdf: { type: 'pbkdf2', iterations: 1, hash: 'SHA-256' } },
    tombstones: [],
  };
}

describe('gitCloneCommand', () => {
  it('无分支：git clone -- <url>', () => {
    const r = newGitRepo({ url: 'https://git.example.com/g/r.git' });
    expect(gitCloneCommand(r)).toBe("git clone -- 'https://git.example.com/g/r.git'");
  });

  it('有分支：git clone -b <branch> -- <url>', () => {
    const r = newGitRepo({ url: 'git@host:g/r.git', branch: 'develop' });
    expect(gitCloneCommand(r)).toBe("git clone -b 'develop' -- 'git@host:g/r.git'");
  });

  it('转义分支和 URL，避免复制命令时注入额外 shell 片段', () => {
    const r = newGitRepo({
      url: "https://git.example.com/o'repo.git; rm -rf ~",
      branch: "main\n$(touch pwn)",
    });

    expect(gitCloneCommand(r)).toBe(
      "git clone -b 'main $(touch pwn)' -- 'https://git.example.com/o'\\''repo.git; rm -rf ~'",
    );
  });
});

describe('normalizeVaultData', () => {
  it('同项目内相同类型和名称的环境会合并', () => {
    const data = vault();
    const project = newProject({ name: '荆二' });
    const envA = {
      ...newEnvironment({ name: '默认', kind: 'prod', updatedAt: 100 }),
      id: 'env-prod-a',
      links: [newLink({ name: '运维管理中心', url: 'https://example.test/#/login' })],
    };
    const envB = {
      ...newEnvironment({ name: '  默认  ', kind: 'prod', updatedAt: 200 }),
      id: 'env-prod-b',
      links: [newLink({ name: '运维管理中心，开启终端', url: 'https://example.test/#/index' })],
    };
    project.environments = [envA, envB];
    data.projects.push(project);

    expect(normalizeVaultData(data, 500)).toBe(true);

    expect(data.projects[0]!.environments).toHaveLength(1);
    expect(data.projects[0]!.environments[0]!.name).toBe('生产');
    expect(data.projects[0]!.environments[0]!.kind).toBe('prod');
    expect(data.projects[0]!.environments[0]!.links.map((l) => l.name)).toEqual([
      '运维管理中心',
      '运维管理中心，开启终端',
    ]);
    expect(data.tombstones).toContainEqual({ id: 'env-prod-b', deletedAt: 500 });
  });

  it('名称相同但类型不同的环境不会合并', () => {
    const data = vault();
    const project = newProject({ name: '项目' });
    project.environments = [
      { ...newEnvironment({ name: '默认', kind: 'dev' }), id: 'env-dev' },
      { ...newEnvironment({ name: '默认', kind: 'prod' }), id: 'env-prod' },
    ];
    data.projects.push(project);

    expect(normalizeVaultData(data, 500)).toBe(true);
    expect(data.projects[0]!.environments.map((e) => e.kind)).toEqual(['dev', 'prod']);
    expect(data.workspaces?.[0]?.name).toBe('默认工作区');
  });
});

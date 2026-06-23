import { describe, expect, it } from 'vitest';
import { mergeVaultData } from '../lib/merge';
import type { Project, VaultData } from '../lib/types';
import { newAccount, newEnvironment, newLink, newProject } from '../lib/vault-ops';

function vault(projects: Project[], tombstones: VaultData['tombstones'] = []): VaultData {
  return {
    version: 1,
    projects,
    settings: { autoLockMinutes: 15, kdf: { type: 'pbkdf2', iterations: 1, hash: 'SHA-256' } },
    tombstones,
  };
}

const NOW = 1_000_000_000_000;

describe('mergeVaultData', () => {
  it('一边新增的项目会被保留', () => {
    const p = newProject({ name: 'A' });
    const m = mergeVaultData(vault([p]), vault([]), NOW);
    expect(m.projects.map((x) => x.name)).toEqual(['A']);
  });

  it('同一项目取 updatedAt 较新者的字段', () => {
    const older: Project = { ...newProject({ name: '旧名' }), id: 'p1', updatedAt: 100 };
    const newer: Project = { ...newProject({ name: '新名' }), id: 'p1', updatedAt: 200 };
    const m = mergeVaultData(vault([older]), vault([newer]), NOW);
    expect(m.projects).toHaveLength(1);
    expect(m.projects[0]!.name).toBe('新名');
  });

  it('墓碑删除会移除另一边仍存在的旧副本', () => {
    const p: Project = { ...newProject({ name: 'A' }), id: 'p1', updatedAt: NOW - 2000 };
    const local = vault([], [{ id: 'p1', deletedAt: NOW - 1000 }]);
    const remote = vault([p]); // 远端还留着旧副本
    const m = mergeVaultData(local, remote, NOW);
    expect(m.projects).toHaveLength(0);
    expect(m.tombstones.find((t) => t.id === 'p1')).toBeTruthy();
  });

  it('删除后又被编辑（updatedAt 晚于删除）则保留', () => {
    const p: Project = { ...newProject({ name: 'A' }), id: 'p1', updatedAt: NOW - 500 };
    const local = vault([], [{ id: 'p1', deletedAt: NOW - 1000 }]);
    const remote = vault([p]);
    const m = mergeVaultData(local, remote, NOW);
    expect(m.projects).toHaveLength(1);
  });

  it('递归合并：一边改项目名、另一边在同项目加环境，两者都保留', () => {
    const envB = newEnvironment({ name: '生产' });
    const a: Project = {
      ...newProject({ name: '改后的名' }),
      id: 'p1',
      updatedAt: 500,
      environments: [],
    };
    const b: Project = {
      ...newProject({ name: '原名' }),
      id: 'p1',
      updatedAt: 100,
      environments: [envB],
    };
    const m = mergeVaultData(vault([a]), vault([b]), NOW);
    expect(m.projects[0]!.name).toBe('改后的名'); // 较新字段
    expect(m.projects[0]!.environments.map((e) => e.name)).toEqual(['生产']); // 另一边的环境
  });

  it('账号级合并：两个不同账号都在，重名账号取较新', () => {
    const link = newLink({ name: 'L', url: 'https://x.com' });
    const acc1 = { ...newAccount({ label: '管理员', password: 'old' }), id: 'a1', updatedAt: 100 };
    const env = newEnvironment({ name: 'E' });
    const linkA = { ...link, id: 'l1', updatedAt: 1, accounts: [acc1] };
    const envA = { ...env, id: 'e1', updatedAt: 1, links: [linkA] };
    const projA: Project = { ...newProject({ name: 'P' }), id: 'p1', updatedAt: 1, environments: [envA] };

    const acc1b = { ...newAccount({ label: '管理员', password: 'new' }), id: 'a1', updatedAt: 200 };
    const acc2 = { ...newAccount({ label: '测试', password: 'pw2' }), id: 'a2', updatedAt: 50 };
    const linkB = { ...link, id: 'l1', updatedAt: 1, accounts: [acc1b, acc2] };
    const envB = { ...env, id: 'e1', updatedAt: 1, links: [linkB] };
    const projB: Project = { ...newProject({ name: 'P' }), id: 'p1', updatedAt: 1, environments: [envB] };

    const m = mergeVaultData(vault([projA]), vault([projB]), NOW);
    const accounts = m.projects[0]!.environments[0]!.links[0]!.accounts;
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.id === 'a1')!.password).toBe('new'); // 较新
    expect(accounts.find((a) => a.id === 'a2')!.label).toBe('测试');
  });

  it('过期墓碑（>365 天）被清理', () => {
    const old = NOW - 400 * 24 * 60 * 60 * 1000;
    const m = mergeVaultData(vault([], [{ id: 'x', deletedAt: old }]), vault([]), NOW);
    expect(m.tombstones).toHaveLength(0);
  });

  it('未到保留期的墓碑（<365 天）被保留', () => {
    const recent = NOW - 100 * 24 * 60 * 60 * 1000;
    const m = mergeVaultData(vault([], [{ id: 'x', deletedAt: recent }]), vault([]), NOW);
    expect(m.tombstones.find((t) => t.id === 'x')).toBeTruthy();
  });

  it('updatedAt 相等时合并结果与方向无关（收敛）', () => {
    const a: Project = { ...newProject({ name: '甲' }), id: 'p1', updatedAt: 500 };
    const b: Project = { ...newProject({ name: '乙' }), id: 'p1', updatedAt: 500 };
    const ab = mergeVaultData(vault([a]), vault([b]), NOW);
    const ba = mergeVaultData(vault([b]), vault([a]), NOW);
    expect(ab.projects[0]!.name).toBe(ba.projects[0]!.name);
  });
});

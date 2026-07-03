import { describe, expect, it } from 'vitest';
import { mergeVaultData } from '../lib/merge';
import type { Project, VaultData, Workspace } from '../lib/types';
import { newAccount, newDoc, newEnvironment, newLink, newMemo, newProject } from '../lib/vault-ops';

function vault(projects: Project[], tombstones: VaultData['tombstones'] = []): VaultData {
  return {
    version: 1,
    projects,
    settings: { autoLockMinutes: 15, kdf: { type: 'pbkdf2', iterations: 1, hash: 'SHA-256' } },
    tombstones,
  };
}

const NOW = 1_000_000_000_000;

function projectWithId(id: string, name: string, updatedAt: number): Project {
  return {
    ...newProject({ name }),
    id,
    environments: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function workspaceWithProjects(
  id: string,
  name: string,
  projects: Project[],
  updatedAt: number,
): Workspace {
  return {
    id,
    name,
    projects,
    createdAt: updatedAt,
    updatedAt,
  };
}

function workspaceVault(
  workspaces: Workspace[],
  activeWorkspaceId: string,
  settingsUpdatedAt: number,
): VaultData {
  return {
    version: 1,
    projects: workspaces.find((w) => w.id === activeWorkspaceId)?.projects ?? [],
    settings: {
      autoLockMinutes: 15,
      kdf: { type: 'pbkdf2', iterations: 1, hash: 'SHA-256' },
      updatedAt: settingsUpdatedAt,
    },
    workspaces,
    activeWorkspaceId,
    tombstones: [],
  };
}

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

  it('删除工作区留墓碑后，同步不会把它复活', () => {
    const kdf = { type: 'pbkdf2' as const, iterations: 1, hash: 'SHA-256' as const };
    const ws = (id: string, name: string): Workspace => ({
      id,
      name,
      projects: [],
      createdAt: NOW - 5000,
      updatedAt: NOW - 5000,
    });
    const local: VaultData = {
      version: 1,
      projects: [],
      settings: { autoLockMinutes: 15, kdf },
      workspaces: [ws('wsB', '个人')], // wsA 已在本地删除
      activeWorkspaceId: 'wsB',
      tombstones: [{ id: 'wsA', deletedAt: NOW - 1000 }],
    };
    const remote: VaultData = {
      version: 1,
      projects: [],
      settings: { autoLockMinutes: 15, kdf },
      workspaces: [ws('wsA', '公司'), ws('wsB', '个人')], // 远端还留着 wsA
      activeWorkspaceId: 'wsA',
      tombstones: [],
    };
    const m = mergeVaultData(local, remote, NOW);
    const wsIds = (m.workspaces ?? []).map((w) => w.id);
    expect(wsIds).toEqual(['wsB']);
    expect(wsIds).not.toContain('wsA');
  });

  it('同步合并会保留双方新增的工作区，并保留本机当前工作区镜像', () => {
    const company = workspaceWithProjects(
      'ws-company',
      '公司',
      [projectWithId('p-company', '公司项目', 100)],
      100,
    );
    const personal = workspaceWithProjects(
      'ws-personal',
      '个人',
      [projectWithId('p-personal', '个人项目', 200)],
      200,
    );
    const local = workspaceVault([company], company.id, 100);
    const remote = workspaceVault([personal], personal.id, 200);

    const m = mergeVaultData(local, remote, NOW);

    expect((m.workspaces ?? []).map((w) => w.name).sort()).toEqual(['个人', '公司']);
    expect(m.activeWorkspaceId).toBe(company.id);
    expect(m.projects.map((p) => p.id)).toEqual(['p-company']);
    expect(m.workspaces?.find((w) => w.id === company.id)?.projects.map((p) => p.id)).toEqual([
      'p-company',
    ]);
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

  it('递归合并：同一项目的文档和备忘不会被项目级较新字段覆盖', () => {
    const doc = { ...newDoc({ title: '说明' }), id: 'd1', updatedAt: 150 };
    const memo = { ...newMemo({ text: '上线前检查' }), id: 'm1', updatedAt: 160 };
    const a: Project = {
      ...newProject({ name: '改后的名' }),
      id: 'p1',
      updatedAt: 500,
      docs: [doc],
      memos: [],
      environments: [],
    };
    const b: Project = {
      ...newProject({ name: '原名' }),
      id: 'p1',
      updatedAt: 100,
      docs: [],
      memos: [memo],
      environments: [],
    };
    const m = mergeVaultData(vault([a]), vault([b]), NOW);
    expect(m.projects[0]!.name).toBe('改后的名');
    expect(m.projects[0]!.docs?.map((d) => d.title)).toEqual(['说明']);
    expect(m.projects[0]!.memos?.map((x) => x.text)).toEqual(['上线前检查']);
  });

  it('同步合并后按环境类型和名称归并重复环境', () => {
    const linkA = newLink({ name: '登录页', url: 'https://example.test/#/login' });
    const linkB = newLink({ name: '开启终端', url: 'https://example.test/#/index' });
    const envA = {
      ...newEnvironment({ name: '默认', kind: 'prod', updatedAt: 100 }),
      id: 'env-a',
      links: [linkA],
    };
    const envB = {
      ...newEnvironment({ name: ' 默认 ', kind: 'prod', updatedAt: 200 }),
      id: 'env-b',
      links: [linkB],
    };
    const local: Project = {
      ...newProject({ name: '荆二' }),
      id: 'p1',
      updatedAt: 100,
      environments: [envA],
    };
    const remote: Project = {
      ...newProject({ name: '荆二' }),
      id: 'p1',
      updatedAt: 200,
      environments: [envB],
    };

    const m = mergeVaultData(vault([local]), vault([remote]), NOW);

    expect(m.projects[0]!.environments).toHaveLength(1);
    expect(m.projects[0]!.environments[0]!.name).toBe('生产');
    expect(m.projects[0]!.environments[0]!.links.map((l) => l.name)).toEqual([
      '登录页',
      '开启终端',
    ]);
    expect(m.tombstones).toContainEqual({ id: 'env-b', deletedAt: NOW });
  });

  it('文档和备忘删除墓碑会阻止旧副本复活', () => {
    const doc = { ...newDoc({ title: '旧文档' }), id: 'd1', updatedAt: NOW - 2000 };
    const memo = { ...newMemo({ text: '旧待办' }), id: 'm1', updatedAt: NOW - 2000 };
    const remote: Project = {
      ...newProject({ name: 'P' }),
      id: 'p1',
      updatedAt: NOW - 3000,
      docs: [doc],
      memos: [memo],
      environments: [],
    };
    const local: Project = {
      ...newProject({ name: 'P' }),
      id: 'p1',
      updatedAt: NOW - 1000,
      docs: [],
      memos: [],
      environments: [],
    };
    const m = mergeVaultData(
      vault([local], [
        { id: 'd1', deletedAt: NOW - 1000 },
        { id: 'm1', deletedAt: NOW - 1000 },
      ]),
      vault([remote]),
      NOW,
    );
    expect(m.projects[0]!.docs).toEqual([]);
    expect(m.projects[0]!.memos).toEqual([]);
  });

  it('移动链接时墓碑清理旧位置，同时保留更新后的目标位置', () => {
    const oldLink = { ...newLink({ name: '登录页', url: 'https://x.test' }), id: 'l1', updatedAt: NOW - 20 };
    const movedLink = { ...oldLink, updatedAt: NOW - 5 };
    const sourceEnvLocal = { ...newEnvironment({ name: '默认', updatedAt: NOW - 5 }), id: 'source-env', links: [] };
    const sourceEnvRemote = { ...sourceEnvLocal, updatedAt: NOW - 20, links: [oldLink] };
    const targetEnv = {
      ...newEnvironment({ name: '默认', updatedAt: NOW - 5 }),
      id: 'target-env',
      links: [movedLink],
    };
    const local = vault(
      [
        { ...newProject({ name: '捕获' }), id: 'capture', updatedAt: NOW - 5, environments: [sourceEnvLocal] },
        { ...newProject({ name: '正式项目' }), id: 'target', updatedAt: NOW - 5, environments: [targetEnv] },
      ],
      [{ id: 'l1', deletedAt: NOW - 10 }],
    );
    const remote = vault([
      { ...newProject({ name: '捕获' }), id: 'capture', updatedAt: NOW - 20, environments: [sourceEnvRemote] },
    ]);

    const m = mergeVaultData(local, remote, NOW);

    const sourceLinks = m.projects.find((p) => p.id === 'capture')!.environments[0]!.links;
    const targetLinks = m.projects.find((p) => p.id === 'target')!.environments[0]!.links;
    expect(sourceLinks).toEqual([]);
    expect(targetLinks.map((link) => link.id)).toEqual(['l1']);
  });

  it('账号级合并：两个不同账号都在，重名账号取较新', () => {
    const link = newLink({ name: 'L', url: 'https://x.com' });
    const acc1 = { ...newAccount({ label: '管理员', password: 'old' }), id: 'a1', updatedAt: 100 };
    const env = newEnvironment({ name: 'E' });
    const linkA = { ...link, id: 'l1', updatedAt: 1, accounts: [acc1] };
    const envA = { ...env, id: 'e1', updatedAt: 1, links: [linkA] };
    const projA: Project = { ...newProject({ name: 'P' }), id: 'p1', updatedAt: 1, environments: [envA] };

    const acc1b = {
      ...newAccount({
        label: '管理员',
        password: 'new',
        customFields: [{ id: 'cf1', type: 'email', label: '备用邮箱', value: 'ops@example.test' }],
      }),
      id: 'a1',
      updatedAt: 200,
    };
    const acc2 = { ...newAccount({ label: '测试', password: 'pw2' }), id: 'a2', updatedAt: 50 };
    const linkB = { ...link, id: 'l1', updatedAt: 1, accounts: [acc1b, acc2] };
    const envB = { ...env, id: 'e1', updatedAt: 1, links: [linkB] };
    const projB: Project = { ...newProject({ name: 'P' }), id: 'p1', updatedAt: 1, environments: [envB] };

    const m = mergeVaultData(vault([projA]), vault([projB]), NOW);
    const accounts = m.projects[0]!.environments[0]!.links[0]!.accounts;
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.id === 'a1')!.password).toBe('new'); // 较新
    expect(accounts.find((a) => a.id === 'a1')!.customFields?.[0]?.value).toBe('ops@example.test');
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

  it('设置按 settings.updatedAt 取较新者，用于同步首页排版和设置', () => {
    const local = vault([]);
    const remote = vault([]);
    local.settings = {
      ...local.settings,
      updatedAt: 100,
      theme: 'light',
      dashboard: { activeBoardId: 'local', boards: [] },
    };
    remote.settings = {
      ...remote.settings,
      updatedAt: 200,
      theme: 'dark',
      dashboard: { activeBoardId: 'remote', boards: [] },
    };

    const m = mergeVaultData(local, remote, NOW);

    expect(m.settings.theme).toBe('dark');
    expect(m.settings.dashboard?.activeBoardId).toBe('remote');
  });

  it('旧数据没有 settings.updatedAt 时仍保持本机设置优先', () => {
    const local = vault([]);
    const remote = vault([]);
    local.settings.theme = 'light';
    remote.settings.theme = 'dark';

    const m = mergeVaultData(local, remote, NOW);

    expect(m.settings.theme).toBe('light');
  });

  it('只在较旧一方配置过的 CNB 令牌不会被较新 settings 整体覆盖掉', () => {
    const configured = vault([]);
    const other = vault([]);
    configured.settings = {
      ...configured.settings,
      updatedAt: 100,
      cnb: { token: 'cnb-token', orgs: ['njly2013'] },
    };
    // 另一台设备之后动过任意设置（如主题），settings.updatedAt 更新，但从未配置 CNB。
    other.settings = { ...other.settings, updatedAt: 200, theme: 'dark' };

    const ab = mergeVaultData(configured, other, NOW);
    const ba = mergeVaultData(other, configured, NOW);

    expect(ab.settings.theme).toBe('dark');
    expect(ab.settings.cnb?.token).toBe('cnb-token');
    expect(ba.settings.cnb?.token).toBe('cnb-token');
  });

  it('两侧都配置过 CNB 时以 settings 胜方为准', () => {
    const older = vault([]);
    const newer = vault([]);
    older.settings = { ...older.settings, updatedAt: 100, cnb: { token: 'old', orgs: [] } };
    newer.settings = { ...newer.settings, updatedAt: 200, cnb: { token: 'new', orgs: [] } };

    const m = mergeVaultData(older, newer, NOW);

    expect(m.settings.cnb?.token).toBe('new');
  });

  it('胜方从未配置同步目标时保留败方的 syncTargets；已存在（含空数组）不回填', () => {
    const configured = vault([]);
    const fresh = vault([]);
    configured.settings = {
      ...configured.settings,
      updatedAt: 100,
      syncTargets: [
        { id: 't1', type: 'self-hosted', label: '家里', enabled: true, serverUrl: 'https://s', token: 'tok' },
      ],
    };
    fresh.settings = { ...fresh.settings, updatedAt: 200 };

    const m = mergeVaultData(configured, fresh, NOW);
    expect(m.settings.syncTargets?.map((t) => t.id)).toEqual(['t1']);

    // 明确删空（[] 仍存在）表示删除，按胜方为准、不回填。
    const cleared = vault([]);
    cleared.settings = { ...cleared.settings, updatedAt: 300, syncTargets: [] };
    const m2 = mergeVaultData(configured, cleared, NOW);
    expect(m2.settings.syncTargets).toEqual([]);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  allWorkspaceProjects,
  allWorkspacesData,
  commitWorkspaceDraft,
  createWorkspace,
  ensureVaultWorkspaces,
  preserveActiveWorkspace,
  switchActiveWorkspace,
} from '../lib/workspace';
import { mergeVaultData } from '../lib/merge';
import { matchForUrl } from '../lib/search';
import type { Project, VaultData, Workspace } from '../lib/types';
import { newAccount, newEnvironment, newLink, newProject } from '../lib/vault-ops';

const kdf = { type: 'pbkdf2' as const, iterations: 1, hash: 'SHA-256' as const };

function ws(id: string, name: string, projectNames: string[] = []): Workspace {
  return {
    id,
    name,
    projects: projectNames.map((n) => newProject({ name: n })),
    createdAt: 1,
    updatedAt: 1,
  };
}

function vault(workspaces: Workspace[], activeWorkspaceId: string, projects: Project[] = []): VaultData {
  return {
    version: 1,
    projects,
    settings: { autoLockMinutes: 15, kdf },
    workspaces,
    activeWorkspaceId,
    tombstones: [],
  };
}

describe('工作区数据安全', () => {
  it('activeWorkspaceId 悬空 + 空根：commit 不得清空 fallback 工作区的项目', () => {
    const def = ws('wsDefault', '默认工作区', ['A', 'B', 'C']);
    // 中间态：active 指向一个不存在的工作区，根 projects 为空（属于已消失的另一个工作区）。
    const data = vault([def], 'ghost-missing', []);
    commitWorkspaceDraft(data, 1000);
    expect((data.workspaces ?? [])[0]!.projects.map((p) => p.name)).toEqual(['A', 'B', 'C']);
    expect(data.activeWorkspaceId).toBe('wsDefault'); // active 归位
    expect(data.projects.map((p) => p.name)).toEqual(['A', 'B', 'C']); // 根镜像出默认项目
  });

  it('新建工作区并切回：默认工作区的项目不丢失', () => {
    const data = vault([ws('wsDefault', '默认工作区', ['A', 'B'])], 'wsDefault');
    createWorkspace(data, '个人', 100);
    expect((data.workspaces ?? []).map((w) => w.name)).toEqual(['默认工作区', '个人']);
    expect(data.projects).toHaveLength(0); // 个人为空、已激活
    switchActiveWorkspace(data, 'wsDefault', 200);
    expect(data.activeWorkspaceId).toBe('wsDefault');
    expect(data.projects.map((p) => p.name)).toEqual(['A', 'B']); // 默认项目仍在
    expect((data.workspaces ?? []).find((w) => w.name === '个人')).toBeTruthy(); // 个人未丢
  });

  it('新建工作区经过前后台两次 commit 后仍保留并激活', () => {
    const def = ws('wsDefault', '默认工作区', ['A', 'B']);
    const data = vault([def], 'wsDefault', structuredClone(def.projects));

    createWorkspace(data, '个人', 100);
    commitWorkspaceDraft(data, 101); // useVault.save 发送前
    const messageData = structuredClone(data);
    commitWorkspaceDraft(messageData, 102); // background.persistData 保存前

    expect((messageData.workspaces ?? []).map((w) => w.name)).toEqual(['默认工作区', '个人']);
    expect(messageData.activeWorkspaceId).toBe(
      (messageData.workspaces ?? []).find((w) => w.name === '个人')?.id,
    );
    expect(messageData.projects).toHaveLength(0);
    switchActiveWorkspace(messageData, 'wsDefault', 103);
    expect(messageData.projects.map((p) => p.name)).toEqual(['A', 'B']);
  });
});

describe('跨工作区匹配当前站点', () => {
  // 一个含单链接单账号的项目：链接主网址为 url。
  function projectWithLogin(projectName: string, url: string, username: string): Project {
    return newProject({
      name: projectName,
      environments: [
        newEnvironment({
          name: '生产',
          kind: 'prod',
          links: [newLink({ name: projectName, url, accounts: [newAccount({ username, password: 'pw' })] })],
        }),
      ],
    });
  }

  it('allWorkspaceProjects 合并全部工作区且不重复计入当前工作区', () => {
    const a = ws('wsA', '工作区A', []);
    a.projects = [projectWithLogin('站点A', 'https://a.example.com/', 'ua')];
    const b = ws('wsB', '工作区B', []);
    b.projects = [projectWithLogin('站点B', 'https://b.example.com/', 'ub')];
    // 根 projects 是当前工作区(A)的镜像(同引用)。
    const data = vault([a, b], 'wsA', a.projects);

    const names = allWorkspaceProjects(data).map((p) => p.name).sort();
    expect(names).toEqual(['站点A', '站点B']); // A 不因根镜像被重复计入
  });

  it('非当前工作区存的账号也能匹配当前打开的网站', () => {
    const a = ws('wsA', '工作区A', []);
    a.projects = [projectWithLogin('站点A', 'https://a.example.com/', 'ua')];
    const b = ws('wsB', '工作区B', []);
    b.projects = [projectWithLogin('站点B', 'https://b.example.com/login', 'ub')];
    const data = vault([a, b], 'wsA', a.projects); // 当前在 A

    // 旧行为(仅当前工作区)匹配不到 B 的站点；跨工作区视图能匹配到。
    expect(matchForUrl(data, 'https://b.example.com/login')).toHaveLength(0);
    const hits = matchForUrl(allWorkspacesData(data), 'https://b.example.com/login');
    expect(hits.map((h) => h.username)).toEqual(['ub']);
  });
});

describe('activeWorkspaceId 稳定性', () => {
  it('普通保存不得回滚 active：旧快照保存时保留后台当前工作区', () => {
    const data = vault([ws('wsDefault', '默认工作区', ['A']), ws('wsP', '个人')], 'wsDefault');
    // 旧快照（active 还在默认）做普通保存；后台当前是个人。
    const restored = preserveActiveWorkspace(data, 'wsP');
    expect(restored).toBe(true);
    expect(data.activeWorkspaceId).toBe('wsP');
    expect(data.projects).toHaveLength(0); // 根镜像跟随个人
    // 后台工作区不存在于该快照时不动，交由 ensure 兜底
    expect(preserveActiveWorkspace(data, 'ghost')).toBe(false);
    expect(data.activeWorkspaceId).toBe('wsP');
  });

  it('工作区 id 缺失被重新生成时 active 跟随新 id，而不是跳回第一个', () => {
    const broken = ws('', '个人', ['P1']);
    const data = vault([ws('wsDefault', '默认工作区', ['A']), broken], '');
    ensureVaultWorkspaces(data, 1000);
    const personal = (data.workspaces ?? []).find((w) => w.name === '个人')!;
    expect(personal.id).not.toBe('');
    expect(data.activeWorkspaceId).toBe(personal.id); // 跟随，不跳默认
    expect(data.projects.map((p) => p.name)).toEqual(['P1']);
    // 再次归一化保持稳定
    ensureVaultWorkspaces(data, 2000);
    expect(data.activeWorkspaceId).toBe(personal.id);
  });

  it('工作区 id 重复被重新生成时 active 跟随被改 id 的那一个', () => {
    const data = vault([ws('dup', '默认工作区', ['A']), ws('dup', '个人', ['P1'])], 'dup');
    ensureVaultWorkspaces(data, 1000);
    const [def, personal] = data.workspaces!;
    expect(def!.id).toBe('dup');
    expect(personal!.id).not.toBe('dup');
    // active 原本指向 'dup'（仍存在，指默认），不动——语义上无法区分用户在哪个，保守保留。
    expect(data.activeWorkspaceId).toBe('dup');
    // 用户切到个人后不再被拉回。
    switchActiveWorkspace(data, personal!.id, 1100);
    ensureVaultWorkspaces(data, 1200);
    expect(data.activeWorkspaceId).toBe(personal!.id);
  });
});

describe('工作区 updatedAt 与同步合并', () => {
  it('ws.updatedAt 提升到所含项目的最大 updatedAt', () => {
    const w = ws('wsDefault', '默认工作区', ['A']);
    w.updatedAt = 10;
    w.projects[0]!.updatedAt = 5000;
    const data = vault([w], 'wsDefault');
    ensureVaultWorkspaces(data, 1000);
    expect(data.workspaces![0]!.updatedAt).toBe(5000);
  });

  it('设备 A 删除工作区后，设备 B 的后续编辑不被墓碑吞掉', () => {
    const shared = ws('wsP', '个人', ['P1']);
    shared.updatedAt = 100;
    shared.projects[0]!.updatedAt = 100;
    const deviceA = vault([ws('wsDefault', '默认工作区', ['A']), structuredClone(shared)], 'wsDefault');
    const deviceB = structuredClone(deviceA);
    // A 在 t=200 删除个人工作区并留墓碑。
    deviceA.workspaces = deviceA.workspaces!.filter((w) => w.id !== 'wsP');
    deviceA.tombstones.push({ id: 'wsP', deletedAt: 200 });
    // B 在 t=300 往个人工作区里编辑项目（日常编辑只 bump project.updatedAt）。
    const bPersonal = deviceB.workspaces!.find((w) => w.id === 'wsP')!;
    bPersonal.projects[0]!.updatedAt = 300;
    ensureVaultWorkspaces(deviceB, 300); // 归一化把 ws.updatedAt 提升到 300
    const merged = mergeVaultData(deviceA, deviceB, 400);
    expect(merged.workspaces!.map((w) => w.name)).toContain('个人'); // 删除后又编辑 → 保留
  });

  it('合并中 byName 命中的旧引用不覆盖已合并结果（互相重命名）', () => {
    // 本地：默认(D1)。远端：D1 已改名「个人」（t=500），另有新工作区 P2 名「默认工作区」（t=500）。
    const localDef = ws('D1', '默认工作区', ['A']);
    localDef.updatedAt = 100;
    const local = vault([localDef], 'D1');
    const remoteDef = ws('D1', '个人', ['A']);
    remoteDef.updatedAt = 500;
    remoteDef.projects = structuredClone(localDef.projects);
    const remoteNew = ws('P2', '默认工作区', ['B']);
    remoteNew.updatedAt = 500;
    const remote = vault([remoteDef, remoteNew], 'D1');
    const merged = mergeVaultData(local, remote, 1000);
    const names = merged.workspaces!.map((w) => w.name).sort();
    // 改名传播 + 新工作区保留：不得因 byName 旧引用把 D1 的合并结果覆盖回旧名。
    expect(names).toEqual(['个人', '默认工作区']);
    const d1 = merged.workspaces!.find((w) => w.id === 'D1')!;
    expect(d1.name).toBe('个人');
    expect(d1.projects.map((p) => p.name)).toEqual(['A']);
  });
});

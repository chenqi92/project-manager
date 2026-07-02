// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  commitWorkspaceDraft,
  createWorkspace,
  switchActiveWorkspace,
} from '../lib/workspace';
import type { Project, VaultData, Workspace } from '../lib/types';
import { newProject } from '../lib/vault-ops';

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

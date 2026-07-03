// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { hasSyncRelevantChange } from '../lib/sync-change';
import type { Project, VaultData, Workspace } from '../lib/types';
import { createWorkspace, switchActiveWorkspace } from '../lib/workspace';
import { newProject } from '../lib/vault-ops';

const kdf = { type: 'pbkdf2' as const, iterations: 1, hash: 'SHA-256' as const };

function project(id: string, name: string): Project {
  return { ...newProject({ name }), id, environments: [], createdAt: 1, updatedAt: 1 };
}

function ws(id: string, name: string, projects: Project[] = []): Workspace {
  return {
    id,
    name,
    projects,
    dashboard: { activeBoardId: `${id}-board`, boards: [] },
    createdAt: 1,
    updatedAt: 1,
  };
}

function vault(workspaces: Workspace[], activeWorkspaceId: string): VaultData {
  const active = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0]!;
  return {
    version: 1,
    projects: active.projects,
    settings: {
      autoLockMinutes: 15,
      kdf,
      dashboard: active.dashboard,
      updatedAt: 1,
    },
    workspaces,
    activeWorkspaceId,
    tombstones: [],
  };
}

describe('自动同步变更判断', () => {
  it('纯切换当前工作区不触发自动同步', () => {
    const before = vault(
      [ws('company', '公司', [project('p1', '公司项目')]), ws('personal', '个人')],
      'company',
    );
    const after = structuredClone(before);

    switchActiveWorkspace(after, 'personal', 100);
    after.settings.updatedAt = 100;

    expect(hasSyncRelevantChange(before, after)).toBe(false);
  });

  it('新增工作区会触发自动同步', () => {
    const before = vault([ws('company', '公司')], 'company');
    const after = structuredClone(before);

    createWorkspace(after, '个人', 100);

    expect(hasSyncRelevantChange(before, after)).toBe(true);
  });

  it('项目内容变化会触发自动同步', () => {
    const before = vault([ws('company', '公司', [project('p1', '旧项目')])], 'company');
    const after = structuredClone(before);

    after.workspaces![0]!.projects[0]!.name = '新项目';
    after.workspaces![0]!.projects[0]!.updatedAt = 100;

    expect(hasSyncRelevantChange(before, after)).toBe(true);
  });

  it('设置变化会触发自动同步', () => {
    const before = vault([ws('company', '公司')], 'company');
    const after = structuredClone(before);

    after.settings.theme = 'dark';
    after.settings.updatedAt = 100;

    expect(hasSyncRelevantChange(before, after)).toBe(true);
  });

  it('工作区看板变化会触发自动同步', () => {
    const before = vault([ws('company', '公司')], 'company');
    const after = structuredClone(before);

    after.workspaces![0]!.dashboard = {
      activeBoardId: 'board-new',
      boards: [{ id: 'board-new', name: '新看板', widgets: [] }],
    };
    after.workspaces![0]!.updatedAt = 100;

    expect(hasSyncRelevantChange(before, after)).toBe(true);
  });

  it('引导/备份提醒状态（onboarded* / lastBackupAt / backupSnoozeUntil）不触发自动同步', () => {
    const before = vault([ws('company', '公司')], 'company');
    const after = structuredClone(before);

    after.settings.onboardedBackup = true;
    after.settings.onboardedFeatureSwitches = true;
    after.settings.lastBackupAt = 100;
    after.settings.backupSnoozeUntil = 200;

    expect(hasSyncRelevantChange(before, after)).toBe(false);
  });

  it('CNB 集成配置变化会触发自动同步', () => {
    const before = vault([ws('company', '公司')], 'company');
    const after = structuredClone(before);

    after.settings.cnb = { token: 'cnb-token', orgs: ['njly2013'] };
    after.settings.updatedAt = 100;

    expect(hasSyncRelevantChange(before, after)).toBe(true);
  });
});

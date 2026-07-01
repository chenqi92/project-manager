import type { DashboardConfig, Project, VaultData, Workspace } from './types';

export const DEFAULT_WORKSPACE_NAME = '默认工作区';

type WorkspaceRead = Pick<Workspace, 'id' | 'name' | 'projects' | 'dashboard'>;

function id(): string {
  return crypto.randomUUID();
}

function cleanName(name: string | undefined, fallback: string): string {
  return (name ?? '').replace(/\s+/g, ' ').trim() || fallback;
}

function makeWorkspace(
  name: string,
  projects: Project[] = [],
  dashboard?: DashboardConfig,
  timestamp = Date.now(),
): Workspace {
  return {
    id: id(),
    name: cleanName(name, DEFAULT_WORKSPACE_NAME),
    projects,
    dashboard,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function activeWorkspaceUnsafe(data: VaultData): Workspace | null {
  const workspaces = data.workspaces ?? [];
  return workspaces.find((w) => w.id === data.activeWorkspaceId) ?? workspaces[0] ?? null;
}

function mirrorActiveToLegacy(data: VaultData): boolean {
  const ws = activeWorkspaceUnsafe(data);
  if (!ws) return false;
  let changed = false;
  if (data.activeWorkspaceId !== ws.id) {
    data.activeWorkspaceId = ws.id;
    changed = true;
  }
  if (data.projects !== ws.projects) {
    data.projects = ws.projects;
    changed = true;
  }
  if (data.settings.dashboard !== ws.dashboard) {
    data.settings.dashboard = ws.dashboard;
    changed = true;
  }
  return changed;
}

/** 确保旧版根 projects/dashboard 已迁移到默认工作区，并把根字段镜像为当前工作区。 */
export function ensureVaultWorkspaces(data: VaultData, timestamp = Date.now()): boolean {
  let changed = false;
  if (!Array.isArray(data.projects)) {
    data.projects = [];
    changed = true;
  }

  if (!Array.isArray(data.workspaces) || data.workspaces.length === 0) {
    const ws = makeWorkspace(
      DEFAULT_WORKSPACE_NAME,
      data.projects,
      data.settings?.dashboard,
      timestamp,
    );
    data.workspaces = [ws];
    data.activeWorkspaceId = ws.id;
    changed = true;
    return mirrorActiveToLegacy(data) || changed;
  }

  const seen = new Set<string>();
  for (let i = 0; i < data.workspaces.length; i++) {
    const ws = data.workspaces[i]!;
    if (!ws.id || seen.has(ws.id)) {
      ws.id = id();
      changed = true;
    }
    seen.add(ws.id);
    const fallback = i === 0 ? DEFAULT_WORKSPACE_NAME : `工作区 ${i + 1}`;
    const name = cleanName(ws.name, fallback);
    if (ws.name !== name) {
      ws.name = name;
      changed = true;
    }
    if (!Array.isArray(ws.projects)) {
      ws.projects = [];
      changed = true;
    }
    if (!ws.createdAt) {
      ws.createdAt = timestamp;
      changed = true;
    }
    if (!ws.updatedAt) {
      ws.updatedAt = timestamp;
      changed = true;
    }
  }

  if (!activeWorkspaceUnsafe(data)) {
    data.activeWorkspaceId = data.workspaces[0]!.id;
    changed = true;
  }
  return mirrorActiveToLegacy(data) || changed;
}

/** 让旧组件继续通过 d.projects / d.settings.dashboard 编辑当前工作区。 */
export function prepareWorkspaceDraft(data: VaultData, timestamp = Date.now()): VaultData {
  ensureVaultWorkspaces(data, timestamp);
  mirrorActiveToLegacy(data);
  return data;
}

/** 保存前把旧字段上的改动写回当前工作区，再重新镜像。 */
export function commitWorkspaceDraft(data: VaultData, timestamp = Date.now()): boolean {
  const rootProjects = data.projects;
  const rootDashboard = data.settings.dashboard;
  let changed = ensureVaultWorkspaces(data, timestamp);
  const ws = activeWorkspaceUnsafe(data);
  if (!ws) return changed;
  if (ws.projects !== rootProjects) {
    ws.projects = rootProjects;
    ws.updatedAt = Math.max(ws.updatedAt ?? 0, timestamp);
    changed = true;
  }
  if (ws.dashboard !== rootDashboard) {
    ws.dashboard = rootDashboard;
    ws.updatedAt = Math.max(ws.updatedAt ?? 0, timestamp);
    changed = true;
  }
  return mirrorActiveToLegacy(data) || changed;
}

export function activeWorkspace(data: VaultData): Workspace {
  ensureVaultWorkspaces(data);
  return activeWorkspaceUnsafe(data)!;
}

export function activeProjects(data: VaultData): Project[] {
  return activeWorkspace(data).projects;
}

/** 只读视图：把根 projects/dashboard 映射成当前工作区，保留整库其它字段。 */
export function workspaceScopedData(data: VaultData): VaultData {
  const ws =
    (data.workspaces ?? []).find((w) => w.id === data.activeWorkspaceId) ??
    (data.workspaces ?? [])[0];
  if (!ws) return data;
  return {
    ...data,
    projects: ws.projects,
    settings: {
      ...data.settings,
      dashboard: ws.dashboard,
    },
  };
}

export function switchActiveWorkspace(data: VaultData, workspaceId: string, timestamp = Date.now()): boolean {
  let changed = commitWorkspaceDraft(data, timestamp);
  const ws = (data.workspaces ?? []).find((w) => w.id === workspaceId);
  if (!ws) return changed;
  if (data.activeWorkspaceId !== ws.id) {
    data.activeWorkspaceId = ws.id;
    changed = true;
  }
  return mirrorActiveToLegacy(data) || changed;
}

export function createWorkspace(data: VaultData, name: string, timestamp = Date.now()): Workspace {
  commitWorkspaceDraft(data, timestamp);
  const ws = makeWorkspace(name, [], undefined, timestamp);
  data.workspaces = [...(data.workspaces ?? []), ws];
  data.activeWorkspaceId = ws.id;
  mirrorActiveToLegacy(data);
  return ws;
}

export function renameWorkspace(data: VaultData, workspaceId: string, name: string, timestamp = Date.now()): boolean {
  ensureVaultWorkspaces(data, timestamp);
  const ws = (data.workspaces ?? []).find((w) => w.id === workspaceId);
  if (!ws) return false;
  const next = cleanName(name, ws.name);
  if (ws.name === next) return false;
  ws.name = next;
  ws.updatedAt = Math.max(ws.updatedAt ?? 0, timestamp);
  return true;
}

export function workspaceListForRead(data: VaultData): WorkspaceRead[] {
  const workspaces = data.workspaces ?? [];
  if (workspaces.length > 0) return workspaces;
  return [
    {
      id: data.activeWorkspaceId || 'legacy',
      name: DEFAULT_WORKSPACE_NAME,
      projects: data.projects ?? [],
      dashboard: data.settings?.dashboard,
    },
  ];
}

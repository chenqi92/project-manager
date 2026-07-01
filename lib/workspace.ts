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

  // activeWorkspaceId 必须精确指向某个现存工作区；悬空则归位到第一个（activeWorkspaceUnsafe
  // 的 fallback 只在读取时兜底，不会修正悬空 id，会掩盖问题）。
  if (!data.workspaces.some((w) => w.id === data.activeWorkspaceId)) {
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
  // 关键安全点：只把根 projects/dashboard 写回「activeWorkspaceId 精确对应」的工作区。
  // 若 active 指向一个不在列表里的工作区（竞态 / 中间态），绝不能用 activeWorkspaceUnsafe 的
  // fallback（workspaces[0]）来接收根字段——那会用别的工作区的（往往是空的）根覆盖并清空它的
  // 项目（就是"新建工作区切走后默认工作区项目全没了"这个数据丢失 bug 的根因）。此时跳过提交，
  // 交给 ensureVaultWorkspaces 把 active 归位、再镜像出正确的根。
  const target = (data.workspaces ?? []).find((w) => w.id === data.activeWorkspaceId);
  let changed = ensureVaultWorkspaces(data, timestamp);
  if (!target) return mirrorActiveToLegacy(data) || changed;
  if (target.projects !== rootProjects) {
    target.projects = rootProjects;
    target.updatedAt = Math.max(target.updatedAt ?? 0, timestamp);
    changed = true;
  }
  if (target.dashboard !== rootDashboard) {
    target.dashboard = rootDashboard;
    target.updatedAt = Math.max(target.updatedAt ?? 0, timestamp);
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
  // 不用 commitWorkspaceDraft：切换工作区不涉及对 root 的编辑；若把（可能是中间态/别的工作区的）
  // root 写回当前工作区，会清空它的项目（数据丢失 bug 根因）。只需确保结构存在即可。
  let changed = ensureVaultWorkspaces(data, timestamp);
  const ws = (data.workspaces ?? []).find((w) => w.id === workspaceId);
  if (!ws) return changed;
  if (data.activeWorkspaceId !== ws.id) {
    data.activeWorkspaceId = ws.id;
    changed = true;
  }
  return mirrorActiveToLegacy(data) || changed;
}

export function createWorkspace(data: VaultData, name: string, timestamp = Date.now()): Workspace {
  // 同上：不 commit（会用中间态 root 覆盖当前工作区、清空其项目），只确保结构存在。
  ensureVaultWorkspaces(data, timestamp);
  const ws = makeWorkspace(name, [], undefined, timestamp);
  data.workspaces = [...(data.workspaces ?? []), ws];
  data.activeWorkspaceId = ws.id;
  mirrorActiveToLegacy(data);
  return ws;
}

/** 删除一个工作区（及其下所有项目）。至少保留一个；删掉当前工作区则切到第一个。 */
export function deleteWorkspace(data: VaultData, workspaceId: string, timestamp = Date.now()): boolean {
  const workspaces = data.workspaces ?? [];
  if (workspaces.length <= 1) return false;
  const idx = workspaces.findIndex((w) => w.id === workspaceId);
  if (idx < 0) return false;
  workspaces.splice(idx, 1);
  data.workspaces = workspaces;
  if (data.activeWorkspaceId === workspaceId) {
    data.activeWorkspaceId = workspaces[0]!.id;
  }
  mirrorActiveToLegacy(data);
  return ensureVaultWorkspaces(data, timestamp) || true;
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

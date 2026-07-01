// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildExport, mergeVaults, parseImport } from '../lib/import-export';
import { createEncryptedVault, emptyVaultData } from '../lib/vault-core';
import type { VaultData } from '../lib/types';
import { newAccount, newEnvironment, newLink, newProject } from '../lib/vault-ops';

const KDF = { type: 'pbkdf2', iterations: 1, hash: 'SHA-256' } as const;

function jsonVault(): VaultData {
  const now = Date.now();
  return {
    version: 1,
    tombstones: [{ id: 'deleted-doc', deletedAt: now - 1000 }],
    projects: [
      {
        id: 'project-stable',
        name: '压测项目',
        docs: [{ id: 'doc-stable', title: '压测说明', content: '# OK', updatedAt: now }],
        memos: [{ id: 'memo-stable', text: '压测待办', done: false, createdAt: now, updatedAt: now }],
        environments: [
          {
            id: 'env-stable',
            name: '生产环境',
            kind: 'prod',
            links: [
              {
                id: 'link-stable',
                name: '管理后台',
                url: 'https://admin.example.test',
                accounts: [
                  {
                    id: 'account-stable',
                    label: '管理员',
                    username: 'admin',
                    password: 'S3cure!Password',
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
                updatedAt: now,
              },
            ],
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    settings: {
      autoLockMinutes: 0,
      kdf: KDF,
      dashboard: {
        activeBoardId: 'board-stress',
        boards: [
          {
            id: 'board-stress',
            name: '全类型压力',
            widgets: [
              {
                id: 'widget-doc',
                type: 'doc',
                config: { projectId: 'project-stable', docId: 'doc-stable' },
              },
            ],
          },
        ],
      },
    },
  };
}

describe('JSON 导入', () => {
  it('保留稳定 id 和 dashboard 配置，替换模式可恢复首页磁贴绑定', async () => {
    const incoming = await parseImport('json', JSON.stringify({ data: jsonVault() }));

    expect(incoming.projects[0]!.id).toBe('project-stable');
    expect(incoming.projects[0]!.docs![0]!.id).toBe('doc-stable');
    expect(incoming.projects[0]!.environments[0]!.links[0]!.accounts[0]!.id).toBe('account-stable');

    const merged = mergeVaults(emptyVaultData(), incoming, 'replace').data;
    const widget = merged.settings.dashboard!.boards![0]!.widgets[0]!;

    expect(merged.projects[0]!.id).toBe('project-stable');
    expect(merged.tombstones[0]!.id).toBe('deleted-doc');
    expect(merged.settings.dashboard!.activeBoardId).toBe('board-stress');
    expect(widget.config?.projectId).toBe('project-stable');
    expect(widget.config?.docId).toBe('doc-stable');
  });
});

describe('加密备份导入', () => {
  it('密码错误时返回明确提示', async () => {
    const { encrypted } = await createEncryptedVault(jsonVault(), 'right-password', KDF);
    const content = JSON.stringify({ format: 'project-env-manager.encrypted', ...encrypted });

    await expect(parseImport('encrypted', content, 'wrong-password')).rejects.toThrow(
      '备份密码不正确',
    );
  });
});

describe('导入合并', () => {
  it('合并模式会导入首页看板、磁贴排版、大小和配置', () => {
    const base = emptyVaultData();
    const incoming = jsonVault();
    incoming.settings.weatherEnabled = true;
    incoming.settings.cnb = { token: 'cnb-token', orgs: ['njly2013'] };
    incoming.settings.dashboard = {
      activeBoardId: 'board-stress',
      boards: [
        {
          id: 'board-stress',
          name: '全类型压力',
          appearance: { bg: 'gradient', gradient: 'forest', tileOpacity: 82, tileBlur: 10 },
          widgets: [
            {
              id: 'widget-doc',
              type: 'doc',
              x: 1,
              y: 2,
              w: 2,
              h: 3,
              config: {
                label: '压测说明',
                projectId: 'project-stable',
                docId: 'doc-stable',
                privacyMode: 'soft',
              },
            },
            {
              id: 'widget-weather',
              type: 'weather',
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              config: { city: '杭州', unit: 'c' },
            },
            {
              id: 'widget-cnb',
              type: 'cnb',
              x: 3,
              y: 0,
              w: 1,
              h: 2,
            },
          ],
        },
      ],
    };

    const { data } = mergeVaults(base, incoming, 'merge');
    const board = data.settings.dashboard!.boards![0]!;
    const widget = board.widgets.find((w) => w.id === 'widget-doc')!;

    expect(data.settings.dashboard!.activeBoardId).toBe('board-stress');
    expect(board.appearance).toMatchObject({ gradient: 'forest', tileOpacity: 82, tileBlur: 10 });
    expect(widget).toMatchObject({ x: 1, y: 2, w: 2, h: 3 });
    expect(widget.config?.label).toBe('压测说明');
    expect(widget.config?.privacyMode).toBe('soft');
    expect(widget.config?.projectId).toBe(data.projects[0]!.id);
    expect(widget.config?.docId).toBe('doc-stable');
    expect(data.projects[0]!.docs![0]!.id).toBe('doc-stable');
    expect(data.settings.weatherEnabled).toBe(true);
    expect(data.settings.cnb?.orgs).toEqual(['njly2013']);
  });

  it('没有 dashboard 的导入不会覆盖本地首页看板', () => {
    const base = emptyVaultData();
    base.settings.dashboard = {
      activeBoardId: 'local-board',
      boards: [{ id: 'local-board', name: '本地', widgets: [{ id: 'local-widget', type: 'stats' }] }],
    };
    const incoming = emptyVaultData();
    const project = newProject({ name: '导入项目' });
    incoming.projects.push(project);

    const { data } = mergeVaults(base, incoming, 'merge');

    expect(data.settings.dashboard?.activeBoardId).toBe('local-board');
    expect(data.settings.dashboard?.boards?.[0]?.widgets[0]?.id).toBe('local-widget');
  });

  it('环境名称相同但类型不同不会被合并到同一个环境', () => {
    const base = emptyVaultData();
    const existing = newProject({ name: '同名项目' });
    existing.environments = [newEnvironment({ name: '默认', kind: 'dev' })];
    base.projects.push(existing);

    const incoming = emptyVaultData();
    const project = newProject({ name: '同名项目' });
    const link = newLink({ name: '后台', url: 'https://admin.example.test' });
    link.accounts.push(newAccount({ label: '管理员', username: 'admin', password: 'pw' }));
    project.environments = [newEnvironment({ name: '默认', kind: 'prod', links: [link] })];
    incoming.projects.push(project);

    const { data, imported } = mergeVaults(base, incoming, 'merge');

    expect(imported).toBe(1);
    expect(data.projects[0]!.environments.map((e) => e.kind)).toEqual(['dev', 'prod']);
  });
});

describe('CSV 导出', () => {
  it('自定义字段可以随 CSV 往返导入导出', async () => {
    const now = Date.now();
    const data = emptyVaultData();
    const link = newLink({
      id: 'l-fields',
      name: '控制台',
      url: 'https://console.example.test',
      customFields: [
        { id: 'lf-1', type: 'phone', label: '维护电话', value: '400-100-200' },
        { id: 'lf-2', type: 'url', label: '工单入口', value: 'https://ticket.example.test' },
      ],
    });
    link.accounts.push(
      newAccount({
        id: 'a-fields',
        label: '管理员',
        username: 'admin',
        password: 'pw',
        customFields: [
          { id: 'af-1', type: 'email', label: '备用邮箱', value: 'ops@example.test' },
          { id: 'af-2', type: 'password', label: '恢复码', value: 'recovery-123', sensitive: true },
        ],
      }),
    );
    data.projects.push({
      id: 'p-fields',
      name: '字段项目',
      environments: [
        {
          id: 'e-fields',
          name: '生产',
          kind: 'prod',
          links: [link],
          updatedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    const csv = (await buildExport(data, 'csv')).content;
    const imported = await parseImport('csv', csv);
    const importedLink = imported.projects[0]!.environments[0]!.links[0]!;
    const importedAccount = importedLink.accounts[0]!;

    expect(csv).toContain('link_fields');
    expect(csv).toContain('account_fields');
    expect(importedLink.customFields?.map((f) => f.label)).toEqual(['维护电话', '工单入口']);
    expect(importedAccount.customFields?.map((f) => f.label)).toEqual(['备用邮箱', '恢复码']);
    expect(importedAccount.customFields?.find((f) => f.id === 'af-2')?.sensitive).toBe(true);
  });

  it('转义公式前缀，避免被表格软件当作可执行公式', async () => {
    const now = Date.now();
    const data = emptyVaultData();
    data.projects.push({
      id: 'p-formula',
      name: '=项目',
      environments: [
        {
          id: 'e-formula',
          name: '+环境',
          kind: 'prod',
          links: [
            {
              id: 'l-formula',
              name: '@后台',
              url: 'https://admin.example.test',
              accounts: [
                {
                  id: 'a-formula',
                  label: '-管理员',
                  username: ' =user',
                  password: '=password',
                  note: '@note',
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              updatedAt: now,
            },
          ],
          updatedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    const csv = (await buildExport(data, 'csv')).content;

    expect(csv).toContain("'=项目");
    expect(csv).toContain("'+环境");
    expect(csv).toContain("'@后台");
    expect(csv).toContain("'-管理员");
    expect(csv).toContain("' =user");
    expect(csv).toContain("'=password");
    expect(csv).toContain("'@note");
  });
});

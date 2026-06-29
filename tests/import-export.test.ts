// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildExport, mergeVaults, parseImport } from '../lib/import-export';
import { createEncryptedVault, emptyVaultData } from '../lib/vault-core';
import type { VaultData } from '../lib/types';

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

describe('CSV 导出', () => {
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

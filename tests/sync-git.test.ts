// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitProvider } from '../lib/sync-providers/git';
import type { EncryptedVault, GitTarget } from '../lib/types';

const target: GitTarget = {
  id: 't',
  type: 'github',
  label: 'gh',
  enabled: true,
  owner: 'me',
  repo: 'r',
  branch: 'main',
  filePath: 'vault.enc',
  token: 'tok',
};

// 含中文的密文对象，验证 UTF-8 base64 编解码不乱码。
const vault = {
  version: 1,
  vaultId: 'vid-中文',
  data: { iv: 'aa', ct: '密文' },
} as unknown as EncryptedVault;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('GitHub provider', () => {
  it('preflight 对公开仓库给出警示，对私有仓库不警示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ private: false })));
    let pf = await createGitProvider(target).preflight();
    expect(pf.warnings.length).toBeGreaterThan(0);

    vi.stubGlobal('fetch', vi.fn(async () => json({ private: true })));
    pf = await createGitProvider(target).preflight();
    expect(pf.warnings).toEqual([]);
  });

  it('pull 能解出仓库里的 base64 密文（带换行），tag=sha', async () => {
    const b64 = Buffer.from(JSON.stringify(vault), 'utf8').toString('base64');
    const withNewlines = b64.replace(/(.{20})/g, '$1\n'); // 模拟 GitHub 的换行
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/repos/me/r/contents/vault.enc?ref=main');
        return json({ content: withNewlines, sha: 'sha123' });
      }),
    );
    const snap = await createGitProvider(target).pull();
    expect(snap?.tag).toBe('sha123');
    expect(snap?.vault.vaultId).toBe('vid-中文');
  });

  it('push 以 base64 提交并带上 sha 做乐观并发，返回新 sha', async () => {
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(init.method).toBe('PUT');
        sentBody = JSON.parse(init.body as string);
        return json({ content: { sha: 'newsha' } });
      }),
    );
    const res = await createGitProvider(target).push(vault, 'oldsha');
    expect(res).toEqual({ ok: true, tag: 'newsha' });
    expect(sentBody.sha).toBe('oldsha');
    expect(sentBody.branch).toBe('main');
    const decoded = Buffer.from(sentBody.content as string, 'base64').toString('utf8');
    expect(JSON.parse(decoded).vaultId).toBe('vid-中文');
  });

  it('push 遇到 422 冲突时回拉当前快照', async () => {
    const b64 = Buffer.from(JSON.stringify(vault), 'utf8').toString('base64');
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) return json({ message: 'conflict' }, 422);
        return json({ content: b64, sha: 'cursha' });
      }),
    );
    const res = await createGitProvider(target).push(vault, 'stale');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.current?.tag).toBe('cursha');
  });
});

describe('Gitee provider', () => {
  const giteeTarget: GitTarget = {
    ...target,
    type: 'gitee',
    label: 'ge',
    owner: 'me',
    repo: 'r',
    token: 'gtok',
  };

  it('preflight 对公开仓库给出警示，对私有仓库不警示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ public: true })));
    let pf = await createGitProvider(giteeTarget).preflight();
    expect(pf.warnings.length).toBeGreaterThan(0);

    vi.stubGlobal('fetch', vi.fn(async () => json({ private: true })));
    pf = await createGitProvider(giteeTarget).preflight();
    expect(pf.warnings).toEqual([]);
  });

  it('pull 用 access_token 和 ref 读取 contents，tag=sha', async () => {
    const b64 = Buffer.from(JSON.stringify(vault), 'utf8').toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('https://gitee.com/api/v5/repos/me/r/contents/vault.enc?ref=main');
        expect(url).toContain('access_token=gtok');
        return json({ content: b64, sha: 'gsha' });
      }),
    );

    const snap = await createGitProvider(giteeTarget).pull();

    expect(snap?.tag).toBe('gsha');
    expect(snap?.vault.vaultId).toBe('vid-中文');
  });

  it('push 新文件用 POST，更新文件用 PUT 并带 sha', async () => {
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(init.body as string);
        return json({ content: { sha: 'newgsha' } });
      }),
    );

    const res = await createGitProvider(giteeTarget).push(vault, 'oldgsha');

    expect(res).toEqual({ ok: true, tag: 'newgsha' });
    expect(sentBody.access_token).toBe('gtok');
    expect(sentBody.sha).toBe('oldgsha');
    expect(sentBody.branch).toBe('main');
  });
});

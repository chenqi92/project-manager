// GitHub / GitLab 后端：把保险箱密文当作仓库里的单个文件（默认 vault.enc）提交。
// 乐观并发：GitHub 用 blob sha，GitLab 用 last_commit_id。
// 预检会检测仓库是否公开——公开仓库里的加密密文人人可下载、可离线爆破，故警示。
import { decodeUtf8, encodeUtf8, fromB64, toB64 } from '../crypto';
import type { EncryptedVault, GitTarget } from '../types';
import { PreflightResult, PushResult, RemoteSnapshot, SyncProvider, SyncProviderError } from './types';

const COMMIT_MSG = 'chore: sync vault';

function encodeVault(vault: EncryptedVault): string {
  return toB64(encodeUtf8(JSON.stringify(vault)));
}
function decodeVault(b64: string): EncryptedVault {
  return JSON.parse(decodeUtf8(fromB64(b64.replace(/\s/g, '')))) as EncryptedVault;
}

export function createGitProvider(target: GitTarget): SyncProvider {
  return target.type === 'gitlab' ? new GitLabProvider(target) : new GitHubProvider(target);
}

// --------------------------------- GitHub ---------------------------------

class GitHubProvider implements SyncProvider {
  private api: string;
  private path: string;
  constructor(private t: GitTarget) {
    this.api = (t.apiBase || 'https://api.github.com').replace(/\/+$/, '');
    this.path = (t.filePath || 'vault.enc').replace(/^\/+/, '');
  }

  private contentsUrl(): string {
    const p = this.path.split('/').map(encodeURIComponent).join('/');
    return `${this.api}/repos/${this.t.owner}/${this.t.repo}/contents/${p}`;
  }
  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.t.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const r = await fetch(`${this.contentsUrl()}?ref=${encodeURIComponent(this.t.branch)}`, {
      headers: this.headers(),
    });
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) {
      throw new SyncProviderError('GitHub 认证失败，请检查访问令牌权限', 'auth');
    }
    if (!r.ok) throw new SyncProviderError(`GitHub 读取失败 ${r.status}`, 'http');
    const j = (await r.json()) as { content?: string; sha: string; git_url?: string };
    let b64 = j.content ?? '';
    // 大文件（>1MB）contents API 不返回内容，回退到 blobs API
    if (!b64 && j.git_url) {
      const b = await fetch(j.git_url, { headers: this.headers() });
      if (!b.ok) throw new SyncProviderError(`GitHub blob 读取失败 ${b.status}`, 'http');
      b64 = ((await b.json()) as { content: string }).content;
    }
    return { vault: decodeVault(b64), tag: j.sha };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    const body: Record<string, unknown> = {
      message: COMMIT_MSG,
      content: encodeVault(vault),
      branch: this.t.branch,
    };
    if (expectedTag) body.sha = expectedTag;
    const r = await fetch(this.contentsUrl(), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 409 || r.status === 422) {
      // sha 过期 / 已存在：回拉最新交给 engine 合并重试
      return { ok: false, current: await this.pull() };
    }
    if (!r.ok) throw new SyncProviderError(`GitHub 写入失败 ${r.status}`, 'http');
    const j = (await r.json()) as { content: { sha: string } };
    return { ok: true, tag: j.content.sha };
  }

  async remove(): Promise<void> {
    const snap = await this.pull();
    if (!snap) return;
    await fetch(this.contentsUrl(), {
      method: 'DELETE',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'chore: remove vault', sha: snap.tag, branch: this.t.branch }),
    });
  }

  async preflight(): Promise<PreflightResult> {
    const r = await fetch(`${this.api}/repos/${this.t.owner}/${this.t.repo}`, {
      headers: this.headers(),
    });
    if (r.status === 404) {
      throw new SyncProviderError('仓库不存在或令牌无权访问', 'not_found');
    }
    if (!r.ok) throw new SyncProviderError(`GitHub 预检失败 ${r.status}`, 'http');
    const j = (await r.json()) as { private: boolean };
    const warnings = j.private
      ? []
      : ['该仓库是公开的：加密密文会被任何人下载到，存在离线爆破主密码的风险。强烈建议改用私有仓库。'];
    return { ok: true, warnings };
  }
}

// --------------------------------- GitLab ---------------------------------

class GitLabProvider implements SyncProvider {
  private api: string;
  private projectId: string;
  private fileApi: string;
  constructor(private t: GitTarget) {
    this.api = (t.apiBase || 'https://gitlab.com/api/v4').replace(/\/+$/, '');
    this.projectId = encodeURIComponent(`${t.owner}/${t.repo}`);
    const file = encodeURIComponent((t.filePath || 'vault.enc').replace(/^\/+/, ''));
    this.fileApi = `${this.api}/projects/${this.projectId}/repository/files/${file}`;
  }
  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.t.token}` };
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const r = await fetch(`${this.fileApi}?ref=${encodeURIComponent(this.t.branch)}`, {
      headers: this.headers(),
    });
    if (r.status === 404) return null;
    if (r.status === 401 || r.status === 403) {
      throw new SyncProviderError('GitLab 认证失败，请检查访问令牌权限', 'auth');
    }
    if (!r.ok) throw new SyncProviderError(`GitLab 读取失败 ${r.status}`, 'http');
    const j = (await r.json()) as { content: string; last_commit_id: string };
    return { vault: decodeVault(j.content), tag: j.last_commit_id };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    const body: Record<string, unknown> = {
      branch: this.t.branch,
      content: encodeVault(vault),
      encoding: 'base64',
      commit_message: COMMIT_MSG,
    };
    if (expectedTag) body.last_commit_id = expectedTag;
    const method = expectedTag ? 'PUT' : 'POST';
    const r = await fetch(this.fileApi, {
      method,
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 400 || r.status === 409) {
      return { ok: false, current: await this.pull() };
    }
    if (!r.ok) throw new SyncProviderError(`GitLab 写入失败 ${r.status}`, 'http');
    // GitLab 写接口不回 blob/commit id，回拉一次取新 tag
    const snap = await this.pull();
    return { ok: true, tag: snap?.tag ?? '' };
  }

  async remove(): Promise<void> {
    await fetch(this.fileApi, {
      method: 'DELETE',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: this.t.branch, commit_message: 'chore: remove vault' }),
    });
  }

  async preflight(): Promise<PreflightResult> {
    const r = await fetch(`${this.api}/projects/${this.projectId}`, { headers: this.headers() });
    if (r.status === 404) throw new SyncProviderError('项目不存在或令牌无权访问', 'not_found');
    if (!r.ok) throw new SyncProviderError(`GitLab 预检失败 ${r.status}`, 'http');
    const j = (await r.json()) as { visibility: string };
    const warnings =
      j.visibility !== 'private'
        ? [`该项目可见性为 ${j.visibility}：加密密文可被他人下载、离线爆破主密码。强烈建议改为 private。`]
        : [];
    return { ok: true, warnings };
  }
}

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SyncEngineError,
  forcePullFromProvider,
  forcePushToProvider,
  syncWithProvider,
} from '../lib/sync-providers/engine';
import type { PushResult, RemoteSnapshot, SyncProvider } from '../lib/sync-providers/types';
import type { EncryptedVault, KdfConfig, Project, VaultData } from '../lib/types';
import { createEncryptedVault, decryptVaultData, emptyVaultData } from '../lib/vault-core';

// 测试用快 KDF（不影响逻辑，只为不跑 19MiB Argon2）。
const FAST_KDF: KdfConfig = { type: 'pbkdf2', iterations: 1000, hash: 'SHA-256' };

function project(id: string, name: string, updatedAt: number): Project {
  return { id, name, environments: [], createdAt: updatedAt, updatedAt };
}

function vaultData(projects: Project[]): VaultData {
  return { ...emptyVaultData(), projects };
}

async function makeVault(projects: Project[], password: string) {
  const data = vaultData(projects);
  const { encrypted, dek } = await createEncryptedVault(data, password, FAST_KDF);
  return { encrypted, dek, data };
}

/** 内存假后端：模拟带 tag 乐观并发的单文件存储，可注入一次性冲突。 */
class FakeProvider implements SyncProvider {
  remote: EncryptedVault | null;
  tag: string;
  /** 若设置，下一次 push 必返回冲突，并把远端替换为该密文 */
  failPushOnce: EncryptedVault | null = null;

  constructor(initial: EncryptedVault | null = null) {
    this.remote = initial;
    this.tag = initial ? '1' : '0';
  }
  async pull(): Promise<RemoteSnapshot | null> {
    return this.remote ? { vault: this.remote, tag: this.tag } : null;
  }
  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    if (this.failPushOnce) {
      this.remote = this.failPushOnce;
      this.tag = 'x';
      this.failPushOnce = null;
      return { ok: false, current: { vault: this.remote, tag: 'x' } };
    }
    const currentTag = this.remote ? this.tag : undefined;
    if (currentTag !== expectedTag) {
      return { ok: false, current: this.remote ? { vault: this.remote, tag: this.tag } : null };
    }
    this.remote = vault;
    const n = Number(this.tag);
    this.tag = String(Number.isNaN(n) ? 1 : n + 1);
    return { ok: true, tag: this.tag };
  }
  async remove(): Promise<void> {
    this.remote = null;
  }
  async preflight() {
    return { ok: true, warnings: [] };
  }
}

const ids = (data: VaultData) => data.projects.map((p) => p.id).sort();

describe('syncWithProvider', () => {
  it('远端为空时首推本地，且无需回写本地', async () => {
    const { encrypted, dek } = await makeVault([project('p1', 'A', 1000)], 'pw');
    const provider = new FakeProvider();
    const out = await syncWithProvider(provider, encrypted, dek);
    expect(out.mergedEncrypted).toBeNull();
    expect(out.tag).toBe('1');
    expect(provider.remote?.vaultId).toBe(encrypted.vaultId);
  });

  it('新目标守卫：远端为空 + guardEmptyPush 未确认 → 抛 empty_remote 且不推送', async () => {
    const { encrypted, dek } = await makeVault([project('p1', 'A', 1000)], 'pw');
    const provider = new FakeProvider();
    await expect(
      syncWithProvider(provider, encrypted, dek, { guardEmptyPush: true }),
    ).rejects.toMatchObject({ code: 'empty_remote' });
    expect(provider.remote).toBeNull(); // 没有静默推送
  });

  it('新目标守卫：确认后（confirmEmptyPush）远端为空才推送本地', async () => {
    const { encrypted, dek } = await makeVault([project('p1', 'A', 1000)], 'pw');
    const provider = new FakeProvider();
    const out = await syncWithProvider(provider, encrypted, dek, {
      guardEmptyPush: true,
      confirmEmptyPush: true,
    });
    expect(out.tag).toBe('1');
    expect(provider.remote?.vaultId).toBe(encrypted.vaultId);
  });

  it('同库：合并远端独有项目进本地，远端也更新', async () => {
    const { encrypted, dek } = await makeVault([project('p1', 'A', 1000)], 'pw');
    // 远端是同一保险箱的另一份（含 p2）——用同一 dek 重新加密。
    const { reencryptData } = await import('../lib/vault-core');
    const remote = await reencryptData(
      encrypted,
      vaultData([project('p1', 'A', 1000), project('p2', 'B', 2000)]),
      dek,
    );
    const provider = new FakeProvider(remote);

    const out = await syncWithProvider(provider, encrypted, dek);
    expect(out.mergedEncrypted).not.toBeNull();
    const merged = await decryptVaultData(out.mergedEncrypted!, dek);
    expect(ids(merged)).toEqual(['p1', 'p2']);
    // 远端被推送为合并结果
    const remoteData = await decryptVaultData(provider.remote!, dek);
    expect(ids(remoteData)).toEqual(['p1', 'p2']);
  });

  it('异库且未提供密码：抛 foreign_vault', async () => {
    const local = await makeVault([project('p1', 'A', 1000)], 'pw-local');
    const foreign = await makeVault([project('q1', 'X', 1000)], 'pw-foreign');
    const provider = new FakeProvider(foreign.encrypted);
    await expect(syncWithProvider(provider, local.encrypted, local.dek)).rejects.toMatchObject({
      code: 'foreign_vault',
    });
  });

  it('异库 + 正确密码：解密远端并三路合并，保留本地保险箱身份', async () => {
    const local = await makeVault([project('p1', 'A', 1000)], 'pw-local');
    const foreign = await makeVault([project('q1', 'X', 1000)], 'pw-foreign');
    const provider = new FakeProvider(foreign.encrypted);

    const out = await syncWithProvider(provider, local.encrypted, local.dek, {
      foreignPassword: 'pw-foreign',
    });
    const merged = await decryptVaultData(out.mergedEncrypted!, local.dek);
    expect(ids(merged)).toEqual(['p1', 'q1']);
    // 合并结果归属本地保险箱，仍能用本地 dek 解密、vaultId 不变
    expect(out.mergedEncrypted!.vaultId).toBe(local.encrypted.vaultId);
  });

  it('异库 + 错误密码：抛 bad_password', async () => {
    const local = await makeVault([project('p1', 'A', 1000)], 'pw-local');
    const foreign = await makeVault([project('q1', 'X', 1000)], 'pw-foreign');
    const provider = new FakeProvider(foreign.encrypted);
    await expect(
      syncWithProvider(provider, local.encrypted, local.dek, { foreignPassword: 'wrong' }),
    ).rejects.toBeInstanceOf(SyncEngineError);
  });

  it('推送冲突时重拉合并并重试成功', async () => {
    const { encrypted, dek } = await makeVault([project('p1', 'A', 1000)], 'pw');
    const { reencryptData } = await import('../lib/vault-core');
    const concurrent = await reencryptData(
      encrypted,
      vaultData([project('p1', 'A', 1000), project('p3', 'C', 3000)]),
      dek,
    );
    const provider = new FakeProvider();
    provider.failPushOnce = concurrent; // 首推遭遇并发写入

    const out = await syncWithProvider(provider, encrypted, dek);
    const merged = await decryptVaultData(out.mergedEncrypted!, dek);
    expect(ids(merged)).toEqual(['p1', 'p3']);
  });
});

describe('forcePush / forcePull', () => {
  it('forcePush 用本地整体覆盖远端', async () => {
    const local = await makeVault([project('p1', 'A', 5000)], 'pw');
    const stale = await makeVault([project('old', 'Z', 1)], 'pw');
    const provider = new FakeProvider(stale.encrypted);
    await forcePushToProvider(provider, local.encrypted);
    expect(provider.remote?.vaultId).toBe(local.encrypted.vaultId);
  });

  it('forcePull 异库先返回 foreign，带密码后用远端覆盖本地', async () => {
    const local = await makeVault([project('p1', 'A', 1000)], 'pw-local');
    const foreign = await makeVault([project('q1', 'X', 1000), project('q2', 'Y', 1000)], 'pw-foreign');
    const provider = new FakeProvider(foreign.encrypted);

    const first = await forcePullFromProvider(provider, local.encrypted, local.dek);
    expect(first.kind).toBe('foreign');

    const second = await forcePullFromProvider(provider, local.encrypted, local.dek, {
      foreignPassword: 'pw-foreign',
    });
    expect(second.kind).toBe('replaced');
    if (second.kind === 'replaced') {
      const data = await decryptVaultData(second.localEncrypted, local.dek);
      expect(ids(data)).toEqual(['q1', 'q2']); // 本地被远端整体替换
    }
  });
});

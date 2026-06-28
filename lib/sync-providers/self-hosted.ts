// 自托管后端：包装现有 SyncClient（/v1/vault 协议），把 server revision 当作 tag。
import { SyncClient } from '../sync';
import type { EncryptedVault, SelfHostedTarget } from '../types';
import type { PushResult, RemoteSnapshot, SyncProvider } from './types';

export class SelfHostedProvider implements SyncProvider {
  private client: SyncClient;

  constructor(target: SelfHostedTarget) {
    this.client = new SyncClient(target.serverUrl, target.token);
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const meta = await this.client.meta();
    if (!meta.exists) return null;
    const vault = await this.client.pull();
    if (!vault) return null;
    return { vault, tag: String(meta.revision) };
  }

  async push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult> {
    const base = expectedTag ? Number(expectedTag) : 0;
    const res = await this.client.push(base, vault);
    if (res.ok) return { ok: true, tag: String(res.revision) };
    return {
      ok: false,
      current: res.current
        ? { vault: res.current, tag: String(res.currentRevision) }
        : null,
    };
  }

  async remove(): Promise<void> {
    await this.client.deleteRemote();
  }

  async preflight() {
    await this.client.meta();
    return { ok: true, warnings: [] };
  }
}

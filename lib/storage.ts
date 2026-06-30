// ---------------------------------------------------------------------------
// 存储抽象层。当前仅本地（chrome.storage.local），但接口已为「自托管端到端
// 加密同步」预留好扩展点：因为 EncryptedVault 本身就是密文，远端只需存取这个
// 不透明 blob，服务器永远看不到明文或密钥。
// ---------------------------------------------------------------------------
import { browser } from 'wxt/browser';
import type { EncryptedVault } from './types';

export const VAULT_KEY = 'vault';

export interface VaultBackend {
  load(): Promise<EncryptedVault | null>;
  save(v: EncryptedVault): Promise<void>;
  clear(): Promise<void>;
}

/** 本地存储后端。密文落在 chrome.storage.local。 */
export class LocalBackend implements VaultBackend {
  async load(): Promise<EncryptedVault | null> {
    const res = await browser.storage.local.get(VAULT_KEY);
    return (res[VAULT_KEY] as EncryptedVault | undefined) ?? null;
  }

  async save(v: EncryptedVault): Promise<void> {
    await browser.storage.local.set({ [VAULT_KEY]: v });
  }

  async clear(): Promise<void> {
    await browser.storage.local.remove(VAULT_KEY);
  }
}

/**
 * 未来的远端同步提供方接口（自托管）。实现时：
 *   - push：把 EncryptedVault 整体（密文）上传
 *   - pull：拉回远端密文
 *   - 用 EncryptedVault.revision / updatedAt 做冲突合并，再交给 LocalBackend 落地
 * 由于是端到端加密，远端无需、也无法解密任何内容。
 */
export interface SyncProvider {
  push(v: EncryptedVault): Promise<void>;
  pull(): Promise<EncryptedVault | null>;
}

export const vaultBackend: VaultBackend = new LocalBackend();

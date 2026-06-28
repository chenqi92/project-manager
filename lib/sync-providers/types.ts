// ---------------------------------------------------------------------------
// 同步后端抽象：每个后端（自托管 / WebDAV / Git / 网盘）只需把「读一个密文文件」
// 「带乐观并发地写回」「删除」「预检」实现出来，合并/加解密由 engine 统一处理。
// 后端永远只接触整个 EncryptedVault（密文），看不到任何明文。
// ---------------------------------------------------------------------------
import type { EncryptedVault } from '../types';

/** 远端当前快照：密文 + 版本标识（ETag / blob sha / drive etag / revision 串）。 */
export interface RemoteSnapshot {
  vault: EncryptedVault;
  /** 乐观并发用的版本标识；后端无法提供时给空串（退化为后写覆盖）。 */
  tag: string;
}

export type PushResult =
  | { ok: true; tag: string }
  | { ok: false; current: RemoteSnapshot | null };

export interface PreflightResult {
  ok: boolean;
  /** 非致命警示（如 Git 仓库是公开的）。 */
  warnings: string[];
}

export interface SyncProvider {
  /** 拉取远端密文；远端不存在返回 null。 */
  pull(): Promise<RemoteSnapshot | null>;
  /**
   * 推送密文。expectedTag 为上次已知 tag（乐观并发）：
   *  - undefined 表示「期望远端尚不存在」（首次创建）。
   *  - 不匹配时返回 {ok:false, current}，由 engine 重拉合并后重试。
   */
  push(vault: EncryptedVault, expectedTag?: string): Promise<PushResult>;
  /** 删除远端副本（关闭同步时）。 */
  remove(): Promise<void>;
  /** 预检连通性 / 凭据；Git 后端在此检测仓库是否公开并写入 warnings。 */
  preflight(): Promise<PreflightResult>;
  /**
   * 列出远端目录下的子文件夹（用于「连接后选择存放目录」）。
   * segments 为从根开始的路径段（空 = 根/共享文件夹层）。仅部分后端支持。
   */
  listDir?(segments: string[]): Promise<Array<{ name: string }>>;
}

export class SyncProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'auth'
      | 'http'
      | 'network'
      | 'not_found'
      | 'public_repo'
      | 'config'
      | 'otp_required',
  ) {
    super(message);
    this.name = 'SyncProviderError';
  }
}

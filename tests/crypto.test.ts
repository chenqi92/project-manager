// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertSafeKdfConfig } from '../lib/crypto';
import type { KdfConfig } from '../lib/types';

describe('assertSafeKdfConfig', () => {
  it('拒绝异常大的 KDF 参数，避免恶意备份导致资源耗尽', () => {
    expect(() =>
      assertSafeKdfConfig({
        type: 'argon2id',
        memKiB: 1024 * 1024,
        iterations: 3,
        parallelism: 1,
      } as KdfConfig),
    ).toThrow(/KDF 参数异常/);

    expect(() =>
      assertSafeKdfConfig({
        type: 'pbkdf2',
        iterations: 50_000_000,
        hash: 'SHA-256',
      } as KdfConfig),
    ).toThrow(/KDF 参数异常/);
  });

  it('允许现有低成本测试/旧备份参数正常解密', () => {
    expect(() =>
      assertSafeKdfConfig({ type: 'pbkdf2', iterations: 1, hash: 'SHA-256' }),
    ).not.toThrow();
  });
});

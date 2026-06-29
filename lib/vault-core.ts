// ---------------------------------------------------------------------------
// 保险箱内核：信封加密（KEK 包裹 DEK，DEK 加密数据）的创建 / 解锁 / 保存 / 改密。
// 纯函数，不接触存储和 UI，便于审计与测试。
// ---------------------------------------------------------------------------
import {
  DEFAULT_KDF,
  aesDecrypt,
  aesEncrypt,
  decodeUtf8,
  deriveKeyBytes,
  deriveKeyFromPrf,
  encodeUtf8,
  fromB64,
  randomBytes,
  toB64,
} from './crypto';
import { BACKUP_REMIND_AFTER_MS } from './backup';
import type { BioEnrollment, EncryptedVault, KdfConfig, VaultData } from './types';

export const VAULT_SCHEMA_VERSION = 1;

export function emptyVaultData(): VaultData {
  return {
    version: VAULT_SCHEMA_VERSION,
    projects: [],
    settings: {
      autoLockMinutes: 15,
      kdf: DEFAULT_KDF,
      autoSubmit: false,
      webAssist: true,
      capturePromptPlacement: 'top-right',
      backupSnoozeUntil: Date.now() + BACKUP_REMIND_AFTER_MS,
    },
    tombstones: [],
  };
}

/** 用主密码创建一个全新的加密保险箱；返回密文信封与（内存用的）DEK。 */
export async function createEncryptedVault(
  data: VaultData,
  password: string,
  kdf: KdfConfig = DEFAULT_KDF,
): Promise<{ encrypted: EncryptedVault; dek: Uint8Array }> {
  const salt = randomBytes(16);
  const dek = randomBytes(32);
  const kek = await deriveKeyBytes(password, salt, kdf);
  const wrappedKey = await aesEncrypt(kek, dek);
  const dataCt = await aesEncrypt(dek, encodeUtf8(JSON.stringify(data)));
  return {
    encrypted: {
      version: VAULT_SCHEMA_VERSION,
      vaultId: crypto.randomUUID(),
      kdf,
      salt: toB64(salt),
      wrappedKey,
      data: dataCt,
      updatedAt: Date.now(),
      revision: 1,
    },
    dek,
  };
}

/** 用主密码解开 DEK。主密码错误时会抛错（GCM 认证失败）。 */
export async function unwrapDEK(
  enc: EncryptedVault,
  password: string,
): Promise<Uint8Array> {
  const kek = await deriveKeyBytes(password, fromB64(enc.salt), enc.kdf);
  return aesDecrypt(kek, enc.wrappedKey);
}

/** 用 DEK 解密保险箱数据。 */
export async function decryptVaultData(
  enc: EncryptedVault,
  dek: Uint8Array,
): Promise<VaultData> {
  const json = decodeUtf8(await aesDecrypt(dek, enc.data));
  return JSON.parse(json) as VaultData;
}

/** 用已有 DEK 重新加密数据（保存时调用）；salt / wrappedKey 不变。 */
export async function reencryptData(
  prev: EncryptedVault,
  data: VaultData,
  dek: Uint8Array,
): Promise<EncryptedVault> {
  const dataCt = await aesEncrypt(dek, encodeUtf8(JSON.stringify(data)));
  return {
    ...prev,
    data: dataCt,
    updatedAt: Date.now(),
    revision: prev.revision + 1,
  };
}

/**
 * 修改主密码：用新密码 + 新盐重新包裹同一个 DEK，数据密文无需改动。
 * 这正是信封加密的好处——改密是 O(1) 而不是重新加密整库。
 */
export async function rewrapDEK(
  prev: EncryptedVault,
  dek: Uint8Array,
  newPassword: string,
  kdf: KdfConfig = prev.kdf,
): Promise<EncryptedVault> {
  const salt = randomBytes(16);
  const kek = await deriveKeyBytes(newPassword, salt, kdf);
  const wrappedKey = await aesEncrypt(kek, dek);
  return {
    ...prev,
    kdf,
    salt: toB64(salt),
    wrappedKey,
    updatedAt: Date.now(),
    revision: prev.revision + 1,
  };
}

// ---------------------------------------------------------------------------
// 生物识别（WebAuthn PRF）：把同一个 DEK 用 PRF 派生的 KEK 再包一份，
// 作为「额外」的解锁方式。主密码始终保留，丢失授权器不会锁死保险箱。
// ---------------------------------------------------------------------------

/** 注册一个生物识别授权器：用其 PRF 输出包裹当前 DEK，追加到 bioEnrollments。 */
export async function enrollBiometric(
  prev: EncryptedVault,
  dek: Uint8Array,
  opts: { label: string; credentialId: string; prfSalt: string; prfOutput: Uint8Array },
): Promise<EncryptedVault> {
  const kek = await deriveKeyFromPrf(opts.prfOutput);
  const wrappedKey = await aesEncrypt(kek, dek);
  const enrollment: BioEnrollment = {
    id: crypto.randomUUID(),
    label: opts.label,
    credentialId: opts.credentialId,
    prfSalt: opts.prfSalt,
    wrappedKey,
    createdAt: Date.now(),
  };
  return {
    ...prev,
    bioEnrollments: [...(prev.bioEnrollments ?? []), enrollment],
    updatedAt: Date.now(),
    revision: prev.revision + 1,
  };
}

/** 用某个授权器的 PRF 输出解开 DEK。PRF 不对会抛错（GCM 认证失败）。 */
export async function unwrapDEKWithPrf(
  enc: EncryptedVault,
  enrollmentId: string,
  prfOutput: Uint8Array,
): Promise<Uint8Array> {
  const enrollment = (enc.bioEnrollments ?? []).find((e) => e.id === enrollmentId);
  if (!enrollment) throw new Error('找不到该生物识别注册项');
  const kek = await deriveKeyFromPrf(prfOutput);
  return aesDecrypt(kek, enrollment.wrappedKey);
}

export function removeBioEnrollment(
  prev: EncryptedVault,
  enrollmentId: string,
): EncryptedVault {
  return {
    ...prev,
    bioEnrollments: (prev.bioEnrollments ?? []).filter((e) => e.id !== enrollmentId),
    updatedAt: Date.now(),
    revision: prev.revision + 1,
  };
}

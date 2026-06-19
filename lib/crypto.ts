// ---------------------------------------------------------------------------
// 加密原语层：Web Crypto (AES-GCM / PBKDF2) + hash-wasm (Argon2id)
// 故意保持小而可审计，不引入任何加密「黑盒」库。
// ---------------------------------------------------------------------------
import { argon2id } from 'hash-wasm';
import type { CipherText, KdfConfig } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 默认 KDF：Argon2id，内存硬，抗 GPU/ASIC 暴力破解。参数 ≥ OWASP 2024 推荐下限。 */
export const DEFAULT_KDF: KdfConfig = {
  type: 'argon2id',
  memKiB: 19456, // 19 MiB
  iterations: 3,
  parallelism: 1,
};

/** 浏览器不原生支持 Argon2 时（理论上不会发生）回退到 PBKDF2-600k。 */
export const PBKDF2_FALLBACK: KdfConfig = {
  type: 'pbkdf2',
  iterations: 600_000,
  hash: 'SHA-256',
};

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function encodeUtf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function decodeUtf8(b: Uint8Array): string {
  return textDecoder.decode(b);
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * 新版 TS 给 Uint8Array 增加了 ArrayBuffer 泛型，而 Web Crypto 的 BufferSource
 * 要求 ArrayBuffer 支撑。这里只在调用边界做一次类型适配，不复制数据、不产生
 * 额外的密钥副本。
 */
function bs(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

/** 由主密码 + 盐派生 32 字节密钥材料（KEK）。 */
export async function deriveKeyBytes(
  password: string,
  salt: Uint8Array,
  kdf: KdfConfig,
): Promise<Uint8Array> {
  if (kdf.type === 'argon2id') {
    const hash = await argon2id({
      password,
      salt,
      parallelism: kdf.parallelism,
      iterations: kdf.iterations,
      memorySize: kdf.memKiB,
      hashLength: 32,
      outputType: 'binary',
    });
    return hash as Uint8Array;
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    bs(encodeUtf8(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: bs(salt), iterations: kdf.iterations, hash: kdf.hash },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * 把 WebAuthn PRF 输出（32 字节，来自 Touch ID / Windows Hello 的 hmac-secret）
 * 经 HKDF-SHA256 派生成一把用于包裹 DEK 的 KEK。绝不直接把 PRF 原值当密钥用。
 */
export async function deriveKeyFromPrf(prfOutput: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', bs(prfOutput), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: bs(new Uint8Array(0)),
      info: bs(encodeUtf8('pem-vault-dek-wrap')),
    },
    base,
    256,
  );
  return new Uint8Array(bits);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bs(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM-256 加密；每次生成全新 96bit 随机 IV（绝不复用）。 */
export async function aesEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
): Promise<CipherText> {
  const key = await importAesKey(keyBytes);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    key,
    bs(plaintext),
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/** AES-GCM-256 解密；密钥/密文被篡改时会抛错（GCM 认证失败），用于校验主密码。 */
export async function aesDecrypt(
  keyBytes: Uint8Array,
  c: CipherText,
): Promise<Uint8Array> {
  const key = await importAesKey(keyBytes);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(fromB64(c.iv)) },
    key,
    bs(fromB64(c.ct)),
  );
  return new Uint8Array(pt);
}

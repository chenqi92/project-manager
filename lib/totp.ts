// ---------------------------------------------------------------------------
// TOTP (RFC 6238) 两步验证码生成。纯 Web Crypto，无依赖。
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface TotpConfig {
  secret: string; // base32
  digits: number;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

/** 解析 base32 密钥或 otpauth:// URI。无法解析返回 null。 */
export function parseTotp(input: string): TotpConfig | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith('otpauth://')) {
    try {
      const u = new URL(s);
      const secret = u.searchParams.get('secret');
      if (!secret) return null;
      const algo = (u.searchParams.get('algorithm') || 'SHA1').toUpperCase();
      return {
        secret,
        digits: Number(u.searchParams.get('digits')) || 6,
        period: Number(u.searchParams.get('period')) || 30,
        algorithm: algo.includes('256') ? 'SHA-256' : algo.includes('512') ? 'SHA-512' : 'SHA-1',
      };
    } catch {
      return null;
    }
  }
  const cleaned = s.replace(/\s/g, '');
  if (!/^[A-Za-z2-7]+=*$/.test(cleaned) || cleaned.length < 8) return null;
  return { secret: cleaned, digits: 6, period: 30, algorithm: 'SHA-1' };
}

export async function generateTotp(
  cfg: TotpConfig,
  nowMs: number,
): Promise<{ code: string; secondsRemaining: number }> {
  const key = base32Decode(cfg.secret);
  const counter = Math.floor(nowMs / 1000 / cfg.period);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32), false);
  view.setUint32(4, counter >>> 0, false);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: cfg.algorithm },
    false,
    ['sign'],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const code = (bin % 10 ** cfg.digits).toString().padStart(cfg.digits, '0');
  const secondsRemaining = cfg.period - Math.floor((nowMs / 1000) % cfg.period);
  return { code, secondsRemaining };
}

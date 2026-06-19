// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { generateTotp, parseTotp } from '../lib/totp';

// RFC 6238 测试密钥 "12345678901234567890" 的 base32。
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  it('匹配 RFC 6238 测试向量（SHA-1, 6 位）', async () => {
    const cfg = { secret: SECRET, digits: 6, period: 30, algorithm: 'SHA-1' as const };
    expect((await generateTotp(cfg, 59 * 1000)).code).toBe('287082');
    expect((await generateTotp(cfg, 1111111109 * 1000)).code).toBe('081804');
  });

  it('解析 otpauth:// URI', () => {
    const c = parseTotp(`otpauth://totp/Acme:alice?secret=${SECRET}&period=30&digits=6`);
    expect(c?.secret).toBe(SECRET);
    expect(c?.period).toBe(30);
    expect(c?.digits).toBe(6);
  });

  it('解析裸 base32 密钥', () => {
    expect(parseTotp(SECRET)?.digits).toBe(6);
  });

  it('无效输入返回 null', () => {
    expect(parseTotp('!!!')).toBe(null);
    expect(parseTotp('')).toBe(null);
  });
});

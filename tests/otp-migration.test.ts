// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { base32Encode } from '../lib/totp';
import { parseMigrationUri } from '../lib/otp-migration';

const enc = new TextEncoder();

// 最小 protobuf 编码器(与被测解码器各自独立实现)。
const varint = (n: number): number[] => {
  const o: number[] = [];
  while (n > 0x7f) {
    o.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  o.push(n);
  return o;
};
const lenF = (f: number, b: number[]): number[] => [(f << 3) | 2, ...varint(b.length), ...b];
const varF = (f: number, v: number): number[] => [(f << 3) | 0, ...varint(v)];
const toUri = (payload: number[]): string =>
  `otpauth-migration://offline?data=${encodeURIComponent(btoa(String.fromCharCode(...payload)))}`;

describe('base32Encode', () => {
  it('编码知名向量 "Hello!"+deadbeef', () => {
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]);
    expect(base32Encode(bytes)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('匹配 RFC 4648 示例(无填充)', () => {
    expect(base32Encode(enc.encode('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(enc.encode('f'))).toBe('MY');
  });
});

describe('parseMigrationUri', () => {
  it('解出单个 TOTP 项并组装 otpauth://', () => {
    const secret = [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef];
    const otp = [
      ...lenF(1, secret),
      ...lenF(2, [...enc.encode('Example:alice@google.com')]),
      ...lenF(3, [...enc.encode('Example')]),
      ...varF(4, 1), // SHA1
      ...varF(5, 1), // SIX
      ...varF(6, 2), // TOTP
    ];
    const res = parseMigrationUri(toUri(lenF(1, otp)));
    expect(res).toHaveLength(1);
    expect(res[0]!.issuer).toBe('Example');
    expect(res[0]!.name).toBe('Example:alice@google.com');
    const u = new URL(res[0]!.otpauth);
    expect(u.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('algorithm')).toBe('SHA1');
    expect(u.searchParams.get('issuer')).toBe('Example');
  });

  it('解出多个项,并把 EIGHT/SHA256 正确映射', () => {
    const mk = (label: string, digits: number, algo: number): number[] =>
      lenF(1, [
        ...lenF(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        ...lenF(2, [...enc.encode(label)]),
        ...varF(4, algo),
        ...varF(5, digits),
        ...varF(6, 2),
      ]);
    const res = parseMigrationUri(toUri([...mk('A', 1, 1), ...mk('B', 2, 2)]));
    expect(res).toHaveLength(2);
    expect(new URL(res[1]!.otpauth).searchParams.get('digits')).toBe('8');
    expect(new URL(res[1]!.otpauth).searchParams.get('algorithm')).toBe('SHA256');
  });

  it('全为 HOTP 时抛错(无可导入的 TOTP)', () => {
    const otp = [...lenF(1, [1, 2, 3, 4, 5]), ...varF(6, 1)]; // type=HOTP
    expect(() => parseMigrationUri(toUri(lenF(1, otp)))).toThrow();
  });

  it('非迁移码 URI 抛错', () => {
    expect(() => parseMigrationUri('otpauth://totp/x?secret=JBSWY3DP')).toThrow();
  });
});

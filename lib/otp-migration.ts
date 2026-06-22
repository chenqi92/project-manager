// ---------------------------------------------------------------------------
// 解析 Google Authenticator 导出的 otpauth-migration:// 迁移码。
// 该码的 data 参数是一段 base64(protobuf) 的 MigrationPayload,内含多个 OTP 项。
// 这里手写一个极小的 protobuf 读取器(只处理用到的 varint / length-delimited),
// 无第三方依赖。仅取 TOTP 项,转成标准 otpauth:// URI 交由 parseTotp 使用。
//
// proto 结构(摘自 Google Authenticator):
//   MigrationPayload { repeated OtpParameters otp_parameters = 1; ... }
//   OtpParameters {
//     bytes  secret    = 1;
//     string name      = 2;
//     string issuer    = 3;
//     enum   algorithm = 4;  // 1=SHA1 2=SHA256 3=SHA512 4=MD5
//     enum   digits    = 5;  // 1=SIX 2=EIGHT
//     enum   type      = 6;  // 1=HOTP 2=TOTP
//   }
// ---------------------------------------------------------------------------
import { fromB64 } from './crypto';
import { base32Encode } from './totp';

export interface MigrationOtp {
  /** 已组装好的 otpauth://totp/... URI(可直接存入 account.totp) */
  otpauth: string;
  /** 展示用：账号名(label 部分) */
  name: string;
  /** 展示用：发行方 */
  issuer: string;
}

/** 读取一个 varint,返回 [值, 新位置]。我们的字段都不大,用 Number 足够。 */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
  }
  throw new Error('迁移码已损坏(varint 越界)');
}

interface Field {
  field: number;
  wire: number;
  varint?: number;
  bytes?: Uint8Array;
}

/** 顺序遍历一段 protobuf 的所有字段。 */
function* walk(buf: Uint8Array, start: number, end: number): Generator<Field> {
  let pos = start;
  while (pos < end) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      yield { field, wire, varint: v };
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      const bytes = buf.subarray(p2, p2 + len);
      pos = p2 + len;
      yield { field, wire, bytes };
    } else if (wire === 5) {
      pos += 4; // 固定 32 位,跳过(我们不需要)
    } else if (wire === 1) {
      pos += 8; // 固定 64 位,跳过
    } else {
      throw new Error('迁移码含不支持的字段类型');
    }
  }
}

const ALGO: Record<number, string> = { 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };

function parseOneOtp(bytes: Uint8Array): MigrationOtp | null {
  let secret: Uint8Array | null = null;
  let name = '';
  let issuer = '';
  let algorithm = 1;
  let digits = 1; // 1=SIX
  let type = 2; // 默认 TOTP
  const dec = new TextDecoder();
  for (const f of walk(bytes, 0, bytes.length)) {
    if (f.field === 1 && f.bytes) secret = f.bytes;
    else if (f.field === 2 && f.bytes) name = dec.decode(f.bytes);
    else if (f.field === 3 && f.bytes) issuer = dec.decode(f.bytes);
    else if (f.field === 4 && f.varint != null) algorithm = f.varint;
    else if (f.field === 5 && f.varint != null) digits = f.varint;
    else if (f.field === 6 && f.varint != null) type = f.varint;
  }
  if (!secret || secret.length === 0) return null;
  if (type !== 2) return null; // 只支持 TOTP(忽略 HOTP)

  const b32 = base32Encode(secret);
  const digitCount = digits === 2 ? 8 : 6;
  const algoName = ALGO[algorithm] ?? 'SHA1';
  const label = issuer ? `${issuer}:${name}` : name || 'TOTP';
  const params = new URLSearchParams({ secret: b32, digits: String(digitCount), period: '30', algorithm: algoName });
  if (issuer) params.set('issuer', issuer);
  return {
    otpauth: `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`,
    name,
    issuer,
  };
}

/** 解析 otpauth-migration:// URI;返回其中的全部 TOTP 项(忽略 HOTP / 损坏项)。 */
export function parseMigrationUri(uri: string): MigrationOtp[] {
  const s = uri.trim();
  if (!s.startsWith('otpauth-migration://')) {
    throw new Error('不是有效的 otpauth-migration:// 迁移码');
  }
  // 不用 URLSearchParams：它会把 base64 里的 '+' 当成空格解码而损坏数据。
  // 改为手动取 data 再 decodeURIComponent(只还原 %xx,保留 '+')。
  const m = s.match(/[?&]data=([^&#]+)/);
  if (!m) throw new Error('迁移码缺少 data 参数');
  let dataParam = m[1]!;
  try {
    dataParam = decodeURIComponent(dataParam);
  } catch {
    /* 已是裸 base64,保持原样 */
  }

  let payload: Uint8Array;
  try {
    payload = fromB64(dataParam);
  } catch {
    throw new Error('迁移码 data 不是有效的 base64');
  }
  const out: MigrationOtp[] = [];
  for (const f of walk(payload, 0, payload.length)) {
    if (f.field === 1 && f.bytes) {
      const otp = parseOneOtp(f.bytes);
      if (otp) out.push(otp);
    }
  }
  if (out.length === 0) throw new Error('迁移码里没有可导入的 TOTP 项');
  return out;
}

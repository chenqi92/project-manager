// ---------------------------------------------------------------------------
// WebAuthn 生物识别（Touch ID / Windows Hello）客户端流程。
// 注意：必须在「页面」上下文（options 页 / 独立标签页）里调用，且要在用户手势中触发；
// 绝不能在工具栏 popup 里跑——系统指纹弹窗会让 popup 关闭从而中断流程。
// RP ID 默认取扩展自身 origin（chrome-extension://<id>），无需网站 / host 权限。
// ---------------------------------------------------------------------------
import { fromB64, toB64 } from './crypto';

const RP_NAME = '项目环境管家';

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const src = fromB64(b64);
  // 拷到独立 ArrayBuffer，满足 WebAuthn 的 BufferSource 类型要求。
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}

function bytesToB64url(b: Uint8Array): string {
  return toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 当前设备是否有可用的「用户验证型平台授权器」（Touch ID / Windows Hello）。 */
export async function isPlatformAuthAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export interface EnrollResult {
  credentialId: string; // base64url
  prfSalt: string; // base64
  prfOutput: Uint8Array; // 32 字节
}

/** 注册一个平台凭据并取得其 PRF 输出（create 仅作启用，secret 由随后的 get 取得）。 */
export async function enrollBiometricCredential(): Promise<EnrollResult> {
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: RP_NAME }, // 省略 rp.id -> 默认用扩展 origin
    user: {
      id: crypto.getRandomValues(new Uint8Array(16)),
      name: 'vault',
      displayName: '本地保险箱',
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
    timeout: 60_000,
    extensions: { prf: {} } as unknown as AuthenticationExtensionsClientInputs,
  };

  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('生物识别注册被取消');

  // 不依据 create() 阶段的 prf.enabled 直接判失败：该标志跨平台/版本并不可靠——
  // Windows Hello 上 Chrome 常返回 enabled:false（甚至更早版本不返回），但实际 get()
  // 阶段能正常产出 PRF。权威判定改为随后的一次真实 get()：能取到 PRF 才算支持。
  const credentialId = bytesToB64url(new Uint8Array(cred.rawId));
  const prfOutput = await evaluatePrf(credentialId, prfSalt);
  return { credentialId, prfSalt: toB64(prfSalt), prfOutput };
}

/** 触发 Touch ID / Windows Hello，返回该 (凭据, 盐) 的 32 字节 PRF 输出。 */
export async function evaluatePrf(
  credentialIdB64url: string,
  prfSalt: Uint8Array,
): Promise<Uint8Array> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: b64urlToBytes(credentialIdB64url) }],
    userVerification: 'required',
    timeout: 60_000,
    extensions: {
      // get() 阶段必须用 evalByCredential（key 为该凭据的 base64url id），不能用 eval：
      // 按规范 eval 仅用于 create()，在 get() 上会被忽略/抛 NotSupportedError，导致
      // results 为空（Windows Hello 上即表现为「未能获得 PRF 输出」）。与解锁路径一致。
      prf: { evalByCredential: { [credentialIdB64url]: { first: prfSalt } } },
    } as unknown as AuthenticationExtensionsClientInputs,
  };

  const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('生物识别验证被取消');

  const ext = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const first = ext.prf?.results?.first;
  if (!first)
    throw new Error(
      '未能获得 PRF 输出：该设备/浏览器不支持 WebAuthn PRF（hmac-secret）。' +
        'Windows 需较新的 Windows Hello 与 Chrome 版本。',
    );
  return new Uint8Array(first);
}

/**
 * 跨多个注册项一次断言：把所有凭据放进 allowCredentials，用 evalByCredential 为
 * 每个凭据提供各自的盐。授权器只会用本机拥有的那个凭据应答，从而一次弹窗即可解锁。
 */
export async function evaluatePrfForAny(
  enrollments: { id: string; credentialId: string; prfSalt: string }[],
): Promise<{ enrollmentId: string; prfOutput: Uint8Array }> {
  const evalByCredential: Record<string, { first: Uint8Array }> = {};
  for (const en of enrollments) {
    evalByCredential[en.credentialId] = { first: fromB64(en.prfSalt) };
  }
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: enrollments.map((en) => ({
      type: 'public-key',
      id: b64urlToBytes(en.credentialId),
    })),
    userVerification: 'required',
    timeout: 60_000,
    extensions: { prf: { evalByCredential } } as unknown as AuthenticationExtensionsClientInputs,
  };

  const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('生物识别验证被取消');

  const usedId = bytesToB64url(new Uint8Array(assertion.rawId));
  const match = enrollments.find((en) => en.credentialId === usedId);
  const ext = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const first = ext.prf?.results?.first;
  if (!match || !first) throw new Error('未能用本设备的生物识别解锁该保险箱');
  return { enrollmentId: match.id, prfOutput: new Uint8Array(first) };
}

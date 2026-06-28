// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSynologyProvider, synologyLogin } from '../lib/sync-providers/synology';
import { SyncProviderError } from '../lib/sync-providers/types';
import type { EncryptedVault, SynologyTarget } from '../lib/types';

const target: SynologyTarget = {
  id: 's',
  type: 'synology',
  label: 'nas',
  enabled: true,
  baseUrl: 'https://nas.example.com:5001',
  account: 'me',
  password: 'pw',
  did: 'DEV123',
  filePath: '/home/vault.enc',
};

const vault = { version: 1, vaultId: 'vid-群晖', data: { iv: 'a', ct: '密' } } as unknown as EncryptedVault;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

describe('synologyLogin', () => {
  it('带 OTP 登录返回 sid 与 did', async () => {
    let body = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return json({ success: true, data: { sid: 'SID1', did: 'NEWDID' } });
      }),
    );
    const r = await synologyLogin(target.baseUrl, { account: 'me', password: 'pw', otpCode: '123456' });
    expect(r).toEqual({ sid: 'SID1', did: 'NEWDID' });
    // 绑定时带上 otp_code 与 enable_device_token
    expect(body).toContain('otp_code=123456');
    expect(body).toContain('enable_device_token=yes');
    expect(body).toContain('version=6');
  });

  it('缺 OTP 时 403 映射为 otp_required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: false, error: { code: 403 } })));
    await expect(synologyLogin(target.baseUrl, { account: 'me', password: 'pw' })).rejects.toMatchObject({
      code: 'otp_required',
    });
  });

  it('OTP 错误时 404 映射为 auth 错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: false, error: { code: 404 } })));
    await expect(
      synologyLogin(target.baseUrl, { account: 'me', password: 'pw', otpCode: '000000' }),
    ).rejects.toBeInstanceOf(SyncProviderError);
  });

  it('静默登录用 device_id=<did> 且不带 otp', async () => {
    let body = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return json({ success: true, data: { sid: 'SID2' } });
      }),
    );
    await synologyLogin(target.baseUrl, { account: 'me', password: 'pw', deviceId: 'DEV123' });
    expect(body).toContain('device_id=DEV123');
    expect(body).not.toContain('otp_code');
  });
});

describe('SynologyProvider', () => {
  // 路由 DSM entry.cgi 的各 API 调用。
  function router(handlers: {
    login?: () => Response;
    getinfo?: () => Response;
    download?: () => Response;
    upload?: () => Response;
  }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('SYNO.API.Auth')) {
        return (handlers.login ?? (() => json({ success: true, data: { sid: 'SID' } })))();
      }
      if (url.includes('SYNO.FileStation.List')) return handlers.getinfo!();
      if (url.includes('SYNO.FileStation.Download')) return handlers.download!();
      // upload 是 POST FormData 到 entry.cgi?_sid=
      if (init?.method === 'POST') return (handlers.upload ?? (() => json({ success: true })))();
      throw new Error('unexpected ' + url);
    });
  }

  it('pull：getinfo 取 mtime+size 作 tag，download 取密文', async () => {
    vi.stubGlobal(
      'fetch',
      router({
        getinfo: () => json({ success: true, data: { files: [{ additional: { size: 42, time: { mtime: 1700 } } }] } }),
        download: () => new Response(JSON.stringify(vault), { status: 200 }),
      }),
    );
    const snap = await createSynologyProvider(target).pull();
    expect(snap?.tag).toBe('1700-42');
    expect(snap?.vault.vaultId).toBe('vid-群晖');
  });

  it('pull：文件不存在（getinfo success:false）返回 null', async () => {
    vi.stubGlobal('fetch', router({ getinfo: () => json({ success: false, error: { code: 408 } }) }));
    expect(await createSynologyProvider(target).pull()).toBeNull();
  });

  it('push：tag 与远端一致则上传并回新 tag', async () => {
    let infoCalls = 0;
    vi.stubGlobal(
      'fetch',
      router({
        getinfo: () => {
          infoCalls++;
          // 第一次（push 前校验）返回旧 tag；第二次（上传后）返回新 tag
          const mtime = infoCalls === 1 ? 1700 : 1800;
          return json({ success: true, data: { files: [{ additional: { size: 42, time: { mtime } } }] } });
        },
        upload: () => json({ success: true }),
      }),
    );
    const res = await createSynologyProvider(target).push(vault, '1700-42');
    expect(res).toEqual({ ok: true, tag: '1800-42' });
  });

  it('push：expectedTag 与远端不一致则冲突回拉', async () => {
    vi.stubGlobal(
      'fetch',
      router({
        getinfo: () => json({ success: true, data: { files: [{ additional: { size: 42, time: { mtime: 9999 } } }] } }),
        download: () => new Response(JSON.stringify(vault), { status: 200 }),
      }),
    );
    const res = await createSynologyProvider(target).push(vault, '1700-42');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.current?.tag).toBe('9999-42');
  });

  it('未绑定 did 的 2FA 账户 pull 时抛 otp_required', async () => {
    const t2 = { ...target, did: '' };
    vi.stubGlobal('fetch', router({ login: () => json({ success: false, error: { code: 403 } }) }));
    await expect(createSynologyProvider(t2).pull()).rejects.toMatchObject({ code: 'otp_required' });
  });
});

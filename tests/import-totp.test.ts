// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseImport } from '../lib/import-export';
import type { VaultData } from '../lib/types';

const SECRET = 'JBSWY3DPEHPK3PXP';
const acc = (d: VaultData) => d.projects[0]!.environments[0]!.links[0]!.accounts[0]!;

describe('导入带 TOTP', () => {
  it('本扩展 CSV 的 totp 列', async () => {
    const csv = [
      'project,environment,env_kind,link,url,account_label,username,password,totp,note',
      `P,Dev,dev,Admin,https://a.com,管理员,admin,pw,${SECRET},备注`,
    ].join('\n');
    const data = await parseImport('csv', csv);
    expect(acc(data).totp).toBe(SECRET);
    expect(acc(data).password).toBe('pw');
  });

  it('Bitwarden CSV 的 login_totp 列', async () => {
    const csv = [
      'folder,favorite,type,name,notes,login_uri,login_username,login_password,login_totp',
      `Work,,login,Acme,,https://acme.com,alice,secret,${SECRET}`,
    ].join('\n');
    const data = await parseImport('bitwarden-csv', csv);
    expect(acc(data).totp).toBe(SECRET);
    expect(acc(data).username).toBe('alice');
  });

  it('1Password CSV 的 otpauth 列', async () => {
    const csv = [
      'title,url,username,password,otpauth,notes',
      `Acme,https://acme.com,alice,pw,otpauth://totp/Acme:alice?secret=${SECRET}&period=30&digits=6,hi`,
    ].join('\n');
    const data = await parseImport('1password-csv', csv);
    const totp = acc(data).totp ?? '';
    expect(totp).toContain('otpauth://');
    expect(totp).toContain(SECRET);
  });
});

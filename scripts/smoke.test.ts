// 加密内核 + 导入导出的运行时冒烟测试（纯逻辑，不依赖浏览器 API）。
// 运行：npx esbuild scripts/smoke.test.ts --bundle --platform=node --format=esm --outfile=.smoke.mjs && node .smoke.mjs
import {
  createEncryptedVault,
  decryptVaultData,
  emptyVaultData,
  enrollBiometric,
  reencryptData,
  rewrapDEK,
  unwrapDEK,
  unwrapDEKWithPrf,
} from '../lib/vault-core';
import { buildExport, mergeVaults, parseImport } from '../lib/import-export';
import { newAccount, newEnvironment, newLink, newProject } from '../lib/vault-ops';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

async function run() {
  const data = emptyVaultData();
  const p = newProject({ name: '电商' });
  const e = newEnvironment({ name: '生产', kind: 'prod' });
  const l = newLink({ name: '后台', url: 'https://admin.example.com/login' });
  l.accounts.push(newAccount({ label: '管理员', username: 'admin', password: 'p@ss1' }));
  l.accounts.push(newAccount({ label: '测试', username: 'tester', password: 'p@ss2' }));
  e.links.push(l);
  p.environments.push(e);
  data.projects.push(p);

  // 1. 创建 + 解锁往返
  const { encrypted, dek } = await createEncryptedVault(data, 'masterpw123');
  const dek2 = await unwrapDEK(encrypted, 'masterpw123');
  const decrypted = await decryptVaultData(encrypted, dek2);
  assert(
    decrypted.projects[0]!.environments[0]!.links[0]!.accounts[1]!.password === 'p@ss2',
    '加解密往返',
  );

  // 2. 错误主密码必须抛错
  let threw = false;
  try {
    await unwrapDEK(encrypted, 'wrong');
  } catch {
    threw = true;
  }
  assert(threw, '错误密码应被拒绝');

  // 3. 保存(重新加密) + revision 递增
  decrypted.projects[0]!.name = '电商改';
  const enc2 = await reencryptData(encrypted, decrypted, dek);
  const d2 = await decryptVaultData(enc2, dek);
  assert(d2.projects[0]!.name === '电商改', '重新加密往返');
  assert(enc2.revision === encrypted.revision + 1, 'revision 递增');

  // 4. 改主密码：旧密码失效、新密码可解
  const enc3 = await rewrapDEK(enc2, dek, 'newmaster999');
  const dek3 = await unwrapDEK(enc3, 'newmaster999');
  const d3 = await decryptVaultData(enc3, dek3);
  assert(d3.projects[0]!.name === '电商改', '改密后仍可解密');
  let threw2 = false;
  try {
    await unwrapDEK(enc3, 'masterpw123');
  } catch {
    threw2 = true;
  }
  assert(threw2, '改密后旧密码失效');

  // 5. 加密备份导出 -> 导入
  const exp = await buildExport(d3, 'encrypted', 'backuppw');
  const importedEnc = await parseImport('encrypted', exp.content, 'backuppw');
  assert(
    importedEnc.projects[0]!.environments[0]!.links[0]!.accounts.length === 2,
    '加密备份导出/导入',
  );

  // 6. CSV 导出 -> 导入合并计数
  const csv = await buildExport(d3, 'csv');
  const fromCsv = await parseImport('csv', csv.content);
  const merged = mergeVaults(emptyVaultData(), fromCsv, 'merge');
  assert(merged.imported === 2, 'CSV 导入计数=2，实际 ' + merged.imported);

  // 7. 重复导入应去重(新增 0)
  const merged2 = mergeVaults(merged.data, fromCsv, 'merge');
  assert(merged2.imported === 0, '二次合并去重，实际 ' + merged2.imported);

  // 8. Chrome 密码 CSV 迁移
  const chromeCsv =
    'name,url,username,password,note\nGitHub,https://github.com/login,me,secret,我的备注';
  const fromChrome = await parseImport('chrome-csv', chromeCsv);
  assert(
    fromChrome.projects[0]!.environments[0]!.links[0]!.accounts[0]!.password === 'secret',
    'Chrome CSV 迁移',
  );

  // 9. 生物识别：用模拟的 PRF 输出注册并解锁同一个 DEK
  const prfOut = new Uint8Array(32).fill(7);
  const encBio = await enrollBiometric(enc3, dek, {
    label: 'Mac',
    credentialId: 'cred1',
    prfSalt: 'c2FsdA==',
    prfOutput: prfOut,
  });
  const bioId = encBio.bioEnrollments![0]!.id;
  const dekViaBio = await unwrapDEKWithPrf(encBio, bioId, prfOut);
  const dViaBio = await decryptVaultData(encBio, dekViaBio);
  assert(dViaBio.projects[0]!.name === '电商改', '生物识别解锁往返');

  let threwBio = false;
  try {
    await unwrapDEKWithPrf(encBio, bioId, new Uint8Array(32).fill(9));
  } catch {
    threwBio = true;
  }
  assert(threwBio, '错误 PRF 应被拒绝');

  console.log('✅ ALL SMOKE TESTS PASSED');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

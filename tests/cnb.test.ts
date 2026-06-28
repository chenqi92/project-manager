import { describe, expect, it } from 'vitest';
import { buildRepoTree, cnbCloneCommand, cnbCloneUrl, type CnbRepo } from '@/lib/cnb';

function repo(path: string, lastUpdatedAt = 0): CnbRepo {
  return { id: path, name: path.split('/').pop()!, path, lastUpdatedAt };
}

describe('buildRepoTree', () => {
  const repos = [
    repo('njly2013/Shuibao/shiyanshishuizhibaozhang/backservice', 100),
    repo('njly2013/Zhifa/funinggonganqianduan/funing-app', 90),
    repo('njly2013/BasicSoftware/lianyunwurenjipingtai/uav-frustum-projection-analysis', 80),
    repo('njly2013/BasicSoftware/lianyunwurenjipingtai/pingtu-software', 70),
    repo('njly2013/SubOnly/repo-x', 60), // org/子组织/仓库（无项目层）
    repo('njly2013/direct-repo', 50), // org/仓库（直属）
  ];

  it('按子组织 → 项目 → 仓库 还原层级', () => {
    const tree = buildRepoTree('njly2013', repos);
    const byKey = Object.fromEntries(tree.map((g) => [g.key, g]));

    // 子组织分组存在
    expect(byKey.Shuibao).toBeTruthy();
    expect(byKey.BasicSoftware).toBeTruthy();
    expect(byKey.SubOnly).toBeTruthy();

    // BasicSoftware 下有一个项目，含两个仓库
    const bs = byKey.BasicSoftware!;
    expect(bs.repoCount).toBe(2);
    expect(bs.projects).toHaveLength(1);
    expect(bs.projects[0]!.name).toBe('lianyunwurenjipingtai');
    expect(bs.projects[0]!.repos.map((r) => r.name).sort()).toEqual([
      'pingtu-software',
      'uav-frustum-projection-analysis',
    ]);
  });

  it('无项目层的仓库归到「直属仓库」项目', () => {
    const tree = buildRepoTree('njly2013', repos);
    const subOnly = tree.find((g) => g.key === 'SubOnly')!;
    expect(subOnly.projects[0]!.name).toBe('（直属仓库）');
  });

  it('org 直属仓库归到根分组，且排在最后', () => {
    const tree = buildRepoTree('njly2013', repos);
    const last = tree[tree.length - 1]!;
    expect(last.key).toBe('__root__');
    expect(last.name).toBe('（直属仓库）');
    expect(last.projects[0]!.repos.map((r) => r.name)).toContain('direct-repo');
  });

  it('非根分组按仓库数倒序', () => {
    const tree = buildRepoTree('njly2013', repos);
    expect(tree[0]!.key).toBe('BasicSoftware'); // 2 个仓库，最多
  });

  it('项目内仓库按最近更新倒序', () => {
    const tree = buildRepoTree('njly2013', repos);
    const bs = tree.find((g) => g.key === 'BasicSoftware')!;
    const order = bs.projects[0]!.repos.map((r) => r.lastUpdatedAt);
    expect(order).toEqual([80, 70]);
  });
});

describe('clone 地址', () => {
  it('clone url 用 cnb.cool 站点根 + .git', () => {
    expect(cnbCloneUrl(repo('a/b/c'))).toBe('https://cnb.cool/a/b/c.git');
    expect(cnbCloneCommand(repo('a/b/c'))).toBe('git clone https://cnb.cool/a/b/c.git');
  });
});

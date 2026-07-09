import { describe, expect, it } from 'vitest';
import { siteNameFromTitle } from '@/lib/site-name';

describe('siteNameFromTitle', () => {
  it('去掉「首页」等通用段，取站点名', () => {
    expect(siteNameFromTitle('首页 - 5G移巡天穹')).toBe('5G移巡天穹');
    expect(siteNameFromTitle('5G移巡天穹 - 首页')).toBe('5G移巡天穹');
    expect(siteNameFromTitle('登录 - 运维管理平台')).toBe('运维管理平台');
  });

  it('中文紧邻的连字符即使没有空格也算分隔', () => {
    expect(siteNameFromTitle('登录-XX平台')).toBe('XX平台');
    expect(siteNameFromTitle('XX平台-用户登录')).toBe('XX平台');
  });

  it('英文站点名里的连字符不拆', () => {
    expect(siteNameFromTitle('K3s-Dashboard')).toBe('K3s-Dashboard');
  });

  it('竖线 / 间隔号分隔', () => {
    expect(siteNameFromTitle('Sign in · GitLab')).toBe('GitLab');
    expect(siteNameFromTitle('控制台 | 阿里云')).toBe('阿里云');
  });

  it('多个有效段取最长', () => {
    expect(siteNameFromTitle('订单管理 - XX商城运营后台')).toBe('XX商城运营后台');
  });

  it('无标题或全部为通用词时返回 undefined', () => {
    expect(siteNameFromTitle(undefined)).toBeUndefined();
    expect(siteNameFromTitle('')).toBeUndefined();
    expect(siteNameFromTitle('登录')).toBeUndefined();
    expect(siteNameFromTitle('Sign in')).toBeUndefined();
    expect(siteNameFromTitle('首页 - 登录')).toBeUndefined();
  });

  it('整段标题就是站点名时原样保留', () => {
    expect(siteNameFromTitle('GitLab')).toBe('GitLab');
    expect(siteNameFromTitle('XX科技有限公司统一门户')).toBe('XX科技有限公司统一门户');
  });
});

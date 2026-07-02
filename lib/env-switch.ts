// ---------------------------------------------------------------------------
// 环境快速切换：在某环境的页面上，找到同项目其它环境里「同名链接」，
// 保留当前路径，构造跳转到对应环境的 URL。
// 例：dev 的 https://admin-dev.x.com/orders/9 -> prod 的 https://admin.x.com/orders/9
// ---------------------------------------------------------------------------
import { getOrigin, linkMatchesUrl } from './autofill';
import type { VaultData } from './types';
import { envTagName, linkUrls } from './vault-ops';

export interface EnvTarget {
  envId: string;
  envName: string;
  envKind: string;
  linkId: string;
  targetUrl: string;
}

export interface EnvSwitch {
  projectName: string;
  currentEnvName: string;
  linkName: string;
  targets: EnvTarget[];
}

export function envSwitchTargets(data: VaultData, currentUrl: string): EnvSwitch | null {
  const pageOrigin = getOrigin(currentUrl);
  if (!pageOrigin) return null;

  let path = '/';
  try {
    const u = new URL(currentUrl);
    path = u.pathname + u.search;
  } catch {
    return null;
  }

  for (const project of data.projects) {
    for (const env of project.environments) {
      for (const link of env.links) {
        if (!linkMatchesUrl(link, currentUrl)) continue;

        const targets: EnvTarget[] = [];
        for (const other of project.environments) {
          if (other.id === env.id) continue;
          const sibling = other.links.find((l) => l.name === link.name && l.url);
          if (!sibling) continue;
          const base = getOrigin(sibling.url);
          if (base) {
            const envKind = sibling.envKind ?? other.kind;
            targets.push({
              envId: other.id,
              envName: envTagName(envKind, sibling.envName ?? other.name),
              envKind,
              linkId: sibling.id,
              targetUrl: base + path,
            });
          }
        }
        if (targets.length) {
          const currentEnvKind = link.envKind ?? env.kind;
          return {
            projectName: project.name,
            currentEnvName: envTagName(currentEnvKind, link.envName ?? env.name),
            linkName: link.name,
            targets,
          };
        }
      }
    }
  }
  return null;
}

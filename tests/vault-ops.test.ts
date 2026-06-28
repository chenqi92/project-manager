// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gitCloneCommand, newGitRepo } from '../lib/vault-ops';

describe('gitCloneCommand', () => {
  it('无分支：git clone -- <url>', () => {
    const r = newGitRepo({ url: 'https://git.example.com/g/r.git' });
    expect(gitCloneCommand(r)).toBe("git clone -- 'https://git.example.com/g/r.git'");
  });

  it('有分支：git clone -b <branch> -- <url>', () => {
    const r = newGitRepo({ url: 'git@host:g/r.git', branch: 'develop' });
    expect(gitCloneCommand(r)).toBe("git clone -b 'develop' -- 'git@host:g/r.git'");
  });

  it('转义分支和 URL，避免复制命令时注入额外 shell 片段', () => {
    const r = newGitRepo({
      url: "https://git.example.com/o'repo.git; rm -rf ~",
      branch: "main\n$(touch pwn)",
    });

    expect(gitCloneCommand(r)).toBe(
      "git clone -b 'main $(touch pwn)' -- 'https://git.example.com/o'\\''repo.git; rm -rf ~'",
    );
  });
});

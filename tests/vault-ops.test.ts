// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gitCloneCommand, newGitRepo } from '../lib/vault-ops';

describe('gitCloneCommand', () => {
  it('无分支：git clone <url>', () => {
    const r = newGitRepo({ url: 'https://git.example.com/g/r.git' });
    expect(gitCloneCommand(r)).toBe('git clone https://git.example.com/g/r.git');
  });

  it('有分支：git clone -b <branch> <url>', () => {
    const r = newGitRepo({ url: 'git@host:g/r.git', branch: 'develop' });
    expect(gitCloneCommand(r)).toBe('git clone -b develop git@host:g/r.git');
  });
});

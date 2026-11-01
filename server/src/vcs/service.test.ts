import { describe, expect, it } from 'vitest';
import { VcsService } from './service.js';

const fakeGit = (url: string) => ({ remotes: async () => [{ name: 'origin', url }] }) as any;

describe('VcsService.target', () => {
  it('parses github https / ssh / git@ remotes', async () => {
    expect(await new VcsService(fakeGit('https://github.com/PGshen/claude-web.git')).target('x')).toEqual({ provider: 'github', host: 'github.com', owner: 'PGshen', repo: 'claude-web' });
    expect(await new VcsService(fakeGit('git@github.com:owner/repo.git')).target('x')).toEqual({ provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' });
    expect(await new VcsService(fakeGit('ssh://git@github.com:22/owner/repo')).target('x')).toEqual({ provider: 'github', host: 'github.com', owner: 'owner', repo: 'repo' });
    expect(await new VcsService(fakeGit('https://user@ghe.corp.com/team/tool')).target('x')).toEqual({ provider: 'github', host: 'ghe.corp.com', owner: 'team', repo: 'tool' });
  });
  it('parses gitlab remotes incl. nested groups', async () => {
    expect(await new VcsService(fakeGit('git@gitlab.com:group/sub/project.git')).target('x')).toEqual({ provider: 'gitlab', host: 'gitlab.com', owner: 'group/sub', repo: 'project' });
    expect(await new VcsService(fakeGit('https://gitlab.example.com/a/b/c/d.git')).target('x')).toEqual({ provider: 'gitlab', host: 'gitlab.example.com', owner: 'a/b/c', repo: 'd' });
  });
  it('accepts explicit owner/repo[@host] and urls', async () => {
    const s = new VcsService(fakeGit(''));
    expect(await s.target('x', 'anthropics/claude-code')).toEqual({ provider: 'github', host: 'github.com', owner: 'anthropics', repo: 'claude-code' });
    expect(await s.target('x', 'https://gitlab.com/gitlab-org/gitlab')).toEqual({ provider: 'gitlab', host: 'gitlab.com', owner: 'gitlab-org', repo: 'gitlab' });
    expect(await s.target('x', 'team/tool@ghe.corp.com')).toEqual({ provider: 'github', host: 'ghe.corp.com', owner: 'team', repo: 'tool' });
    await expect(s.target('x', 'nonsense')).rejects.toThrow();
  });
  it('errors without a remote', async () => {
    await expect(new VcsService({ remotes: async () => [] } as any).target('x')).rejects.toThrow('没有 git remote');
  });
});

describe('VcsService.target with vcs.gitlabHosts', () => {
  it('a self-hosted GitLab named in vcs.gitlabHosts is GitLab', async () => {
    const v = new VcsService({} as any, { gitlabHosts: () => ['git.corp.example'] });
    expect((await v.target('', 'https://git.corp.example/acme/app')).provider).toBe('gitlab');
    expect((await v.target('', 'https://ghe.corp/acme/app')).provider).toBe('github');
  });
});

describe('VcsService token lookup (fix E-I1)', () => {
  const store = (m: Record<string, string>) => ({ get: async (h: string) => m[h] ?? '', hosts: () => Object.keys(m) }) as any;
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const old: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  };
  it('a token saved for the host beats the environment', async () => {
    await withEnv({ GH_TOKEN: 'env-gh', GITLAB_TOKEN: 'env-gl', CW_FAKE_FORGE_FILE: undefined }, async () => {
      const v = new VcsService({} as any, { tokens: store({ 'github.com': 'saved-gh', 'gitlab.com': 'saved-gl' }) });
      expect(await (v as any).lookupToken({ provider: 'github', host: 'github.com', owner: 'o', repo: 'r' })).toBe('saved-gh');
      expect(await (v as any).lookupToken({ provider: 'gitlab', host: 'gitlab.com', owner: 'o', repo: 'r' })).toBe('saved-gl');
    });
  });
  it('GITLAB_TOKEN never goes to a host that only has gitlab in its name', async () => {
    await withEnv({ GITLAB_TOKEN: 'env-gl', GITLAB_HOST: undefined, CW_FAKE_FORGE_FILE: undefined }, async () => {
      const v = new VcsService({} as any, { tokens: store({}) });
      (v as any).glabReady = async () => false;
      expect(await (v as any).lookupToken({ provider: 'gitlab', host: 'gitlab.evil.example', owner: 'o', repo: 'r' })).toBe('');
      expect(await (v as any).lookupToken({ provider: 'gitlab', host: 'gitlab.com', owner: 'o', repo: 'r' })).toBe('env-gl');
    });
  });
});

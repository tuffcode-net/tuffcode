import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectThread,
  createTestContext,
  git,
  initBareRepo,
  initRepo,
  type ProjectThread,
  type TestContext,
} from '../test-support.js';
import { commitThread, pushThread } from './commit.js';
import { assertGitHubCli, parsePullRequestUrl, preparePullRequest } from './pr.js';

describe('git commit and push', () => {
  let ctx: TestContext;
  let setup: ProjectThread;
  let worktree: string;
  let readme: string;

  beforeEach(async () => {
    ctx = createTestContext();
    setup = await createProjectThread(ctx.repos, initRepo(join(ctx.env.root, 'commit-repo')));
    worktree = setup.thread.worktreePath ?? '';
    readme = join(worktree, 'README.md');
  });

  afterEach(() => {
    ctx.dispose();
  });

  it('commits on the thread branch and refuses an empty commit', async () => {
    writeFileSync(readme, '# demo\ncommitted\n');
    const result = await commitThread(ctx.repos, setup.thread.id, 'change readme');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(worktree, ['log', '-1', '--format=%s'])).toBe('change readme');
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(result.sha);

    await expect(commitThread(ctx.repos, setup.thread.id, 'again')).rejects.toThrow(
      'nothing to commit',
    );
  });

  it('refuses to commit on main', async () => {
    const now = new Date().toISOString();
    ctx.repos.threads.create({
      id: 'thr_main',
      projectId: setup.project.id,
      parentThreadId: null,
      title: 'Main checkout',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: setup.project.path,
      branch: 'main',
      baseBranch: 'main',
      createdAt: now,
      updatedAt: now,
    });
    writeFileSync(join(setup.project.path, 'README.md'), '# demo\nmain edit\n');
    await expect(commitThread(ctx.repos, 'thr_main', 'nope')).rejects.toThrow(
      'commits are not allowed on main',
    );
  });

  it('pushes the thread branch to origin', async () => {
    const bare = initBareRepo(join(ctx.env.root, 'remote.git'));
    git(setup.project.path, ['remote', 'add', 'origin', bare]);
    writeFileSync(readme, '# demo\npush me\n');
    const { sha } = await commitThread(ctx.repos, setup.thread.id, 'push me');

    const pushed = await pushThread(ctx.repos, setup.thread.id);
    expect(pushed.remote).toBe('origin');
    expect(pushed.branch).toBe(`tuffcode/${setup.thread.id}`);
    expect(git(bare, ['rev-parse', `refs/heads/${pushed.branch}`])).toBe(sha);
  });

  it('commits and pushes leftover work before a pull request', async () => {
    const bare = initBareRepo(join(ctx.env.root, 'pr-remote.git'));
    git(setup.project.path, ['remote', 'add', 'origin', bare]);
    writeFileSync(readme, '# demo\npr work\n');

    await preparePullRequest(ctx.repos, setup.thread.id, 'Ship the widget');

    expect(git(worktree, ['log', '-1', '--format=%s'])).toBe('Changes from Ship the widget');
    const head = git(worktree, ['rev-parse', 'HEAD']);
    expect(git(bare, ['rev-parse', `refs/heads/tuffcode/${setup.thread.id}`])).toBe(head);
  });

  it('pushes an already committed branch without making another commit', async () => {
    const bare = initBareRepo(join(ctx.env.root, 'pr-remote-2.git'));
    git(setup.project.path, ['remote', 'add', 'origin', bare]);
    writeFileSync(readme, '# demo\nalready committed\n');
    const { sha } = await commitThread(ctx.repos, setup.thread.id, 'worker commit');

    await preparePullRequest(ctx.repos, setup.thread.id, 'Ship the widget');

    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(sha);
    expect(git(bare, ['rev-parse', `refs/heads/tuffcode/${setup.thread.id}`])).toBe(sha);
  });

  it('refuses to prepare a pull request on a protected branch', async () => {
    const now = new Date().toISOString();
    ctx.repos.threads.create({
      id: 'thr_main_pr',
      projectId: setup.project.id,
      parentThreadId: null,
      title: 'Main checkout',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: setup.project.path,
      branch: 'main',
      baseBranch: 'main',
      createdAt: now,
      updatedAt: now,
    });
    writeFileSync(join(setup.project.path, 'README.md'), '# demo\nmain pr edit\n');

    await expect(preparePullRequest(ctx.repos, 'thr_main_pr', 'Ship it')).rejects.toThrow(
      'commits are not allowed on main',
    );
  });

  it('parses the pull request URL from gh output', () => {
    const output = [
      'Creating pull request for tuffcode/thr_1 into main in owner/repo',
      '',
      'https://github.com/owner/repo/pull/42',
    ].join('\n');
    expect(parsePullRequestUrl(output)).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      number: 42,
    });
    expect(parsePullRequestUrl('no pull request here')).toBeNull();
  });

  it('reports the fatal line when the repository has no origin', async () => {
    const error = await pushThread(ctx.repos, setup.thread.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("fatal: 'origin' does not appear to be a git repository");
    expect(message).not.toContain('and the repository exists.');
  });

  it('reports the rejected ref, not a hint line, when the remote moved ahead', async () => {
    const bare = initBareRepo(join(ctx.env.root, 'reject-remote.git'));
    git(setup.project.path, ['remote', 'add', 'origin', bare]);
    writeFileSync(readme, '# demo\nfirst\n');
    await commitThread(ctx.repos, setup.thread.id, 'first');
    const pushed = await pushThread(ctx.repos, setup.thread.id);

    const ahead = join(ctx.env.root, 'ahead-clone');
    git(ctx.env.root, ['clone', bare, ahead]);
    git(ahead, ['config', 'user.email', 'ahead@example.com']);
    git(ahead, ['config', 'user.name', 'Ahead']);
    git(ahead, ['checkout', pushed.branch]);
    writeFileSync(join(ahead, 'ahead.txt'), 'ahead\n');
    git(ahead, ['add', '-A']);
    git(ahead, ['commit', '-m', 'ahead']);
    git(ahead, ['push', 'origin', pushed.branch]);

    writeFileSync(readme, '# demo\nsecond\n');
    await commitThread(ctx.repos, setup.thread.id, 'second');
    const error = await pushThread(ctx.repos, setup.thread.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('! [rejected]');
    expect(message).toContain('fetch first');
    expect(message).not.toContain('hint:');
  });

  it('reports a missing gh before a pull request can push', async () => {
    const bare = initBareRepo(join(ctx.env.root, 'gh-remote.git'));
    git(setup.project.path, ['remote', 'add', 'origin', bare]);
    writeFileSync(readme, '# demo\nnot pushed yet\n');
    const emptyBin = join(ctx.env.root, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
    const previousPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await expect(assertGitHubCli(ctx.repos, setup.thread.id)).rejects.toThrow(
        'GitHub CLI (gh) not found',
      );
    } finally {
      process.env.PATH = previousPath;
    }
    // Nothing left the machine: the work is still uncommitted.
    expect(git(worktree, ['status', '--porcelain'])).toContain('README.md');
    expect(git(bare, ['for-each-ref'])).toBe('');
  });
});

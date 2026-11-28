import { writeFileSync } from 'node:fs';
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
import { parsePullRequestUrl } from './pr.js';

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
});

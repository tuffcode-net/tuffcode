import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, git, initRepo, type TestContext } from './test-support.js';

describe('initRepo', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.dispose();
  });

  it('creates a repository with one commit on main and a local identity', () => {
    const repo = initRepo(join(ctx.env.root, 'fixture'));

    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(repo, ['log', '--format=%s', '-1'])).toBe('init');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['config', 'user.email'])).toBe('tuffcode@example.com');
    expect(git(repo, ['config', 'user.name'])).toBe('Tuffcode Test');
    expect(git(repo, ['config', 'commit.gpgsign'])).toBe('false');
    expect(git(repo, ['config', 'core.autocrlf'])).toBe('false');
  });

  it('honours a non-default branch name', () => {
    const repo = initRepo(join(ctx.env.root, 'trunk-repo'), 'trunk');

    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('trunk');
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('gives every call an independent copy', () => {
    const first = initRepo(join(ctx.env.root, 'first'));
    const second = initRepo(join(ctx.env.root, 'second'));

    writeFileSync(join(first, 'only-first.txt'), 'x');
    git(first, ['add', '-A']);
    git(first, ['commit', '-m', 'first only']);

    expect(git(first, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(git(second, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(existsSync(join(second, 'only-first.txt'))).toBe(false);
    expect(git(second, ['status', '--porcelain'])).toBe('');
  });

  it('supports a branch and a worktree, which the thread tests rely on', () => {
    const repo = initRepo(join(ctx.env.root, 'worktree-repo'));
    const worktree = join(ctx.env.root, 'worktree');

    git(repo, ['worktree', 'add', '-b', 'tuffcode/one', worktree]);

    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('tuffcode/one');
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain('tuffcode/one');
  });
});

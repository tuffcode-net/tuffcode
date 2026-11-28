import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProjectThread,
  createTestContext,
  initRepo,
  type ProjectThread,
  type TestContext,
} from '../test-support.js';
import { createCheckpoint } from './checkpoints.js';
import { getDiff } from './diff.js';

describe('git diff', () => {
  let ctx: TestContext;
  let setup: ProjectThread;
  let worktree: string;
  let readme: string;

  beforeEach(async () => {
    ctx = createTestContext();
    setup = await createProjectThread(ctx.repos, initRepo(join(ctx.env.root, 'diff-repo')));
    worktree = setup.thread.worktreePath ?? '';
    readme = join(worktree, 'README.md');
  });

  afterEach(() => {
    ctx.dispose();
  });

  it('reports modified tracked files and untracked files', async () => {
    writeFileSync(readme, '# demo\nsecond line\n');
    writeFileSync(join(worktree, 'notes.txt'), 'hello\nworld\n');

    const files = await getDiff(ctx.repos, setup.thread.id);
    const modified = files.find((file) => file.path === 'README.md');
    expect(modified?.status).toBe('modified');
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(0);
    expect(modified?.binary).toBe(false);
    expect(modified?.patch).toContain('+second line');

    const untracked = files.find((file) => file.path === 'notes.txt');
    expect(untracked?.status).toBe('untracked');
    expect(untracked?.additions).toBe(2);
    expect(untracked?.patch).toContain('+hello');
    expect(untracked?.patch).toContain('+world');
  });

  it('scopes the diff to a checkpoint baseline', async () => {
    writeFileSync(readme, '# demo\nsecond line\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'after first edit');
    writeFileSync(readme, '# demo\nsecond line\nthird line\n');

    const scoped = await getDiff(ctx.repos, setup.thread.id, checkpoint.id);
    const readmeDiff = scoped.find((file) => file.path === 'README.md');
    expect(readmeDiff?.additions).toBe(1);
    expect(readmeDiff?.patch).toContain('+third line');
    expect(readmeDiff?.patch).not.toContain('+second line');
  });

  it('is empty right after a checkpoint captured an untracked file', async () => {
    writeFileSync(readme, '# demo\nsecond line\n');
    writeFileSync(join(worktree, 'added.txt'), 'captured\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'captures added.txt');

    const scoped = await getDiff(ctx.repos, setup.thread.id, checkpoint.id);
    expect(scoped).toEqual([]);
  });

  it('reports a captured untracked file as modified once it changes', async () => {
    writeFileSync(join(worktree, 'added.txt'), 'captured\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'captures added.txt');
    writeFileSync(join(worktree, 'added.txt'), 'captured\nmore\n');

    const scoped = await getDiff(ctx.repos, setup.thread.id, checkpoint.id);
    const changed = scoped.find((file) => file.path === 'added.txt');
    expect(changed?.status).toBe('modified');
    expect(changed?.additions).toBe(1);
    expect(changed?.patch).toContain('+more');
  });

  it('still lists files created after the checkpoint as untracked', async () => {
    writeFileSync(join(worktree, 'added.txt'), 'captured\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'captures added.txt');
    writeFileSync(join(worktree, 'later.txt'), 'later\n');

    const scoped = await getDiff(ctx.repos, setup.thread.id, checkpoint.id);
    expect(scoped.map((file) => [file.path, file.status])).toEqual([['later.txt', 'untracked']]);
  });

  it('reports deletions and binary files', async () => {
    rmSync(readme);
    writeFileSync(join(worktree, 'image.bin'), Buffer.from([0, 1, 2, 3, 0]));

    const files = await getDiff(ctx.repos, setup.thread.id);
    const deleted = files.find((file) => file.path === 'README.md');
    expect(deleted?.status).toBe('deleted');
    expect(deleted?.deletions).toBe(1);
    expect(deleted?.patch).toContain('-# demo');

    const binary = files.find((file) => file.path === 'image.bin');
    expect(binary?.status).toBe('untracked');
    expect(binary?.binary).toBe(true);
    expect(binary?.patch).toBeNull();
  });

  it('rejects a checkpoint that belongs to another thread', async () => {
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'mine');
    const other = await createProjectThread(ctx.repos, initRepo(join(ctx.env.root, 'other')));
    await expect(getDiff(ctx.repos, other.thread.id, checkpoint.id)).rejects.toThrow(
      'checkpoint not found',
    );
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProject } from '../projects.js';
import {
  createProjectThread,
  createTestContext,
  git,
  initRepo,
  type ProjectThread,
  type TestContext,
} from '../test-support.js';
import { createThread } from '../threads.js';
import { createCheckpoint, listCheckpoints, revertCheckpoint } from './checkpoints.js';

/** Porcelain status without `trim()`, so a leading space keeps its meaning. */
function status(cwd: string): string[] {
  const out = execFileSync('git', ['-c', 'core.longpaths=true', 'status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
  });
  return out.length === 0 ? [] : out.split('\n').filter((line) => line.length > 0);
}

describe('git checkpoints', () => {
  let ctx: TestContext;
  let setup: ProjectThread;
  let worktree: string;
  let readme: string;

  beforeEach(async () => {
    ctx = createTestContext();
    setup = await createProjectThread(ctx.repos, initRepo(join(ctx.env.root, 'checkpoint-repo')));
    worktree = setup.thread.worktreePath ?? '';
    readme = join(worktree, 'README.md');
  });

  afterEach(() => {
    ctx.dispose();
  });

  it('snapshots untracked files without touching HEAD, the branch, or the index', async () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    const branch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
    writeFileSync(readme, '# demo\ncheckpointed\n');
    writeFileSync(join(worktree, 'keep.txt'), 'keep me\n');

    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'before edit');

    expect(checkpoint.threadId).toBe(setup.thread.id);
    expect(checkpoint.label).toBe('before edit');
    expect(checkpoint.ref).toBe(`refs/tuffcode/${setup.thread.id}/${checkpoint.id}`);
    expect(checkpoint.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(checkpoint.commitSha).not.toBe(head);
    expect(listCheckpoints(ctx.repos, setup.thread.id)).toHaveLength(1);
    // The snapshot holds the untracked file, not just the tracked edits.
    expect(git(worktree, ['ls-tree', '-r', '--name-only', checkpoint.commitSha]).split('\n')).toEqual(
      ['README.md', 'keep.txt'],
    );
    // HEAD and the branch never move, and the real index still knows nothing about keep.txt.
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);
    expect(git(worktree, ['ls-files', '--cached']).split('\n')).toEqual(['README.md']);
  });

  it('reverts to the snapshot, keeps captured files, and removes files created later', async () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    const branch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
    writeFileSync(readme, '# demo\ncheckpointed\n');
    writeFileSync(join(worktree, 'keep.txt'), 'keep me\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'before edit');

    writeFileSync(readme, '# demo\nchanged\n');
    writeFileSync(join(worktree, 'keep.txt'), 'overwritten\n');
    writeFileSync(join(worktree, 'scratch.txt'), 'temporary\n');
    mkdirSync(join(worktree, 'scratch-dir', 'deep'), { recursive: true });
    writeFileSync(join(worktree, 'scratch-dir', 'deep', 'note.txt'), 'temporary\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(readFileSync(readme, 'utf8')).toBe('# demo\ncheckpointed\n');
    expect(readFileSync(join(worktree, 'keep.txt'), 'utf8')).toBe('keep me\n');
    expect(existsSync(join(worktree, 'scratch.txt'))).toBe(false);
    expect(existsSync(join(worktree, 'scratch-dir'))).toBe(false);
    // The restore rewrote index and worktree but never committed or moved the branch.
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);
    // The status matches the checkpoint: README modified in the worktree, keep.txt untracked.
    expect(status(worktree)).toEqual([' M README.md', '?? keep.txt']);
    expect(git(worktree, ['diff', '--cached', '--name-only', 'HEAD'])).toBe('');
  });

  it('requires confirmation and leaves the worktree alone when it is missing', async () => {
    writeFileSync(readme, '# demo\ncheckpointed\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'before edit');
    writeFileSync(readme, '# demo\nchanged\n');
    const scratch = join(worktree, 'scratch.txt');
    writeFileSync(scratch, 'temporary\n');

    await expect(
      revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, false),
    ).rejects.toThrow('revert requires confirmation');

    expect(readFileSync(readme, 'utf8')).toBe('# demo\nchanged\n');
    expect(existsSync(scratch)).toBe(true);
    // The gate runs before any side effect, so no recovery checkpoint was recorded.
    expect(listCheckpoints(ctx.repos, setup.thread.id)).toHaveLength(1);
  });

  it('snapshots HEAD when the worktree is clean', async () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'clean tree');
    expect(checkpoint.commitSha).toBe(head);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('records a recovery checkpoint before discarding a dirty worktree', async () => {
    writeFileSync(readme, '# demo\ncheckpointed\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'before edit');
    writeFileSync(readme, '# demo\nabout to be lost\n');
    writeFileSync(join(worktree, 'lost.txt'), 'lost\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    const recovery = listCheckpoints(ctx.repos, setup.thread.id).find(
      (entry) => entry.label === 'before revert: before edit',
    );
    expect(recovery).toBeDefined();
    expect(git(worktree, ['show', `${recovery?.commitSha}:README.md`])).toBe(
      '# demo\nabout to be lost',
    );
    expect(git(worktree, ['show', `${recovery?.commitSha}:lost.txt`])).toBe('lost');
    expect(existsSync(join(worktree, 'lost.txt'))).toBe(false);
  });

  it('skips the recovery checkpoint when the worktree is already clean', async () => {
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'clean point');
    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);
    expect(listCheckpoints(ctx.repos, setup.thread.id)).toHaveLength(1);
  });

  it('restores a legacy stash checkpoint without deleting files it never captured', async () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    writeFileSync(readme, '# demo\nlegacy\n');
    const stashSha = git(worktree, ['stash', 'create']);
    expect(stashSha).toMatch(/^[0-9a-f]{40}$/);
    const ref = `refs/tuffcode/${setup.thread.id}/ckp_legacy`;
    git(worktree, ['update-ref', ref, stashSha]);
    const legacy = ctx.repos.checkpoints.create({
      id: 'ckp_legacy',
      threadId: setup.thread.id,
      ref,
      label: 'legacy',
      commitSha: stashSha,
      createdAt: new Date().toISOString(),
    });

    writeFileSync(readme, '# demo\nlater\n');
    const uncaptured = join(worktree, 'uncaptured.txt');
    writeFileSync(uncaptured, 'keep\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, legacy.id, true);

    expect(readFileSync(readme, 'utf8')).toBe('# demo\nlegacy\n');
    // The stash commit never held untracked files, so the revert must not clean them.
    expect(existsSync(uncaptured)).toBe(true);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('rejects a checkpoint from another thread', async () => {
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'mine');
    const other = await createProjectThread(ctx.repos, initRepo(join(ctx.env.root, 'other-repo')));
    await expect(revertCheckpoint(ctx.repos, other.thread.id, checkpoint.id, true)).rejects.toThrow(
      'checkpoint not found',
    );
  });

  it('refuses to revert a folder-backed thread', async () => {
    const project = await addProject(ctx.repos, initRepo(join(ctx.env.root, 'folder-repo')));
    const thread = await createThread(ctx.repos, {
      projectId: project.id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      workspace: 'folder',
    });
    expect(thread.worktreePath).toBe(project.path);
    const checkpoint = await createCheckpoint(ctx.repos, thread.id, 'folder snapshot');
    const projectReadme = join(project.path, 'README.md');
    const head = git(project.path, ['rev-parse', 'HEAD']);
    writeFileSync(projectReadme, '# demo\nchanged in the project\n');

    await expect(revertCheckpoint(ctx.repos, thread.id, checkpoint.id, true)).rejects.toThrow(
      'folder-backed',
    );

    expect(readFileSync(projectReadme, 'utf8')).toBe('# demo\nchanged in the project\n');
    expect(git(project.path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(listCheckpoints(ctx.repos, thread.id)).toHaveLength(1);
  });

  it('removes files created after a checkpoint taken on a clean tree', async () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'clean tree');
    expect(checkpoint.commitSha).toBe(head);
    writeFileSync(join(worktree, 'after.txt'), 'created later\n');
    mkdirSync(join(worktree, 'after-dir', 'deep'), { recursive: true });
    writeFileSync(join(worktree, 'after-dir', 'deep', 'note.txt'), 'created later\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(existsSync(join(worktree, 'after.txt'))).toBe(false);
    expect(existsSync(join(worktree, 'after-dir'))).toBe(false);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('keeps a tracked file that .gitignore also matches', async () => {
    writeFileSync(join(worktree, 'build.log'), 'artifact\n');
    git(worktree, ['add', 'build.log']);
    git(worktree, ['commit', '-m', 'track build log']);
    writeFileSync(join(worktree, '.gitignore'), '*.log\n');
    git(worktree, ['add', '.gitignore']);
    git(worktree, ['commit', '-m', 'ignore logs']);
    const head = git(worktree, ['rev-parse', 'HEAD']);
    writeFileSync(readme, '# demo\ncheckpointed\n');

    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'before revert');
    expect(git(worktree, ['ls-tree', '-r', '--name-only', checkpoint.commitSha]).split('\n')).toContain(
      'build.log',
    );

    writeFileSync(join(worktree, 'build.log'), 'changed after checkpoint\n');
    writeFileSync(join(worktree, 'new.log'), 'ignored and new\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(readFileSync(join(worktree, 'build.log'), 'utf8')).toBe('artifact\n');
    expect(readFileSync(readme, 'utf8')).toBe('# demo\ncheckpointed\n');
    // Ignored files are never part of a snapshot, so one created later is left alone.
    expect(existsSync(join(worktree, 'new.log'))).toBe(true);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
    // The recovery snapshot holds the tracked-ignored file too, so the change is not lost.
    const recovery = listCheckpoints(ctx.repos, setup.thread.id).find(
      (entry) => entry.label === 'before revert: before revert',
    );
    expect(recovery).toBeDefined();
    expect(git(worktree, ['show', `${recovery?.commitSha}:build.log`])).toBe(
      'changed after checkpoint',
    );
  });

  it('leaves ignored-only files untouched by a revert', async () => {
    writeFileSync(join(worktree, '.gitignore'), '*.tmp\n');
    git(worktree, ['add', '.gitignore']);
    git(worktree, ['commit', '-m', 'ignore tmp']);
    writeFileSync(join(worktree, 'before.tmp'), 'before\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'ignored present');
    writeFileSync(readme, '# demo\nchanged\n');
    writeFileSync(join(worktree, 'after.tmp'), 'after\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(readFileSync(join(worktree, 'before.tmp'), 'utf8')).toBe('before\n');
    expect(readFileSync(join(worktree, 'after.tmp'), 'utf8')).toBe('after\n');
    expect(readFileSync(readme, 'utf8')).toBe('# demo\n');
  });

  it('handles spaces, brackets, a leading dash, and non-ASCII names', async () => {
    const captured = ['space name.txt', 'later[9].txt', '-leading.txt', 'héllo-ünïcode.txt'];
    for (const name of captured) writeFileSync(join(worktree, name), 'original\n');
    // These two are captured and must not be caught by a `later[1].txt` glob below.
    writeFileSync(join(worktree, 'later1.txt'), 'captured one\n');
    writeFileSync(join(worktree, 'later2.txt'), 'captured two\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'odd names');

    for (const name of captured) writeFileSync(join(worktree, name), 'changed\n');
    writeFileSync(join(worktree, 'later[1].txt'), 'created later\n');
    writeFileSync(join(worktree, 'later[2].txt'), 'created later\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    for (const name of captured) {
      expect(readFileSync(join(worktree, name), 'utf8')).toBe('original\n');
    }
    expect(readFileSync(join(worktree, 'later1.txt'), 'utf8')).toBe('captured one\n');
    expect(readFileSync(join(worktree, 'later2.txt'), 'utf8')).toBe('captured two\n');
    expect(existsSync(join(worktree, 'later[1].txt'))).toBe(false);
    expect(existsSync(join(worktree, 'later[2].txt'))).toBe(false);
  });

  it('restores a file replaced by a directory and a directory replaced by a file', async () => {
    writeFileSync(join(worktree, 'thing'), 'file content\n');
    mkdirSync(join(worktree, 'tree'), { recursive: true });
    writeFileSync(join(worktree, 'tree', 'inner.txt'), 'inner\n');
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'mixed shapes');

    rmSync(join(worktree, 'thing'));
    mkdirSync(join(worktree, 'thing'), { recursive: true });
    writeFileSync(join(worktree, 'thing', 'nested.txt'), 'nested\n');
    rmSync(join(worktree, 'tree'), { recursive: true });
    writeFileSync(join(worktree, 'tree'), 'now a file\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(statSync(join(worktree, 'thing')).isFile()).toBe(true);
    expect(readFileSync(join(worktree, 'thing'), 'utf8')).toBe('file content\n');
    expect(readFileSync(join(worktree, 'tree', 'inner.txt'), 'utf8')).toBe('inner\n');
  });

  it('restores what was staged as well as what was modified', async () => {
    writeFileSync(join(worktree, 'staged-edit.txt'), 'base\n');
    git(worktree, ['add', 'staged-edit.txt']);
    git(worktree, ['commit', '-m', 'base edit']);
    writeFileSync(join(worktree, 'staged-new.txt'), 'v1\n');
    git(worktree, ['add', 'staged-new.txt']);
    writeFileSync(join(worktree, 'staged-edit.txt'), 'staged\n');
    git(worktree, ['add', 'staged-edit.txt']);
    expect(status(worktree)).toEqual(['M  staged-edit.txt', 'A  staged-new.txt']);

    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'staged only');
    writeFileSync(join(worktree, 'staged-edit.txt'), 'unstaged on top\n');
    writeFileSync(join(worktree, 'later.txt'), 'later\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(readFileSync(join(worktree, 'staged-new.txt'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(worktree, 'staged-edit.txt'), 'utf8')).toBe('staged\n');
    expect(existsSync(join(worktree, 'later.txt'))).toBe(false);
    // The staged split comes back exactly, not as one big staged change.
    expect(status(worktree)).toEqual(['M  staged-edit.txt', 'A  staged-new.txt']);
  });

  it('checkpoints an index with a conflict without losing the conflicted file', async () => {
    writeFileSync(join(worktree, 'conflict.txt'), 'base\n');
    git(worktree, ['add', 'conflict.txt']);
    git(worktree, ['commit', '-m', 'base conflict file']);
    const branch = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
    git(worktree, ['checkout', '-b', 'side']);
    writeFileSync(join(worktree, 'conflict.txt'), 'side\n');
    git(worktree, ['commit', '-am', 'side']);
    git(worktree, ['checkout', branch]);
    writeFileSync(join(worktree, 'conflict.txt'), 'thread\n');
    git(worktree, ['commit', '-am', 'thread']);
    try {
      git(worktree, ['merge', 'side', '--no-edit']);
    } catch {
      // The merge is expected to conflict.
    }
    expect(git(worktree, ['status', '--porcelain'])).toContain('UU conflict.txt');
    const head = git(worktree, ['rev-parse', 'HEAD']);

    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'mid conflict');
    expect(git(worktree, ['show', `${checkpoint.commitSha}:conflict.txt`])).toContain('<<<<<<<');

    writeFileSync(join(worktree, 'conflict.txt'), 'hand edited\n');
    writeFileSync(join(worktree, 'new.txt'), 'new\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(readFileSync(join(worktree, 'conflict.txt'), 'utf8')).toContain('<<<<<<<');
    expect(existsSync(join(worktree, 'new.txt'))).toBe(false);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('round trips CRLF files with core.autocrlf on', async () => {
    git(worktree, ['config', 'core.autocrlf', 'true']);
    writeFileSync(join(worktree, 'crlf.txt'), 'one\r\ntwo\r\n');
    git(worktree, ['add', 'crlf.txt']);
    git(worktree, ['commit', '-m', 'crlf file']);
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'crlf');
    // Git stores the normalized content, and the worktree keeps CRLF.
    expect(git(worktree, ['show', `${checkpoint.commitSha}:crlf.txt`])).toBe('one\ntwo');

    writeFileSync(join(worktree, 'crlf.txt'), 'later\r\n');
    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(readFileSync(join(worktree, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
  });

  it('leaves a nested repository alone', async () => {
    const nested = join(worktree, 'vendor', 'nested');
    mkdirSync(nested, { recursive: true });
    git(nested, ['init', '-b', 'main']);
    git(nested, ['config', 'user.email', 'nested@example.com']);
    git(nested, ['config', 'user.name', 'Nested']);
    writeFileSync(join(nested, 'inner.txt'), 'nested content\n');
    git(nested, ['add', '-A']);
    git(nested, ['commit', '-m', 'nested init']);
    const checkpoint = await createCheckpoint(ctx.repos, setup.thread.id, 'with nested repo');
    writeFileSync(readme, '# demo\nchanged\n');
    writeFileSync(join(worktree, 'new.txt'), 'new\n');

    await revertCheckpoint(ctx.repos, setup.thread.id, checkpoint.id, true);

    expect(readFileSync(join(nested, 'inner.txt'), 'utf8')).toBe('nested content\n');
    expect(existsSync(join(worktree, 'new.txt'))).toBe(false);
    expect(readFileSync(readme, 'utf8')).toBe('# demo\n');
  });

  it('can revert back to an earlier checkpoint after reverting forward', async () => {
    const head = git(worktree, ['rev-parse', 'HEAD']);
    writeFileSync(readme, '# demo\nA\n');
    const first = await createCheckpoint(ctx.repos, setup.thread.id, 'A');
    writeFileSync(readme, '# demo\nB\n');
    const second = await createCheckpoint(ctx.repos, setup.thread.id, 'B');
    writeFileSync(readme, '# demo\nC\n');
    const third = await createCheckpoint(ctx.repos, setup.thread.id, 'C');

    await revertCheckpoint(ctx.repos, setup.thread.id, second.id, true);
    expect(readFileSync(readme, 'utf8')).toBe('# demo\nB\n');
    await revertCheckpoint(ctx.repos, setup.thread.id, first.id, true);
    expect(readFileSync(readme, 'utf8')).toBe('# demo\nA\n');
    await revertCheckpoint(ctx.repos, setup.thread.id, third.id, true);
    expect(readFileSync(readme, 'utf8')).toBe('# demo\nC\n');
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
  });
});

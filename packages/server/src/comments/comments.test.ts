import type { ReviewComment } from '@tuffcode/contracts';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProject } from '../projects.js';
import { dispatch, type RpcHandlers } from '../rpc.js';
import { createTestContext, initRepo, type TestContext } from '../test-support.js';
import { createCommentHandlers } from './rpc.js';

describe('review comments', () => {
  let ctx: TestContext;
  let handlers: RpcHandlers;
  let projectId: string;

  beforeEach(async () => {
    ctx = createTestContext();
    const repo = initRepo(join(ctx.env.root, 'comments-repo'));
    const project = await addProject(ctx.repos, repo);
    projectId = project.id;
    handlers = createCommentHandlers({ repos: ctx.repos });
  });

  afterEach(() => {
    ctx.dispose();
  });

  function makeThread(id: string): void {
    const now = new Date().toISOString();
    ctx.repos.threads.create({
      id,
      projectId,
      parentThreadId: null,
      title: id,
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: null,
      branch: null,
      baseBranch: 'main',
      createdAt: now,
      updatedAt: now,
    });
  }

  async function addComment(threadId: string, body = 'rename this'): Promise<ReviewComment> {
    const response = await dispatch(handlers, {
      id: 'add',
      method: 'comments.add',
      params: { threadId, filePath: 'src/app.ts', line: 12, side: 'new', body },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('comment add failed');
    return response.result as ReviewComment;
  }

  it('adds and lists comments for one thread only', async () => {
    makeThread('thr_a');
    makeThread('thr_b');

    const created = await addComment('thr_a', '  rename this  ');
    expect(created).toMatchObject({
      threadId: 'thr_a',
      filePath: 'src/app.ts',
      line: 12,
      side: 'new',
      body: 'rename this',
      resolved: false,
    });

    const listed = await dispatch(handlers, {
      id: 'list-a',
      method: 'comments.list',
      params: { threadId: 'thr_a' },
    });
    expect(listed.ok).toBe(true);
    expect(listed.ok && (listed.result as ReviewComment[]).map((item) => item.id)).toEqual([
      created.id,
    ]);

    const other = await dispatch(handlers, {
      id: 'list-b',
      method: 'comments.list',
      params: { threadId: 'thr_b' },
    });
    expect(other).toEqual({ id: 'list-b', ok: true, result: [] });
  });

  it('resolves and reopens a comment', async () => {
    makeThread('thr_a');
    const created = await addComment('thr_a');
    const deliveredAt = '2026-01-01T00:00:00.000Z';
    ctx.repos.comments.markDelivered([created.id], deliveredAt);

    const resolved = await dispatch(handlers, {
      id: 'resolve',
      method: 'comments.resolve',
      params: { id: created.id, resolved: true },
    });
    expect(resolved).toMatchObject({
      ok: true,
      result: { id: created.id, resolved: true, deliveredAt },
    });

    // Reopening returns the comment to the unsent state so the next turn carries it.
    const reopened = await dispatch(handlers, {
      id: 'reopen',
      method: 'comments.resolve',
      params: { id: created.id, resolved: false },
    });
    expect(reopened).toMatchObject({
      ok: true,
      result: { id: created.id, resolved: false, deliveredAt: null },
    });
  });

  it('keeps the first delivery stamp when a comment is sent again', async () => {
    makeThread('thr_a');
    const created = await addComment('thr_a');
    const first = '2026-01-01T00:00:00.000Z';
    ctx.repos.comments.markDelivered([created.id], first);
    ctx.repos.comments.markDelivered([created.id], '2026-02-02T00:00:00.000Z');

    expect(ctx.repos.comments.get(created.id)?.deliveredAt).toBe(first);
    expect(created.deliveredAt).toBeNull();
  });

  it('rejects operations on a missing thread', async () => {
    const added = await dispatch(handlers, {
      id: 'add-missing',
      method: 'comments.add',
      params: { threadId: 'thr_missing', filePath: 'a.ts', line: 1, side: 'old', body: 'x' },
    });
    expect(added).toMatchObject({
      ok: false,
      error: { code: 'not-found', message: 'thread not found' },
    });

    const listed = await dispatch(handlers, {
      id: 'list-missing',
      method: 'comments.list',
      params: { threadId: 'thr_missing' },
    });
    expect(listed).toMatchObject({
      ok: false,
      error: { code: 'not-found', message: 'thread not found' },
    });
  });

  it('refuses a comment whose thread no longer owns it', async () => {
    makeThread('thr_a');
    const created = await addComment('thr_a');

    // Simulate an orphaned row (foreign keys bypassed) to prove the ownership check.
    ctx.db.exec('PRAGMA foreign_keys=OFF;');
    ctx.db.prepare('DELETE FROM threads WHERE id = ?').run('thr_a');
    ctx.db.exec('PRAGMA foreign_keys=ON;');

    const resolved = await dispatch(handlers, {
      id: 'resolve-orphan',
      method: 'comments.resolve',
      params: { id: created.id, resolved: true },
    });
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: 'not-found', message: 'thread not found' },
    });
  });

  it('rejects an unknown comment and invalid params', async () => {
    const unknown = await dispatch(handlers, {
      id: 'resolve-unknown',
      method: 'comments.resolve',
      params: { id: 'rc_missing', resolved: true },
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not-found' } });

    makeThread('thr_a');
    const blank = await dispatch(handlers, {
      id: 'blank',
      method: 'comments.add',
      params: { threadId: 'thr_a', filePath: 'a.ts', line: 1, side: 'new', body: '   ' },
    });
    expect(blank).toMatchObject({ ok: false, error: { code: 'bad-request' } });

    const blankPath = await dispatch(handlers, {
      id: 'blank-path',
      method: 'comments.add',
      params: { threadId: 'thr_a', filePath: '   ', line: 1, side: 'new', body: 'x' },
    });
    expect(blankPath).toMatchObject({ ok: false, error: { code: 'bad-request' } });

    const invalidLine = await dispatch(handlers, {
      id: 'bad-line',
      method: 'comments.add',
      params: { threadId: 'thr_a', filePath: 'a.ts', line: 0, side: 'new', body: 'x' },
    });
    expect(invalidLine).toMatchObject({ ok: false, error: { code: 'bad-request' } });
  });
});

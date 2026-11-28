import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test-support.js';

const ISO = '2026-11-24T10:00:00.000Z';

describe('messages repo', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.repos.projects.add({
      id: 'prj_a',
      name: 'alpha',
      path: ctx.env.root,
      defaultBranch: 'main',
      createdAt: ISO,
    });
    ctx.repos.threads.create({
      id: 'thr_a',
      projectId: 'prj_a',
      parentThreadId: null,
      title: 'alpha thread',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      createdAt: ISO,
      updatedAt: ISO,
    });
  });

  afterEach(() => {
    ctx.dispose();
  });

  it('lists one thread in createdAt order and keeps threads apart', () => {
    ctx.repos.threads.create({
      id: 'thr_b',
      projectId: 'prj_a',
      parentThreadId: null,
      title: 'other thread',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      createdAt: ISO,
      updatedAt: ISO,
    });
    ctx.repos.messages.add({
      id: 'msg_late',
      threadId: 'thr_a',
      role: 'assistant',
      content: 'second',
      createdAt: '2026-11-24T10:00:02.000Z',
    });
    ctx.repos.messages.add({
      id: 'msg_early',
      threadId: 'thr_a',
      role: 'user',
      content: 'first',
      createdAt: '2026-11-24T10:00:01.000Z',
    });
    ctx.repos.messages.add({
      id: 'msg_other',
      threadId: 'thr_b',
      role: 'user',
      content: 'elsewhere',
      createdAt: '2026-11-24T10:00:03.000Z',
    });

    expect(ctx.repos.messages.list('thr_a').map((message) => message.id)).toEqual([
      'msg_early',
      'msg_late',
    ]);
    expect(ctx.repos.messages.list('thr_b').map((message) => message.id)).toEqual(['msg_other']);
  });

  it('addIfAbsent keeps the first row for an id and returns it on replay', () => {
    const input = {
      id: 'msg_turn_1_user',
      threadId: 'thr_a',
      role: 'user' as const,
      content: 'hello',
      createdAt: ISO,
    };
    ctx.repos.messages.addIfAbsent(input);
    const replayed = ctx.repos.messages.addIfAbsent({ ...input, content: 'changed' });

    expect(replayed.content).toBe('hello');
    expect(ctx.repos.messages.list('thr_a')).toHaveLength(1);
  });

  it('add still rejects a duplicate id so a real bug surfaces', () => {
    const input = {
      id: 'msg_dup',
      threadId: 'thr_a',
      role: 'user' as const,
      content: 'hello',
      createdAt: ISO,
    };
    ctx.repos.messages.add(input);
    expect(() => ctx.repos.messages.add(input)).toThrow();
  });

  it('round-trips the attachments a user sent with a message', () => {
    ctx.repos.messages.add({
      id: 'msg_with_image',
      threadId: 'thr_a',
      role: 'user',
      content: 'look at this',
      attachments: [
        { name: 'shot.png', id: `${'a'.repeat(64)}.png`, mimeType: 'image/png' },
        { name: 'notes.txt', path: 'C:/work/notes.txt' },
      ],
      createdAt: ISO,
    });

    const [message] = ctx.repos.messages.list('thr_a');
    expect(message?.attachments).toEqual([
      { name: 'shot.png', id: `${'a'.repeat(64)}.png`, mimeType: 'image/png' },
      { name: 'notes.txt', path: 'C:/work/notes.txt' },
    ]);
  });

  it('leaves attachments absent when a row never had them', () => {
    ctx.repos.messages.add({
      id: 'msg_plain',
      threadId: 'thr_a',
      role: 'user',
      content: 'no files',
      createdAt: ISO,
    });

    expect(ctx.repos.messages.list('thr_a')[0]).not.toHaveProperty('attachments');
  });
});

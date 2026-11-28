import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test-support.js';
import { measureContext } from './service.js';

const ISO = '2026-11-24T10:00:00.000Z';

function setup(): { ctx: TestContext; threadId: string } {
  const ctx = createTestContext();
  ctx.repos.projects.add({
    id: 'prj_m',
    name: 'measure',
    path: ctx.env.root,
    defaultBranch: 'main',
    createdAt: ISO,
  });
  ctx.repos.providers.upsert({
    id: 'prv_m',
    kind: 'claude',
    label: 'Measure',
    config: { contextWindow: 100_000 },
  });
  const thread = ctx.repos.threads.create({
    id: 'thr_m',
    projectId: 'prj_m',
    parentThreadId: null,
    title: 'measure thread',
    providerId: 'prv_m',
    modelId: 'model-x',
    executionMode: 'work',
    permissionMode: 'ask',
    status: 'idle',
    worktreePath: ctx.env.root,
    branch: 'tuffcode/thr_m',
    baseBranch: 'main',
    createdAt: ISO,
    updatedAt: ISO,
  });
  return { ctx, threadId: thread.id };
}

describe('measureContext', () => {
  it('charges the current turn images to the user-message section', () => {
    const { ctx, threadId } = setup();
    try {
      ctx.repos.messages.add({
        id: 'msg_current',
        threadId,
        role: 'user',
        content: 'look',
        attachments: [{ name: 'shot.png', id: `${'a'.repeat(64)}.png`, mimeType: 'image/png', width: 1024, height: 512 }],
        createdAt: ISO,
      });
      const thread = ctx.repos.threads.get(threadId);
      if (thread === undefined) throw new Error('thread missing');

      const measured = measureContext(
        ctx.repos,
        thread,
        [
          { name: 'base', tokens: 100 },
          { name: 'user-message', tokens: 1 },
        ],
        { excludeMessageId: 'msg_current' },
      );

      const user = measured.segments.find((segment) => segment.name === 'user-message');
      expect(user?.tokens).toBe(1 + 700);
      const messages = measured.segments.find((segment) => segment.name === 'messages');
      expect(messages?.tokens).toBe(0);
    } finally {
      ctx.dispose();
    }
  });
});

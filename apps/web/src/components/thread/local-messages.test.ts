import { describe, expect, it } from 'vitest';
import type { LocalUserMessage } from './grouping';
import {
  addLocalUserMessage,
  failLocalUserMessage,
  localUserMessages,
  pruneResolvedLocalUserMessages,
  resolveLocalUserMessage,
  retryLocalUserMessage,
  supersedeTurn,
  supersededTurns,
  updateLocalUserMessageText,
} from './local-messages';

function echo(overrides: Partial<LocalUserMessage> = {}): LocalUserMessage {
  const id = `echo-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    threadId: `thread-${id}`,
    turnId: null,
    text: 'Do the thing',
    attachments: [],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('local message status', () => {
  it('keeps a sent message pending until the server accepts it', () => {
    const message = echo();
    addLocalUserMessage(message);

    const [added] = localUserMessages(message.threadId);
    expect(added?.status).toBe('pending');
    expect(added?.turnId).toBeNull();
  });

  it('marks a resolved message sent with its turn id', () => {
    const message = echo();
    addLocalUserMessage(message);

    resolveLocalUserMessage(message.id, 'turn-1');

    const [resolved] = localUserMessages(message.threadId);
    expect(resolved?.status).toBe('sent');
    expect(resolved?.turnId).toBe('turn-1');
  });

  it('keeps a queued send marked queued with its preallocated turn id', () => {
    const message = echo();
    addLocalUserMessage(message);

    resolveLocalUserMessage(message.id, 'turn-2', true);

    const [resolved] = localUserMessages(message.threadId);
    expect(resolved?.status).toBe('queued');
    expect(resolved?.turnId).toBe('turn-2');
  });

  it('keeps the text when a send fails and returns to pending on retry', () => {
    const message = echo();
    addLocalUserMessage(message);

    failLocalUserMessage(message.id);
    const [failed] = localUserMessages(message.threadId);
    expect(failed?.status).toBe('failed');
    expect(failed?.text).toBe('Do the thing');

    retryLocalUserMessage(message.id);
    const [retried] = localUserMessages(message.threadId);
    expect(retried?.status).toBe('pending');
  });

  it('prunes echoes once their turn has a persisted row', () => {
    const threadId = 'thread-prune';
    const resolved = echo({ threadId, turnId: 'turn-1', status: 'sent' });
    const pending = echo({ threadId, status: 'pending' });
    addLocalUserMessage(resolved);
    addLocalUserMessage(pending);

    pruneResolvedLocalUserMessages(threadId, new Set(['turn-1']));

    const remaining = localUserMessages(threadId);
    expect(remaining.map((message) => message.id)).toEqual([pending.id]);
  });

  it('does not touch messages in another thread', () => {
    const first = echo({ threadId: 'thread-a' });
    const second = echo({ threadId: 'thread-b' });
    addLocalUserMessage(first);
    addLocalUserMessage(second);

    failLocalUserMessage(first.id);

    expect(localUserMessages('thread-a')[0]?.status).toBe('failed');
    expect(localUserMessages('thread-b')[0]?.status).toBe('pending');
  });

  it('rewrites an echo text and reports a persisted id as unknown', () => {
    const message = echo();
    addLocalUserMessage(message);

    expect(updateLocalUserMessageText(message.id, 'Edited text')).toBe(true);
    expect(localUserMessages(message.threadId)[0]?.text).toBe('Edited text');
    expect(updateLocalUserMessageText('msg_turn-1_user', 'nope')).toBe(false);
  });

  it('records superseded turns with a new snapshot for subscribers', () => {
    const threadId = 'thread-supersede';
    const first = supersededTurns(threadId);
    expect(first.size).toBe(0);

    supersedeTurn(threadId, 'turn-1');

    const next = supersededTurns(threadId);
    expect(next).not.toBe(first);
    expect(next.has('turn-1')).toBe(true);
  });
});

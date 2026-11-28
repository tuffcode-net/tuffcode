import type { AdapterEvent, Message, ThreadEventRow } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  MAX_EVENTS_PER_SUBAGENT,
  MAX_EVENTS_PER_THREAD,
  coalesceStreamDelta,
  createAppStore,
  mergeSubagentView,
  trimThreadEvents,
  type SubagentChild,
} from './app-store';

function message(id: string, threadId = 'thread-1'): Message {
  return {
    id,
    threadId,
    role: 'user',
    content: id,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function textEvent(seq: number, threadId = 'thread-1'): ThreadEventRow {
  return {
    id: seq + 1,
    threadId,
    seq,
    type: 'text.delta',
    payload: { type: 'text.delta', turnId: 'turn-1', text: `chunk ${seq}` },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function seqs(store: ReturnType<typeof createAppStore>, threadId = 'thread-1'): number[] {
  return (store.getState().events[threadId] ?? []).map((event) => event.seq);
}

const AT = (second: number): string => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

function eventRow(seq: number, payload: AdapterEvent, createdAt = AT(0)): ThreadEventRow {
  return { id: seq + 1, threadId: 'thread-1', seq, type: payload.type, payload, createdAt };
}

function delta(seq: number, text: string, turnId = 'turn-1', createdAt = AT(0)): ThreadEventRow {
  return eventRow(seq, { type: 'text.delta', turnId, text }, createdAt);
}

describe('app store appendEvent', () => {
  it('keeps events ordered and ignores seq values at or below the last event', () => {
    const store = createAppStore();

    store.getState().appendEvent('thread-1', textEvent(1));
    store.getState().appendEvent('thread-1', textEvent(3));
    store.getState().appendEvent('thread-1', textEvent(2));
    store.getState().appendEvent('thread-1', textEvent(3));

    expect(seqs(store)).toEqual([1, 3]);
  });

  it('dedupes by seq within a thread and keeps threads separate', () => {
    const store = createAppStore();

    store.getState().appendEvent('thread-1', textEvent(1));
    store.getState().appendEvent('thread-1', textEvent(1));
    store.getState().appendEvent('thread-2', textEvent(1, 'thread-2'));

    expect(seqs(store, 'thread-1')).toEqual([1]);
    expect(seqs(store, 'thread-2')).toEqual([1]);
  });

  it('coalesces contiguous deltas into one row with the first timestamp and newest seq', () => {
    const store = createAppStore();

    store.getState().appendEvent('thread-1', delta(1, 'Hel', 'turn-1', AT(1)));
    store.getState().appendEvent('thread-1', delta(2, 'lo', 'turn-1', AT(2)));
    store.getState().appendEvent('thread-1', delta(3, ' there', 'turn-1', AT(3)));

    const rows = store.getState().events['thread-1'] ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seq).toBe(3);
    expect(rows[0]?.createdAt).toBe(AT(1));
    expect(rows[0]?.payload).toEqual({ type: 'text.delta', turnId: 'turn-1', text: 'Hello there' });
  });

  it('keeps deltas separate across a tool event and across turns', () => {
    const store = createAppStore();

    store.getState().appendEvent('thread-1', delta(1, 'a'));
    store.getState().appendEvent(
      'thread-1',
      eventRow(2, {
        type: 'tool.started',
        turnId: 'turn-1',
        toolCallId: 'call_1',
        name: 'bash',
        input: {},
      }),
    );
    store.getState().appendEvent('thread-1', delta(3, 'b'));
    store.getState().appendEvent('thread-1', delta(4, 'c'));

    const rows = store.getState().events['thread-1'] ?? [];
    expect(rows.map((entry) => entry.type)).toEqual(['text.delta', 'tool.started', 'text.delta']);
    expect(rows.map((entry) => entry.seq)).toEqual([1, 2, 4]);

    const turnStore = createAppStore();
    turnStore.getState().appendEvent('thread-1', delta(1, 'x', 'turn-1'));
    turnStore.getState().appendEvent('thread-1', delta(2, 'y', 'turn-2'));
    expect(turnStore.getState().events['thread-1']).toHaveLength(2);
  });

  it('never evicts structural events, even when they alone exceed the cap', () => {
    const store = createAppStore();
    const turns = 1400;
    let seq = 0;
    for (let turn = 0; turn < turns; turn += 1) {
      const turnId = `turn-${turn}`;
      store.getState().appendEvent('thread-1', eventRow(++seq, { type: 'turn.started', turnId }));
      store.getState().appendEvent(
        'thread-1',
        eventRow(++seq, {
          type: 'tool.started',
          turnId,
          toolCallId: `call_${turn}`,
          name: 'bash',
          input: {},
        }),
      );
      store.getState().appendEvent('thread-1', delta(++seq, 'streamed', turnId));
      store.getState().appendEvent(
        'thread-1',
        eventRow(++seq, {
          type: 'tool.finished',
          turnId,
          toolCallId: `call_${turn}`,
          output: 'ok',
          isError: false,
        }),
      );
      store.getState().appendEvent(
        'thread-1',
        eventRow(++seq, { type: 'turn.finished', turnId, reason: 'complete' }),
      );
    }

    const rows = store.getState().events['thread-1'] ?? [];
    expect(rows.length).toBeGreaterThan(MAX_EVENTS_PER_THREAD);
    const counts = new Map<string, number>();
    for (const entry of rows) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
    expect(counts.get('turn.started')).toBe(turns);
    expect(counts.get('turn.finished')).toBe(turns);
    expect(counts.get('tool.started')).toBe(turns);
    expect(counts.get('tool.finished')).toBe(turns);
    expect(counts.get('text.delta')).toBeUndefined();
  });

  it('trims the oldest deltas first and keeps structural rows above the cap', () => {
    const events = [
      delta(1, 'old'),
      eventRow(2, {
        type: 'tool.started',
        turnId: 'turn-1',
        toolCallId: 'call_1',
        name: 'bash',
        input: {},
      }),
      delta(3, 'mid'),
      eventRow(4, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }),
    ];
    expect(trimThreadEvents(events, 3).map((entry) => entry.seq)).toEqual([2, 3, 4]);

    const structuralOnly = [
      eventRow(1, { type: 'turn.started', turnId: 'turn-1' }),
      eventRow(2, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }),
    ];
    expect(trimThreadEvents(structuralOnly, 1)).toHaveLength(2);
  });

  it('reports no merge for a delta that does not extend the previous row', () => {
    const previous = delta(1, 'a');
    expect(coalesceStreamDelta(previous, delta(3, 'b'))).toBeNull();
    expect(coalesceStreamDelta(previous, eventRow(2, { type: 'usage', turnId: 'turn-1' }))).toBeNull();
    expect(coalesceStreamDelta(undefined, delta(1, 'a'))).toBeNull();
  });
});

describe('app store messages', () => {
  it('stores persisted rows per thread and replaces them on reload', () => {
    const store = createAppStore();

    store.getState().setMessages('thread-1', [message('msg_turn-1_user')]);
    store.getState().setMessages('thread-2', [message('msg_turn-2_user', 'thread-2')]);

    expect(store.getState().messages['thread-1']?.map((row) => row.id)).toEqual([
      'msg_turn-1_user',
    ]);
    expect(store.getState().messages['thread-2']?.map((row) => row.id)).toEqual([
      'msg_turn-2_user',
    ]);

    store.getState().setMessages('thread-1', [message('msg_turn-3_user')]);
    expect(store.getState().messages['thread-1']?.map((row) => row.id)).toEqual([
      'msg_turn-3_user',
    ]);
  });

  it('drops messages with the thread', () => {
    const store = createAppStore();

    store.getState().upsertThread({
      id: 'thread-1',
      projectId: 'project-1',
      parentThreadId: null,
      title: 'Thread',
      providerId: 'provider-1',
      modelId: 'model-1',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: 'C:/worktree',
      branch: 'tuffcode/thread-1',
      baseBranch: 'main',
      prUrl: null,
      reasoningEffort: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastSeq: 0,
    });
    store.getState().setMessages('thread-1', [message('msg_turn-1_user')]);

    store.getState().removeThread('thread-1');

    expect(store.getState().messages['thread-1']).toBeUndefined();
  });
});

function childEvent(seq: number, text = `chunk ${seq}`): AdapterEvent {
  return { type: 'text.delta', turnId: 'turn-child', text };
}

function startChild(
  store: ReturnType<typeof createAppStore>,
  childId = 'child-1',
  threadId = 'thread-1',
): void {
  store.getState().subagentStarted({ childId, threadId, type: 'explorer', model: 'mock-model' });
}

describe('app store subagents', () => {
  it('keys children by id and appends their events with a per-child cursor', () => {
    const store = createAppStore();
    startChild(store, 'child-1');
    startChild(store, 'child-2');

    store
      .getState()
      .subagentEvent({ childId: 'child-1', threadId: 'thread-1', event: childEvent(0) });
    store
      .getState()
      .subagentEvent({ childId: 'child-2', threadId: 'thread-1', event: childEvent(0) });
    store
      .getState()
      .subagentEvent({ childId: 'child-1', threadId: 'thread-1', event: childEvent(1) });

    const first = store.getState().subagents['child-1'];
    const second = store.getState().subagents['child-2'];
    expect(first?.events.map((row) => row.seq)).toEqual([0, 1]);
    expect(second?.events.map((row) => row.seq)).toEqual([0]);
    expect(first?.nextSeq).toBe(2);
    expect(first?.type).toBe('explorer');
    expect(first?.model).toBe('mock-model');
    expect(first?.status).toBe('running');
  });

  it('caps each child at 2000 events and keeps the newest', () => {
    const store = createAppStore();
    startChild(store);

    for (let seq = 0; seq <= MAX_EVENTS_PER_SUBAGENT; seq += 1) {
      store
        .getState()
        .subagentEvent({ childId: 'child-1', threadId: 'thread-1', event: childEvent(seq) });
    }

    const events = store.getState().subagents['child-1']?.events ?? [];
    expect(events).toHaveLength(MAX_EVENTS_PER_SUBAGENT);
    expect(events[0]?.seq).toBe(1);
    expect(events.at(-1)?.seq).toBe(MAX_EVENTS_PER_SUBAGENT);
  });

  it('settles once: finished sets status, summary and time, and a late start cannot revive it', () => {
    const store = createAppStore();
    startChild(store);

    store.getState().subagentFinished({
      childId: 'child-1',
      threadId: 'thread-1',
      status: 'done',
      summary: 'mapped the project',
    });
    const settled = store.getState().subagents['child-1'];
    expect(settled?.status).toBe('done');
    expect(settled?.summary).toBe('mapped the project');
    expect(settled?.finishedAt).not.toBeNull();

    store.getState().subagentStarted({
      childId: 'child-1',
      threadId: 'thread-1',
      type: 'explorer',
      model: 'mock-model',
    });
    expect(store.getState().subagents['child-1']?.status).toBe('done');
  });

  it('creates a child when a finished frame arrives before its started frame', () => {
    const store = createAppStore();

    store.getState().subagentFinished({
      childId: 'child-1',
      threadId: 'thread-1',
      status: 'failed',
    });

    const child = store.getState().subagents['child-1'];
    expect(child?.status).toBe('failed');
    expect(child?.threadId).toBe('thread-1');
  });

  it('merges list rows into live children without reverting a settled status', () => {
    const store = createAppStore();
    startChild(store);
    store.getState().subagentFinished({ childId: 'child-1', threadId: 'thread-1', status: 'done' });
    expect(store.getState().subagents['child-1']?.childThreadId).toBeNull();

    store.getState().mergeSubagentViews('thread-1', [
      {
        childId: 'child-1',
        threadId: 'thread-1',
        childThreadId: 'child-thread-1',
        type: 'explorer',
        model: 'mock-model',
        providerId: 'provider-1',
        status: 'running',
        task: 'map the project',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:05.000Z',
      },
    ]);

    const child = store.getState().subagents['child-1'];
    expect(child?.status).toBe('done');
    expect(child?.task).toBe('map the project');
    expect(child?.childThreadId).toBe('child-thread-1');
  });

  it('drops list rows from another thread', () => {
    const store = createAppStore();

    store.getState().mergeSubagentViews('thread-1', [
      {
        childId: 'child-9',
        threadId: 'thread-2',
        childThreadId: 'child-thread-9',
        type: 'worker',
        model: 'mock-model',
        providerId: 'provider-1',
        status: 'queued',
        task: 'other',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(store.getState().subagents['child-9']).toBeUndefined();
  });

  it('opens, selects and closes the pane while remembering the selected tab', () => {
    const store = createAppStore();
    startChild(store, 'child-1');
    startChild(store, 'child-2');

    store.getState().openSubagent('child-1');
    expect(store.getState().subagentPane).toEqual({ open: true, activeChildId: 'child-1' });

    store.getState().selectSubagent('child-2');
    expect(store.getState().subagentPane).toEqual({ open: true, activeChildId: 'child-2' });

    store.getState().closeSubagentPane();
    expect(store.getState().subagentPane).toEqual({ open: false, activeChildId: 'child-2' });

    store.getState().openSubagent('missing');
    expect(store.getState().subagentPane).toEqual({ open: false, activeChildId: 'child-2' });
  });

  it('prunes children and the pane selection with their thread', () => {
    const store = createAppStore();
    startChild(store, 'child-1');
    store.getState().openSubagent('child-1');

    store.getState().removeThread('thread-1');

    expect(store.getState().subagents['child-1']).toBeUndefined();
    expect(store.getState().subagentPane).toEqual({ open: false, activeChildId: null });
  });

  it('seeds questions from a reload without clobbering one that arrived by event', () => {
    const store = createAppStore();
    store.getState().subagentQuestion({
      childId: 'child-1',
      threadId: 'thread-1',
      questionId: 'sq_live',
      text: 'Which file should I change?',
    });
    const live = store.getState().questions['sq_live'];

    store.getState().mergeSubagentQuestions([
      {
        questionId: 'sq_live',
        childId: 'child-1',
        threadId: 'thread-1',
        text: 'stale copy from the server',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        questionId: 'sq_seeded',
        childId: 'child-2',
        threadId: 'thread-1',
        text: 'Seeded after reload',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]);

    expect(store.getState().questions['sq_live']).toBe(live);
    expect(store.getState().questions['sq_live']?.text).toBe('Which file should I change?');
    expect(store.getState().questions['sq_seeded']?.childId).toBe('child-2');
    expect(store.getState().questions['sq_seeded']?.text).toBe('Seeded after reload');
  });
});

describe('mergeSubagentView', () => {
  const view = {
    childId: 'child-1',
    threadId: 'thread-1',
    childThreadId: 'child-thread-1',
    type: 'reviewer' as const,
    model: 'other-model',
    providerId: 'provider-1',
    status: 'done' as const,
    task: 'review the diff',
    summary: 'one blocker',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:09.000Z',
  };

  it('creates a settled child from a list row alone', () => {
    const child: SubagentChild = mergeSubagentView(undefined, view);
    expect(child.status).toBe('done');
    expect(child.summary).toBe('one blocker');
    expect(child.childThreadId).toBe('child-thread-1');
    expect(child.finishedAt).toBe('2026-01-01T00:00:09.000Z');
    expect(child.events).toEqual([]);
  });

  it('keeps a known child thread when a stale row has not seen one yet', () => {
    const live = mergeSubagentView(undefined, view);
    const stale = mergeSubagentView(live, { ...view, childThreadId: null });
    expect(stale.childThreadId).toBe('child-thread-1');
  });
});

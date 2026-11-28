import type { AdapterEvent, Goal, RpcResult, Task, ThreadEventRow } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import type { SubagentChild } from '../../store/app-store';
import {
  activityCount,
  councilActivityOf,
  countRunningSubagents,
  finishedToolRows,
  runningElapsedMs,
  runningToolCount,
  runningToolRows,
  waitingItems,
} from './activity-model';

let nextRowId = 0;

function row(
  threadId: string,
  payload: AdapterEvent,
  createdAt = '2026-11-25T12:00:00.000Z',
): ThreadEventRow {
  nextRowId += 1;
  return {
    id: nextRowId,
    threadId,
    seq: nextRowId,
    type: payload.type,
    payload,
    createdAt,
  };
}

function started(turnId: string, toolCallId: string, name: string, input: unknown): AdapterEvent {
  return { type: 'tool.started', turnId, toolCallId, name, input };
}

function delta(turnId: string, toolCallId: string, text: string): AdapterEvent {
  return { type: 'tool.delta', turnId, toolCallId, text };
}

function finished(
  turnId: string,
  toolCallId: string,
  output: string,
  isError = false,
): AdapterEvent {
  return { type: 'tool.finished', turnId, toolCallId, output, isError };
}

function child(
  overrides: Partial<SubagentChild> & { childId: string; threadId: string },
): SubagentChild {
  return {
    childThreadId: null,
    type: 'explorer',
    model: 'model-1',
    status: 'running',
    task: '',
    summary: null,
    createdAt: '2026-11-25T12:00:00.000Z',
    startedAt: '2026-11-25T12:00:00.000Z',
    finishedAt: null,
    events: [],
    nextSeq: 0,
    closedAt: null,
    messages: [],
    awaitingReopen: false,
    ...overrides,
  };
}

describe('runningToolRows', () => {
  it('lists an open bash call with its accumulated output', () => {
    const events = [
      row('thr_1', started('turn-1', 'call-1', 'bash', { command: 'pnpm test\n--watch' })),
      row('thr_1', delta('turn-1', 'call-1', 'building\n')),
      row('thr_1', delta('turn-1', 'call-1', '3 tests passed')),
      row('thr_1', started('turn-1', 'call-2', 'read', { path: 'src/index.ts' })),
      row('thr_1', finished('turn-1', 'call-2', 'file body')),
    ];

    const rows = runningToolRows(events);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      key: 'thread:turn-1:call-1',
      childId: null,
      childType: null,
      headline: 'Ran pnpm test',
      output: 'building\n3 tests passed',
      startedAt: '2026-11-25T12:00:00.000Z',
    });
  });

  it('prefixes a child tool with its subagent type', () => {
    const explorer = child({
      childId: 'child_1',
      threadId: 'thr_1',
      type: 'explorer',
      events: [row('thr_1', started('turn-9', 'call-1', 'grep', { pattern: 'TODO' }))],
    });

    const rows = runningToolRows([], [explorer]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'child_1:turn-9:call-1',
      childId: 'child_1',
      childType: 'explorer',
      headline: 'Searched TODO',
    });
  });

  it('keeps the thread tools before its children', () => {
    const events = [row('thr_1', started('turn-1', 'call-1', 'bash', { command: 'pnpm check' }))];
    const worker = child({
      childId: 'child_1',
      threadId: 'thr_1',
      type: 'worker',
      events: [row('thr_1', started('turn-2', 'call-1', 'write', { path: 'a.ts' }))],
    });

    expect(runningToolRows(events, [worker]).map((entry) => entry.childId)).toEqual([
      null,
      'child_1',
    ]);
  });
});

describe('finishedToolRows', () => {
  it('lists completed calls newest first and caps at the limit', () => {
    const events = [
      row(
        'thr_1',
        started('turn-1', 'call-1', 'bash', { command: 'pnpm test' }),
        '2026-11-25T12:00:00.000Z',
      ),
      row('thr_1', finished('turn-1', 'call-1', 'all green'), '2026-11-25T12:00:05.000Z'),
      row(
        'thr_1',
        started('turn-1', 'call-2', 'read', { path: 'src/index.ts' }),
        '2026-11-25T12:00:01.000Z',
      ),
      row('thr_1', finished('turn-1', 'call-2', 'file body'), '2026-11-25T12:00:09.000Z'),
      row(
        'thr_1',
        started('turn-1', 'call-3', 'grep', { pattern: 'TODO' }),
        '2026-11-25T12:00:02.000Z',
      ),
      row('thr_1', finished('turn-1', 'call-3', 'no matches'), '2026-11-25T12:00:07.000Z'),
    ];

    const rows = finishedToolRows(events);

    expect(rows.map((entry) => entry.toolCallId)).toEqual(['call-2', 'call-3', 'call-1']);
    expect(rows[0]).toEqual({
      key: 'thread:turn-1:call-2',
      childId: null,
      childType: null,
      toolCallId: 'call-2',
      headline: 'Read src/index.ts',
      output: 'file body',
      isError: false,
      finishedAt: '2026-11-25T12:00:09.000Z',
    });
    expect(finishedToolRows(events, [], 2).map((entry) => entry.toolCallId)).toEqual([
      'call-2',
      'call-3',
    ]);
  });

  it('keeps ten finished calls by default', () => {
    const events = Array.from({ length: 12 }, (_, index) => [
      row('thr_1', started('turn-1', `call-${index}`, 'bash', { command: `cmd ${index}` })),
      row(
        'thr_1',
        finished('turn-1', `call-${index}`, 'ok'),
        `2026-11-25T12:00:${String(index).padStart(2, '0')}.000Z`,
      ),
    ]).flat();

    expect(finishedToolRows(events)).toHaveLength(10);
  });

  it('skips a call that started but has not finished', () => {
    const events = [
      row('thr_1', started('turn-1', 'call-1', 'bash', { command: 'pnpm test' })),
      row('thr_1', started('turn-1', 'call-2', 'read', { path: 'a.ts' })),
      row('thr_1', finished('turn-1', 'call-2', 'body')),
    ];

    expect(finishedToolRows(events).map((entry) => entry.toolCallId)).toEqual(['call-2']);
  });

  it('flags a failed call with its error output', () => {
    const events = [
      row('thr_1', started('turn-1', 'call-1', 'bash', { command: 'pnpm test' })),
      row('thr_1', finished('turn-1', 'call-1', '1 test failed', true)),
    ];

    expect(finishedToolRows(events)[0]).toMatchObject({
      isError: true,
      output: '1 test failed',
    });
  });

  it('prefixes a child call with its subagent type', () => {
    const explorer = child({
      childId: 'child_1',
      threadId: 'thr_1',
      type: 'explorer',
      events: [
        row('thr_1', started('turn-9', 'call-1', 'grep', { pattern: 'TODO' })),
        row(
          'thr_1',
          finished('turn-9', 'call-1', 'src/a.ts:1'),
          '2026-11-25T12:00:03.000Z',
        ),
      ],
    });

    const rows = finishedToolRows([], [explorer]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'child_1:turn-9:call-1',
      childId: 'child_1',
      childType: 'explorer',
      headline: 'Searched TODO',
      output: 'src/a.ts:1',
      finishedAt: '2026-11-25T12:00:03.000Z',
    });
  });
});

describe('runningToolCount', () => {
  it('counts only calls without a finished frame', () => {
    const events = [
      row('thr_1', started('turn-1', 'call-1', 'bash', {})),
      row('thr_1', started('turn-1', 'call-2', 'bash', {})),
      row('thr_1', finished('turn-1', 'call-2', 'done')),
    ];

    expect(runningToolCount(events)).toBe(1);
  });

  it('keeps a reused call id across turns distinct', () => {
    const events = [
      row('thr_1', started('turn-1', 'call-1', 'bash', {})),
      row('thr_1', started('turn-2', 'call-1', 'bash', {})),
      row('thr_1', finished('turn-1', 'call-1', 'done')),
    ];

    expect(runningToolCount(events)).toBe(1);
  });
});

describe('activityCount', () => {
  const events = [row('thr_1', started('turn-1', 'call-1', 'bash', {}))];
  const subagents: Record<string, SubagentChild> = {
    a: child({ childId: 'a', threadId: 'thr_1', status: 'running' }),
    b: child({ childId: 'b', threadId: 'thr_1', status: 'queued' }),
    c: child({ childId: 'c', threadId: 'thr_1', status: 'done' }),
    d: child({ childId: 'd', threadId: 'thr_2', status: 'running' }),
  };

  it('counts running children only, never queued or settled ones', () => {
    expect(countRunningSubagents(subagents, 'thr_1')).toBe(1);
    expect(countRunningSubagents(subagents, 'thr_2')).toBe(1);
    expect(countRunningSubagents(subagents, 'thr_3')).toBe(0);
  });

  it('adds open tool calls and running children for the thread', () => {
    expect(activityCount(events, subagents, 'thr_1')).toBe(2);
    expect(activityCount(events, subagents, 'thr_2')).toBe(2);
    expect(activityCount([], subagents, 'thr_3')).toBe(0);
  });
});

describe('waitingItems', () => {
  const queuedChild = child({ childId: 'q1', threadId: 'thr_1', status: 'queued' });
  const runningChild = child({ childId: 'r1', threadId: 'thr_1', status: 'running' });

  it('lists queued children and nothing else while no approval is open', () => {
    const items = waitingItems([queuedChild, runningChild], 'running');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'child', child: { childId: 'q1' } });
  });

  it('adds the approval line when the thread needs an approval', () => {
    const items = waitingItems([], 'needs-approval');

    expect(items).toEqual([{ kind: 'approval' }]);
  });

  it('keeps queued children ahead of the approval line', () => {
    const items = waitingItems([queuedChild], 'needs-approval');

    expect(items.map((item) => item.kind)).toEqual(['child', 'approval']);
  });

  it('reports nothing waiting without queued children or an open approval', () => {
    expect(waitingItems([], 'idle')).toEqual([]);
    expect(waitingItems([runningChild], undefined)).toEqual([]);
  });
});

describe('runningElapsedMs', () => {
  const now = Date.parse('2026-11-25T12:00:05.000Z');

  it('measures from the start timestamp', () => {
    expect(runningElapsedMs('2026-11-25T12:00:00.000Z', now)).toBe(5000);
  });

  it('rejects a missing, unparseable or future start', () => {
    expect(runningElapsedMs(null, now)).toBeNull();
    expect(runningElapsedMs('not-a-date', now)).toBeNull();
    expect(runningElapsedMs('2026-11-25T12:00:10.000Z', now)).toBeNull();
  });
});

function goal(state: Goal['state']): Goal {
  return {
    id: 'gol_1',
    threadId: 'thr_1',
    text: 'Ship the round',
    autonomy: 'manual',
    state,
    createdAt: '2026-11-25T12:00:00.000Z',
    reportedAt: null,
  };
}

function planTask(id: string, title: string, state: Task['state']): Task {
  return {
    id,
    goalId: 'gol_1',
    threadId: `thr_${id}`,
    title,
    brief: `Do ${title}.`,
    dependsOn: [],
    state,
    authorProvider: 'p1',
    authorModel: 'model-1',
    reviewerProvider: null,
    reviewerModel: null,
    critical: false,
    round: 0,
    error: null,
    createdAt: '2026-11-25T12:00:00.000Z',
    updatedAt: '2026-11-25T12:00:00.000Z',
  };
}

describe('councilActivityOf', () => {
  it('has no Council section before a goal exists', () => {
    expect(councilActivityOf(null)).toBeNull();
  });

  it('lists the goal state and every task with its own state', () => {
    const status: RpcResult<'council.status'> = {
      goal: goal('running'),
      tasks: [
        planTask('tsk_1', 'Build api', 'running'),
        planTask('tsk_2', 'Build ui', 'queued'),
      ],
      reviews: [],
    };

    const council = councilActivityOf(status);

    expect(council).toMatchObject({
      goalState: 'running',
      goalLabel: 'Running',
      goalTone: 'primary',
      goalActive: true,
    });
    expect(council?.tasks).toEqual([
      { id: 'tsk_1', title: 'Build api', state: 'running', stateLabel: 'Running', tone: 'primary' },
      { id: 'tsk_2', title: 'Build ui', state: 'queued', stateLabel: 'Queued', tone: 'neutral' },
    ]);
  });

  it('keeps the goal active until it reaches a terminal state', () => {
    expect(
      councilActivityOf({ goal: goal('reviewing'), tasks: [], reviews: [] })?.goalActive,
    ).toBe(true);
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      const council = councilActivityOf({ goal: goal(state), tasks: [], reviews: [] });
      expect(council?.goalActive).toBe(false);
    }
  });
});

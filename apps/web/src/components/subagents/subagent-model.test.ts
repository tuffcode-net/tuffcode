import type { ThreadEventRow } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import type { SubagentChild } from '../../store/app-store';
import {
  SUBAGENT_CHIP_LIMIT,
  childForThread,
  mergeChildEvents,
  mergeSubagentMessages,
  selectActiveSubagent,
  subagentElapsedMs,
  subagentFinishedLabel,
  subagentMessageDirectionLabel,
  subagentStripChips,
  subagentsOfThread,
  type SubagentChip,
} from './subagent-model';

const T0 = '2026-01-01T00:00:00.000Z';

function child(overrides: Partial<SubagentChild> & { childId: string }): SubagentChild {
  return {
    threadId: 'thread-1',
    childThreadId: null,
    type: 'explorer',
    model: 'mock-model',
    status: 'running',
    task: '',
    summary: null,
    createdAt: T0,
    startedAt: T0,
    finishedAt: null,
    events: [],
    nextSeq: 0,
    closedAt: null,
    messages: [],
    awaitingReopen: false,
    ...overrides,
  };
}

function settled(childId: string): SubagentChild {
  return child({ childId, status: 'done', finishedAt: T0 });
}

/** Chip identities in row order, with the two aggregate chips named by kind. */
function chipIds(chips: readonly SubagentChip[]): string[] {
  return chips.map((chip) => (chip.kind === 'child' ? chip.child.childId : chip.kind));
}

describe('selectActiveSubagent', () => {
  const running = child({ childId: 'c-running', task: 'map' });
  const done = child({ childId: 'c-done', status: 'done', finishedAt: T0 });

  it('returns the requested child when it belongs to the thread', () => {
    expect(selectActiveSubagent([done, running], 'c-done')?.childId).toBe('c-done');
  });

  it('falls back to the first running child, then to the first child', () => {
    expect(selectActiveSubagent([done, running], null)?.childId).toBe('c-running');
    expect(selectActiveSubagent([done], 'missing')?.childId).toBe('c-done');
    expect(selectActiveSubagent([], 'missing')).toBeNull();
  });
});

describe('subagentsOfThread', () => {
  it('keeps spawn order and drops children of other threads', () => {
    const first = child({ childId: 'c1' });
    const second = child({ childId: 'c2', threadId: 'thread-2' });
    const third = child({ childId: 'c3' });

    const registry = { c1: first, c2: second, c3: third };
    expect(subagentsOfThread(registry, 'thread-1').map((entry) => entry.childId)).toEqual([
      'c1',
      'c3',
    ]);
  });
});

describe('childForThread', () => {
  it('matches a child row thread id against the child thread, not the parent', () => {
    const running = child({
      childId: 'c1',
      threadId: 'thread-1',
      childThreadId: 'child-thread-1',
    });
    const registry = { c1: running };

    expect(childForThread(registry, 'child-thread-1')?.childId).toBe('c1');
    expect(childForThread(registry, 'thread-1')).toBeUndefined();
  });

  it('finds the one child per child thread and misses unknown threads', () => {
    const first = child({ childId: 'c1', childThreadId: 'child-thread-1' });
    const second = child({ childId: 'c2', childThreadId: 'child-thread-2' });
    const pending = child({ childId: 'c3', childThreadId: null });
    const registry = { c1: first, c2: second, c3: pending };

    expect(childForThread(registry, 'child-thread-2')?.childId).toBe('c2');
    expect(childForThread(registry, 'child-thread-3')).toBeUndefined();
  });
});

describe('subagentStripChips', () => {
  it('draws one chip per child while the row fits four', () => {
    const chips = subagentStripChips([
      child({ childId: 'a' }),
      child({ childId: 'b', type: 'worker' }),
      settled('c'),
      child({ childId: 'd', type: 'reviewer' }),
    ]);

    expect(SUBAGENT_CHIP_LIMIT).toBe(4);
    expect(chipIds(chips)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the first three running children and folds the rest into a count', () => {
    const chips = subagentStripChips([
      child({ childId: 'r1' }),
      child({ childId: 'r2' }),
      child({ childId: 'r3' }),
      child({ childId: 'r4' }),
      settled('s1'),
    ]);

    expect(chipIds(chips)).toEqual(['r1', 'r2', 'r3', 'more']);
    expect(chips[3]).toEqual({ kind: 'more', count: 2, childId: 'r1' });
  });

  it('keeps only the running children when they are the ones that fit', () => {
    const chips = subagentStripChips([
      settled('s1'),
      child({ childId: 'r1' }),
      child({ childId: 'r2' }),
      settled('s2'),
      settled('s3'),
      settled('s4'),
    ]);

    expect(chipIds(chips)).toEqual(['r1', 'r2', 'more']);
    expect(chips[2]).toEqual({ kind: 'more', count: 4, childId: 'r1' });
  });

  it('folds a settled set into one finished chip on the last child', () => {
    expect(subagentStripChips([settled('s1'), settled('s2'), settled('s3')])).toEqual([
      { kind: 'finished', count: 3, label: '3 subagents finished', childId: 's3' },
    ]);
  });

  it('has no chips before the first spawn', () => {
    expect(subagentStripChips([])).toEqual([]);
  });
});

describe('subagentFinishedLabel', () => {
  it('counts one child and many children', () => {
    expect(subagentFinishedLabel(1)).toBe('1 subagent finished');
    expect(subagentFinishedLabel(4)).toBe('4 subagents finished');
  });
});

describe('subagentElapsedMs', () => {
  it('counts to now while running and to the finish time once settled', () => {
    const started = '2026-01-01T00:00:00.000Z';
    const finished = '2026-01-01T00:00:04.500Z';

    expect(
      subagentElapsedMs(child({ childId: 'a', startedAt: started }), Date.parse(finished)),
    ).toBe(4500);
    expect(
      subagentElapsedMs(
        child({ childId: 'a', startedAt: started, status: 'done', finishedAt: finished }),
        Date.parse('2026-01-01T00:01:00.000Z'),
      ),
    ).toBe(4500);
    expect(subagentElapsedMs(child({ childId: 'a', startedAt: null }), 1)).toBeNull();
  });
});

describe('mergeChildEvents', () => {
  const event = (seq: number, type: ThreadEventRow['type']): ThreadEventRow => ({
    id: seq + 1,
    threadId: 'thr_child',
    seq,
    type,
    payload: { type } as ThreadEventRow['payload'],
    createdAt: T0,
  });

  it('replays persisted rows in seq order', () => {
    const persisted = [event(1, 'turn.started'), event(2, 'text.delta')];
    expect(mergeChildEvents(persisted, []).map((row) => row.seq)).toEqual([1, 2]);
  });

  it('lets a live frame replace the persisted row at the same seq', () => {
    const persisted = [event(1, 'turn.started'), event(2, 'text.delta')];
    const live = [event(2, 'tool.started'), event(3, 'turn.finished')];
    const merged = mergeChildEvents(persisted, live);
    expect(merged.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(merged[1]?.type).toBe('tool.started');
  });
});

describe('mergeSubagentMessages', () => {
  const row = (id: string, createdAt: string, kind: 'message' | 'report' | 'question' | 'answer') => ({
    id,
    childId: 'sub_1',
    direction: kind === 'answer' || kind === 'message' ? ('to-child' as const) : ('to-parent' as const),
    kind,
    text: `text of ${id}`,
    createdAt,
  });

  it('merges persisted and live rows, dedupes by id and orders by time', () => {
    const persisted = [row('sm_2', '2026-01-01T00:00:02.000Z', 'report')];
    const live = [
      row('sm_1', '2026-01-01T00:00:01.000Z', 'message'),
      row('sm_2', '2026-01-01T00:00:02.000Z', 'report'),
      row('sm_3', '2026-01-01T00:00:03.000Z', 'question'),
    ];
    expect(mergeSubagentMessages(persisted, live).map((message) => message.id)).toEqual([
      'sm_1',
      'sm_2',
      'sm_3',
    ]);
  });

  it('names both directions in words', () => {
    expect(subagentMessageDirectionLabel(row('sm_1', T0, 'message'))).toBe('parent to child');
    expect(subagentMessageDirectionLabel(row('sm_2', T0, 'report'))).toBe('child to parent');
  });
});

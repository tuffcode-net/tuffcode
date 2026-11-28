import {
  DEFAULT_SETTINGS,
  councilAutonomy,
  type RpcResult,
  type Task,
  type TaskState,
} from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import { councilSummary, isCancelPending, stillTracksGoal } from './council-goal';

const CREATED = '2026-01-01T00:00:00.000Z';

function task(id: string, state: TaskState): Task {
  return {
    id,
    goalId: 'g1',
    threadId: 't1',
    title: id,
    brief: '',
    dependsOn: [],
    state,
    authorProvider: 'p1',
    authorModel: 'm1',
    reviewerProvider: null,
    reviewerModel: null,
    critical: false,
    round: 0,
    error: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function status(state: RpcResult<'council.status'>['goal']['state'], tasks: Task[]) {
  return {
    goal: {
      id: 'g1',
      threadId: 't1',
      text: 'Ship the composer',
      autonomy: 'manual' as const,
      state,
      createdAt: CREATED,
      reportedAt: null,
    },
    tasks,
    reviews: [],
  };
}

describe('councilSummary', () => {
  it('counts in-flight and passed work while planning', () => {
    const summary = councilSummary(
      status('planning', [task('a', 'queued'), task('b', 'running'), task('c', 'passed')]),
    );

    expect(summary).toMatchObject({
      state: 'planning',
      label: 'Planning',
      tone: 'info',
      running: 1,
      passed: 1,
      total: 3,
      terminal: false,
    });
  });

  it('treats merged work as passed and marks finished goals terminal', () => {
    const summary = councilSummary(
      status('done', [
        task('a', 'merged'),
        task('b', 'changes-requested'),
        task('c', 'provisioning'),
      ]),
    );

    expect(summary.passed).toBe(1);
    expect(summary.running).toBe(1);
    expect(summary.terminal).toBe(true);
    expect(summary.tone).toBe('success');
  });

  it('reports an empty goal without inventing work', () => {
    const summary = councilSummary(status('intake', []));

    expect(summary.running).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.total).toBe(0);
    expect(summary.terminal).toBe(false);
  });
});

describe('councilAutonomy', () => {
  it('leaves the decision to the captain unless the default permission is full auto', () => {
    expect(councilAutonomy(null)).toBe('manual');
    expect(councilAutonomy({ ...DEFAULT_SETTINGS, defaultPermissionMode: 'ask' })).toBe('manual');
    expect(
      councilAutonomy({ ...DEFAULT_SETTINGS, defaultPermissionMode: 'accept-edits' }),
    ).toBe('manual');
    expect(councilAutonomy({ ...DEFAULT_SETTINGS, defaultPermissionMode: 'full-auto' })).toBe(
      'auto',
    );
  });
});

describe('isCancelPending', () => {
  it('locks Stop from the moment cancel is requested until the goal is terminal', () => {
    expect(isCancelPending(true, 'planning', false)).toBe(true);
    expect(isCancelPending(true, 'running', false)).toBe(true);
    // The goal was started but its first status has not loaded yet.
    expect(isCancelPending(true, undefined, false)).toBe(true);
    expect(isCancelPending(true, 'cancelled', false)).toBe(false);
    expect(isCancelPending(true, 'failed', false)).toBe(false);
  });

  it('does not lock Stop before a cancel and releases it when polling gives up', () => {
    expect(isCancelPending(false, 'planning', false)).toBe(false);
    expect(isCancelPending(false, undefined, false)).toBe(false);
    expect(isCancelPending(true, 'planning', true)).toBe(false);
  });
});

describe('stillTracksGoal', () => {
  it('applies a late status load only for the goal the composer still follows', () => {
    expect(stillTracksGoal('goal-1', 'goal-1')).toBe(true);
    // A second goal was started while the cancel was settling.
    expect(stillTracksGoal('goal-2', 'goal-1')).toBe(false);
    // The composer was cleared by a thread switch or reload.
    expect(stillTracksGoal(null, 'goal-1')).toBe(false);
  });
});

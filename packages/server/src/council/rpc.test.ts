import type { Goal } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import { createCouncilHandlers } from './rpc.js';
import type { Council, CouncilStatus } from './types.js';

const goal: Goal = {
  id: 'gol_1',
  threadId: 'thr_1',
  text: 'Ship the widget',
  autonomy: 'auto',
  state: 'running',
  createdAt: '2026-11-24T10:00:00.000Z',
  reportedAt: null,
};

const status: CouncilStatus = { goal, tasks: [], reviews: [], escalations: [], plan: [] };

function fakeCouncil(): { council: Council; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    council: {
      start: async (input) => {
        calls.push(`start:${input.threadId}:${input.autonomy}`);
        return { goalId: goal.id };
      },
      cancel: async (goalId) => {
        calls.push(`cancel:${goalId}`);
      },
      approvePlan: async (goalId) => {
        calls.push(`approvePlan:${goalId}`);
      },
      revisePlan: async (goalId, feedback) => {
        calls.push(`revisePlan:${goalId}:${feedback}`);
      },
      answerEscalation: async (input) => {
        calls.push(`answerEscalation:${input.taskId}:${input.decision}`);
      },
      status: (goalId) => {
        calls.push(`status:${goalId}`);
        return status;
      },
      latest: (threadId) => {
        calls.push(`latest:${threadId}`);
        return status;
      },
      awaitGoal: async () => goal,
      dispose: async () => undefined,
    },
  };
}

describe('createCouncilHandlers', () => {
  it('registers exactly the council methods', () => {
    const { council } = fakeCouncil();
    expect(Array.from(createCouncilHandlers({ council }).keys()).toSorted()).toEqual([
      'council.answerEscalation',
      'council.approvePlan',
      'council.cancel',
      'council.latest',
      'council.revisePlan',
      'council.start',
      'council.status',
    ]);
  });

  it('delegates start, cancel, status and latest', async () => {
    const { council, calls } = fakeCouncil();
    const handlers = createCouncilHandlers({ council });

    await expect(
      handlers.get('council.start')?.({
        threadId: 'thr_1',
        goal: 'Ship the widget',
        autonomy: 'auto',
      }),
    ).resolves.toEqual({ goalId: 'gol_1' });
    await expect(handlers.get('council.cancel')?.({ goalId: 'gol_1' })).resolves.toEqual({});
    expect(handlers.get('council.status')?.({ goalId: 'gol_1' })).toBe(status);
    expect(handlers.get('council.latest')?.({ threadId: 'thr_1' })).toBe(status);
    expect(calls).toEqual(['start:thr_1:auto', 'cancel:gol_1', 'status:gol_1', 'latest:thr_1']);
  });

  it('delegates the captain answers', async () => {
    const { council, calls } = fakeCouncil();
    const handlers = createCouncilHandlers({ council });

    await expect(handlers.get('council.approvePlan')?.({ goalId: 'gol_1' })).resolves.toEqual({});
    await expect(
      handlers.get('council.revisePlan')?.({ goalId: 'gol_1', feedback: 'Split the parser' }),
    ).resolves.toEqual({});
    await expect(
      handlers.get('council.answerEscalation')?.({
        taskId: 'tsk_1',
        decision: 'revise',
        feedback: 'Cover the null case',
      }),
    ).resolves.toEqual({});
    expect(calls).toEqual([
      'approvePlan:gol_1',
      'revisePlan:gol_1:Split the parser',
      'answerEscalation:tsk_1:revise',
    ]);
  });
});

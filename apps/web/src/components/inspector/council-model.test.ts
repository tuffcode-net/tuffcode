import { describe, expect, it } from 'vitest';
import {
  GOAL_STATES,
  GOAL_STATE_LABEL,
  GOAL_STATE_TONE,
  REVIEW_VERDICTS,
  REVIEW_VERDICT_LABEL,
  REVIEW_VERDICT_TONE,
  TASK_STATES,
  TASK_STATE_LABEL,
  TASK_STATE_TONE,
  councilErrorMessage,
  countFinishedTasks,
  isGoalTerminal,
  isPermanentCouncilFailure,
} from './council-model';

describe('council state labels', () => {
  it('labels and tones every goal state', () => {
    expect(GOAL_STATES.map((state) => GOAL_STATE_LABEL[state])).toEqual([
      'Intake',
      'Planning',
      'Awaiting approval',
      'Provisioning',
      'Running',
      'Reviewing',
      'Reporting',
      'Done',
      'Failed',
      'Cancelled',
    ]);
    expect(GOAL_STATE_TONE['awaiting-approval']).toBe('warning');
    expect(GOAL_STATE_TONE.done).toBe('success');
    expect(GOAL_STATE_TONE.failed).toBe('error');
    expect(GOAL_STATE_TONE.cancelled).toBe('neutral');
  });

  it('labels and tones every task state', () => {
    expect(TASK_STATES.map((state) => TASK_STATE_LABEL[state])).toEqual([
      'Queued',
      'Provisioning',
      'Running',
      'Blocked',
      'PR open',
      'Reviewing',
      'Changes requested',
      'Passed',
      'Merged',
      'Awaiting captain',
      'Failed',
      'Cancelled',
    ]);
    expect(TASK_STATE_TONE['awaiting-captain']).toBe('warning');
    expect(TASK_STATE_TONE.merged).toBe('success');
  });

  it('labels and tones every review verdict', () => {
    expect(REVIEW_VERDICTS.map((verdict) => REVIEW_VERDICT_LABEL[verdict])).toEqual([
      'Pass',
      'Changes requested',
      'Escalate',
    ]);
    expect(REVIEW_VERDICT_TONE.pass).toBe('success');
    expect(REVIEW_VERDICT_TONE['changes-requested']).toBe('warning');
    expect(REVIEW_VERDICT_TONE.escalate).toBe('error');
  });
});

describe('council goal helpers', () => {
  it('treats done, failed and cancelled as terminal', () => {
    expect(GOAL_STATES.filter((state) => isGoalTerminal(state))).toEqual([
      'done',
      'failed',
      'cancelled',
    ]);
  });

  it('counts tasks that no longer need attention', () => {
    expect(
      countFinishedTasks([
        { state: 'running' },
        { state: 'passed' },
        { state: 'merged' },
        { state: 'failed' },
        { state: 'cancelled' },
      ]),
    ).toBe(4);
  });
});

describe('council error messages', () => {
  it('explains that the server has no council runtime', () => {
    expect(
      councilErrorMessage({
        code: 'bad-request',
        message: 'unknown method: council.start',
      }),
    ).toBe(
      'This server does not run council goals yet. Everything else in the inspector still works.',
    );
  });

  it('passes a real server error through and falls back for unknown throws', () => {
    expect(councilErrorMessage(new Error('thread not found'))).toBe('thread not found');
    expect(councilErrorMessage({ code: 'not-found', message: 'goal not found' })).toBe(
      'The council request failed.',
    );
    expect(councilErrorMessage('boom')).toBe('The council request failed.');
  });

  it('separates permanent failures from transient ones', () => {
    expect(isPermanentCouncilFailure({ code: 'not-found' })).toBe(true);
    expect(isPermanentCouncilFailure({ code: 'bad-request' })).toBe(true);
    expect(isPermanentCouncilFailure({ code: 'permission-denied' })).toBe(true);
    expect(isPermanentCouncilFailure({ code: 'internal' })).toBe(false);
    expect(isPermanentCouncilFailure(new Error('socket closed'))).toBe(false);
    expect(isPermanentCouncilFailure(null)).toBe(false);
  });
});

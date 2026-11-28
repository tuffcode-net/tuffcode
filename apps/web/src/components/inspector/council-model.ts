import type { GoalState, ReviewVerdict, TaskState } from '@tuffcode/contracts';

export type CouncilTone = 'neutral' | 'primary' | 'info' | 'success' | 'warning' | 'error';

export const GOAL_STATES = [
  'intake',
  'planning',
  'awaiting-approval',
  'provisioning',
  'running',
  'reviewing',
  'reporting',
  'done',
  'failed',
  'cancelled',
] as const satisfies readonly GoalState[];

export const GOAL_STATE_LABEL: Record<GoalState, string> = {
  intake: 'Intake',
  planning: 'Planning',
  'awaiting-approval': 'Awaiting approval',
  provisioning: 'Provisioning',
  running: 'Running',
  reviewing: 'Reviewing',
  reporting: 'Reporting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const GOAL_STATE_TONE: Record<GoalState, CouncilTone> = {
  intake: 'neutral',
  planning: 'info',
  'awaiting-approval': 'warning',
  provisioning: 'info',
  running: 'primary',
  reviewing: 'info',
  reporting: 'info',
  done: 'success',
  failed: 'error',
  cancelled: 'neutral',
};

export const TASK_STATES = [
  'queued',
  'provisioning',
  'running',
  'blocked',
  'pr-open',
  'reviewing',
  'changes-requested',
  'passed',
  'merged',
  'awaiting-captain',
  'failed',
  'cancelled',
] as const satisfies readonly TaskState[];

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: 'Queued',
  provisioning: 'Provisioning',
  running: 'Running',
  blocked: 'Blocked',
  'pr-open': 'PR open',
  reviewing: 'Reviewing',
  'changes-requested': 'Changes requested',
  passed: 'Passed',
  merged: 'Merged',
  'awaiting-captain': 'Awaiting captain',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const TASK_STATE_TONE: Record<TaskState, CouncilTone> = {
  queued: 'neutral',
  provisioning: 'info',
  running: 'primary',
  blocked: 'warning',
  'pr-open': 'info',
  reviewing: 'info',
  'changes-requested': 'warning',
  passed: 'success',
  merged: 'success',
  'awaiting-captain': 'warning',
  failed: 'error',
  cancelled: 'neutral',
};

export const REVIEW_VERDICTS = [
  'pass',
  'changes-requested',
  'escalate',
] as const satisfies readonly ReviewVerdict[];

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  pass: 'Pass',
  'changes-requested': 'Changes requested',
  escalate: 'Escalate',
};

export const REVIEW_VERDICT_TONE: Record<ReviewVerdict, CouncilTone> = {
  pass: 'success',
  'changes-requested': 'warning',
  escalate: 'error',
};

const TERMINAL_GOAL_STATES: Partial<Record<GoalState, true>> = {
  done: true,
  failed: true,
  cancelled: true,
};

export function isGoalTerminal(state: GoalState): boolean {
  return TERMINAL_GOAL_STATES[state] === true;
}

/** Tasks that no longer need attention; used for the progress line. */
const FINISHED_TASK_STATES: Partial<Record<TaskState, true>> = {
  passed: true,
  merged: true,
  failed: true,
  cancelled: true,
};

export function countFinishedTasks(tasks: readonly { state: TaskState }[]): number {
  return tasks.filter((task) => FINISHED_TASK_STATES[task.state] === true).length;
}

function isUnknownCouncilMethod(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const { code, message } = cause as { code?: unknown; message?: unknown };
  return (
    code === 'bad-request' &&
    typeof message === 'string' &&
    message.startsWith('unknown method: council.')
  );
}

const PERMANENT_FAILURE_CODES: Partial<Record<string, true>> = {
  'bad-request': true,
  'not-found': true,
  'permission-denied': true,
  unauthorized: true,
};

/** Errors that retrying the same goal id cannot fix; polling stops until the user asks. */
export function isPermanentCouncilFailure(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const { code } = cause as { code?: unknown };
  return typeof code === 'string' && PERMANENT_FAILURE_CODES[code] === true;
}

export function councilErrorMessage(cause: unknown): string {
  if (isUnknownCouncilMethod(cause)) {
    return 'This server does not run council goals yet. Everything else in the inspector still works.';
  }
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return 'The council request failed.';
}

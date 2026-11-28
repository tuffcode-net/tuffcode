/**
 * Council limits from spec section 7. They are constants, not settings: a goal that
 * needs more than this is a planning bug, and the caps are what stop a runaway PR
 * storm before it starts.
 */
export const COUNCIL_CAPS = {
  concurrentWorkers: 8,
  tasksPerGoal: 12,
  reviewRounds: 3,
  goalsPerThread: 2,
  /** A manual plan may be sent back to the planner this many times before it fails. */
  planRevisions: 2,
} as const;

/** Goal states that no longer consume a goal slot on the thread. */
export const TERMINAL_GOAL_STATES: Readonly<Record<string, true>> = {
  done: true,
  failed: true,
  cancelled: true,
};

/** Task states that need no further worker or reviewer. */
export const TERMINAL_TASK_STATES: Readonly<Record<string, true>> = {
  passed: true,
  merged: true,
  'awaiting-captain': true,
  failed: true,
  cancelled: true,
};

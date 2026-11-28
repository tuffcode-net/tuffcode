import type {
  GoalState,
  RpcResult,
  Task,
  TaskState,
} from '@tuffcode/contracts';
import {
  GOAL_STATE_LABEL,
  GOAL_STATE_TONE,
  isGoalTerminal,
  type CouncilTone,
} from '../inspector/council-model';

/** Tasks the orchestrator is actively working on right now. */
const RUNNING_TASK_STATES: Partial<Record<TaskState, true>> = {
  provisioning: true,
  running: true,
};

/** Tasks that came out of review in one piece. */
const PASSED_TASK_STATES: Partial<Record<TaskState, true>> = {
  passed: true,
  merged: true,
};

export interface CouncilSummary {
  state: GoalState;
  label: string;
  tone: CouncilTone;
  /** Tasks provisioning or running. */
  running: number;
  /** Tasks that passed or merged. */
  passed: number;
  total: number;
  /** No further state changes will arrive for this goal. */
  terminal: boolean;
}

function countTasks(tasks: readonly Task[], states: Partial<Record<TaskState, true>>): number {
  return tasks.filter((task) => states[task.state] === true).length;
}

/**
 * The one-line status the composer strip shows: the goal state plus how much work
 * is in flight and how much has passed review.
 */
export function councilSummary(status: RpcResult<'council.status'>): CouncilSummary {
  const { goal, tasks } = status;
  return {
    state: goal.state,
    label: GOAL_STATE_LABEL[goal.state],
    tone: GOAL_STATE_TONE[goal.state],
    running: countTasks(tasks, RUNNING_TASK_STATES),
    passed: countTasks(tasks, PASSED_TASK_STATES),
    total: tasks.length,
    terminal: isGoalTerminal(goal.state),
  };
}

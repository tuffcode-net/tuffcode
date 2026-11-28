import type {
  Escalation,
  EscalationDecision,
  ExecutionMode,
  Goal,
  GoalAutonomy,
  PermissionMode,
  Review,
  Task,
  Thread,
} from '@tuffcode/contracts';
import type { CreateIntegrationBranchInput, IntegrationBranch } from './integration.js';

/** One task exactly as the planner returned it, after validation. */
export interface PlanTask {
  title: string;
  files: string[];
  dependsOn: string[];
  critical: boolean;
  brief: string;
}

export interface CouncilPlan {
  tasks: PlanTask[];
  question: string | null;
}

export type TurnStatus = 'complete' | 'interrupted' | 'error';

/** The outcome of one runner turn, including the assistant text it produced. */
export interface TurnResult {
  threadId: string;
  turnId: string;
  status: TurnStatus;
  text: string;
  error?: string;
}

export interface RunTurnInput {
  threadId: string;
  text: string;
  signal: AbortSignal;
}

export interface ChildThreadRequest {
  projectId: string;
  parentThreadId: string;
  title: string;
  providerId: string;
  modelId: string;
  executionMode: ExecutionMode;
  permissionMode: PermissionMode;
  baseBranch: string;
  /** The branch or commit the task worktree starts from; absent means `baseBranch`. */
  startRef?: string;
  /** The role's configured reasoning effort; null means inherit. */
  effort?: string | null;
}

/** What the task branch changed relative to its base branch. */
export interface TaskChanges {
  changed: boolean;
  files: string[];
  patch: string;
}

export interface PullRequestRequest {
  title: string;
  body: string;
}

export interface PullRequest {
  url: string;
  number: number;
}

/**
 * Every effect council has on the outside world. The service never imports git, the
 * runner, or the thread helpers directly; it goes through these ports so tests can
 * drive a full goal with fake adapters and no process, network, or disk checkout.
 */
export interface CouncilPorts {
  createThread(request: ChildThreadRequest): Promise<Thread>;
  /** Merges several dependency branches into one temporary base branch a task starts from. */
  createIntegrationBranch(input: CreateIntegrationBranchInput): Promise<IntegrationBranch>;
  deleteThread(threadId: string): Promise<void>;
  runTurn(input: RunTurnInput): Promise<TurnResult>;
  /** Answers an approval a child raised; council decides, the runner applies it. */
  approve(threadId: string, approvalId: string, decision: 'allow' | 'deny'): Promise<void>;
  openPullRequest(threadId: string, request: PullRequestRequest): Promise<PullRequest>;
  /** Commits any leftover work and pushes it so a rework reaches the PR before review. */
  syncPullRequest?(threadId: string): Promise<void>;
  changesForThread(threadId: string): Promise<TaskChanges>;
}

export interface CouncilStatus {
  goal: Goal;
  tasks: Task[];
  reviews: Review[];
  /** Every escalation the goal raised, newest last, so a captain reads the question. */
  escalations: Escalation[];
  /** The plan the live run holds in memory; empty once the run settled or after a restart. */
  plan: CouncilPlanTaskView[];
}

/** One planned task as the board and the approval panel read it. */
export interface CouncilPlanTaskView {
  taskId: string;
  title: string;
  files: string[];
  dependsOn: string[];
  critical: boolean;
}

export interface CouncilStartInput {
  threadId: string;
  goal: string;
  autonomy: GoalAutonomy;
}

export interface CouncilEscalationAnswer {
  taskId: string;
  decision: EscalationDecision;
  feedback?: string;
}

export interface Council {
  /** Creates the goal row and starts orchestration; resolves before planning begins. */
  start(input: CouncilStartInput): Promise<{ goalId: string }>;
  /** Stops every worker, disposes child threads, and marks open rows cancelled. */
  cancel(goalId: string): Promise<void>;
  /** Releases a manual goal parked in `awaiting-approval` to run the approved plan. */
  approvePlan(goalId: string): Promise<void>;
  /** Sends a manual plan back to the planner with the captain feedback. */
  revisePlan(goalId: string, feedback: string): Promise<void>;
  /** Answers a task escalation: accept it, ask for one revision, or drop it. */
  answerEscalation(input: CouncilEscalationAnswer): Promise<void>;
  status(goalId: string): CouncilStatus;
  /** The thread's newest goal with its tasks and reviews; null before the first goal. */
  latest(threadId: string): CouncilStatus | null;
  /** Test and shutdown hook: resolves when the goal run has fully settled. */
  awaitGoal(goalId: string): Promise<Goal>;
  /** Cancels every live goal; safe to call more than once. */
  dispose(): Promise<void>;
}

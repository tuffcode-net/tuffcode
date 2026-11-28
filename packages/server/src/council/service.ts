import type {
  Goal,
  GoalState,
  Project,
  ProviderView,
  Review,
  ReviewVerdict,
  SubagentModelChoice,
  Task,
  TaskState,
  Thread,
} from '@tuffcode/contracts';
import { newId, worktreesRoot, type Logger } from '@tuffcode/shared';
import type { Repos, TaskStatePatch } from '../db/repos/index.js';
import { badRequest, conflict, notFound, RpcError } from '../errors.js';
import type { EventBus } from '../events.js';
import { commitThread, openPullRequest as openPullRequestInRepo, pushThread } from '../git/index.js';
import type { Runner } from '../runner/runner.js';
import { COUNCIL_CAPS, TERMINAL_GOAL_STATES, TERMINAL_TASK_STATES } from './caps.js';
import { providerFamily, selectReviewer } from './family.js';
import { changesForThread } from './git.js';
import { createIntegrationBranch, type IntegrationBranch } from './integration.js';
import { parsePlan } from './plan.js';
import {
  buildCaptainRevisionBrief,
  buildPlannerPrompt,
  buildReviewPrompt,
  buildRevisionBrief,
  buildWorkerBrief,
  parsePullRequestUrl,
  parseReviewVerdict,
} from './prompts.js';
import { createBusTurnRunner } from './runner-turn.js';
import { deriveTitle } from '../titles.js';
import { deleteChildThread, provisionChildThread } from './threads.js';
import type {
  Council,
  CouncilEscalationAnswer,
  CouncilPorts,
  CouncilStartInput,
  CouncilStatus,
  CouncilPlan,
  CouncilPlanTaskView,
  PlanTask,
  PullRequest,
  TurnResult,
} from './types.js';

export interface CouncilDeps {
  repos: Repos;
  bus: EventBus;
  runner: Runner;
  logger: Logger;
  /** Test seam: any port may be replaced by a fake. */
  ports?: Partial<CouncilPorts>;
}

interface GoalRun {
  goalId: string;
  threadId: string;
  controller: AbortController;
  cancelled: boolean;
  childThreads: Set<string>;
  planTasks: Map<string, PlanTask>;
  /** The one wait slot a plan approval or an escalation answer resolves. */
  parking: GoalParking;
  /** True while an escalation answer runs its revision turn outside the dispatch loop. */
  answering: boolean;
  promise: Promise<void>;
  resolveDone: () => void;
}

type ParkingKind = 'plan' | 'escalation';

/** What a parked manual goal receives: approval, or plan feedback for the planner. */
type PlanDecision = { kind: 'approve' } | { kind: 'revise'; feedback: string };

interface ParkingWaiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * One wait slot per run, so a goal never busy-waits. The RPC that answers resolves
 * the slot. A decision that arrives before the run reaches its wait is kept and
 * consumed by the next park, which closes the race between the state event and the
 * captain's click. Cancellation and shutdown reject the slot so the run exits.
 */
interface GoalParking {
  park<T>(kind: ParkingKind): Promise<T>;
  /** True when the decision was delivered, either to a parked run or for the next park. */
  resume(kind: ParkingKind, value: unknown): boolean;
  fail(error: Error): void;
}

function createParking(): GoalParking {
  let parked: { kind: ParkingKind; waiter: ParkingWaiter } | null = null;
  let early: { kind: ParkingKind; value: unknown } | null = null;
  return {
    park<T>(kind: ParkingKind): Promise<T> {
      if (parked !== null) throw new Error('council run is already parked');
      if (early !== null && early.kind === kind) {
        const value = early.value;
        early = null;
        return Promise.resolve(value as T);
      }
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      parked = { kind, waiter: { resolve, reject } };
      return promise as Promise<T>;
    },
    resume(kind, value): boolean {
      const current = parked;
      if (current !== null) {
        if (current.kind !== kind) return false;
        parked = null;
        current.waiter.resolve(value);
        return true;
      }
      if (early !== null && early.kind !== kind) return false;
      early = { kind, value };
      return true;
    },
    fail(error): void {
      early = null;
      const current = parked;
      if (current === null) return;
      parked = null;
      current.waiter.reject(error);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a child turn failed: the adapter's own text, then its throw, then its status. */
function turnFailure(role: string, result: TurnResult, detail: string | null): Error {
  return new Error(detail ?? result.error ?? `${role} turn ${result.status}`);
}

function pullRequestNumber(url: string): number {
  const match = /\/pull\/(\d+)/.exec(url);
  return match === null ? 0 : Number.parseInt(match[1] ?? '0', 10);
}

function dependenciesPassed(planTask: PlanTask, byTitle: Map<string, Task>): boolean {
  return planTask.dependsOn.every((title) => {
    const task = byTitle.get(title.toLowerCase());
    return task !== undefined && (task.state === 'passed' || task.state === 'merged');
  });
}

function blockedReason(planTask: PlanTask, byTitle: Map<string, Task>): string {
  const waiting = planTask.dependsOn.map((title) => {
    const task = byTitle.get(title.toLowerCase());
    return `"${title}" is ${task === undefined ? 'missing' : task.state}`;
  });
  return `blocked by ${waiting.join(', ')}`;
}

/**
 * True when a queued task waits on a captain decision, directly or through other
 * queued tasks: every dependency either passed or leads to an awaiting-captain task,
 * and at least one leads there. A fan-in task behind two escalated branches is waiting
 * too, so it parks with them instead of being terminalized. A dependency that failed,
 * is blocked, or is missing is not waiting, so the failure path runs.
 */
function waitsOnCaptain(
  planTask: PlanTask,
  byTitle: Map<string, Task>,
  planTasks: Map<string, PlanTask>,
  seen: Set<string> = new Set(),
): boolean {
  let waiting = false;
  for (const title of planTask.dependsOn) {
    const dependency = byTitle.get(title.toLowerCase());
    if (dependency === undefined) return false;
    if (dependency.state === 'passed' || dependency.state === 'merged') continue;
    if (dependency.state === 'awaiting-captain') {
      waiting = true;
      continue;
    }
    if (dependency.state === 'queued') {
      const dependencyPlan = planTasks.get(dependency.id);
      if (dependencyPlan === undefined || seen.has(dependency.id)) return false;
      seen.add(dependency.id);
      if (!waitsOnCaptain(dependencyPlan, byTitle, planTasks, seen)) return false;
      waiting = true;
      continue;
    }
    return false;
  }
  return waiting;
}

function escalationQuestion(
  planTask: PlanTask,
  verdict: ReviewVerdict,
  round: number,
  body: string,
): string {
  const reason =
    verdict === 'escalate' ? 'the reviewer escalated' : `round ${round} still requested changes`;
  const detail = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12)
    .join('\n');
  return `Task "${planTask.title}": ${reason}. Captain decision required.\n\n${detail}`;
}

/** The provider and model one council role actually runs with. */
export interface CouncilModelTarget {
  providerId: string;
  modelId: string;
}

/**
 * A resolved role target plus the role's configured reasoning effort. The effort
 * follows the role's `settings.subagentModels` entry rather than the model that wins,
 * matching how subagent spawns treat it; null leaves the child on its own default.
 */
export interface CouncilRoleTarget extends CouncilModelTarget {
  effort: string | null;
}

export interface CouncilModelInput {
  /** The role's `settings.subagentModels` entry; empty when the user never chose. */
  choice: SubagentModelChoice | undefined;
  providers: readonly ProviderView[];
  /** The goal thread's own provider and model. */
  fallback: CouncilModelTarget;
}

/**
 * Picks the provider and model for one council role. Order: the per-type setting's
 * model on its configured provider (or the goal thread's provider when only a model
 * was named), that setting's fallback model when the primary cannot run, then the goal
 * thread's own model. A candidate whose provider is missing or disabled never runs,
 * so a stale settings entry degrades to the thread model instead of failing the goal.
 */
export function resolveCouncilModel(input: CouncilModelInput): CouncilModelTarget {
  const usable = (providerId: string): boolean =>
    providerId.length > 0 &&
    input.providers.some((provider) => provider.id === providerId && provider.enabled);
  const configured = input.choice?.providerId?.trim() ?? '';
  const providerId = configured.length > 0 ? configured : input.fallback.providerId;
  const model = input.choice?.model?.trim() ?? '';
  if (model.length > 0 && usable(providerId)) return { providerId, modelId: model };
  const fallbackModel = input.choice?.fallbackModel?.trim() ?? '';
  if (fallbackModel.length > 0) {
    const fallbackProvider = usable(providerId) ? providerId : input.fallback.providerId;
    if (usable(fallbackProvider)) return { providerId: fallbackProvider, modelId: fallbackModel };
  }
  return { providerId: input.fallback.providerId, modelId: input.fallback.modelId };
}

/**
 * Council orchestration: one goal thread, a planner turn, one child thread per
 * task, a pull request per task, and one cross-family review per round. All side
 * effects go through `CouncilPorts`, so the service itself is a state machine over
 * the council repos.
 */
export function createCouncil(deps: CouncilDeps): Council {
  const { repos, bus, logger } = deps;
  const overrides = deps.ports ?? {};
  // Ports may be class instances whose methods live on the prototype, so every
  // override is bound before it is called from the service.
  const ports: CouncilPorts = {
    createThread:
      overrides.createThread?.bind(overrides) ??
      ((request) => provisionChildThread(repos, request)),
    createIntegrationBranch:
      overrides.createIntegrationBranch?.bind(overrides) ??
      ((input) => createIntegrationBranch(input)),
    deleteThread:
      overrides.deleteThread?.bind(overrides) ?? ((threadId) => deleteChildThread(repos, threadId)),
    runTurn:
      overrides.runTurn?.bind(overrides) ??
      createBusTurnRunner({
        bus,
        runner: deps.runner,
        approve: (threadId, approvalId, decision) => ports.approve(threadId, approvalId, decision),
        logger,
      }),
    approve:
      overrides.approve?.bind(overrides) ??
      ((threadId, approvalId, decision) => deps.runner.approve(threadId, approvalId, decision)),
    openPullRequest:
      overrides.openPullRequest?.bind(overrides) ??
      (async (threadId, request) => {
        await pushThread(repos, threadId);
        const result = await openPullRequestInRepo(repos, threadId, { ...request, draft: false });
        repos.threads.setPrUrl(threadId, result.url);
        return result;
      }),
    syncPullRequest:
      overrides.syncPullRequest?.bind(overrides) ??
      (async (threadId) => {
        // A worker told to commit may still leave edits in the tree; the reviewer reads
        // the local diff, so the PR must be brought level before the next round.
        try {
          await commitThread(repos, threadId, 'council: revision');
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== 'conflict') throw error;
          // Nothing to commit: the worker committed its own change.
        }
        await pushThread(repos, threadId);
      }),
    changesForThread:
      overrides.changesForThread?.bind(overrides) ??
      ((threadId) => changesForThread(repos, threadId)),
  };
  const runs = new Map<string, GoalRun>();

  function emitGoal(goal: Goal): void {
    bus.emit({
      kind: 'event',
      type: 'council.updated',
      threadId: goal.threadId,
      payload: { goalId: goal.id, state: goal.state },
    });
  }

  /**
   * A task change carries its id and new state, so the board refreshes on the event
   * instead of waiting for its poll. The goal state rides along for the same reason.
   */
  function emitTask(goalId: string, task: Task): void {
    const goal = repos.council.getGoal(goalId);
    if (goal === undefined) return;
    bus.emit({
      kind: 'event',
      type: 'council.updated',
      threadId: goal.threadId,
      payload: {
        goalId,
        state: goal.state,
        taskId: task.id,
        taskState: task.state,
      },
    });
  }

  function requireGoal(goalId: string): Goal {
    const goal = repos.council.getGoal(goalId);
    if (goal === undefined) throw notFound('goal not found');
    return goal;
  }

  function requireThread(threadId: string): Thread {
    const thread = repos.threads.get(threadId);
    if (thread === undefined) throw notFound('thread not found');
    return thread;
  }

  function requireTask(taskId: string): Task {
    const task = repos.council.getTask(taskId);
    if (task === undefined) throw notFound('task not found');
    return task;
  }

  /** The provider, model and reasoning effort one role runs with, from live settings. */
  function modelTarget(
    role: 'planner' | 'worker' | 'reviewer',
    thread: Thread,
  ): CouncilRoleTarget {
    const choice = repos.settings.get().subagentModels[role];
    return {
      ...resolveCouncilModel({
        choice,
        providers: repos.providers.list(),
        fallback: { providerId: thread.providerId, modelId: thread.modelId },
      }),
      effort: choice.effort ?? null,
    };
  }

  /**
   * A reviewer the user configured explicitly, or null when the reviewer setting names
   * no model the provider list can run. An unusable entry falls through to the
   * cross-family rule rather than reviewing with the author's own model.
   */
  function configuredReviewer(thread: Thread): CouncilModelTarget | null {
    const choice = repos.settings.get().subagentModels.reviewer;
    const named =
      (choice.model?.trim() ?? '').length > 0 || (choice.fallbackModel?.trim() ?? '').length > 0;
    if (!named) return null;
    const target = modelTarget('reviewer', thread);
    return target.providerId === thread.providerId && target.modelId === thread.modelId
      ? null
      : target;
  }

  /**
   * Runs one child turn and keeps the adapter's own error frame, which the runner
   * appends before `turn.finished`. A turn that ends as `error` then reports the
   * provider's text (an upstream 502, a refused request) instead of only its status.
   */
  async function runChildTurn(
    threadId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{ result: TurnResult; detail: string | null }> {
    let detail: string | null = null;
    const unsubscribe = bus.subscribe((event) => {
      if (event.type !== 'thread.event' || event.threadId !== threadId) return;
      if (event.payload.type !== 'error') return;
      detail = event.payload.message;
    });
    try {
      return { result: await ports.runTurn({ threadId, text, signal }), detail };
    } finally {
      unsubscribe();
    }
  }

  function advanceGoal(goalId: string, state: GoalState, reportedAt: string | null = null): Goal {
    const current = requireGoal(goalId);
    if (current.state === state) return current;
    if (TERMINAL_GOAL_STATES[current.state] === true) return current;
    const next = repos.council.setGoalState(goalId, state, reportedAt) ?? current;
    emitGoal(next);
    return next;
  }

  function advanceTask(
    run: GoalRun,
    taskId: string,
    state: TaskState,
    patch?: TaskStatePatch,
  ): Task | undefined {
    if (run.cancelled && state !== 'cancelled') return undefined;
    const current = repos.council.getTask(taskId);
    if (current === undefined) return undefined;
    if (TERMINAL_TASK_STATES[current.state] === true && state !== current.state) return current;
    const next = repos.council.setTaskState(taskId, state, patch);
    if (next !== undefined && (next.state !== current.state || patch !== undefined)) {
      emitTask(run.goalId, next);
    }
    return next;
  }

  /**
   * Moves a task out of a terminal state, which advanceTask refuses. Only a captain
   * answer uses this: accept, drop and revise all start from `awaiting-captain`.
   */
  function reopenTask(
    run: GoalRun,
    taskId: string,
    state: TaskState,
    patch?: TaskStatePatch,
  ): Task | undefined {
    const current = repos.council.getTask(taskId);
    if (current === undefined) return undefined;
    const next = repos.council.setTaskState(taskId, state, patch);
    if (next !== undefined) emitTask(run.goalId, next);
    return next;
  }

  function addGoalMessage(goal: Goal, content: string): void {
    repos.messages.add({
      id: newId('msg'),
      threadId: goal.threadId,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
    });
  }

  async function disposeChild(run: GoalRun, threadId: string): Promise<void> {
    try {
      await ports.deleteThread(threadId);
    } catch (error) {
      logger.warn('council child thread dispose failed', {
        goalId: run.goalId,
        threadId,
        message: errorMessage(error),
      });
    }
    run.childThreads.delete(threadId);
  }

  function cancelOpenTasks(goalId: string): void {
    for (const task of repos.council.listTasks(goalId)) {
      if (TERMINAL_TASK_STATES[task.state] === true) continue;
      const cancelled = repos.council.setTaskState(task.id, 'cancelled');
      if (cancelled !== undefined) emitTask(goalId, cancelled);
    }
  }

  function failOpenTasks(goalId: string, message: string): void {
    for (const task of repos.council.listTasks(goalId)) {
      if (TERMINAL_TASK_STATES[task.state] === true) continue;
      const failed = repos.council.setTaskState(task.id, 'failed', { error: message });
      if (failed !== undefined) emitTask(goalId, failed);
    }
  }

  async function planGoal(
    goal: Goal,
    run: GoalRun,
    revision?: { round: number; feedback: string },
  ): Promise<CouncilPlan> {
    const thread = requireThread(goal.threadId);
    const project = repos.projects.get(thread.projectId);
    if (project === undefined) throw notFound('project not found');
    const baseBranch = thread.baseBranch ?? project.defaultBranch;
    const plannerModel = modelTarget('planner', thread);
    const planner = await ports.createThread({
      projectId: project.id,
      parentThreadId: thread.id,
      title: `Plan: ${deriveTitle(goal.text, 54) ?? 'council goal'}`,
      providerId: plannerModel.providerId,
      modelId: plannerModel.modelId,
      executionMode: 'plan',
      permissionMode: 'full-auto',
      baseBranch,
      effort: plannerModel.effort,
    });
    run.childThreads.add(planner.id);
    const prompt = buildPlannerPrompt({
      goal: goal.text,
      projectName: project.name,
      projectPath: project.path,
      baseBranch,
      ...(revision === undefined ? {} : { revision }),
    });
    // One malformed planner reply must not fail the goal: the same planner thread is
    // asked once more with the validation error, and only a second failure ends it.
    const attempt = async (text: string): Promise<CouncilPlan | Error> => {
      try {
        const { result, detail } = await runChildTurn(planner.id, text, run.controller.signal);
        if (result.status !== 'complete') throw turnFailure('planner', result, detail);
        return parsePlan(result.text);
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    };
    try {
      const first = await attempt(prompt);
      if (!(first instanceof Error)) {
        return run.cancelled ? { tasks: [], question: null } : first;
      }
      if (run.cancelled) return { tasks: [], question: null };
      logger.warn('council planner reply rejected; retrying once', {
        goalId: goal.id,
        message: first.message,
      });
      const correction = [
        prompt,
        '',
        'CORRECTION',
        `The previous reply was rejected: ${first.message}`,
        'Return the same JSON object shape, corrected. No prose.',
      ].join('\n');
      const second = await attempt(correction);
      if (!(second instanceof Error)) {
        return run.cancelled ? { tasks: [], question: null } : second;
      }
      throw new Error(`planner failed twice: ${first.message}; retry: ${second.message}`);
    } finally {
      await disposeChild(run, planner.id);
    }
  }

  function createTasks(goal: Goal, run: GoalRun, planTasks: readonly PlanTask[]): void {
    const thread = requireThread(goal.threadId);
    const workerModel = modelTarget('worker', thread);
    for (const planTask of planTasks) {
      const task = repos.council.createTask({
        goalId: goal.id,
        title: planTask.title,
        brief: planTask.brief,
        dependsOn: planTask.dependsOn,
        state: 'queued',
        authorProvider: workerModel.providerId,
        authorModel: workerModel.modelId,
        critical: planTask.critical,
        round: 0,
      });
      run.planTasks.set(task.id, planTask);
    }
  }

  /**
   * Retires the previous plan before a revision writes the next one. Nothing has been
   * dispatched at `awaiting-approval`, so every task is still queued; cancelling the
   * rows keeps the history instead of deleting work the user may want to read.
   */
  function retirePlanTasks(goal: Goal, run: GoalRun): void {
    for (const task of repos.council.listTasks(goal.id)) {
      if (TERMINAL_TASK_STATES[task.state] === true) continue;
      const cancelled = repos.council.setTaskState(task.id, 'cancelled');
      if (cancelled !== undefined) emitTask(goal.id, cancelled);
    }
    run.planTasks.clear();
  }

  async function ensurePullRequest(
    goal: Goal,
    planTask: PlanTask,
    child: Thread,
    workerReport: string,
  ): Promise<PullRequest> {
    const existingUrl = repos.threads.get(child.id)?.prUrl ?? parsePullRequestUrl(workerReport);
    if (existingUrl !== null && existingUrl !== undefined) {
      repos.threads.setPrUrl(child.id, existingUrl);
      return { url: existingUrl, number: pullRequestNumber(existingUrl) };
    }
    const changes = await ports.changesForThread(child.id);
    if (!changes.changed) throw new Error('worker produced no changes');
    const result = await ports.openPullRequest(child.id, {
      title: planTask.title,
      body: [
        `Goal: ${goal.text}`,
        '',
        planTask.brief,
        '',
        `Council task opened automatically for goal ${goal.id}.`,
      ].join('\n'),
    });
    repos.threads.setPrUrl(child.id, result.url);
    return result;
  }

  function maybeEnterReviewing(goal: Goal): void {
    const current = repos.council.getGoal(goal.id);
    if (current === undefined || current.state !== 'running') return;
    const working = repos.council
      .listTasks(goal.id)
      .some(
        (task) =>
          task.state === 'queued' ||
          task.state === 'provisioning' ||
          task.state === 'running' ||
          task.state === 'changes-requested',
      );
    if (!working) advanceGoal(goal.id, 'reviewing');
  }

  async function reviewTask(
    goal: Goal,
    run: GoalRun,
    task: Task,
    planTask: PlanTask,
    child: Thread,
    pullRequest: PullRequest,
    workerReport: string,
  ): Promise<void> {
    const goalThread = requireThread(goal.threadId);
    const reviewerModel = modelTarget('reviewer', goalThread);
    const selection =
      configuredReviewer(goalThread) ??
      selectReviewer({
        providers: repos.providers.list(),
        models: (providerId) => repos.providers.listModels(providerId),
        authorProviderId: task.authorProvider,
        authorModelId: task.authorModel,
      });
    let reviewThreadId: string | null = null;
    let round = task.round;
    try {
      for (;;) {
        if (run.cancelled) return;
        const project = repos.projects.get(goalThread.projectId);
        if (project === undefined) throw notFound('project not found');
        const baseBranch = goalThread.baseBranch ?? project.defaultBranch;
        if (reviewThreadId === null) {
          const reviewThread = await ports.createThread({
            projectId: project.id,
            parentThreadId: child.id,
            title: `Review: ${planTask.title}`,
            providerId: selection.providerId,
            modelId: selection.modelId,
            executionMode: 'plan',
            permissionMode: 'full-auto',
            baseBranch,
            effort: reviewerModel.effort,
          });
          reviewThreadId = reviewThread.id;
          run.childThreads.add(reviewThread.id);
        }
        if (run.cancelled) return;
        maybeEnterReviewing(goal);
        advanceTask(run, task.id, 'reviewing');
        const changes = await ports.changesForThread(child.id);
        const { result: review, detail } = await runChildTurn(
          reviewThreadId,
          buildReviewPrompt({
            task: planTask,
            prUrl: pullRequest.url,
            workerReport,
            patch: changes.patch,
          }),
          run.controller.signal,
        );
        if (run.cancelled) return;
        const verdict = review.status === 'complete' ? parseReviewVerdict(review.text) : 'escalate';
        // A captain revision re-enters this path at the round it escalated on, so the
        // count stops at the cap instead of running past it.
        round = Math.min(round + 1, COUNCIL_CAPS.reviewRounds);
        const body =
          review.text.trim().length > 0
            ? review.text
            : (detail ?? review.error ?? `review turn ${review.status}`);
        const stored = repos.council.createReview({
          taskId: task.id,
          providerId: selection.providerId,
          modelId: selection.modelId,
          verdict,
          body,
        });
        advanceTask(run, task.id, 'reviewing', {
          round,
          reviewerProvider: selection.providerId,
          reviewerModel: selection.modelId,
        });

        if (verdict === 'pass') {
          advanceTask(run, task.id, 'passed');
          return;
        }
        if (verdict === 'escalate' || round >= COUNCIL_CAPS.reviewRounds) {
          repos.council.createEscalation({
            taskId: task.id,
            question: escalationQuestion(planTask, verdict, round, stored.body),
          });
          advanceTask(run, task.id, 'awaiting-captain');
          return;
        }

        advanceTask(run, task.id, 'changes-requested');
        advanceTask(run, task.id, 'running');
        const revision = await runChildTurn(
          child.id,
          buildRevisionBrief({ round, findings: stored.body }),
          run.controller.signal,
        );
        if (run.cancelled) return;
        if (revision.result.status !== 'complete') {
          throw turnFailure('revision', revision.result, revision.detail);
        }
        await ports.syncPullRequest?.(child.id);
        advanceTask(run, task.id, 'pr-open');
      }
    } finally {
      if (reviewThreadId !== null) await disposeChild(run, reviewThreadId);
    }
  }

  /**
   * Where a task's worktree starts. One dependency means its branch; several are merged
   * into one temporary base branch first, because a worktree has a single start point.
   * A task with no dependency starts from the goal's base branch.
   */
  async function taskStart(
    goal: Goal,
    task: Task,
    planTask: PlanTask,
    project: Project,
    baseBranch: string,
  ): Promise<{ startRef: string; integration: IntegrationBranch | null }> {
    const byTitle = new Map(
      repos.council.listTasks(goal.id).map((row) => [row.title.toLowerCase(), row]),
    );
    const branches: string[] = [];
    for (const title of planTask.dependsOn) {
      const dependency = byTitle.get(title.toLowerCase());
      const threadId = dependency?.threadId ?? null;
      if (threadId === null) continue;
      const branch = repos.threads.get(threadId)?.branch?.trim() ?? '';
      if (branch.length > 0) branches.push(branch);
    }
    if (branches.length === 0) return { startRef: baseBranch, integration: null };
    if (branches.length === 1) {
      return { startRef: branches[0] ?? baseBranch, integration: null };
    }
    const integration = await ports.createIntegrationBranch({
      repoPath: project.path,
      worktreesRoot: repos.settings.get().worktreeRoot ?? worktreesRoot(),
      projectId: project.id,
      taskId: task.id,
      branches,
    });
    return { startRef: integration.branch, integration };
  }

  /**
   * Creates the task's child thread. A temporary integration branch is removed as soon
   * as the worktree exists: the worktree already carries the merged commits, and the
   * thread row records the merge commit, so nothing needs the branch again.
   */
  async function createTaskThread(
    goal: Goal,
    task: Task,
    planTask: PlanTask,
    project: Project,
    goalThread: Thread,
    baseBranch: string,
  ): Promise<Thread> {
    const workerModel = modelTarget('worker', goalThread);
    const { startRef, integration } = await taskStart(goal, task, planTask, project, baseBranch);
    try {
      return await ports.createThread({
        projectId: project.id,
        parentThreadId: goalThread.id,
        title: `Council: ${planTask.title}`,
        providerId: task.authorProvider,
        modelId: task.authorModel,
        executionMode: 'work',
        permissionMode: 'full-auto',
        baseBranch,
        ...(startRef === baseBranch ? {} : { startRef }),
        effort: workerModel.effort,
      });
    } finally {
      if (integration !== null) {
        try {
          await integration.cleanup();
        } catch (error) {
          logger.warn('council integration branch cleanup failed', {
            goalId: goal.id,
            taskId: task.id,
            message: errorMessage(error),
          });
        }
      }
    }
  }

  async function executeTask(
    goal: Goal,
    run: GoalRun,
    task: Task,
    planTask: PlanTask,
  ): Promise<void> {
    if (run.cancelled) return;
    const goalThread = requireThread(goal.threadId);
    const project = repos.projects.get(goalThread.projectId);
    if (project === undefined) throw notFound('project not found');
    const baseBranch = goalThread.baseBranch ?? project.defaultBranch;

    advanceTask(run, task.id, 'provisioning');
    const child = await createTaskThread(goal, task, planTask, project, goalThread, baseBranch);
    run.childThreads.add(child.id);
    if (run.cancelled) return;
    const running = advanceTask(run, task.id, 'running', { threadId: child.id }) ?? task;

    const order = [...run.planTasks.keys()];
    const worker = await runChildTurn(
      child.id,
      buildWorkerBrief({
        task: planTask,
        goal: goal.text,
        goalId: goal.id,
        projectName: project.name,
        projectPath: project.path,
        baseBranch,
        worktreePath: child.worktreePath ?? '(missing)',
        branch: child.branch ?? '(missing)',
        taskIndex: Math.max(0, order.indexOf(task.id)),
        taskCount: order.length,
      }),
      run.controller.signal,
    );
    if (run.cancelled) return;
    if (worker.result.status !== 'complete') {
      throw turnFailure('worker', worker.result, worker.detail);
    }

    const pullRequest = await ensurePullRequest(goal, planTask, child, worker.result.text);
    if (run.cancelled) return;
    advanceTask(run, task.id, 'pr-open');
    await reviewTask(goal, run, running, planTask, child, pullRequest, worker.result.text);
  }

  async function executeTasks(goal: Goal, run: GoalRun): Promise<void> {
    const inflight = new Map<string, Promise<void>>();
    for (;;) {
      if (run.cancelled) break;
      const tasks = repos.council.listTasks(goal.id);
      const byTitle = new Map(tasks.map((task) => [task.title.toLowerCase(), task]));
      for (const task of tasks) {
        if (task.state !== 'queued' || inflight.has(task.id)) continue;
        const planTask = run.planTasks.get(task.id);
        if (planTask === undefined) continue;
        if (!dependenciesPassed(planTask, byTitle)) continue;
        if (inflight.size >= COUNCIL_CAPS.concurrentWorkers) break;
        const promise = executeTask(goal, run, task, planTask)
          .catch((error) => {
            if (run.cancelled) return;
            const message = errorMessage(error);
            logger.warn('council task failed', {
              goalId: goal.id,
              taskId: task.id,
              message,
            });
            advanceTask(run, task.id, 'failed', { error: message });
          })
          .finally(() => {
            inflight.delete(task.id);
          });
        inflight.set(task.id, promise);
      }

      if (inflight.size === 0) {
        const tasksNow = repos.council.listTasks(goal.id);
        const remaining = tasksNow.filter((task) => task.state === 'queued');
        const byRemainingTitle = new Map(
          tasksNow.map((task) => [task.title.toLowerCase(), task]),
        );
        // A queued task stays reachable when every dependency either passed or waits on
        // the captain, directly or through another queued task, so a fan-in task behind
        // two escalated branches waits with them. A task no answer can revive is dead
        // and takes the failure path now, so a goal with one broken branch still ends.
        const waiting: Task[] = [];
        const dead: Task[] = [];
        for (const task of remaining) {
          const planTask = run.planTasks.get(task.id);
          if (planTask === undefined) {
            dead.push(task);
            continue;
          }
          if (waitsOnCaptain(planTask, byRemainingTitle, run.planTasks)) waiting.push(task);
          else dead.push(task);
        }
        for (const task of dead) {
          const planTask = run.planTasks.get(task.id);
          if (planTask === undefined) {
            advanceTask(run, task.id, 'failed', { error: 'plan metadata is missing' });
            continue;
          }
          const waitingOnCaptain = planTask.dependsOn.some((title) => {
            const dependency = byRemainingTitle.get(title.toLowerCase());
            return dependency?.state === 'awaiting-captain' || dependency?.state === 'blocked';
          });
          advanceTask(run, task.id, waitingOnCaptain ? 'blocked' : 'failed', {
            error: blockedReason(planTask, byRemainingTitle),
          });
        }
        const awaitingCaptain = tasksNow.some((task) => task.state === 'awaiting-captain');
        // The captain owes an answer while a task waits on one, or while an answer is
        // already running its revision turn. Otherwise every queued task was dead and
        // was settled above, so the loop ends instead of parking forever.
        if (run.answering || waiting.length > 0 || awaitingCaptain) {
          try {
            await run.parking.park('escalation');
          } catch {
            break;
          }
          continue;
        }
        if (remaining.length === 0) break;
        continue;
      }

      await Promise.race(inflight.values());
    }
    await Promise.allSettled(inflight.values());
  }

  /**
   * One more worker turn on the task's existing child thread, then the existing review
   * path once. The round the review lands on decides the task: passed, or a fresh
   * escalation capped by `reviewRounds`.
   */
  async function reviseTaskForCaptain(
    goal: Goal,
    run: GoalRun,
    task: Task,
    question: string,
    feedback: string,
  ): Promise<void> {
    const planTask = run.planTasks.get(task.id);
    if (planTask === undefined) {
      reopenTask(run, task.id, 'failed', { error: 'plan metadata is missing' });
      return;
    }
    const child = task.threadId === null ? undefined : repos.threads.get(task.threadId);
    if (child === undefined) {
      reopenTask(run, task.id, 'failed', { error: 'the task thread is missing' });
      return;
    }
    if (run.cancelled) return;
    const reopened = reopenTask(run, task.id, 'running') ?? task;
    const revision = await runChildTurn(
      child.id,
      buildCaptainRevisionBrief({ question, feedback }),
      run.controller.signal,
    );
    if (run.cancelled) return;
    if (revision.result.status !== 'complete') {
      const message = turnFailure('revision', revision.result, revision.detail).message;
      reopenTask(run, task.id, 'failed', { error: message });
      return;
    }
    const url = child.prUrl ?? '';
    try {
      await reviewTask(
        goal,
        run,
        reopened,
        planTask,
        child,
        { url, number: pullRequestNumber(url) },
        '',
      );
    } catch (error) {
      if (run.cancelled) return;
      const message = errorMessage(error);
      logger.warn('council captain revision failed', {
        goalId: goal.id,
        taskId: task.id,
        message,
      });
      reopenTask(run, task.id, 'failed', { error: message });
    }
  }

  /**
   * The captain's answer to one escalation. Accept and drop settle the task at once,
   * so a dependent either dispatches or fails on the next loop pass. Revise runs its
   * turn here and only then wakes the parked run, so the loop never reads the task
   * mid revision.
   */
  async function answerEscalation(input: CouncilEscalationAnswer): Promise<void> {
    const task = requireTask(input.taskId);
    const goal = requireGoal(task.goalId);
    if (task.state !== 'awaiting-captain') {
      throw conflict('task is not awaiting a captain decision');
    }
    if (goal.state === 'cancelled') throw conflict('the council goal was cancelled');
    const escalation = repos.council
      .listEscalations(task.id)
      .findLast((row) => row.resolvedAt === null);
    if (escalation === undefined) throw conflict('task has no open escalation');
    const feedback = input.feedback?.trim() ?? '';
    if (input.decision === 'revise' && feedback.length === 0) {
      throw badRequest('captain feedback is required to revise a task');
    }
    const answer = feedback.length === 0 ? input.decision : `${input.decision}: ${feedback}`;
    repos.council.resolveEscalation(escalation.id, answer, new Date().toISOString());

    const run = runs.get(goal.id);
    if (input.decision === 'accept') {
      if (run !== undefined) {
        reopenTask(run, task.id, 'passed');
      } else {
        const passed = repos.council.setTaskState(task.id, 'passed');
        if (passed !== undefined) emitTask(goal.id, passed);
      }
      run?.parking.resume('escalation', undefined);
      return;
    }
    if (input.decision === 'drop') {
      if (run !== undefined) {
        reopenTask(run, task.id, 'failed', { error: 'captain dropped the task' });
      } else {
        const failed = repos.council.setTaskState(task.id, 'failed', {
          error: 'captain dropped the task',
        });
        if (failed !== undefined) emitTask(goal.id, failed);
      }
      run?.parking.resume('escalation', undefined);
      return;
    }

    if (run === undefined || TERMINAL_GOAL_STATES[goal.state] === true || run.cancelled) {
      throw conflict('the council goal is no longer running');
    }
    // The revision is a model turn plus a review, so the RPC returns as soon as the
    // work starts: the run stays parked on `answering` and wakes when it settles. The
    // state change to `running` happens in the synchronous prefix, before the RPC
    // answers, so the board never shows a stale awaiting-captain row.
    run.answering = true;
    void reviseTaskForCaptain(goal, run, task, escalation.question, feedback)
      .catch((error) => {
        if (run.cancelled) return;
        const message = errorMessage(error);
        logger.warn('council captain revision failed', {
          goalId: goal.id,
          taskId: task.id,
          message,
        });
        reopenTask(run, task.id, 'failed', { error: message });
      })
      .finally(() => {
        run.answering = false;
        run.parking.resume('escalation', undefined);
      });
  }

  function requireParkedGoal(goalId: string): GoalRun {
    const goal = requireGoal(goalId);
    const run = runs.get(goalId);
    if (run === undefined) throw conflict('the council goal is no longer running');
    if (goal.state !== 'awaiting-approval') {
      throw conflict('the goal is not waiting for plan approval');
    }
    return run;
  }

  async function approvePlan(goalId: string): Promise<void> {
    const run = requireParkedGoal(goalId);
    if (!run.parking.resume('plan', { kind: 'approve' } satisfies PlanDecision)) {
      throw conflict('the goal is not waiting for plan approval');
    }
  }

  async function revisePlan(goalId: string, feedback: string): Promise<void> {
    const run = requireParkedGoal(goalId);
    const text = feedback.trim();
    if (text.length === 0) throw badRequest('plan feedback is required');
    if (!run.parking.resume('plan', { kind: 'revise', feedback: text } satisfies PlanDecision)) {
      throw conflict('the goal is not waiting for plan approval');
    }
  }

  /**
   * Waits for a captain to approve a manual plan, re-planning on feedback. The run
   * stays parked between attempts; the cap ends the goal instead of looping forever.
   */
  async function awaitPlanApproval(goal: Goal, run: GoalRun): Promise<boolean> {
    let revisions = 0;
    for (;;) {
      if (run.cancelled) return false;
      advanceGoal(goal.id, 'awaiting-approval');
      let decision: PlanDecision;
      try {
        decision = await run.parking.park<PlanDecision>('plan');
      } catch {
        return false;
      }
      if (run.cancelled) return false;
      if (decision.kind === 'approve') return true;
      revisions += 1;
      if (revisions > COUNCIL_CAPS.planRevisions) {
        throw new Error('plan was revised twice without approval');
      }
      advanceGoal(goal.id, 'planning');
      const revised = await planGoal(goal, run, { round: revisions, feedback: decision.feedback });
      if (run.cancelled) return false;
      if (revised.tasks.length === 0) {
        addGoalMessage(
          goal,
          `Council could not plan this goal.\n\n${revised.question ?? 'The planner returned no tasks.'}`,
        );
        advanceGoal(goal.id, 'failed');
        return false;
      }
      advanceGoal(goal.id, 'provisioning');
      retirePlanTasks(goal, run);
      createTasks(goal, run, revised.tasks);
    }
  }

  function reviewLabel(review: Review, task: Task): string {
    const reviewer = repos.providers.get(review.providerId);
    const author = repos.providers.get(task.authorProvider);
    const reviewerFamily =
      reviewer === undefined ? 'unknown' : providerFamily(reviewer.kind, reviewer.config);
    const authorFamily =
      author === undefined ? 'unknown' : providerFamily(author.kind, author.config);
    return reviewerFamily === authorFamily ? `${review.verdict} (same-family)` : review.verdict;
  }

  function summarise(goal: Goal): { state: 'done' | 'failed'; report: string } {
    const tasks = repos.council.listTasks(goal.id);
    const succeeded = tasks.some(
      (task) => task.state === 'passed' || task.state === 'merged',
    );
    const lines = tasks.map((task) => {
      const thread = task.threadId === null ? undefined : repos.threads.get(task.threadId);
      const review = repos.council.listReviews(task.id).at(-1);
      const parts = [`- ${task.title}: ${task.state}`];
      if (task.round > 0) parts.push(`round ${task.round}`);
      if (review !== undefined) parts.push(`review ${reviewLabel(review, task)}`);
      if (thread?.prUrl !== undefined && thread?.prUrl !== null) parts.push(`PR ${thread.prUrl}`);
      if (task.error !== null) parts.push(`error: ${task.error}`);
      return parts.join(' | ');
    });
    return {
      state: succeeded ? 'done' : 'failed',
      report: [`Council report for goal ${goal.id}: ${goal.text}`, '', ...lines].join('\n'),
    };
  }

  async function runGoal(goal: Goal, run: GoalRun): Promise<void> {
    try {
      advanceGoal(goal.id, 'planning');
      const plan = await planGoal(goal, run);
      if (run.cancelled) return;
      if (plan.tasks.length === 0) {
        addGoalMessage(
          goal,
          `Council could not plan this goal.\n\n${plan.question ?? 'The planner returned no tasks.'}`,
        );
        advanceGoal(goal.id, 'failed');
        return;
      }
      advanceGoal(goal.id, 'provisioning');
      createTasks(goal, run, plan.tasks);
      if (run.cancelled) return;
      if (goal.autonomy === 'manual') {
        const approved = await awaitPlanApproval(goal, run);
        if (!approved || run.cancelled) return;
      }
      advanceGoal(goal.id, 'running');
      await executeTasks(goal, run);
      if (run.cancelled) return;
      advanceGoal(goal.id, 'reporting');
      const outcome = summarise(goal);
      addGoalMessage(goal, outcome.report);
      advanceGoal(
        goal.id,
        outcome.state,
        outcome.state === 'done' ? new Date().toISOString() : null,
      );
    } catch (error) {
      if (run.cancelled) return;
      const message = errorMessage(error);
      logger.warn('council goal failed', { goalId: goal.id, message });
      failOpenTasks(goal.id, message);
      addGoalMessage(goal, `Council failed: ${message}`);
      advanceGoal(goal.id, 'failed');
    }
  }

  async function start(input: CouncilStartInput): Promise<{ goalId: string }> {
    const thread = requireThread(input.threadId);
    const project = repos.projects.get(thread.projectId);
    if (project === undefined) throw notFound('project not found');
    const provider = repos.providers.get(thread.providerId);
    if (provider === undefined) throw notFound('provider not found');
    if (!provider.enabled) {
      throw new RpcError('provider-unavailable', 'provider is disabled');
    }
    const text = input.goal.trim();
    if (text.length === 0) throw badRequest('goal text is required');
    if (deps.runner.listActive().some((active) => active.threadId === thread.id)) {
      throw conflict('thread already has an active turn');
    }
    const activeGoals = repos.council
      .listGoals(thread.id)
      .filter((goal) => TERMINAL_GOAL_STATES[goal.state] !== true);
    if (activeGoals.length >= COUNCIL_CAPS.goalsPerThread) {
      throw conflict(`thread already has ${activeGoals.length} active council goals`);
    }

    const goal = repos.council.createGoal({
      threadId: thread.id,
      text,
      autonomy: input.autonomy,
      state: 'intake',
    });
    emitGoal(goal);
    const { promise, resolve } = Promise.withResolvers<void>();
    const run: GoalRun = {
      goalId: goal.id,
      threadId: thread.id,
      controller: new AbortController(),
      cancelled: false,
      childThreads: new Set(),
      planTasks: new Map(),
      parking: createParking(),
      answering: false,
      promise,
      resolveDone: resolve,
    };
    runs.set(goal.id, run);
    void runGoal(goal, run)
      .catch((error) => {
        logger.error('council run crashed', {
          goalId: goal.id,
          message: errorMessage(error),
        });
      })
      .finally(() => {
        run.resolveDone();
        runs.delete(goal.id);
      });
    return { goalId: goal.id };
  }

  async function cancel(goalId: string): Promise<void> {
    const goal = requireGoal(goalId);
    const run = runs.get(goalId);
    if (run === undefined || TERMINAL_GOAL_STATES[goal.state] === true) {
      if (TERMINAL_GOAL_STATES[goal.state] !== true) {
        const cancelled = repos.council.setGoalState(goalId, 'cancelled');
        if (cancelled !== undefined) emitGoal(cancelled);
        cancelOpenTasks(goalId);
      }
      return;
    }

    run.cancelled = true;
    run.controller.abort();
    run.parking.fail(new Error('council goal cancelled'));
    const cancelled = repos.council.setGoalState(goalId, 'cancelled');
    if (cancelled !== undefined) emitGoal(cancelled);
    cancelOpenTasks(goalId);

    for (const threadId of Array.from(run.childThreads)) {
      await deps.runner.disposeThread(threadId).catch(() => undefined);
    }
    await run.promise.catch(() => undefined);
    for (const threadId of Array.from(run.childThreads)) {
      await disposeChild(run, threadId);
    }
    addGoalMessage(goal, 'Council cancelled by the user.');
  }

  function statusFor(goal: Goal): CouncilStatus {
    const tasks = repos.council.listTasks(goal.id);
    const reviews = tasks.flatMap((task) => repos.council.listReviews(task.id));
    const escalations = tasks.flatMap((task) => repos.council.listEscalations(task.id));
    const run = runs.get(goal.id);
    const plan: CouncilPlanTaskView[] = [];
    if (run !== undefined) {
      for (const [taskId, planTask] of run.planTasks) {
        plan.push({
          taskId,
          title: planTask.title,
          files: planTask.files,
          dependsOn: planTask.dependsOn,
          critical: planTask.critical,
        });
      }
    }
    return { goal, tasks, reviews, escalations, plan };
  }

  function status(goalId: string): CouncilStatus {
    return statusFor(requireGoal(goalId));
  }

  function latest(threadId: string): CouncilStatus | null {
    const goal = repos.council.latestGoal(threadId);
    return goal === undefined ? null : statusFor(goal);
  }

  async function awaitGoal(goalId: string): Promise<Goal> {
    const run = runs.get(goalId);
    if (run !== undefined) await run.promise;
    return requireGoal(goalId);
  }

  async function dispose(): Promise<void> {
    for (const goalId of Array.from(runs.keys())) {
      await cancel(goalId).catch((error) => {
        logger.warn('council goal dispose failed', {
          goalId,
          message: errorMessage(error),
        });
      });
    }
  }

  return {
    start,
    cancel,
    approvePlan,
    revisePlan,
    answerEscalation,
    status,
    latest,
    awaitGoal,
    dispose,
  };
}

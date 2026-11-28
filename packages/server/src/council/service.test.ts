import {
  emptySubagentModels,
  type Approval,
  type GoalState,
  type ProviderView,
  type ReasoningEffort,
  type ServerEvent,
  type TaskState,
  type Thread,
} from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import { createEventBus, type EventBus } from '../events.js';
import type { Runner } from '../runner/runner.js';
import { createTestContext, silentLogger, type TestContext } from '../test-support.js';
import type { CreateIntegrationBranchInput, IntegrationBranch } from './integration.js';
import { createBusTurnRunner } from './runner-turn.js';
import { createCouncil, resolveCouncilModel } from './service.js';
import type {
  ChildThreadRequest,
  Council,
  CouncilPorts,
  PullRequest,
  PullRequestRequest,
  RunTurnInput,
  TaskChanges,
  TurnResult,
} from './types.js';

type TurnHandler = (input: RunTurnInput, title: string) => Promise<TurnResult>;

function result(
  input: RunTurnInput,
  text: string,
  status: TurnResult['status'] = 'complete',
): TurnResult {
  return { threadId: input.threadId, turnId: 'turn_fake', status, text };
}

function planJson(
  tasks: readonly Record<string, unknown>[],
  question: string | null = null,
): string {
  return JSON.stringify({ tasks, question });
}

function planTask(
  title: string,
  files: string[],
  dependsOn: string[] = [],
): Record<string, unknown> {
  return { title, files, dependsOn, critical: false, brief: `Do ${title}.` };
}

const PASS_REVIEW = 'VERDICT: pass\nFINDINGS: none\nNOTES: ok';

class FakePorts implements CouncilPorts {
  readonly created: ChildThreadRequest[] = [];
  readonly integrations: CreateIntegrationBranchInput[] = [];
  readonly turns: RunTurnInput[] = [];
  readonly deleted: string[] = [];
  readonly pullRequests: { threadId: string; title: string }[] = [];
  readonly synced: string[] = [];
  readonly approvals: {
    threadId: string;
    approvalId: string;
    decision: 'allow' | 'deny';
  }[] = [];
  readonly titles = new Map<string, string>();
  changed = true;
  workerActive = 0;
  workerMax = 0;
  cleanups = 0;
  handler: TurnHandler;
  private watchers: { predicate: () => boolean; resolve: () => void }[] = [];

  constructor(private readonly ctx: TestContext) {
    this.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(input, planJson([planTask('Add widget', ['src/widget.ts'])])),
        );
      }
      if (title.startsWith('Review:')) return Promise.resolve(result(input, PASS_REVIEW));
      return Promise.resolve(result(input, 'worker done'));
    };
  }

  async createThread(request: ChildThreadRequest): Promise<Thread> {
    const id = `thr_child_${this.created.length + 1}`;
    this.created.push(request);
    this.titles.set(id, request.title);
    const now = new Date().toISOString();
    return this.ctx.repos.threads.create({
      id,
      projectId: request.projectId,
      parentThreadId: request.parentThreadId,
      title: request.title,
      providerId: request.providerId,
      modelId: request.modelId,
      executionMode: request.executionMode,
      permissionMode: request.permissionMode,
      reasoningEffort: request.effort ?? null,
      status: 'idle',
      worktreePath: `C:/worktrees/${id}`,
      branch: `tuffcode/${id}`,
      baseBranch: request.startRef ?? request.baseBranch,
      createdAt: now,
      updatedAt: now,
    });
  }

  async createIntegrationBranch(
    input: CreateIntegrationBranchInput,
  ): Promise<IntegrationBranch> {
    this.integrations.push(input);
    return {
      branch: `council/${input.taskId}/base`,
      cleanup: async () => {
        this.cleanups += 1;
      },
    };
  }

  async deleteThread(threadId: string): Promise<void> {
    this.deleted.push(threadId);
    this.ctx.repos.threads.remove(threadId);
  }

  async runTurn(input: RunTurnInput): Promise<TurnResult> {
    this.turns.push(input);
    const title = this.titles.get(input.threadId) ?? '';
    const isWorker = title.startsWith('Council:');
    if (isWorker) {
      this.workerActive += 1;
      this.workerMax = Math.max(this.workerMax, this.workerActive);
      this.notify();
    }
    try {
      if (input.signal.aborted) return result(input, '', 'interrupted');
      return await this.handler(input, title);
    } finally {
      if (isWorker) this.workerActive -= 1;
    }
  }

  async approve(threadId: string, approvalId: string, decision: 'allow' | 'deny'): Promise<void> {
    this.approvals.push({ threadId, approvalId, decision });
  }

  async openPullRequest(threadId: string, request: PullRequestRequest): Promise<PullRequest> {
    this.pullRequests.push({ threadId, title: request.title });
    const number = this.pullRequests.length;
    return { url: `https://example.test/pull/${number}`, number };
  }

  async syncPullRequest(threadId: string): Promise<void> {
    this.synced.push(threadId);
  }

  async changesForThread(): Promise<TaskChanges> {
    return this.changed
      ? {
          changed: true,
          files: ['src/widget.ts'],
          patch: 'diff --git a/src/widget.ts b/src/widget.ts',
        }
      : { changed: false, files: [], patch: '' };
  }

  workerTurns(): RunTurnInput[] {
    return this.turns.filter((turn) => this.titles.get(turn.threadId)?.startsWith('Council:'));
  }

  /** Resolves as soon as `predicate` holds, without polling the clock. */
  when(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.watchers.push({ predicate, resolve });
    return promise;
  }

  private notify(): void {
    for (const watcher of this.watchers.slice()) {
      if (!watcher.predicate()) continue;
      this.watchers = this.watchers.filter((entry) => entry !== watcher);
      watcher.resolve();
    }
  }
}

interface Harness {
  ctx: TestContext;
  council: Council;
  ports: FakePorts;
  bus: EventBus;
  events: ServerEvent[];
  disposed: string[];
  dispose(): Promise<void>;
}

function seedGoalThread(ctx: TestContext): Thread {
  const now = new Date().toISOString();
  ctx.repos.projects.add({
    id: 'prj_1',
    name: 'Demo',
    path: 'C:/demo',
    defaultBranch: 'main',
    createdAt: now,
  });
  ctx.repos.providers.upsert({ id: 'prv_claude', kind: 'claude', label: 'Claude', config: {} });
  ctx.repos.providers.upsert({ id: 'prv_codex', kind: 'codex', label: 'Codex', config: {} });
  ctx.repos.providers.replaceModels('prv_codex', [
    { modelId: 'gpt-x', label: 'GPT', contextWindow: null, isDefault: true },
  ]);
  return ctx.repos.threads.create({
    id: 'thr_goal',
    projectId: 'prj_1',
    parentThreadId: null,
    title: 'Goal thread',
    providerId: 'prv_claude',
    modelId: 'claude-x',
    executionMode: 'council',
    permissionMode: 'full-auto',
    status: 'idle',
    worktreePath: 'C:/demo',
    branch: 'main',
    baseBranch: 'main',
    createdAt: now,
    updatedAt: now,
  });
}

function fakeRunner(disposed: string[]): Runner {
  return {
    listActive: () => [],
    send: async () => ({ turnId: 'turn_unused' }),
    interrupt: async () => undefined,
    approve: async () => undefined,
    disposeThread: async (threadId) => {
      disposed.push(threadId);
    },
    disposeAll: async () => undefined,
    recoverOrphanedRuns: () => undefined,
  };
}

function turnText(title: string): string {
  if (title.startsWith('Plan:')) return planJson([planTask('Add widget', ['src/widget.ts'])]);
  if (title.startsWith('Review:')) return PASS_REVIEW;
  return 'worker done';
}

/**
 * A runner that raises one benign approval per turn before finishing it, so the real
 * bus turn runner answers approvals exactly as the shipped council wiring does.
 */
function approvalRunner(bus: EventBus, titles: Map<string, string>): Runner {
  let turn = 0;
  return {
    listActive: () => [],
    send: async (threadId) => {
      turn += 1;
      const turnId = `turn_${turn}`;
      queueMicrotask(() => {
        const approval: Approval = {
          id: `apv_${turnId}`,
          threadId,
          toolCallId: `call_${turnId}`,
          toolName: 'bash',
          input: { command: 'pnpm test' },
          decision: 'pending',
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        };
        bus.emit({ kind: 'event', type: 'approval.requested', threadId, payload: approval });
        const text = turnText(titles.get(threadId) ?? '');
        bus.emit({
          kind: 'event',
          type: 'thread.event',
          threadId,
          seq: 1,
          createdAt: new Date().toISOString(),
          payload: { type: 'text.delta', turnId, text },
        });
        bus.emit({
          kind: 'event',
          type: 'thread.event',
          threadId,
          seq: 2,
          createdAt: new Date().toISOString(),
          payload: { type: 'turn.finished', turnId, reason: 'complete' },
        });
      });
      return { turnId };
    },
    interrupt: async () => undefined,
    approve: async () => undefined,
    disposeThread: async () => undefined,
    disposeAll: async () => undefined,
    recoverOrphanedRuns: () => undefined,
  };
}

function createHarness(configure?: (ports: FakePorts, bus: EventBus) => void): Harness {
  const ctx = createTestContext();
  seedGoalThread(ctx);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const disposed: string[] = [];
  const ports = new FakePorts(ctx);
  configure?.(ports, bus);
  const council = createCouncil({
    repos: ctx.repos,
    bus,
    runner: fakeRunner(disposed),
    logger: silentLogger(),
    ports,
  });
  return {
    ctx,
    council,
    ports,
    bus,
    events,
    disposed,
    dispose: async () => {
      await council.dispose();
      ctx.dispose();
    },
  };
}

interface Gate {
  wait(signal: AbortSignal): Promise<void>;
  open(): void;
}

function makeGate(): Gate {
  let opened = false;
  const waiters: (() => void)[] = [];
  return {
    open() {
      opened = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
    wait(signal: AbortSignal) {
      if (opened || signal.aborted) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      const done = (): void => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      waiters.push(done);
      signal.addEventListener('abort', done, { once: true });
      return promise;
    },
  };
}

async function startGoal(
  harness: Harness,
  goal = 'Ship the widget',
  autonomy: 'auto' | 'manual' = 'auto',
): Promise<string> {
  const { goalId } = await harness.council.start({
    threadId: 'thr_goal',
    goal,
    autonomy,
  });
  return goalId;
}

/** Resolves on the next published event matching `predicate`, ignoring past ones. */
function nextEvent(harness: Harness, predicate: (event: ServerEvent) => boolean): Promise<void> {
  const seen = harness.events.length;
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsubscribe = harness.bus.subscribe(() => {
    if (!harness.events.slice(seen).some(predicate)) return;
    unsubscribe();
    resolve();
  });
  return promise;
}

/** Resolves when the goal next reports the given state. */
function nextGoalState(harness: Harness, goalId: string, state: GoalState): Promise<void> {
  return nextEvent(
    harness,
    (event) =>
      event.type === 'council.updated' &&
      event.payload.goalId === goalId &&
      event.payload.state === state,
  );
}

/** Resolves when the named task next reports the given state. */
function nextTaskState(
  harness: Harness,
  goalId: string,
  title: string,
  state: TaskState,
): Promise<void> {
  return nextEvent(harness, (event) => {
    if (event.type !== 'council.updated' || event.payload.goalId !== goalId) return false;
    if (event.payload.taskState !== state) return false;
    const taskId = event.payload.taskId;
    if (taskId === undefined) return false;
    return harness.ctx.repos.council.getTask(taskId)?.title === title;
  });
}

interface ModelChoice {
  providerId?: string;
  model?: string;
  fallbackModel?: string;
  effort?: ReasoningEffort | null;
}

/** Writes the per-type model settings the council roles read. */
function configureModels(
  harness: Harness,
  choice: { planner?: ModelChoice; worker?: ModelChoice; reviewer?: ModelChoice },
): void {
  harness.ctx.repos.settings.patch({
    subagentModels: { ...emptySubagentModels(), ...choice },
  });
}

function createdThread(harness: Harness, prefix: string): ChildThreadRequest | undefined {
  return harness.ports.created.find((request) => request.title.startsWith(prefix));
}

describe('council goal lifecycle', () => {
  it('plans, runs a worker, opens a PR, reviews it, and reports done', async () => {
    const harness = createHarness();
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);

      expect(goal.state).toBe('done');
      const status = harness.council.status(goalId);
      expect(status.tasks).toHaveLength(1);
      expect(status.tasks[0]?.state).toBe('passed');
      expect(status.tasks[0]?.round).toBe(1);
      expect(status.reviews).toHaveLength(1);
      expect(status.reviews[0]?.verdict).toBe('pass');
      expect(harness.ports.pullRequests).toHaveLength(1);
      expect(harness.ports.pullRequests[0]?.title).toBe('Add widget');

      const workerThreadId = status.tasks[0]?.threadId;
      expect(workerThreadId).not.toBeNull();
      expect(harness.ctx.repos.threads.get(workerThreadId ?? '')).toBeDefined();
      expect(harness.ctx.repos.threads.get(workerThreadId ?? '')?.parentThreadId).toBe('thr_goal');

      const states = harness.events
        .filter((event) => event.type === 'council.updated')
        .map((event) => event.payload.state);
      expect(states).toEqual(
        expect.arrayContaining([
          'planning',
          'provisioning',
          'running',
          'reviewing',
          'reporting',
          'done',
        ]),
      );

      const messages = harness.ctx.repos.messages.list('thr_goal');
      const report = messages.find((message) => message.content.includes('Council report'));
      expect(report?.content).toContain('Add widget: passed');
      expect(report?.content).toContain('PR https://example.test/pull/1');

      const childTitles = harness.ports.created.map((request) => request.title);
      expect(childTitles).toEqual([
        'Plan: Ship the widget',
        'Council: Add widget',
        'Review: Add widget',
      ]);
      expect(harness.ports.created.map((request) => request.permissionMode)).toEqual([
        'full-auto',
        'full-auto',
        'full-auto',
      ]);
      expect(harness.ports.deleted).toContain('thr_child_1');
      expect(harness.ports.deleted).toContain('thr_child_3');
      expect(harness.ports.deleted).not.toContain(workerThreadId);
    } finally {
      await harness.dispose();
    }
  });

  it('fails the goal when the plan has overlapping file ownership', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([planTask('One', ['src/shared.ts']), planTask('Two', ['src/shared.ts'])]),
          ),
        );
      }
      return Promise.resolve(result(input, PASS_REVIEW));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      expect(harness.council.status(goalId).tasks).toHaveLength(0);
      const messages = harness.ctx.repos.messages.list('thr_goal');
      expect(messages.some((message) => /ownership overlaps/i.test(message.content))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('enforces the twelve task cap at plan time', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        const tasks = Array.from({ length: 13 }, (_, index) =>
          planTask(`Task ${index}`, [`src/${index}.ts`]),
        );
        return Promise.resolve(result(input, planJson(tasks)));
      }
      return Promise.resolve(result(input, PASS_REVIEW));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      expect(
        harness.ctx.repos.messages.list('thr_goal').some((m) => /cap is 12/.test(m.content)),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('reports a planner question as a failed goal', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(result(input, planJson([], 'Which database should this use?')));
      }
      return Promise.resolve(result(input, PASS_REVIEW));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      expect(
        harness.ctx.repos.messages
          .list('thr_goal')
          .some((m) => m.content.includes('Which database')),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('fails a task that produced no changes', async () => {
    const harness = createHarness();
    harness.ports.changed = false;
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      const task = harness.council.status(goalId).tasks[0];
      expect(task?.state).toBe('failed');
      expect(task?.error).toBe('worker produced no changes');
      const report = harness.ctx.repos.messages
        .list('thr_goal')
        .find((message) => message.content.includes('Council report'));
      expect(report?.content).toContain('worker produced no changes');
    } finally {
      await harness.dispose();
    }
  });
});

describe('council review loop', () => {
  it('re-runs the same worker thread after changes-requested and passes on round two', async () => {
    const harness = createHarness();
    let reviewCount = 0;
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(input, planJson([planTask('Add widget', ['src/widget.ts'])])),
        );
      }
      if (title.startsWith('Review:')) {
        reviewCount += 1;
        return Promise.resolve(
          result(
            input,
            reviewCount === 1
              ? 'VERDICT: changes-requested\nFINDINGS: 1. Handle null.'
              : PASS_REVIEW,
          ),
        );
      }
      return Promise.resolve(
        result(input, input.text.includes('REWORK ROUND') ? 'fixed' : 'worker done'),
      );
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      const status = harness.council.status(goalId);
      expect(status.tasks[0]?.state).toBe('passed');
      expect(status.tasks[0]?.round).toBe(2);
      expect(status.reviews.map((review) => review.verdict)).toEqual(['changes-requested', 'pass']);
      const workerTurns = harness.ports.workerTurns();
      expect(workerTurns).toHaveLength(2);
      expect(workerTurns[1]?.threadId).toBe(workerTurns[0]?.threadId);
      expect(workerTurns[1]?.text).toContain('REWORK ROUND 1');
      expect(workerTurns[1]?.text).toContain('Handle null');
      // The revision is pushed before the next review, so the PR is not stale.
      expect(harness.ports.synced).toEqual([workerTurns[0]?.threadId]);
    } finally {
      await harness.dispose();
    }
  });

  it('escalates to the captain after three review rounds', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(input, planJson([planTask('Add widget', ['src/widget.ts'])])),
        );
      }
      if (title.startsWith('Review:')) {
        return Promise.resolve(
          result(input, 'VERDICT: changes-requested\nFINDINGS: 1. Still wrong.'),
        );
      }
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      await nextTaskState(harness, goalId, 'Add widget', 'awaiting-captain');
      const parked = harness.council.status(goalId);
      expect(parked.goal.state).not.toBe('done');
      expect(parked.tasks[0]?.state).toBe('awaiting-captain');
      expect(parked.tasks[0]?.round).toBe(3);
      expect(parked.reviews).toHaveLength(3);
      expect(harness.ctx.repos.council.listEscalations(parked.tasks[0]?.id ?? '')).toHaveLength(1);
      expect(harness.ports.workerTurns()).toHaveLength(3);

      await harness.council.answerEscalation({
        taskId: parked.tasks[0]?.id ?? '',
        decision: 'accept',
      });
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      expect(harness.council.status(goalId).tasks[0]?.state).toBe('passed');
    } finally {
      await harness.dispose();
    }
  });

  it('escalates immediately when the reviewer escalates', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(input, planJson([planTask('Add widget', ['src/widget.ts'])])),
        );
      }
      if (title.startsWith('Review:')) {
        return Promise.resolve(result(input, 'VERDICT: escalate\nFINDINGS: needs a product call'));
      }
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      await nextTaskState(harness, goalId, 'Add widget', 'awaiting-captain');
      const task = harness.council.status(goalId).tasks[0];
      expect(task?.state).toBe('awaiting-captain');
      expect(task?.round).toBe(1);
      expect(harness.ctx.repos.council.listEscalations(task?.id ?? '')).toHaveLength(1);
      await harness.council.answerEscalation({ taskId: task?.id ?? '', decision: 'accept' });
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
    } finally {
      await harness.dispose();
    }
  });
});

describe('council reviewer selection', () => {
  it('uses a different model family when one is configured', async () => {
    const harness = createHarness();
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      const reviewThread = harness.ports.created.find((request) =>
        request.title.startsWith('Review:'),
      );
      expect(reviewThread?.providerId).toBe('prv_codex');
      expect(reviewThread?.modelId).toBe('gpt-x');
    } finally {
      await harness.dispose();
    }
  });

  it('falls back to the author provider and labels the review same-family', async () => {
    const harness = createHarness();
    harness.ctx.repos.providers.replaceModels('prv_codex', []);
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      const reviewThread = harness.ports.created.find((request) =>
        request.title.startsWith('Review:'),
      );
      expect(reviewThread?.providerId).toBe('prv_claude');
      expect(reviewThread?.modelId).toBe('claude-x');
      const report = harness.ctx.repos.messages
        .list('thr_goal')
        .find((message) => message.content.includes('Council report'));
      expect(report?.content).toContain('same-family');
    } finally {
      await harness.dispose();
    }
  });
});

describe('council caps', () => {
  it('allows two goals per thread and rejects a third', async () => {
    const harness = createHarness();
    const gate = makeGate();
    harness.ports.handler = async (input, title) => {
      if (title.startsWith('Plan:')) {
        await gate.wait(input.signal);
        return result(input, planJson([planTask('Add widget', ['src/widget.ts'])]));
      }
      return result(input, PASS_REVIEW);
    };
    try {
      const first = await startGoal(harness, 'First goal');
      const second = await startGoal(harness, 'Second goal');
      await expect(startGoal(harness, 'Third goal')).rejects.toThrow(/active council goals/i);
      gate.open();
      await harness.council.cancel(first);
      await harness.council.cancel(second);
      expect(harness.council.status(first).goal.state).toBe('cancelled');
      expect(harness.council.status(second).goal.state).toBe('cancelled');
    } finally {
      await harness.dispose();
    }
  });

  // Nine tasks is the smallest plan that must queue behind the eight-worker cap.
  // Workers block on a manual gate, so the only wall-clock risk is CI starvation
  // (one vitest worker per file on a shared runner); the timeout is headroom, not
  // a wait. The gate opens only after eight workers are observed running.
  it('never runs more than eight workers at once', { timeout: 15_000 }, async () => {
    const harness = createHarness();
    const gate = makeGate();
    harness.ports.handler = async (input, title) => {
      if (title.startsWith('Plan:')) {
        const tasks = Array.from({ length: 9 }, (_, index) =>
          planTask(`Task ${index}`, [`src/${index}.ts`]),
        );
        return result(input, planJson(tasks));
      }
      if (title.startsWith('Review:')) return result(input, PASS_REVIEW);
      await gate.wait(input.signal);
      return result(input, 'worker done');
    };
    try {
      const goalId = await startGoal(harness);
      await harness.ports.when(() => harness.ports.workerMax === 8);
      expect(harness.ports.workerActive).toBeLessThanOrEqual(8);
      gate.open();
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      expect(harness.council.status(goalId).tasks.every((task) => task.state === 'passed')).toBe(
        true,
      );
      expect(harness.ports.workerMax).toBe(8);
    } finally {
      await harness.dispose();
    }
  });
});

describe('council dependencies', () => {
  it('fails a dependent task when its dependency failed', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([
              planTask('First', ['src/first.ts']),
              planTask('Second', ['src/second.ts'], ['First']),
            ]),
          ),
        );
      }
      if (title === 'Council: First') return Promise.resolve(result(input, '', 'error'));
      return Promise.resolve(result(input, PASS_REVIEW));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      const tasks = harness.council.status(goalId).tasks;
      expect(tasks.find((task) => task.title === 'First')?.state).toBe('failed');
      const second = tasks.find((task) => task.title === 'Second');
      expect(second?.state).toBe('failed');
      expect(second?.dependsOn).toEqual(['First']);
      expect(second?.error).toContain('blocked by');
      expect(harness.ports.created.some((request) => request.title === 'Council: Second')).toBe(
        false,
      );
    } finally {
      await harness.dispose();
    }
  });
});

describe('council dependencies', () => {
  it('parks a dependent task while its dependency awaits the captain', async () => {
    const harness = createHarness();
    let reviews = 0;
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([
              planTask('First', ['src/first.ts']),
              planTask('Second', ['src/second.ts'], ['First']),
            ]),
          ),
        );
      }
      if (title.startsWith('Review:')) {
        reviews += 1;
        return Promise.resolve(
          result(
            input,
            reviews === 1 ? 'VERDICT: escalate\nFINDINGS: needs a call' : PASS_REVIEW,
          ),
        );
      }
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      await nextTaskState(harness, goalId, 'First', 'awaiting-captain');
      // The loop parks without publishing anything else, so a short real wait is the
      // only way to observe that nothing happened: fake timers cannot advance a promise
      // chain that is already parked on an answer RPC.
      const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
      setTimeout(settle, 20);
      await settled;
      const parked = harness.council.status(goalId);
      expect(parked.goal.state).toBe('running');
      expect(parked.tasks.find((task) => task.title === 'First')?.state).toBe('awaiting-captain');
      expect(parked.tasks.find((task) => task.title === 'Second')?.state).toBe('queued');
      expect(harness.ports.created.some((request) => request.title === 'Council: Second')).toBe(
        false,
      );

      const first = parked.tasks.find((task) => task.title === 'First');
      await harness.council.answerEscalation({
        taskId: first?.id ?? '',
        decision: 'accept',
      });
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      const tasks = harness.council.status(goalId).tasks;
      expect(tasks.find((task) => task.title === 'First')?.state).toBe('passed');
      expect(tasks.find((task) => task.title === 'Second')?.state).toBe('passed');
      expect(harness.ports.created.some((request) => request.title === 'Council: Second')).toBe(
        true,
      );
    } finally {
      await harness.dispose();
    }
  });
});

describe('council dependency branches', () => {
  it('starts a dependent task from its dependency branch', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([
              planTask('First', ['src/first.ts']),
              planTask('Second', ['src/second.ts'], ['First']),
            ]),
          ),
        );
      }
      if (title.startsWith('Review:')) return Promise.resolve(result(input, PASS_REVIEW));
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');

      const tasks = harness.council.status(goalId).tasks;
      const first = tasks.find((task) => task.title === 'First');
      const firstBranch = harness.ctx.repos.threads.get(first?.threadId ?? '')?.branch ?? '';
      expect(firstBranch).toMatch(/^tuffcode\//);

      const firstRequest = createdThread(harness, 'Council: First');
      expect(firstRequest?.startRef).toBeUndefined();
      expect(firstRequest?.baseBranch).toBe('main');

      const secondRequest = createdThread(harness, 'Council: Second');
      expect(secondRequest?.startRef).toBe(firstBranch);
      expect(secondRequest?.baseBranch).toBe('main');

      const second = tasks.find((task) => task.title === 'Second');
      expect(harness.ctx.repos.threads.get(second?.threadId ?? '')?.baseBranch).toBe(firstBranch);
      expect(harness.ports.integrations).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });

  it('merges several dependencies into one base branch and removes it', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([
              planTask('First', ['src/first.ts']),
              planTask('Second', ['src/second.ts']),
              planTask('Third', ['src/third.ts'], ['First', 'Second']),
            ]),
          ),
        );
      }
      if (title.startsWith('Review:')) return Promise.resolve(result(input, PASS_REVIEW));
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');

      const tasks = harness.council.status(goalId).tasks;
      const third = tasks.find((task) => task.title === 'Third');
      expect(third?.state).toBe('passed');

      expect(harness.ports.integrations).toHaveLength(1);
      const integration = harness.ports.integrations[0];
      expect(integration?.projectId).toBe('prj_1');
      expect(integration?.taskId).toBe(third?.id);
      const dependencyBranches = ['First', 'Second'].map((title) => {
        const task = tasks.find((row) => row.title === title);
        return harness.ctx.repos.threads.get(task?.threadId ?? '')?.branch;
      });
      expect(integration?.branches).toEqual(dependencyBranches);
      expect(integration?.branches).toHaveLength(2);

      const thirdRequest = createdThread(harness, 'Council: Third');
      expect(thirdRequest?.startRef).toBe(`council/${third?.id}/base`);
      expect(harness.ports.cleanups).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

describe('council cancellation', () => {
  it('stops the worker, disposes child threads, and marks rows cancelled', async () => {
    const harness = createHarness();
    const gate = makeGate();
    harness.ports.handler = async (input, title) => {
      if (title.startsWith('Plan:')) {
        return result(input, planJson([planTask('Add widget', ['src/widget.ts'])]));
      }
      if (title.startsWith('Review:')) return result(input, PASS_REVIEW);
      await gate.wait(input.signal);
      return result(input, 'worker done');
    };
    try {
      const goalId = await startGoal(harness);
      await harness.ports.when(() => harness.ports.workerActive === 1);
      const workerThreadId = harness.council.status(goalId).tasks[0]?.threadId;
      expect(workerThreadId).toBeTruthy();

      await harness.council.cancel(goalId);
      const status = harness.council.status(goalId);
      expect(status.goal.state).toBe('cancelled');
      expect(status.tasks[0]?.state).toBe('cancelled');
      expect(harness.disposed).toContain(workerThreadId);
      expect(harness.ctx.repos.threads.get(workerThreadId ?? '')).toBeUndefined();
      expect(harness.ports.deleted).toContain(workerThreadId);
      expect((await harness.council.awaitGoal(goalId)).state).toBe('cancelled');

      await expect(harness.council.cancel(goalId)).resolves.toBeUndefined();
      await expect(harness.council.cancel('gol_missing')).rejects.toThrow(/goal not found/i);
    } finally {
      gate.open();
      await harness.dispose();
    }
  });
});

describe('council model selection', () => {
  it('runs the planner with the configured planner model', async () => {
    const harness = createHarness();
    configureModels(harness, { planner: { providerId: 'prv_codex', model: 'gpt-plan' } });
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      const planner = createdThread(harness, 'Plan:');
      expect(planner?.providerId).toBe('prv_codex');
      expect(planner?.modelId).toBe('gpt-plan');
    } finally {
      await harness.dispose();
    }
  });

  it('runs workers with the configured worker model and records it on the task', async () => {
    const harness = createHarness();
    configureModels(harness, {
      worker: { providerId: 'prv_codex', model: 'gpt-worker', effort: 'high' },
    });
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      const worker = createdThread(harness, 'Council:');
      expect(worker?.providerId).toBe('prv_codex');
      expect(worker?.modelId).toBe('gpt-worker');
      expect(worker?.effort).toBe('high');
      expect(createdThread(harness, 'Plan:')?.effort).toBeNull();
      expect(createdThread(harness, 'Review:')?.effort).toBeNull();
      const task = harness.council.status(goalId).tasks[0];
      expect(task?.authorProvider).toBe('prv_codex');
      expect(task?.authorModel).toBe('gpt-worker');
    } finally {
      await harness.dispose();
    }
  });

  it('falls back to the goal thread model when the configured provider is disabled', async () => {
    const harness = createHarness();
    harness.ctx.repos.providers.upsert({
      id: 'prv_off',
      kind: 'codex',
      label: 'Disabled',
      config: {},
      enabled: false,
    });
    configureModels(harness, {
      planner: { providerId: 'prv_off', model: 'gpt-plan' },
      worker: { providerId: 'prv_off', model: 'gpt-worker' },
    });
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      expect(createdThread(harness, 'Plan:')?.providerId).toBe('prv_claude');
      expect(createdThread(harness, 'Plan:')?.modelId).toBe('claude-x');
      expect(createdThread(harness, 'Council:')?.providerId).toBe('prv_claude');
      expect(createdThread(harness, 'Council:')?.modelId).toBe('claude-x');
    } finally {
      await harness.dispose();
    }
  });

  it('uses the fallback model when the primary model is blank', async () => {
    const harness = createHarness();
    configureModels(harness, {
      worker: { providerId: 'prv_codex', model: '   ', fallbackModel: 'gpt-fallback' },
    });
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      expect(createdThread(harness, 'Council:')?.providerId).toBe('prv_codex');
      expect(createdThread(harness, 'Council:')?.modelId).toBe('gpt-fallback');
    } finally {
      await harness.dispose();
    }
  });

  it('runs the reviewer with the configured reviewer model and labels it', async () => {
    const harness = createHarness();
    configureModels(harness, { reviewer: { providerId: 'prv_claude', model: 'claude-review' } });
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      const review = createdThread(harness, 'Review:');
      expect(review?.providerId).toBe('prv_claude');
      expect(review?.modelId).toBe('claude-review');
      const status = harness.council.status(goalId);
      expect(status.tasks[0]?.reviewerProvider).toBe('prv_claude');
      expect(status.tasks[0]?.reviewerModel).toBe('claude-review');
      expect(status.reviews[0]?.providerId).toBe('prv_claude');
      expect(status.reviews[0]?.modelId).toBe('claude-review');
      // The author ran on the same family, so the review is labelled for the captain.
      const report = harness.ctx.repos.messages
        .list('thr_goal')
        .find((message) => message.content.includes('Council report'));
      expect(report?.content).toContain('same-family');
    } finally {
      await harness.dispose();
    }
  });

  it('keeps cross-family review when the configured reviewer provider is disabled', async () => {
    const harness = createHarness();
    harness.ctx.repos.providers.upsert({
      id: 'prv_off',
      kind: 'codex',
      label: 'Disabled',
      config: {},
      enabled: false,
    });
    configureModels(harness, { reviewer: { providerId: 'prv_off', model: 'gpt-review' } });
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      const review = createdThread(harness, 'Review:');
      expect(review?.providerId).toBe('prv_codex');
      expect(review?.modelId).toBe('gpt-x');
    } finally {
      await harness.dispose();
    }
  });

  it('resolves a blank choice to the goal thread model', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const provider = (id: string, enabled: boolean): ProviderView => ({
      id,
      kind: 'codex',
      label: id,
      config: {},
      enabled,
      hasSecret: false,
      createdAt: at,
      updatedAt: at,
    });
    const providers = [provider('prv_a', true), provider('prv_b', false)];
    const fallback = { providerId: 'prv_a', modelId: 'thread-model' };
    expect(resolveCouncilModel({ choice: undefined, providers, fallback })).toEqual(fallback);
    expect(resolveCouncilModel({ choice: {}, providers, fallback })).toEqual(fallback);
    expect(
      resolveCouncilModel({
        choice: { providerId: 'prv_b', model: 'm', fallbackModel: 'fm' },
        providers,
        fallback,
      }),
    ).toEqual({ providerId: 'prv_a', modelId: 'fm' });
    expect(
      resolveCouncilModel({
        choice: { providerId: 'prv_missing', model: 'm' },
        providers,
        fallback,
      }),
    ).toEqual(fallback);
  });
});

describe('council planning failure', () => {
  it('reports the adapter error text in the goal message and fails the goal', async () => {
    const harness = createHarness((ports, bus) => {
      ports.handler = (input, title) => {
        if (title.startsWith('Plan:')) {
          bus.emit({
            kind: 'event',
            type: 'thread.event',
            threadId: input.threadId,
            seq: 1,
            createdAt: new Date().toISOString(),
            payload: {
              type: 'error',
              message: 'openai: request failed with status 502',
              retryable: false,
            },
          });
          return Promise.resolve(result(input, '', 'error'));
        }
        return Promise.resolve(result(input, PASS_REVIEW));
      };
    });
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      expect(harness.council.status(goalId).tasks).toHaveLength(0);
      const messages = harness.ctx.repos.messages.list('thr_goal');
      expect(
        messages.some((message) =>
          message.content.includes('openai: request failed with status 502'),
        ),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});

describe('council planner retry', () => {
  it('retries once with a correction block and finishes the plan', async () => {
    const harness = createHarness();
    let plannerTurns = 0;
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        plannerTurns += 1;
        return Promise.resolve(
          result(
            input,
            plannerTurns === 1
              ? 'I cannot produce that.'
              : planJson([planTask('Add widget', ['src/widget.ts'])]),
          ),
        );
      }
      if (title.startsWith('Review:')) return Promise.resolve(result(input, PASS_REVIEW));
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);

      expect(goal.state).toBe('done');
      expect(harness.council.status(goalId).tasks).toHaveLength(1);
      expect(plannerTurns).toBe(2);
      const plannerTurnsSeen = harness.ports.turns.filter((turn) =>
        harness.ports.titles.get(turn.threadId)?.startsWith('Plan:'),
      );
      expect(plannerTurnsSeen).toHaveLength(2);
      expect(plannerTurnsSeen[1]?.text).toContain('CORRECTION');
      expect(plannerTurnsSeen[1]?.text).toContain('planner did not return a JSON object');
    } finally {
      await harness.dispose();
    }
  });

  it('fails the goal with both errors when the retry also fails', async () => {
    const harness = createHarness();
    let plannerTurns = 0;
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        plannerTurns += 1;
        return Promise.resolve(
          result(input, plannerTurns === 1 ? 'not json' : '{"tasks": "nope"}'),
        );
      }
      if (title.startsWith('Review:')) return Promise.resolve(result(input, PASS_REVIEW));
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      const goal = await harness.council.awaitGoal(goalId);

      expect(goal.state).toBe('failed');
      expect(plannerTurns).toBe(2);
      expect(harness.council.status(goalId).tasks).toHaveLength(0);
      const failure = harness.ctx.repos.messages
        .list('thr_goal')
        .find((message) => message.content.includes('Council failed'));
      expect(failure?.content).toContain('planner did not return a JSON object');
      expect(failure?.content).toContain('plan.tasks must be an array');
    } finally {
      await harness.dispose();
    }
  });
});

describe('council.latest', () => {
  it('returns the newest goal on the thread with its tasks and reviews', async () => {
    const harness = createHarness();
    try {
      expect(harness.council.latest('thr_goal')).toBeNull();
      expect(harness.council.latest('thr_missing')).toBeNull();

      const firstId = await startGoal(harness, 'First goal');
      await harness.council.awaitGoal(firstId);
      const secondId = await startGoal(harness, 'Second goal');
      await harness.council.awaitGoal(secondId);

      const latest = harness.council.latest('thr_goal');
      expect(latest?.goal.id).toBe(secondId);
      expect(latest?.goal.text).toBe('Second goal');
      expect(latest?.tasks.map((task) => task.title)).toEqual(['Add widget']);
      expect(latest?.reviews).toHaveLength(1);
      expect(latest?.reviews[0]?.taskId).toBe(latest?.tasks[0]?.id);
    } finally {
      await harness.dispose();
    }
  });
});

describe('council approval policy', () => {
  it('denies a benign approval for both an auto goal and a manual goal', async () => {
    const harness = createHarness((ports, bus) => {
      ports.runTurn = createBusTurnRunner({
        bus,
        runner: approvalRunner(bus, ports.titles),
        approve: (threadId, approvalId, decision) => ports.approve(threadId, approvalId, decision),
        logger: silentLogger(),
      });
    });
    try {
      for (const autonomy of ['auto', 'manual'] as const) {
        const { goalId } = await harness.council.start({
          threadId: 'thr_goal',
          goal: `Ship it ${autonomy}`,
          autonomy,
        });
        if (autonomy === 'manual') {
          await nextGoalState(harness, goalId, 'awaiting-approval');
          await harness.council.approvePlan(goalId);
        }
        const goal = await harness.council.awaitGoal(goalId);
        expect(goal.state).toBe('done');
        expect(goal.autonomy).toBe(autonomy);
      }

      expect(harness.ports.approvals.length).toBeGreaterThan(0);
      for (const approval of harness.ports.approvals) {
        expect(approval.decision).toBe('deny');
      }
    } finally {
      await harness.dispose();
    }
  });
});

describe('council plan approval', () => {
  it('parks a manual goal until the captain approves the plan', async () => {
    const harness = createHarness();
    try {
      const goalId = await startGoal(harness, 'Ship the widget', 'manual');
      await nextGoalState(harness, goalId, 'awaiting-approval');
      const parked = harness.council.status(goalId);
      expect(parked.plan.map((entry) => entry.title)).toEqual(['Add widget']);
      expect(parked.plan[0]?.files).toEqual(['src/widget.ts']);
      expect(parked.plan[0]?.dependsOn).toEqual([]);
      expect(parked.plan[0]?.taskId).toBe(parked.tasks[0]?.id);
      expect(parked.tasks.map((task) => task.state)).toEqual(['queued']);
      expect(
        harness.ports.created.some((request) => request.title.startsWith('Council:')),
      ).toBe(false);
      expect(harness.ports.workerTurns()).toHaveLength(0);

      await harness.council.approvePlan(goalId);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      expect(harness.council.status(goalId).tasks[0]?.state).toBe('passed');
      expect(harness.ports.workerTurns()).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it('re-plans on captain feedback and parks again', async () => {
    const harness = createHarness();
    let plans = 0;
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        plans += 1;
        return Promise.resolve(
          result(
            input,
            planJson([
              plans === 1
                ? planTask('Add widget', ['src/widget.ts'])
                : planTask('Add gadget', ['src/gadget.ts']),
            ]),
          ),
        );
      }
      if (title.startsWith('Review:')) return Promise.resolve(result(input, PASS_REVIEW));
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness, 'Ship the widget', 'manual');
      await nextGoalState(harness, goalId, 'awaiting-approval');
      const parkedAgain = nextGoalState(harness, goalId, 'awaiting-approval');
      await harness.council.revisePlan(goalId, 'Split the widget into two tasks');
      await parkedAgain;

      const revised = harness.council.status(goalId);
      expect(revised.plan.map((entry) => entry.title)).toEqual(['Add gadget']);
      expect(revised.tasks.map((task) => [task.title, task.state])).toEqual([
        ['Add widget', 'cancelled'],
        ['Add gadget', 'queued'],
      ]);
      expect(harness.ports.workerTurns()).toHaveLength(0);
      const plannerTurns = harness.ports.turns.filter((turn) =>
        (harness.ports.titles.get(turn.threadId) ?? '').startsWith('Plan:'),
      );
      expect(plannerTurns).toHaveLength(2);
      expect(plannerTurns[1]?.text).toContain('REVISION');
      expect(plannerTurns[1]?.text).toContain('Split the widget into two tasks');

      await harness.council.approvePlan(goalId);
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      const tasks = harness.council.status(goalId).tasks;
      expect(tasks.find((task) => task.title === 'Add gadget')?.state).toBe('passed');
      expect(tasks.find((task) => task.title === 'Add widget')?.state).toBe('cancelled');
    } finally {
      await harness.dispose();
    }
  });

  it('fails the goal when the plan is revised twice without approval', async () => {
    const harness = createHarness();
    try {
      const goalId = await startGoal(harness, 'Ship the widget', 'manual');
      await nextGoalState(harness, goalId, 'awaiting-approval');
      const secondPark = nextGoalState(harness, goalId, 'awaiting-approval');
      await harness.council.revisePlan(goalId, 'First feedback');
      await secondPark;
      const thirdPark = nextGoalState(harness, goalId, 'awaiting-approval');
      await harness.council.revisePlan(goalId, 'Second feedback');
      await thirdPark;

      await harness.council.revisePlan(goalId, 'Third feedback');
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      const report = harness.ctx.repos.messages
        .list('thr_goal')
        .find((message) => message.content.includes('Council failed'));
      expect(report?.content).toContain('plan was revised twice without approval');
      expect(harness.ports.workerTurns()).toHaveLength(0);
      expect(
        harness.council
          .status(goalId)
          .tasks.every((task) => task.state === 'cancelled' || task.state === 'failed'),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('refuses an approval for a goal that is not parked', async () => {
    const harness = createHarness();
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      await expect(harness.council.approvePlan(goalId)).rejects.toThrow(/no longer running/i);
      await expect(harness.council.revisePlan(goalId, 'Change it')).rejects.toThrow(
        /no longer running/i,
      );
    } finally {
      await harness.dispose();
    }
  });
});

describe('council escalation answers', () => {
  it('runs a fan-in dependent after the captain accepts the escalated branch', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([
              planTask('First', ['src/first.ts']),
              planTask('Second', ['src/second.ts'], ['First']),
              planTask('Third', ['src/third.ts'], ['First']),
              planTask('Fourth', ['src/fourth.ts'], ['Second', 'Third']),
            ]),
          ),
        );
      }
      if (title === 'Review: First') {
        return Promise.resolve(result(input, 'VERDICT: escalate\nFINDINGS: needs a call'));
      }
      if (title.startsWith('Review:')) return Promise.resolve(result(input, PASS_REVIEW));
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      await nextTaskState(harness, goalId, 'First', 'awaiting-captain');
      // The loop parks without publishing anything else, so a short real wait is the
      // only way to observe that the rest of the plan is still queued and not dead:
      // fake timers cannot advance a promise chain already parked on an answer RPC.
      const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
      setTimeout(settle, 20);
      await settled;
      // The fan-in task waits through the two branches, so nothing may be terminalized
      // while the captain still owes an answer.
      const parked = harness.council.status(goalId);
      expect(parked.goal.state).toBe('running');
      for (const title of ['Second', 'Third', 'Fourth']) {
        expect(parked.tasks.find((task) => task.title === title)?.state).toBe('queued');
      }
      const first = parked.tasks.find((task) => task.title === 'First');
      await harness.council.answerEscalation({ taskId: first?.id ?? '', decision: 'accept' });
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      const tasks = harness.council.status(goalId).tasks;
      for (const title of ['First', 'Second', 'Third', 'Fourth']) {
        expect(tasks.find((task) => task.title === title)?.state).toBe('passed');
      }
      expect(harness.ports.created.some((request) => request.title === 'Council: Fourth')).toBe(
        true,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('fails a dropped task and its dependent', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([
              planTask('First', ['src/first.ts']),
              planTask('Second', ['src/second.ts'], ['First']),
            ]),
          ),
        );
      }
      if (title.startsWith('Review:')) {
        return Promise.resolve(result(input, 'VERDICT: escalate\nFINDINGS: needs a call'));
      }
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      await nextTaskState(harness, goalId, 'First', 'awaiting-captain');
      const first = harness.council.status(goalId).tasks.find((task) => task.title === 'First');
      await harness.council.answerEscalation({ taskId: first?.id ?? '', decision: 'drop' });
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('failed');
      const tasks = harness.council.status(goalId).tasks;
      const dropped = tasks.find((task) => task.title === 'First');
      expect(dropped?.state).toBe('failed');
      expect(dropped?.error).toBe('captain dropped the task');
      const second = tasks.find((task) => task.title === 'Second');
      expect(second?.state).toBe('failed');
      expect(second?.error).toContain('blocked by');
      expect(harness.ports.created.some((request) => request.title === 'Council: Second')).toBe(
        false,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('runs one more worker turn on the same thread and lets the review decide', async () => {
    const harness = createHarness();
    let reviews = 0;
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(
            input,
            planJson([
              planTask('First', ['src/first.ts']),
              planTask('Second', ['src/second.ts'], ['First']),
            ]),
          ),
        );
      }
      if (title.startsWith('Review:')) {
        reviews += 1;
        return Promise.resolve(
          result(
            input,
            reviews === 1 ? 'VERDICT: escalate\nFINDINGS: Handle the null case' : PASS_REVIEW,
          ),
        );
      }
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      await nextTaskState(harness, goalId, 'First', 'awaiting-captain');
      const first = harness.council.status(goalId).tasks.find((task) => task.title === 'First');
      const childThreadId = first?.threadId ?? '';
      await harness.council.answerEscalation({
        taskId: first?.id ?? '',
        decision: 'revise',
        feedback: 'Cover the empty input',
      });
      const goal = await harness.council.awaitGoal(goalId);
      expect(goal.state).toBe('done');
      const tasks = harness.council.status(goalId).tasks;
      expect(tasks.find((task) => task.title === 'First')?.state).toBe('passed');
      expect(tasks.find((task) => task.title === 'First')?.round).toBe(2);
      expect(tasks.find((task) => task.title === 'Second')?.state).toBe('passed');
      const turns = harness.ports.workerTurns().filter((turn) => turn.threadId === childThreadId);
      expect(turns).toHaveLength(2);
      expect(turns[1]?.text).toContain('CAPTAIN REVISION');
      expect(turns[1]?.text).toContain('Cover the empty input');
      expect(turns[1]?.text).toContain('Handle the null case');
    } finally {
      await harness.dispose();
    }
  });

  it('keeps the task awaiting the captain when the revision escalates again', async () => {
    const harness = createHarness();
    harness.ports.handler = (input, title) => {
      if (title.startsWith('Plan:')) {
        return Promise.resolve(
          result(input, planJson([planTask('First', ['src/first.ts'])])),
        );
      }
      if (title.startsWith('Review:')) {
        return Promise.resolve(result(input, 'VERDICT: escalate\nFINDINGS: still wrong'));
      }
      return Promise.resolve(result(input, 'worker done'));
    };
    try {
      const goalId = await startGoal(harness);
      await nextTaskState(harness, goalId, 'First', 'awaiting-captain');
      const first = harness.council.status(goalId).tasks.find((task) => task.title === 'First');
      await harness.council.answerEscalation({
        taskId: first?.id ?? '',
        decision: 'revise',
        feedback: 'Try once more',
      });
      await nextTaskState(harness, goalId, 'First', 'awaiting-captain');
      const task = harness.council.status(goalId).tasks[0];
      expect(task?.state).toBe('awaiting-captain');
      expect(task?.round).toBe(2);
      expect(harness.ctx.repos.council.listEscalations(task?.id ?? '')).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });
});

describe('council task events', () => {
  it('publishes taskId and taskState on council.updated', async () => {
    const harness = createHarness();
    try {
      const goalId = await startGoal(harness);
      await harness.council.awaitGoal(goalId);
      const task = harness.council.status(goalId).tasks[0];
      const taskEvents = harness.events.filter(
        (event) =>
          event.type === 'council.updated' &&
          event.payload.goalId === goalId &&
          event.payload.taskId !== undefined,
      );
      expect(taskEvents.length).toBeGreaterThan(0);
      for (const event of taskEvents) {
        if (event.type !== 'council.updated') continue;
        expect(event.payload.taskState).toBeDefined();
        expect(event.payload.state).toBeDefined();
      }
      expect(
        taskEvents.some(
          (event) =>
            event.type === 'council.updated' &&
            event.payload.taskId === task?.id &&
            event.payload.taskState === 'passed',
        ),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});

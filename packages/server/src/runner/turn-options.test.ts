import type {
  AdapterEvent,
  AdapterSession,
  Message,
  ServerEvent,
  TurnContext,
} from '@tuffcode/contracts';
import { SUBAGENT_TOOL_PROFILES } from '@tuffcode/prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, type EventBus } from '../events.js';
import { createSecretBridge } from '../secrets/bridge.js';
import { createTestContext, silentLogger, type TestContext } from '../test-support.js';
import { updateThread } from '../threads.js';
import { createRunner, type Runner } from './runner.js';
import {
  HANDOFF_HEADING,
  buildHandoffDigest,
  handoffChildren,
  isCouncilThread,
  subagentChildFor,
  turnReasoningEffort,
  turnToolPolicy,
} from './turn-options.js';

const ISO = '2026-11-25T10:00:00.000Z';

/** Answers every turn with one text delta and a clean finish, recording each context. */
class EchoAdapter implements AdapterSession {
  readonly id = 'sess_echo';
  readonly capabilities = { tools: true, approvals: true, resume: false, models: false };
  readonly contexts: TurnContext[] = [];
  constructor(readonly providerId: string) {}
  async *send(_text: string, ctx: TurnContext): AsyncIterable<AdapterEvent> {
    this.contexts.push(ctx);
    yield { type: 'text.delta', turnId: ctx.turnId, text: `answer from ${this.providerId}` };
    yield { type: 'turn.finished', turnId: ctx.turnId, reason: 'complete' };
  }
  approve(): void {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function message(role: Message['role'], content: string, index: number): Message {
  return { id: `m${index}`, threadId: 't', role, content, createdAt: ISO };
}

describe('handoff digest', () => {
  it('returns null with nothing to replay and keeps the newest messages under budget', () => {
    expect(buildHandoffDigest([])).toBeNull();
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(index % 2 === 0 ? 'user' : 'assistant', `message number ${index} ${'x'.repeat(200)}`, index),
    );
    const digest = buildHandoffDigest(messages, 400) ?? '';
    expect(digest.startsWith(HANDOFF_HEADING)).toBe(true);
    expect(digest).toContain('message number 59');
    expect(digest).not.toContain('message number 0 ');
    expect(Math.ceil(digest.length / 4)).toBeLessThanOrEqual(460);
  });

  it('skips tool rows and caps one long message', () => {
    const digest =
      buildHandoffDigest([message('tool', 'raw output', 1), message('user', 'y'.repeat(5000), 2)]) ?? '';
    expect(digest).not.toContain('raw output');
    expect(digest).toContain('...');
    expect(digest.length).toBeLessThan(1000);
  });

  it('keeps one line per child so a compaction cannot lose a report', () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(index % 2 === 0 ? 'user' : 'assistant', `message number ${index} ${'x'.repeat(200)}`, index),
    );
    const digest =
      buildHandoffDigest(messages, 400, [
        { childId: 'sub_one', type: 'explorer', status: 'done', reportId: 'srep_one' },
        { childId: 'sub_two', type: 'reviewer', status: 'running', reportId: null },
        { childId: 'sub_three', type: 'worker', status: 'failed', reportId: 'srep_three' },
      ]) ?? '';
    expect(digest).toContain('sub_one explorer done report srep_one');
    expect(digest).toContain('sub_two reviewer running report none');
    expect(digest).toContain('sub_three worker failed report srep_three');
    // The child lines are reserved, so the message budget is what shrinks.
    expect(Math.ceil(digest.length / 4)).toBeLessThanOrEqual(520);
  });

  it('drops the oldest child first when the children alone exceed the budget', () => {
    const children = Array.from({ length: 40 }, (_, index) => ({
      childId: `sub_${String(index).padStart(2, '0')}`,
      type: 'explorer' as const,
      status: 'done' as const,
      reportId: null,
    }));
    const digest = buildHandoffDigest([], 120, children) ?? '';
    expect(digest).toContain('sub_39 explorer done report none');
    expect(digest).not.toContain('sub_00 explorer done report none');
  });

  it('keeps every child id of a real thread in the digest', () => {
    const ctx = createTestContext();
    try {
      const now = new Date().toISOString();
      ctx.repos.projects.add({
        id: 'prj_1',
        name: 'Demo',
        path: 'C:/demo',
        defaultBranch: 'main',
        createdAt: now,
      });
      ctx.repos.threads.create({
        id: 'thr_parent',
        projectId: 'prj_1',
        parentThreadId: null,
        title: 'Parent thread',
        providerId: 'prv_1',
        modelId: 'model-x',
        executionMode: 'work',
        permissionMode: 'ask',
        status: 'idle',
        worktreePath: 'C:/worktrees/parent',
        branch: 'tuffcode/thr_parent',
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
      });
      for (const childId of ['sub_one', 'sub_two', 'sub_three']) {
        ctx.repos.subagents.create({
          childId,
          threadId: 'thr_parent',
          type: 'explorer',
          providerId: 'prv_1',
          model: 'model-x',
          status: 'queued',
          task: `task ${childId}`,
          createdAt: now,
        });
      }
      const digest = buildHandoffDigest([], 3000, handoffChildren(ctx.repos, 'thr_parent')) ?? '';
      expect(digest).toContain('sub_one explorer queued report none');
      expect(digest).toContain('sub_two explorer queued report none');
      expect(digest).toContain('sub_three explorer queued report none');
    } finally {
      ctx.dispose();
    }
  });
});

describe('turn tool policy', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.dispose());

  it('follows capabilities for ordinary threads and opens every tool for council', () => {
    const settings = ctx.repos.settings.get();
    const narrowed = {
      ...settings,
      enabledTools: ['read'],
      capabilities: { ...settings.capabilities, skills: false, connectors: false, todo: false },
    };
    const ordinary = turnToolPolicy({ settings: narrowed, council: false });
    expect(ordinary.toolAllowlist).toEqual(['read']);
    expect(ordinary.toolOptions).toMatchObject({ skill: false, mcp: false, todo: false, subagent: true });
    const council = turnToolPolicy({ settings: narrowed, council: true });
    expect(council.toolAllowlist).toBeUndefined();
    expect(Object.values(council.toolOptions).every(Boolean)).toBe(true);
  });

  it('carries a child profile through unchanged and leaves it unset otherwise', () => {
    const settings = ctx.repos.settings.get();
    const profile = SUBAGENT_TOOL_PROFILES.explorer;
    expect(turnToolPolicy({ settings, council: false, profile }).profile).toBe(profile);
    expect(turnToolPolicy({ settings, council: true, profile }).profile).toBe(profile);
    expect(turnToolPolicy({ settings, council: false }).profile).toBeUndefined();
  });

  it('finds the subagent row behind a child thread', () => {
    ctx.repos.projects.add({
      id: 'prj_sub',
      name: 'p',
      path: ctx.env.root,
      defaultBranch: 'main',
      createdAt: ISO,
    });
    ctx.repos.threads.create({
      id: 'thr_parent',
      projectId: 'prj_sub',
      parentThreadId: null,
      title: 'parent',
      providerId: 'prv',
      modelId: 'm',
      executionMode: 'work',
      permissionMode: 'full-auto',
      status: 'idle',
      worktreePath: null,
      branch: null,
      baseBranch: null,
      createdAt: ISO,
      updatedAt: ISO,
    });
    ctx.repos.subagents.create({
      childId: 'sub_1',
      threadId: 'thr_parent',
      type: 'explorer',
      providerId: 'prv',
      model: 'm',
      status: 'queued',
      task: 'map it',
      createdAt: ISO,
    });
    expect(subagentChildFor(ctx.repos, 'thr_parent')).toBeUndefined();
    ctx.repos.subagents.setRunning('sub_1', 'thr_child', ISO);
    expect(subagentChildFor(ctx.repos, 'thr_child')?.childId).toBe('sub_1');
    expect(subagentChildFor(ctx.repos, 'thr_parent')).toBeUndefined();
  });

  it('prefers the thread reasoning level over the provider default', () => {
    const base = { reasoningEffort: null } as const;
    expect(turnReasoningEffort({ ...base } as never, { reasoningEffort: 'high' })).toBe('high');
    expect(turnReasoningEffort({ reasoningEffort: 'low' } as never, { reasoningEffort: 'high' })).toBe(
      'low',
    );
    expect(turnReasoningEffort({ ...base } as never, {})).toBeUndefined();
  });

  it('detects council goal threads and their children, not ordinary threads', () => {
    ctx.repos.projects.add({ id: 'prj', name: 'p', path: ctx.env.root, defaultBranch: 'main', createdAt: ISO });
    const make = (id: string, parent: string | null, mode: 'work' | 'plan' | 'council') =>
      ctx.repos.threads.create({
        id,
        projectId: 'prj',
        parentThreadId: parent,
        title: id,
        providerId: 'prv',
        modelId: 'm',
        executionMode: mode,
        permissionMode: 'full-auto',
        status: 'idle',
        worktreePath: null,
        branch: null,
        baseBranch: null,
        createdAt: ISO,
        updatedAt: ISO,
      });
    const goal = make('goal', null, 'council');
    const worker = make('worker', 'goal', 'work');
    const review = make('review', 'worker', 'plan');
    const plain = make('plain', null, 'work');
    expect(isCouncilThread(ctx.repos, goal)).toBe(true);
    expect(isCouncilThread(ctx.repos, worker)).toBe(true);
    expect(isCouncilThread(ctx.repos, review)).toBe(true);
    expect(isCouncilThread(ctx.repos, plain)).toBe(false);
  });
});

describe('runner provider switch', () => {
  let ctx: TestContext;
  let bus: EventBus;
  let runner: Runner;
  const adapters = new Map<string, EchoAdapter>();

  /** Resolves once the turn finished and the runner released the thread. */
  async function turnEnd(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const off = bus.subscribe((event: ServerEvent) => {
      if (event.type === 'thread.event' && event.payload.type === 'turn.finished') {
        off();
        resolve();
      }
    });
    await promise;
    while (runner.listActive().length > 0) await new Promise((done) => setTimeout(done, 5));
  }

  beforeEach(() => {
    ctx = createTestContext();
    bus = createEventBus();
    adapters.clear();
    ctx.repos.projects.add({ id: 'prj', name: 'p', path: ctx.env.root, defaultBranch: 'main', createdAt: ISO });
    for (const id of ['prv_a', 'prv_b']) {
      ctx.repos.providers.upsert({ id, kind: 'openai-compatible', label: id, config: {}, enabled: true });
    }
    ctx.repos.threads.create({
      id: 'thr',
      projectId: 'prj',
      parentThreadId: null,
      title: 'New chat',
      providerId: 'prv_a',
      modelId: 'model-a',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: ctx.env.root,
      branch: null,
      baseBranch: null,
      createdAt: ISO,
      updatedAt: ISO,
    });
    runner = createRunner({
      repos: ctx.repos,
      bus,
      logger: silentLogger(),
      secrets: createSecretBridge(undefined),
      settings: () => ctx.repos.settings.get(),
      createAdapter: async (provider) => {
        const adapter = new EchoAdapter(provider.id);
        adapters.set(provider.id, adapter);
        return adapter;
      },
    });
  });

  afterEach(async () => {
    await runner.disposeAll();
    ctx.dispose();
  });

  it('names the thread from its first message and replays a digest after a provider switch', async () => {
    let ended = turnEnd();
    await runner.send('thr', 'please fix the flaky login test');
    await ended;
    expect(ctx.repos.threads.get('thr')?.title).toBe('Fix the flaky login test');
    const first = adapters.get('prv_a')?.contexts[0];
    expect(first?.threadId).toBe('thr');
    expect(first?.systemPrompt).not.toContain(HANDOFF_HEADING);

    updateThread(ctx.repos, { id: 'thr', providerId: 'prv_b', modelId: 'model-b', reasoningEffort: 'high' });
    ended = turnEnd();
    await runner.send('thr', 'now add a regression test');
    await ended;
    const moved = adapters.get('prv_b')?.contexts[0];
    expect(moved?.systemPrompt).toContain(HANDOFF_HEADING);
    expect(moved?.systemPrompt).toContain('user: please fix the flaky login test');
    expect(moved?.systemPrompt).toContain('assistant: answer from prv_a');
    expect(moved?.systemPrompt).not.toContain('now add a regression test');
    expect(moved?.reasoningEffort).toBe('high');
    expect(ctx.repos.threads.get('thr')?.title).toBe('Fix the flaky login test');

    ended = turnEnd();
    await runner.send('thr', 'thanks');
    await ended;
    expect(adapters.get('prv_b')?.contexts[1]?.systemPrompt).not.toContain(HANDOFF_HEADING);
  });

  it('refuses a provider switch without a model or to a disabled provider', () => {
    expect(() => updateThread(ctx.repos, { id: 'thr', providerId: 'prv_b' })).toThrow(/model id/);
    ctx.repos.providers.upsert({ id: 'prv_off', kind: 'openai-compatible', label: 'off', config: {}, enabled: false });
    expect(() =>
      updateThread(ctx.repos, { id: 'thr', providerId: 'prv_off', modelId: 'x' }),
    ).toThrow(/disabled/);
    expect(() => updateThread(ctx.repos, { id: 'thr', providerId: 'prv_missing', modelId: 'x' })).toThrow(
      /not found/,
    );
  });
});

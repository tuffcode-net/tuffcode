import { join } from 'node:path';
import type {
  AdapterEvent,
  AdapterSession,
  ApprovalChoice,
  ServerEvent,
  ThreadStatus,
  TurnContext,
} from '@tuffcode/contracts';
import { BASE_SYSTEM_PROMPT } from '@tuffcode/prompt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeAttachmentBytes } from '../attachments/store.js';
import type { ProviderRecord } from '../db/repos/index.js';
import { createEventBus, type EventBus } from '../events.js';
import { planPrompt } from '../prompt/service.js';
import { createSecretBridge } from '../secrets/bridge.js';
import { createTestContext, silentLogger, type TestContext } from '../test-support.js';
import { createRunner, INTERRUPTED_MARKER, recordTurnStart, type Runner } from './runner.js';

const ISO = '2026-11-24T10:00:00.000Z';

interface SendCall {
  text: string;
  ctx: TurnContext;
}

interface FakeStream {
  queue: AdapterEvent[];
  waiter: (() => void) | null;
  closed: boolean;
  failure: Error | null;
}

interface FakeAdapterOptions {
  /**
   * What the adapter does to its live stream when the runner interrupts it: yield its
   * own boundary, surface the cancellation as a stream failure, or stay silent until
   * the session is disposed.
   */
  interrupt?: 'boundary' | 'failure' | 'silent';
  /** Park dispose until the test releases it, to model a slow teardown. */
  holdDispose?: boolean;
}

/**
 * A queue-driven adapter: the test pushes events, the runner consumes them in order,
 * and `approve`/`interrupt` are observable without any vendor process. Each `send`
 * owns its stream, like a real adapter, so a cancelled turn's stream can never leak
 * an event into the next turn.
 */
class FakeAdapter implements AdapterSession {
  readonly id = 'sess_fake';
  readonly providerId = 'prv_test';
  readonly capabilities = { tools: true, approvals: true, resume: false, models: false };
  readonly sends: SendCall[] = [];
  readonly approvals: { approvalId: string; decision: ApprovalChoice }[] = [];
  interrupts = 0;
  disposes = 0;
  compactCalls = 0;

  private readonly streams: FakeStream[] = [];
  private readonly interruptMode: 'boundary' | 'failure' | 'silent';
  private readonly disposeGate: { promise: Promise<void>; resolve: () => void } | null;
  private readonly disposeStarted: { promise: Promise<void>; resolve: () => void } | null;
  private lastTurnId = 'turn_unknown';

  constructor(options: FakeAdapterOptions = {}) {
    this.interruptMode = options.interrupt ?? 'boundary';
    this.disposeGate = options.holdDispose === true ? Promise.withResolvers<void>() : null;
    this.disposeStarted = options.holdDispose === true ? Promise.withResolvers<void>() : null;
  }

  /** Resolves once dispose was entered and captured its stream. */
  whenDisposing(): Promise<void> {
    return this.disposeStarted?.promise ?? Promise.resolve();
  }

  /** Releases a held dispose so the session teardown can finish. */
  releaseDispose(): void {
    this.disposeGate?.resolve();
  }

  send(text: string, ctx: TurnContext): AsyncIterable<AdapterEvent> {
    this.sends.push({ text, ctx });
    this.lastTurnId = ctx.turnId;
    const stream: FakeStream = { queue: [], waiter: null, closed: false, failure: null };
    this.streams.push(stream);
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.next(stream) }),
    };
  }

  private async next(stream: FakeStream): Promise<IteratorResult<AdapterEvent>> {
    for (;;) {
      const event = stream.queue.shift();
      if (event !== undefined) {
        if (event.type === 'turn.finished') stream.closed = true;
        return { done: false, value: event };
      }
      // A real adapter's stream throws wherever it is, including while the runner is
      // parked waiting for the next event, so the failure is checked on every wake.
      if (stream.failure !== null) throw stream.failure;
      if (stream.closed) return { done: true, value: undefined };
      const { promise, resolve } = Promise.withResolvers<void>();
      stream.waiter = resolve;
      await promise;
    }
  }

  /** The stream of the latest send(); pushes and failures target it. */
  private latest(): FakeStream {
    const stream = this.streams.at(-1);
    if (stream === undefined) throw new Error('fake adapter has no stream: call send first');
    return stream;
  }

  push(...events: AdapterEvent[]): void {
    const stream = this.latest();
    stream.queue.push(...events);
    FakeAdapter.wake(stream);
  }

  fail(message: string): void {
    const stream = this.latest();
    stream.failure = new Error(message);
    FakeAdapter.wake(stream);
  }

  end(): void {
    const stream = this.streams.at(-1);
    if (stream === undefined) return;
    stream.closed = true;
    FakeAdapter.wake(stream);
  }

  approve(approvalId: string, decision: ApprovalChoice): void {
    this.approvals.push({ approvalId, decision });
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    if (this.interruptMode === 'failure') {
      // A real adapter can surface the cancellation as a stream failure instead of a
      // boundary event; the runner must not turn that into an error row.
      this.fail('stream closed during stop');
      return;
    }
    if (this.interruptMode === 'silent') return;
    // An aborted adapter yields its own boundary; the runner already settled, so this
    // must be ignored rather than logged a second time.
    this.push({ type: 'turn.finished', turnId: this.lastTurnId, reason: 'interrupted' });
  }

  async compact(): Promise<{ removed: number }> {
    this.compactCalls += 1;
    return { removed: 2 };
  }

  async dispose(): Promise<void> {
    this.disposes += 1;
    // The stream belongs to the send that was live when dispose was called; a later
    // send must keep its own stream open.
    const stream = this.streams.at(-1);
    this.disposeStarted?.resolve();
    if (this.disposeGate !== null) await this.disposeGate.promise;
    if (stream === undefined) return;
    stream.closed = true;
    FakeAdapter.wake(stream);
  }

  private static wake(stream: FakeStream): void {
    const waiter = stream.waiter;
    stream.waiter = null;
    waiter?.();
  }
}

function waitFor(bus: EventBus, predicate: (event: ServerEvent) => boolean): Promise<ServerEvent> {
  const { promise, resolve } = Promise.withResolvers<ServerEvent>();
  const unsubscribe = bus.subscribe((event) => {
    if (!predicate(event)) return;
    unsubscribe();
    resolve(event);
  });
  return promise;
}

function waitForTurnEnd(bus: EventBus): Promise<ServerEvent> {
  return waitFor(
    bus,
    (event) => event.type === 'thread.event' && event.payload.type === 'turn.finished',
  );
}

function contextEvents(events: readonly ServerEvent[]): ContextUpdatedEvent[] {
  return events.filter((event): event is ContextUpdatedEvent => event.type === 'context.updated');
}

type ContextUpdatedEvent = Extract<ServerEvent, { type: 'context.updated' }>;

/** The persisted event log of the fixture thread, oldest first. */
function storedEvents(f: Fixture) {
  return f.ctx.repos.events.since('thr_a', 0, 500);
}

/** Every turn.finished boundary in the persisted log, in order. */
function finishPayloads(f: Fixture) {
  const finished: {
    type: 'turn.finished';
    turnId: string;
    reason: 'complete' | 'interrupted' | 'error';
  }[] = [];
  for (const row of storedEvents(f)) {
    // The events column is stored JSON and typed unknown; the runner only appends
    // AdapterEvent payloads, so the cast recovers that boundary.
    const payload = row.payload as AdapterEvent;
    if (payload.type === 'turn.finished') {
      finished.push({ type: payload.type, turnId: payload.turnId, reason: payload.reason });
    }
  }
  return finished;
}

/** Event types of the log rows that belong to one turn. */
function turnEventTypes(f: Fixture, turnId: string): string[] {
  const types: string[] = [];
  for (const row of storedEvents(f)) {
    const payload = row.payload as AdapterEvent;
    if ('turnId' in payload && payload.turnId === turnId) types.push(row.type);
  }
  return types;
}

interface Fixture {
  ctx: TestContext;
  bus: EventBus;
  runner: Runner;
  adapter: FakeAdapter;
  adapterCalls: { provider: ProviderRecord; secret: string | null }[];
  events: ServerEvent[];
  threadStatus(): ThreadStatus;
  turnStatus(turnId: string): string | undefined;
}

describe('thread runner', () => {
  let fixtures: Fixture[] = [];

  function setup(
    options: {
      providerEnabled?: boolean;
      adapter?: FakeAdapter;
      /** Parks adapter creation for the calls it answers, to hold a turn mid-assembly. */
      adapterGate?: (call: number) => Promise<void> | undefined;
    } = {},
  ): Fixture {
    const ctx = createTestContext();
    const bus = createEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((event) => events.push(event));
    ctx.repos.projects.add({
      id: 'prj_a',
      name: 'alpha',
      path: ctx.env.root,
      defaultBranch: 'main',
      createdAt: ISO,
    });
    ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: {},
      enabled: options.providerEnabled ?? true,
    });
    ctx.repos.threads.create({
      id: 'thr_a',
      projectId: 'prj_a',
      parentThreadId: null,
      title: 'alpha thread',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: ctx.env.root,
      branch: 'tuffcode/thr_a',
      baseBranch: 'main',
      createdAt: ISO,
      updatedAt: ISO,
    });
    const adapter = options.adapter ?? new FakeAdapter();
    const adapterCalls: { provider: ProviderRecord; secret: string | null }[] = [];
    const runner = createRunner({
      repos: ctx.repos,
      bus,
      logger: silentLogger(),
      secrets: createSecretBridge(undefined),
      settings: () => ctx.repos.settings.get(),
      createAdapter: async (provider, secret) => {
        adapterCalls.push({ provider, secret });
        const parked = options.adapterGate?.(adapterCalls.length);
        if (parked !== undefined) await parked;
        return adapter;
      },
    });
    const fixture: Fixture = {
      ctx,
      bus,
      runner,
      adapter,
      adapterCalls,
      events,
      threadStatus: () => ctx.repos.threads.get('thr_a')?.status ?? 'idle',
      turnStatus: (turnId) => ctx.repos.turns.get(turnId)?.status,
    };
    fixtures.push(fixture);
    return fixture;
  }

  beforeEach(() => {
    fixtures = [];
  });

  afterEach(async () => {
    for (const fixture of fixtures) {
      await fixture.runner.disposeAll();
      fixture.ctx.dispose();
    }
    fixtures = [];
  });

  it('persists every event in order before broadcasting and writes one assistant message', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);

    const { turnId } = await f.runner.send('thr_a', 'hello');
    expect(turnId).toMatch(/^turn_/);

    f.adapter.push(
      { type: 'turn.started', turnId },
      { type: 'text.delta', turnId, text: 'hello ' },
      // A structural event forces the buffered text out, so this step writes two rows.
      { type: 'usage', turnId, inputTokens: 5 },
      { type: 'text.delta', turnId, text: 'world' },
      { type: 'turn.finished', turnId, reason: 'complete' },
    );
    await ended;

    const rows = f.ctx.repos.events.since('thr_a', 0, 100);
    expect(rows.map((row) => row.type)).toEqual([
      'turn.started',
      'text.delta',
      'usage',
      'text.delta',
      'turn.finished',
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);

    const broadcasts = f.events.filter(
      (event): event is Extract<ServerEvent, { type: 'thread.event' }> =>
        event.type === 'thread.event',
    );
    expect(broadcasts.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const broadcast of broadcasts) {
      const stored = f.ctx.repos.events.since('thr_a', broadcast.seq - 1, 1)[0];
      expect(stored?.payload).toEqual(broadcast.payload);
      // One timestamp per event: the live frame carries the persisted row's time.
      expect(broadcast.createdAt).toBe(stored?.createdAt);
      expect(broadcast.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    expect(f.threadStatus()).toBe('ready-to-review');
    expect(f.turnStatus(turnId)).toBe('complete');
    const messages = f.ctx.repos.messages.list('thr_a');
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content).toBe('hello world');
  });

  it('persists exactly one user row per turn and one assistant row when it completes', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    const sent = f.ctx.repos.messages.list('thr_a');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: `msg_${turnId}_user`, role: 'user', content: 'hello' });

    f.adapter.push(
      { type: 'text.delta', turnId, text: 'a' },
      { type: 'text.delta', turnId, text: 'b' },
      { type: 'turn.finished', turnId, reason: 'complete' },
    );
    await ended;

    const stored = f.ctx.repos.messages.list('thr_a');
    expect(stored.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(stored[1]).toMatchObject({ id: `msg_${turnId}_assistant`, content: 'ab' });
  });

  it('writes a 300-delta stream as a few rows and reconstructs the exact text', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'stream');

    const pieces = Array.from({ length: 300 }, (_, index) => `piece ${index} `);
    const expected = pieces.join('');
    f.adapter.push({ type: 'turn.started', turnId });
    for (const piece of pieces) f.adapter.push({ type: 'text.delta', turnId, text: piece });
    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    const rows = storedEvents(f);
    const deltas = rows.filter((row) => row.type === 'text.delta');
    // 302 pushed events (start, 300 deltas, boundary) become 3 rows.
    expect(rows).toHaveLength(3);
    expect(deltas).toHaveLength(1);
    const deltaText = (row: (typeof deltas)[number]): string => {
      const payload = row.payload as AdapterEvent;
      return payload.type === 'text.delta' ? payload.text : '';
    };
    expect(deltas.map(deltaText).join('')).toBe(expected);
    expect(f.ctx.repos.messages.list('thr_a')[1]?.content).toBe(expected);
    // Structural events keep their positions: the start leads and the boundary trails.
    expect(rows[0]?.type).toBe('turn.started');
    expect(rows.at(-1)?.type).toBe('turn.finished');
    const seqs = rows.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
  });

  it('flushes buffered text on the timer while the stream is idle', async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      const { turnId } = await f.runner.send('thr_a', 'slow');
      f.adapter.push({ type: 'text.delta', turnId, text: 'slow ' });
      // Drain the microtasks so the delta sits in the buffer, with the 50ms timer pending.
      await vi.advanceTimersByTimeAsync(0);
      expect(storedEvents(f)).toHaveLength(0);

      // No structural event arrives, so only the timer can surface this row.
      await vi.advanceTimersByTimeAsync(50);
      expect(storedEvents(f).map((row) => row.type)).toEqual(['text.delta']);

      const ended = waitForTurnEnd(f.bus);
      f.adapter.push(
        { type: 'text.delta', turnId, text: 'answer' },
        { type: 'turn.finished', turnId, reason: 'complete' },
      );
      await vi.advanceTimersByTimeAsync(0);
      await ended;

      const deltas = storedEvents(f).filter((row) => row.type === 'text.delta');
      expect(deltas).toHaveLength(2);
      expect(f.ctx.repos.messages.list('thr_a')[1]?.content).toBe('slow answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes a pending delta before the interrupt boundary and leaves no timer behind', async () => {
    vi.useFakeTimers();
    try {
      const f = setup();
      const { turnId } = await f.runner.send('thr_a', 'long job');
      f.adapter.push({ type: 'text.delta', turnId, text: 'partial' });
      // The delta is buffered and the 50ms timer has not fired yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(storedEvents(f)).toHaveLength(0);

      await f.runner.interrupt('thr_a');
      await vi.advanceTimersByTimeAsync(0);

      expect(storedEvents(f).map((row) => row.type)).toEqual(['text.delta', 'turn.finished']);
      expect(f.ctx.repos.messages.list('thr_a')[1]?.content).toBe(
        `partial${INTERRUPTED_MARKER}`,
      );
      // A timer that outlived the turn would append a second, empty delta row here.
      await vi.advanceTimersByTimeAsync(200);
      expect(storedEvents(f).map((row) => row.type)).toEqual(['text.delta', 'turn.finished']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the enabled tools from settings into the turn', async () => {
    const f = setup();
    f.ctx.repos.settings.patch({ enabledTools: ['read'] });
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    const ctx = f.adapter.sends[0]?.ctx;
    expect(ctx?.toolAllowlist).toEqual(['read']);

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
  });

  it('passes the settings output cap into the turn', async () => {
    const f = setup();
    f.ctx.repos.settings.patch({ maxOutputTokens: 4096 });
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    expect(f.adapter.sends[0]?.ctx.maxOutputTokens).toBe(4096);

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
  });

  it('lets a per-model output cap override the settings default', async () => {
    const f = setup();
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: { models: [{ id: 'model-x', label: 'Model X', maxOutputTokens: 2048 }] },
    });
    f.ctx.repos.settings.patch({ maxOutputTokens: 4096 });
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    expect(f.adapter.sends[0]?.ctx.maxOutputTokens).toBe(2048);

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
  });

  it('emits context.updated before and after a turn', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    const before = contextEvents(f.events);
    expect(before).toHaveLength(1);
    expect(before[0]?.payload).toMatchObject({
      threadId: 'thr_a',
      compacted: false,
      limitSource: 'default',
    });

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;

    await vi.waitFor(() => expect(contextEvents(f.events)).toHaveLength(2));
    const after = contextEvents(f.events);
    expect(after[1]?.payload.compacted).toBe(false);
    expect(after[1]?.payload.limitSource).toBe('default');
    expect(after[1]?.payload.usedTokens).toBeGreaterThan(0);
  });

  it('reports the provider config as the window source when the model row has none', async () => {
    const f = setup();
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: { contextWindow: 50_000 },
    });
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    expect(contextEvents(f.events)[0]?.payload).toMatchObject({
      maxTokens: 50_000,
      limitSource: 'config',
    });

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;

    await vi.waitFor(() => expect(contextEvents(f.events)).toHaveLength(2));
    expect(contextEvents(f.events)[1]?.payload.limitSource).toBe('config');
  });

  it('reports the model row as the window source when it declares one', async () => {
    const f = setup();
    f.ctx.repos.providers.replaceModels('prv_test', [
      { modelId: 'model-x', label: 'Model X', contextWindow: 12_000, isDefault: true },
    ]);
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    expect(contextEvents(f.events)[0]?.payload).toMatchObject({
      maxTokens: 12_000,
      limitSource: 'model',
    });

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
  });

  it('compacts once before a turn when usage crosses the warning threshold', async () => {
    const f = setup();
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: { contextWindow: 100 },
    });
    f.ctx.repos.settings.patch({ contextWarningThreshold: 0.5, autoCompact: true });
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    expect(f.adapter.compactCalls).toBe(1);
    const compacted = contextEvents(f.events).filter((event) => event.payload.compacted);
    expect(compacted).toHaveLength(1);

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
  });

  it('leaves history alone when auto-compaction is off', async () => {
    const f = setup();
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: { contextWindow: 100 },
    });
    f.ctx.repos.settings.patch({ contextWarningThreshold: 0.5, autoCompact: false });
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    expect(f.adapter.compactCalls).toBe(0);
    expect(contextEvents(f.events).some((event) => event.payload.compacted)).toBe(false);

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
  });

  it('does not duplicate the user row when the turn start is replayed', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', 'hello');
    f.adapter.end();

    recordTurnStart(f.ctx.repos, {
      threadId: 'thr_a',
      turnId,
      text: 'hello',
      injectedIds: [],
      createdAt: ISO,
    });

    expect(f.ctx.repos.messages.list('thr_a')).toHaveLength(1);
  });

  it('stores streamed text with a marker when the turn is interrupted', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', 'long job');
    const delta = waitFor(
      f.bus,
      (event) => event.type === 'thread.event' && event.payload.type === 'text.delta',
    );
    f.adapter.push({ type: 'text.delta', turnId, text: 'partial answer' });
    await delta;

    await f.runner.interrupt('thr_a');
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    const stored = f.ctx.repos.messages.list('thr_a');
    expect(stored.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(stored[1]).toMatchObject({
      id: `msg_${turnId}_assistant`,
      content: `partial answer${INTERRUPTED_MARKER}`,
    });
    expect(f.turnStatus(turnId)).toBe('interrupted');
  });

  it('queues a send behind a live turn and runs it once the turn settles', async () => {
    const f = setup();
    const first = await f.runner.send('thr_a', 'first');
    const queued = await f.runner.send('thr_a', 'second');
    expect(queued).toMatchObject({ queued: true });
    expect(queued.turnId).not.toBe(first.turnId);
    // One row per message: the queued text is persisted at send time, not at delivery.
    expect(f.ctx.repos.messages.list('thr_a')).toHaveLength(2);
    expect(f.adapter.sends.map((call) => call.text)).toEqual(['first']);

    const ended = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId: first.turnId, reason: 'complete' });
    await ended;
    await vi.waitFor(() => expect(f.adapter.sends).toHaveLength(2));

    expect(f.adapter.sends[1]).toMatchObject({ text: 'second' });
    expect(f.adapter.sends[1]?.ctx.turnId).toBe(queued.turnId);
    // The preallocated turn id makes recordTurnStart reuse the row, never duplicate it.
    expect(f.ctx.repos.messages.list('thr_a')).toHaveLength(2);

    const second = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'text.delta', turnId: queued.turnId, text: 'done' });
    f.adapter.push({ type: 'turn.finished', turnId: queued.turnId, reason: 'complete' });
    await second;

    expect(f.turnStatus(queued.turnId)).toBe('complete');
    expect(f.ctx.repos.messages.list('thr_a')).toHaveLength(3);
  });

  it('starts one turn when two sends arrive together', async () => {
    const f = setup();
    const [first, second] = await Promise.all([
      f.runner.send('thr_a', 'one'),
      f.runner.send('thr_a', 'two'),
    ]);
    // The slot is claimed before the first await, so the second send joins the backlog.
    expect([first.queued, second.queued].filter((queued) => queued === true)).toHaveLength(1);
    expect(f.adapter.sends.map((call) => call.text)).toEqual(['one']);

    const live = first.queued === true ? second : first;
    const backlogged = first.queued === true ? first : second;
    const ended = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId: live.turnId, reason: 'complete' });
    await ended;
    await vi.waitFor(() => expect(f.adapter.sends).toHaveLength(2));
    expect(f.adapter.sends[1]?.ctx.turnId).toBe(backlogged.turnId);
    const secondEnd = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId: backlogged.turnId, reason: 'complete' });
    await secondEnd;
    expect(f.turnStatus(backlogged.turnId)).toBe('complete');
  });

  it('queues a send that lands while the settle hands the thread over', async () => {
    const f = setup();
    let sneaky: Promise<{ turnId: string; queued?: boolean }> | null = null;
    // The settle deletes the slot, emits context, then delivers the backlog. A send that
    // lands in that gap must queue, not start a second turn beside the drained one.
    f.bus.subscribe((event) => {
      if (event.type !== 'context.updated') return;
      if (sneaky !== null || f.adapter.sends.length !== 1) return;
      sneaky = f.runner.send('thr_a', 'sneaky');
    });
    const first = await f.runner.send('thr_a', 'one');
    const queued = await f.runner.send('thr_a', 'two');
    expect(queued.queued).toBe(true);

    const ended = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId: first.turnId, reason: 'complete' });
    await ended;
    await vi.waitFor(() => expect(sneaky).not.toBeNull());
    const sneaked = await sneaky!;
    expect(sneaked.queued).toBeUndefined();

    // Only the turn that took the slot runs; the backlog waits for its settle.
    await vi.waitFor(() => expect(f.adapter.sends).toHaveLength(2));
    expect(f.adapter.sends.map((call) => call.text)).toEqual(['one', 'sneaky']);
    expect(f.turnStatus(queued.turnId)).toBeUndefined();

    const sneakyEnd = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId: sneaked.turnId, reason: 'complete' });
    await sneakyEnd;
    await vi.waitFor(() => expect(f.adapter.sends).toHaveLength(3));
    expect(f.adapter.sends[2]?.text).toBe('two');
    const twoEnd = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId: queued.turnId, reason: 'complete' });
    await twoEnd;
    expect(f.turnStatus(queued.turnId)).toBe('complete');
  });

  it('drops a turn interrupted while it assembles and frees the slot', async () => {
    const gate = Promise.withResolvers<void>();
    const f = setup({ adapterGate: (call) => (call === 1 ? gate.promise : undefined) });
    const pending = f.runner.send('thr_a', 'long job');
    await vi.waitFor(() => expect(f.adapterCalls).toHaveLength(1));
    await f.runner.interrupt('thr_a');
    gate.resolve();
    const { turnId } = await pending;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));
    // The adapter was built but never asked to run, and the turn settled honestly.
    expect(f.adapter.sends).toHaveLength(0);
    expect(f.turnStatus(turnId)).toBe('interrupted');
    expect(f.ctx.repos.messages.list('thr_a').map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    // The slot is free: the next send starts a turn instead of queueing forever.
    const next = await f.runner.send('thr_a', 'after the stop');
    expect(next.queued).toBeUndefined();
    const ended = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId: next.turnId, reason: 'complete' });
    await ended;
    expect(f.turnStatus(next.turnId)).toBe('complete');
  });

  it('runs two queued messages in the order they were sent', async () => {
    const f = setup();
    const first = await f.runner.send('thr_a', 'one');
    const second = await f.runner.send('thr_a', 'two');
    const third = await f.runner.send('thr_a', 'three');
    expect([second.queued, third.queued]).toEqual([true, true]);

    let live = 1;
    for (const turnId of [first.turnId, second.turnId, third.turnId]) {
      await vi.waitFor(() => expect(f.adapter.sends).toHaveLength(live));
      const ended = waitForTurnEnd(f.bus);
      f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
      await ended;
      live += 1;
    }
    await vi.waitFor(() => expect(f.adapter.sends).toHaveLength(3));

    expect(f.adapter.sends.map((call) => call.text)).toEqual(['one', 'two', 'three']);
  });

  it('refuses a ninth queued message', async () => {
    const f = setup();
    await f.runner.send('thr_a', 'first');
    for (let index = 0; index < 8; index += 1) {
      await expect(f.runner.send('thr_a', `queued ${index}`)).resolves.toMatchObject({
        queued: true,
      });
    }
    await expect(f.runner.send('thr_a', 'overflow')).rejects.toMatchObject({ code: 'conflict' });
    await f.runner.interrupt('thr_a');
  });

  it('drops the queue when the turn is interrupted', async () => {
    const f = setup();
    await f.runner.send('thr_a', 'long job');
    const queued = await f.runner.send('thr_a', 'never runs');
    expect(queued.queued).toBe(true);

    await f.runner.interrupt('thr_a');
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    // The dropped turn never starts: no second stream, no turn row, one message each.
    expect(f.adapter.sends).toHaveLength(1);
    expect(f.turnStatus(queued.turnId)).toBeUndefined();
    expect(f.ctx.repos.messages.list('thr_a')).toHaveLength(2);
  });

  it('rejects a blank message and an unknown thread', async () => {
    const idle = setup();
    await expect(idle.runner.send('thr_a', '   ')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(idle.runner.send('thr_missing', 'hello')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('reports a missing provider and a disabled provider with contract codes', async () => {
    const missing = setup();
    missing.ctx.repos.threads.create({
      id: 'thr_orphan',
      projectId: 'prj_a',
      parentThreadId: null,
      title: 'orphan',
      providerId: 'prv_missing',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: missing.ctx.env.root,
      branch: null,
      baseBranch: null,
      createdAt: ISO,
      updatedAt: ISO,
    });
    await expect(missing.runner.send('thr_orphan', 'hello')).rejects.toMatchObject({
      code: 'not-found',
    });

    const disabled = setup({ providerEnabled: false });
    await expect(disabled.runner.send('thr_a', 'hello')).rejects.toMatchObject({
      code: 'provider-unavailable',
    });
  });

  it('turns an adapter throw into error events and a failed thread', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    f.adapter.push({ type: 'turn.started', turnId });
    f.adapter.fail('socket closed');
    await ended;

    const rows = f.ctx.repos.events.since('thr_a', 0, 100);
    expect(rows.map((row) => row.type)).toEqual(['turn.started', 'error', 'turn.finished']);
    expect(rows[1]?.payload).toMatchObject({ message: expect.stringContaining('socket closed') });
    expect(f.threadStatus()).toBe('failed');
    expect(f.turnStatus(turnId)).toBe('failed');
  });

  it('synthesizes a failed finish when the stream ends without turn.finished', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');
    f.adapter.push({ type: 'turn.started', turnId });
    f.adapter.end();
    await ended;

    expect(f.ctx.repos.events.since('thr_a', 0, 100).map((row) => row.type)).toEqual([
      'turn.started',
      'error',
      'turn.finished',
    ]);
    expect(f.turnStatus(turnId)).toBe('failed');
  });

  it('resolves attachments inside the worktree and skips one that escapes with a notice', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', 'look at these', [
      { name: 'shot.png', path: 'shot.png', mimeType: 'image/png' },
      { name: 'escape.txt', path: '../escape.txt' },
    ]);
    expect(turnId).toMatch(/^turn_/);
    const ctx = f.adapter.sends[0]?.ctx;
    expect(ctx?.attachments).toEqual([
      { name: 'shot.png', path: join(f.ctx.env.root, 'shot.png'), mimeType: 'image/png', kind: 'image' },
    ]);
    const notices = f.events.flatMap((event) =>
      event.type === 'thread.event' && event.payload.type === 'notice' ? [event.payload] : [],
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('outside the worktree');
    f.adapter.end();
  });

  it('passes inline image bytes through without a worktree path', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', '', [
      { name: 'pasted.png', data: 'AAAA', mimeType: 'image/png' },
    ]);
    expect(turnId).toMatch(/^turn_/);
    expect(f.adapter.sends[0]?.ctx.attachments).toEqual([
      { name: 'pasted.png', data: 'AAAA', mimeType: 'image/png', kind: 'image' },
    ]);
    f.adapter.end();
  });

  it('reads a stored attachment id back for a retry or a replayed message', async () => {
    const f = setup();
    const id = await storeAttachmentBytes('AAAA', 'image/png');
    const { turnId } = await f.runner.send('thr_a', 'try again', [
      { name: 'pasted.png', id, mimeType: 'image/png' },
    ]);
    expect(turnId).toMatch(/^turn_/);
    expect(f.adapter.sends[0]?.ctx.attachments).toEqual([
      { name: 'pasted.png', data: 'AAAA', mimeType: 'image/png', kind: 'image' },
    ]);
    f.adapter.end();
  });

  it('rejects an attachment that carries neither a path nor data', async () => {
    const f = setup();
    await expect(f.runner.send('thr_a', '', [{ name: 'empty' }])).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('marks the turn as vision capable when the provider toggle is on', async () => {
    const f = setup();
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: { capabilities: { tools: true, vision: true, reasoning: false, reasoningEfforts: [] } },
    });
    const ended = waitForTurnEnd(f.bus);
    await f.runner.send('thr_a', 'look at this');
    expect(f.adapter.sends[0]?.ctx.vision).toBe(true);
    f.adapter.end();
    await ended;
  });

  it('leaves vision off when the provider toggle is off', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    await f.runner.send('thr_a', 'hello');
    expect(f.adapter.sends[0]?.ctx.vision).toBe(false);
    f.adapter.end();
    await ended;
  });

  it('prefers a model row that declares its own capabilities over the provider toggle', async () => {
    const f = setup();
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: { capabilities: { tools: true, vision: true, reasoning: false, reasoningEfforts: [] } },
    });
    f.ctx.repos.providers.replaceModels('prv_test', [
      {
        modelId: 'model-x',
        label: 'Model X',
        contextWindow: null,
        capabilities: { tools: true, vision: false, reasoning: false, reasoningEfforts: [] },
        isDefault: true,
      },
    ]);
    const ended = waitForTurnEnd(f.bus);
    await f.runner.send('thr_a', 'hello');
    expect(f.adapter.sends[0]?.ctx.vision).toBe(false);
    f.adapter.end();
    await ended;
  });

  it('uses the provider toggle when the discovered model row knows nothing', async () => {
    const f = setup();
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: { capabilities: { tools: true, vision: true, reasoning: false, reasoningEfforts: [] } },
    });
    // Discovery stored the row with no capabilities, which is what an endpoint that
    // publishes only model names produces. The turn must fall back to the toggle.
    f.ctx.repos.providers.replaceModels('prv_test', [
      { modelId: 'model-x', label: 'Model X', contextWindow: null, capabilities: null, isDefault: true },
    ]);
    const ended = waitForTurnEnd(f.bus);
    await f.runner.send('thr_a', 'hello');
    expect(f.adapter.sends[0]?.ctx.vision).toBe(true);
    f.adapter.end();
    await ended;
  });

  it('denies an approval whose run died and fails the thread', async () => {
    const f = setup();
    f.ctx.repos.approvals.create({
      id: 'apv_dead',
      threadId: 'thr_a',
      toolCallId: 'call_1',
      toolName: 'bash',
      input: {},
      createdAt: ISO,
    });

    await expect(f.runner.approve('thr_a', 'apv_dead', 'allow')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.ctx.repos.approvals.get('apv_dead')).toMatchObject({ decision: 'deny' });
    expect(f.threadStatus()).toBe('failed');
  });

  it('creates an approval, parks the thread, and resumes it on allow', async () => {
    const f = setup();
    const requested = waitFor(f.bus, (event) => event.type === 'approval.requested');
    const { turnId } = await f.runner.send('thr_a', 'run the tool');

    f.adapter.push({
      type: 'approval.requested',
      turnId,
      approvalId: 'apv_1',
      toolCallId: 'call_1',
      name: 'bash',
      input: { command: 'ls' },
    });
    await requested;

    const pending = f.ctx.repos.approvals.get('apv_1');
    expect(pending).toMatchObject({ decision: 'pending', toolName: 'bash' });
    expect(f.threadStatus()).toBe('needs-approval');
    expect(f.turnStatus(turnId)).toBe('needs-approval');

    await f.runner.approve('thr_a', 'apv_1', 'allow');
    expect(f.adapter.approvals).toEqual([{ approvalId: 'apv_1', decision: 'allow' }]);
    expect(f.ctx.repos.approvals.get('apv_1')).toMatchObject({ decision: 'allow' });
    expect(f.threadStatus()).toBe('running');
    expect(f.turnStatus(turnId)).toBe('running');

    const ended = waitForTurnEnd(f.bus);
    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
  });

  it('forwards deny and allow-thread unchanged and rejects unknown or resolved approvals', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', 'run the tool');

    f.adapter.push(
      {
        type: 'approval.requested',
        turnId,
        approvalId: 'apv_deny',
        toolCallId: 'call_1',
        name: 'bash',
        input: {},
      },
      {
        type: 'approval.requested',
        turnId,
        approvalId: 'apv_thread',
        toolCallId: 'call_2',
        name: 'bash',
        input: {},
      },
    );
    await waitFor(
      f.bus,
      (event) => event.type === 'approval.requested' && event.payload.id === 'apv_thread',
    );

    await expect(f.runner.approve('thr_a', 'apv_missing', 'allow')).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(f.adapter.approvals).toEqual([]);

    await f.runner.approve('thr_a', 'apv_deny', 'deny');
    await f.runner.approve('thr_a', 'apv_thread', 'allow-thread');
    expect(f.adapter.approvals).toEqual([
      { approvalId: 'apv_deny', decision: 'deny' },
      { approvalId: 'apv_thread', decision: 'allow-thread' },
    ]);

    await expect(f.runner.approve('thr_a', 'apv_deny', 'allow')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(f.adapter.approvals).toHaveLength(2);
    f.adapter.end();
  });

  it('interrupts the session, denies pending approvals, and ends ready-to-review', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', 'run the tool');
    f.adapter.push({
      type: 'approval.requested',
      turnId,
      approvalId: 'apv_1',
      toolCallId: 'call_1',
      name: 'bash',
      input: {},
    });
    await waitFor(f.bus, (event) => event.type === 'approval.requested');

    await f.runner.interrupt('thr_a');
    expect(f.adapter.interrupts).toBe(1);
    expect(f.ctx.repos.approvals.get('apv_1')?.decision).toBe('deny');
    expect(f.threadStatus()).toBe('ready-to-review');
    expect(f.turnStatus(turnId)).toBe('interrupted');
  });

  it('is a no-op interrupt for an idle thread and a conflict for a stuck one', async () => {
    const f = setup();
    await expect(f.runner.interrupt('thr_a')).resolves.toBeUndefined();
    f.ctx.repos.threads.update('thr_a', { status: 'running', updatedAt: ISO });
    await expect(f.runner.interrupt('thr_a')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('settles an interrupt with no streamed text and writes the boundary row', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', 'long job');
    expect(f.runner.listActive()).toHaveLength(1);

    await f.runner.interrupt('thr_a');

    expect(f.runner.listActive()).toEqual([]);
    expect(finishPayloads(f)).toEqual([{ type: 'turn.finished', turnId, reason: 'interrupted' }]);
    const messages = f.ctx.repos.messages.list('thr_a');
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({
      id: `msg_${turnId}_assistant`,
      content: '[interrupted]',
    });
    expect(f.turnStatus(turnId)).toBe('interrupted');
    expect(f.threadStatus()).toBe('ready-to-review');
  });

  it('tolerates a second interrupt without a duplicate finish', async () => {
    const f = setup();
    const { turnId } = await f.runner.send('thr_a', 'long job');

    await f.runner.interrupt('thr_a');
    await expect(f.runner.interrupt('thr_a')).resolves.toBeUndefined();

    expect(finishPayloads(f)).toEqual([{ type: 'turn.finished', turnId, reason: 'interrupted' }]);
    expect(f.adapter.interrupts).toBe(1);
    expect(f.adapter.disposes).toBe(1);
    expect(f.ctx.repos.messages.list('thr_a')).toHaveLength(2);
  });

  it('ignores a late adapter error once the interrupt settled the turn', async () => {
    const adapter = new FakeAdapter({ interrupt: 'failure' });
    const f = setup({ adapter });
    const { turnId } = await f.runner.send('thr_a', 'long job');
    const delta = waitFor(
      f.bus,
      (event) => event.type === 'thread.event' && event.payload.type === 'text.delta',
    );
    adapter.push({ type: 'text.delta', turnId, text: 'half' });
    await delta;

    await f.runner.interrupt('thr_a');
    // The run's finally emits its context update once the cancelled stream unwinds.
    await vi.waitFor(() => expect(contextEvents(f.events)).toHaveLength(2));

    expect(storedEvents(f).map((row) => row.type)).toEqual(['text.delta', 'turn.finished']);
    expect(finishPayloads(f)).toEqual([{ type: 'turn.finished', turnId, reason: 'interrupted' }]);
    expect(f.turnStatus(turnId)).toBe('interrupted');
    expect(f.threadStatus()).toBe('ready-to-review');
    expect(f.ctx.repos.messages.list('thr_a')[1]?.content).toBe(`half${INTERRUPTED_MARKER}`);
  });

  it('lets an immediate send start a fresh turn after an interrupt', async () => {
    const f = setup();
    const first = await f.runner.send('thr_a', 'one');
    const delta = waitFor(
      f.bus,
      (event) => event.type === 'thread.event' && event.payload.type === 'text.delta',
    );
    f.adapter.push({ type: 'text.delta', turnId: first.turnId, text: 'partial' });
    await delta;

    await f.runner.interrupt('thr_a');
    // Anything the cancelled stream still emits must never reach the log or a new turn.
    f.adapter.push({ type: 'text.delta', turnId: first.turnId, text: 'late' });
    f.adapter.fail('late socket error');

    const second = await f.runner.send('thr_a', 'two');
    expect(second.turnId).not.toBe(first.turnId);
    // The fence dropped the cached session, so this send built a new adapter session.
    expect(f.adapterCalls).toHaveLength(2);
    expect(f.adapter.sends).toHaveLength(2);
    // The old run's finally must not clear the new turn's slot.
    expect(f.runner.listActive().map((run) => run.turnId)).toEqual([second.turnId]);
    // A send while the replacement turn is live joins its backlog: it resolves as queued,
    // starts no stream, and the slot still names the live turn.
    const third = await f.runner.send('thr_a', 'three');
    expect(third.queued).toBe(true);
    expect(third.turnId).not.toBe(second.turnId);
    expect(f.adapter.sends).toHaveLength(2);
    expect(f.runner.listActive().map((run) => run.turnId)).toEqual([second.turnId]);

    const secondEnded = waitFor(
      f.bus,
      (event) =>
        event.type === 'thread.event' &&
        event.payload.type === 'turn.finished' &&
        event.payload.turnId === second.turnId,
    );
    f.adapter.push(
      { type: 'turn.started', turnId: second.turnId },
      { type: 'text.delta', turnId: second.turnId, text: 'fresh' },
      { type: 'turn.finished', turnId: second.turnId, reason: 'complete' },
    );
    await secondEnded;
    // The settled run hands the thread to the queued turn instead of going idle.
    await vi.waitFor(() => expect(f.adapter.sends).toHaveLength(3));
    expect(f.adapter.sends.map((call) => call.text)).toEqual(['one', 'two', 'three']);
    expect(f.runner.listActive().map((run) => run.turnId)).toEqual([third.turnId]);

    const thirdEnded = waitFor(
      f.bus,
      (event) =>
        event.type === 'thread.event' &&
        event.payload.type === 'turn.finished' &&
        event.payload.turnId === third.turnId,
    );
    f.adapter.push(
      { type: 'turn.started', turnId: third.turnId },
      { type: 'text.delta', turnId: third.turnId, text: 'queued' },
      { type: 'turn.finished', turnId: third.turnId, reason: 'complete' },
    );
    await thirdEnded;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    expect(finishPayloads(f)).toEqual([
      { type: 'turn.finished', turnId: first.turnId, reason: 'interrupted' },
      { type: 'turn.finished', turnId: second.turnId, reason: 'complete' },
      { type: 'turn.finished', turnId: third.turnId, reason: 'complete' },
    ]);
    // The cancelled run wrote its delta and its boundary, and nothing else.
    expect(turnEventTypes(f, first.turnId)).toEqual(['text.delta', 'turn.finished']);
    expect(turnEventTypes(f, second.turnId)).toEqual([
      'turn.started',
      'text.delta',
      'turn.finished',
    ]);
    expect(turnEventTypes(f, third.turnId)).toEqual([
      'turn.started',
      'text.delta',
      'turn.finished',
    ]);
    expect(storedEvents(f).some((row) => row.type === 'error')).toBe(false);

    // The queued send writes its user row immediately, so it lands ahead of the
    // assistant row of the turn it waited behind.
    const messages = f.ctx.repos.messages.list('thr_a');
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'assistant',
      'assistant',
    ]);
    expect(messages[1]?.content).toBe(`partial${INTERRUPTED_MARKER}`);
    expect(messages[2]?.content).toBe('two');
    expect(messages[3]?.content).toBe('three');
    expect(messages[4]?.content).toBe('fresh');
    expect(messages[5]?.content).toBe('queued');
  });

  it('does not let a stopped run clear the slot of the turn that replaced it', async () => {
    const adapter = new FakeAdapter({ interrupt: 'silent', holdDispose: true });
    const f = setup({ adapter });
    const first = await f.runner.send('thr_a', 'one');

    // The interrupt fences synchronously, then parks inside the slow session dispose,
    // so the replacement send runs while the first run is still registered with its
    // adapter stream.
    const stopping = f.runner.interrupt('thr_a');
    await adapter.whenDisposing();
    const second = await f.runner.send('thr_a', 'two');
    expect(second.turnId).not.toBe(first.turnId);
    expect(f.runner.listActive().map((run) => run.turnId)).toEqual([second.turnId]);

    adapter.releaseDispose();
    await stopping;
    // The first run's finally runs after the second turn was registered. It may only
    // clear its own slot, so the new turn must still own the thread.
    await vi.waitFor(() => expect(contextEvents(f.events)).toHaveLength(3));
    expect(f.runner.listActive().map((run) => run.turnId)).toEqual([second.turnId]);

    const secondEnded = waitFor(
      f.bus,
      (event) =>
        event.type === 'thread.event' &&
        event.payload.type === 'turn.finished' &&
        event.payload.turnId === second.turnId,
    );
    adapter.push({ type: 'turn.finished', turnId: second.turnId, reason: 'complete' });
    await secondEnded;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    expect(finishPayloads(f)).toEqual([
      { type: 'turn.finished', turnId: first.turnId, reason: 'interrupted' },
      { type: 'turn.finished', turnId: second.turnId, reason: 'complete' },
    ]);
  });

  it('ignores adapter events that follow the turn boundary', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    f.adapter.push(
      { type: 'turn.finished', turnId, reason: 'complete' },
      { type: 'text.delta', turnId, text: 'after the finish' },
    );
    await ended;
    await vi.waitFor(() => expect(contextEvents(f.events)).toHaveLength(2));

    expect(storedEvents(f).map((row) => row.type)).toEqual(['turn.finished']);
    expect(finishPayloads(f)).toEqual([{ type: 'turn.finished', turnId, reason: 'complete' }]);
    // Nothing streamed before the boundary, so no assistant row is written.
    expect(f.ctx.repos.messages.list('thr_a').map((message) => message.role)).toEqual(['user']);
  });

  it('emits exactly one turn.finished and one assistant row on normal completion', async () => {
    const f = setup();
    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'hello');

    f.adapter.push(
      { type: 'text.delta', turnId, text: 'done' },
      { type: 'turn.finished', turnId, reason: 'complete' },
    );
    await ended;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    expect(finishPayloads(f)).toEqual([{ type: 'turn.finished', turnId, reason: 'complete' }]);
    const assistants = f.ctx.repos.messages
      .list('thr_a')
      .filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe('done');
    expect(f.threadStatus()).toBe('ready-to-review');
  });

  it('records brain injection ids on the turn and touches them once', async () => {
    const f = setup();
    const rule = f.ctx.repos.brain.upsert({
      kind: 'rule',
      scope: 'global',
      text: 'always run pnpm',
      appliesTo: 'all',
    });
    const memory = f.ctx.repos.brain.upsert({
      kind: 'memory',
      scope: 'global',
      text: 'sharedtoken memory',
    });
    const { turnId } = await f.runner.send('thr_a', 'sharedtoken please');
    const turn = f.ctx.repos.turns.get(turnId);
    expect(turn?.injectedIds).toEqual(expect.arrayContaining([rule.id, memory.id]));
    expect(f.ctx.repos.brain.get(rule.id)?.useCount).toBe(1);
    expect(f.ctx.repos.brain.get(memory.id)?.useCount).toBe(1);

    const ctx = f.adapter.sends[0]?.ctx;
    expect(ctx?.systemPrompt).toContain('always run pnpm');
    expect(ctx?.systemPrompt).toContain('sharedtoken memory');
    expect(ctx?.brainSlice).toBe('');
    f.adapter.end();
  });

  it('captures a standing rule from the message once and never duplicates it', async () => {
    const f = setup();

    const firstEnd = waitForTurnEnd(f.bus);
    const first = await f.runner.send('thr_a', 'always remember: use pnpm');
    f.adapter.push({ type: 'turn.finished', turnId: first.turnId, reason: 'complete' });
    await firstEnd;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    const rules = f.ctx.repos.brain.list({ kind: 'rule' });
    expect(rules.map((entry) => entry.text)).toEqual(['use pnpm']);
    expect(rules[0]?.appliesTo).toBe('all');

    const secondEnd = waitForTurnEnd(f.bus);
    const second = await f.runner.send('thr_a', 'always remember: use pnpm');
    f.adapter.push({ type: 'turn.finished', turnId: second.turnId, reason: 'complete' });
    await secondEnd;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    expect(f.ctx.repos.brain.list({ kind: 'rule' })).toHaveLength(1);
  });

  it('keeps the turn running when standing rule capture fails', async () => {
    const f = setup();
    const upsert = vi.spyOn(f.ctx.repos.brain, 'upsert');
    upsert.mockImplementation(() => {
      throw new Error('brain store offline');
    });

    const ended = waitForTurnEnd(f.bus);
    const { turnId } = await f.runner.send('thr_a', 'always remember: use pnpm');

    expect(f.turnStatus(turnId)).toBe('running');
    expect(f.ctx.repos.messages.list('thr_a')).toHaveLength(1);

    f.adapter.push({ type: 'turn.finished', turnId, reason: 'complete' });
    await ended;
    expect(f.turnStatus(turnId)).toBe('complete');
    upsert.mockRestore();
  });

  it('assembles base, custom instructions, brain, context, then the user message', async () => {
    const f = setup();
    f.ctx.repos.settings.patch({ customInstructions: 'Prefer pnpm.\r\nNever force push.' });
    const rule = f.ctx.repos.brain.upsert({
      kind: 'rule',
      scope: 'global',
      text: 'pin tool versions',
      appliesTo: 'all',
    });
    const memory = f.ctx.repos.brain.upsert({
      kind: 'memory',
      scope: 'global',
      text: 'promptparity marker',
    });
    const message = 'promptparity run the suite';
    await f.runner.send('thr_a', message);

    const ctx = f.adapter.sends[0]?.ctx;
    const system = ctx?.systemPrompt ?? '';
    const thread = f.ctx.repos.threads.get('thr_a');
    const project = f.ctx.repos.projects.get('prj_a');
    if (thread === undefined || project === undefined) throw new Error('fixture is incomplete');

    const plan = planPrompt(f.ctx.repos, {
      thread,
      project,
      message,
      settings: f.ctx.repos.settings.get(),
    });
    expect(system).toBe(plan.assembly.systemPrompt);
    expect(ctx?.brainSlice).toBe('');
    expect(system.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);

    const custom = system.indexOf('## Custom instructions');
    const brain = system.indexOf('pin tool versions');
    const retrieved = system.indexOf('promptparity marker');
    const context = system.indexOf('<context>');
    expect(custom).toBeGreaterThan(0);
    expect(custom).toBeLessThan(brain);
    expect(brain).toBeLessThan(retrieved);
    expect(retrieved).toBeLessThan(context);
    expect(system).toContain('Prefer pnpm.\nNever force push.');
    expect(system).not.toContain(message);

    expect(f.ctx.repos.brain.get(rule.id)?.useCount).toBe(1);
    expect(f.ctx.repos.brain.get(memory.id)?.useCount).toBe(1);
    f.adapter.end();
  });

  it('reuses a session for the same provider and model and replaces it after a change', async () => {
    const f = setup();
    const firstEnded = waitForTurnEnd(f.bus);
    const first = await f.runner.send('thr_a', 'one');
    f.adapter.push({ type: 'turn.finished', turnId: first.turnId, reason: 'complete' });
    await firstEnded;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    const secondEnded = waitForTurnEnd(f.bus);
    const second = await f.runner.send('thr_a', 'two');
    expect(f.adapterCalls).toHaveLength(1);
    f.adapter.push({ type: 'turn.finished', turnId: second.turnId, reason: 'complete' });
    await secondEnded;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    f.ctx.repos.threads.update('thr_a', { modelId: 'model-y', updatedAt: ISO });
    const thirdEnded = waitForTurnEnd(f.bus);
    const third = await f.runner.send('thr_a', 'three');
    expect(f.adapterCalls).toHaveLength(2);
    expect(f.adapter.disposes).toBe(1);
    f.adapter.push({ type: 'turn.finished', turnId: third.turnId, reason: 'complete' });
    await thirdEnded;
    await vi.waitFor(() => expect(f.runner.listActive()).toHaveLength(0));

    await f.runner.disposeThread('thr_a');
    expect(f.adapter.disposes).toBe(2);
    await f.runner.disposeAll();
    expect(f.adapter.disposes).toBe(2);
  });

  it('resolves a provider secret ref through the bridge before creating the adapter', async () => {
    const f = setup();
    const seen: (string | null)[] = [];
    const withSecret = createRunner({
      repos: f.ctx.repos,
      bus: f.bus,
      logger: silentLogger(),
      secrets: {
        available: true,
        get: async (key) => (key === 'provider:prv_test' ? 'sk-resolved' : null),
        set: async () => undefined,
        dispose: () => undefined,
      },
      settings: () => f.ctx.repos.settings.get(),
      createAdapter: async (_provider, secret) => {
        seen.push(secret);
        return f.adapter;
      },
    });
    f.ctx.repos.providers.upsert({
      id: 'prv_test',
      kind: 'claude',
      label: 'Test',
      config: {},
      secretRef: 'provider:prv_test',
    });
    await withSecret.send('thr_a', 'hello');
    expect(seen).toEqual(['sk-resolved']);
    f.adapter.end();
    await withSecret.disposeAll();
  });
});

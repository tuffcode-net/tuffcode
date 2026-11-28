import { ClientRequestSchema, methods, type ThreadEventRow } from '@tuffcode/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../store/app-store';
import { createRpcClient, reconnectDelay, type EventSink, type RpcSocket } from './client';

class FakeSocket implements RpcSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  message(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function createClient(overrides: { requestTimeoutMs?: number; jitter?: () => number } = {}) {
  return createRpcClient({
    url: 'ws://127.0.0.1:9999/ws',
    token: 'test-token',
    socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1000,
    jitter: overrides.jitter ?? (() => 0),
    logger: { warn: vi.fn() },
  });
}

function lastSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error('Expected a fake socket.');
  return socket;
}

function sentFrame(socket: FakeSocket, index = 0): Record<string, unknown> {
  const frame = socket.sent[index];
  if (!frame) throw new Error(`Expected sent frame ${index}.`);
  return JSON.parse(frame) as Record<string, unknown>;
}

function sinkClient(appended: ThreadEventRow[]) {
  return createRpcClient({
    url: 'ws://127.0.0.1:9999/ws',
    token: 'test-token',
    socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    requestTimeoutMs: 1000,
    logger: { warn: vi.fn() },
    store: {
      getState: () => ({
        appendEvent: (_threadId: string, event: ThreadEventRow) => appended.push(event),
        subagentStarted: () => undefined,
        subagentEvent: () => undefined,
        subagentFinished: () => undefined,
        subagentTelemetry: () => undefined,
        subagentMessage: () => undefined,
        subagentQuestion: () => undefined,
        subagentAnswered: () => undefined,
        setTodos: () => undefined,
        setPlugins: () => undefined,
      }),
    },
  });
}

function replayRow(seq: number): ThreadEventRow {
  return {
    id: seq + 1,
    threadId: 'thread-1',
    seq,
    type: 'text.delta',
    payload: { type: 'text.delta', turnId: `turn-${Math.ceil(seq / 200)}`, text: `chunk ${seq}` },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function structuralRow(seq: number): ThreadEventRow {
  return {
    id: seq + 1,
    threadId: 'thread-1',
    seq,
    type: 'tool.started',
    payload: {
      type: 'tool.started',
      turnId: `turn-${seq}`,
      toolCallId: `call_${seq}`,
      name: 'bash',
      input: {},
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Waits for the client to send frame `index`, then answers it. */
async function respondToFrame(
  socket: FakeSocket,
  index: number,
  result: unknown,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20 && socket.sent.length <= index; attempt += 1) {
    await Promise.resolve();
  }
  const frame = sentFrame(socket, index);
  socket.message({ id: frame.id, ok: true, result });
  return frame;
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.useRealTimers();
});

describe('rpc client', () => {
  it('sends a request with the bearer subprotocol and resolves a validated result', async () => {
    const client = createClient();
    const socket = lastSocket();
    expect(socket.protocols).toEqual(['tuffcode.bearer.test-token']);

    socket.open();
    const pending = client.request('app.health', {});
    const frame = sentFrame(socket);
    expect(frame.method).toBe('app.health');

    socket.message({
      id: frame.id,
      ok: true,
      result: { version: '0.1.0', pid: 42, uptimeMs: 10, dbPath: 'C:/tmp/db.sqlite' },
    });

    await expect(pending).resolves.toEqual({
      version: '0.1.0',
      pid: 42,
      uptimeMs: 10,
      dbPath: 'C:/tmp/db.sqlite',
    });
    client.close();
  });

  it('rejects a request that exceeds the timeout', async () => {
    vi.useFakeTimers();
    const client = createClient({ requestTimeoutMs: 500 });
    lastSocket().open();

    const settled = client.request('app.health', {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);

    const error = await settled;
    expect(error).toMatchObject({ name: 'RpcRequestError', code: 'internal' });
    client.close();
  });

  it('reconnects on the deterministic exponential backoff schedule', async () => {
    vi.useFakeTimers();
    const client = createClient({ jitter: () => 0 });
    expect(FakeSocket.instances).toHaveLength(1);

    const expectedDelays = [500, 1000, 2000, 4000, 8000, 10_000, 10_000];
    for (const [index, delay] of expectedDelays.entries()) {
      lastSocket().serverClose();
      const count = FakeSocket.instances.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeSocket.instances).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(count + 1);
      expect(index).toBeLessThan(expectedDelays.length);
    }

    client.close();
  });

  it('drops an invalid event frame and signals a protocol error', () => {
    const statuses: string[] = [];
    const client = createClient();
    client.onStatus((status) => statuses.push(status));
    const socket = lastSocket();
    socket.open();

    socket.message({ kind: 'event', type: 'not-a-real-event', payload: {} });

    expect(statuses).toEqual(['open', 'protocol-error']);
    client.close();
  });

  it('replays thread events into the store', async () => {
    const appended: ThreadEventRow[] = [];
    const client = sinkClient(appended);
    const socket = lastSocket();
    socket.open();

    const event: ThreadEventRow = {
      id: 7,
      threadId: 'thread-1',
      seq: 3,
      type: 'text.delta',
      payload: { type: 'text.delta', turnId: 'turn-1', text: 'hello' },
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const pending = client.replay('thread-1', 0);
    const frame = sentFrame(socket);
    socket.message({
      id: frame.id,
      ok: true,
      result: { events: [event], hasMore: false },
    });

    await expect(pending).resolves.toEqual({ hasMore: false });
    expect(appended).toEqual([event]);
    client.close();
  });

  it('drains three replay pages and advances the cursor to each last row', async () => {
    const appended: ThreadEventRow[] = [];
    const client = sinkClient(appended);
    const socket = lastSocket();
    socket.open();

    const pageSizes = [200, 200, 50];
    let next = 1;
    const pending = client.replay('thread-1', 0);
    for (const [index, size] of pageSizes.entries()) {
      const events = Array.from({ length: size }, (_, offset) => replayRow(next + offset));
      next += size;
      await respondToFrame(socket, index, {
        events,
        hasMore: index < pageSizes.length - 1,
      });
    }

    await expect(pending).resolves.toEqual({ hasMore: false });
    expect(appended).toHaveLength(450);
    expect(appended.at(-1)?.seq).toBe(450);
    const requests = socket.sent.map((_, index) =>
      ClientRequestSchema.parse(sentFrame(socket, index)),
    );
    const cursors = requests.map(
      (request) => methods['threads.events'].params.parse(request.params).sinceSeq,
    );
    expect(cursors).toEqual([0, 200, 400]);
    client.close();
  });

  it('stops a replay when a page returns no events even if the server reports more', async () => {
    const appended: ThreadEventRow[] = [];
    const client = sinkClient(appended);
    const socket = lastSocket();
    socket.open();

    const pending = client.replay('thread-1', 5);
    await respondToFrame(socket, 0, { events: [], hasMore: true });

    await expect(pending).resolves.toEqual({ hasMore: false });
    expect(socket.sent).toHaveLength(1);
    expect(appended).toHaveLength(0);
    client.close();
  });

  it('replays 6000 structural events across 30 pages and keeps every row', async () => {
    const store = createAppStore();
    const client = createRpcClient({
      url: 'ws://127.0.0.1:9999/ws',
      token: 'test-token',
      socketFactory: (url, protocols) => new FakeSocket(url, protocols),
      requestTimeoutMs: 1000,
      logger: { warn: vi.fn() },
      store,
    });
    const socket = lastSocket();
    socket.open();

    const pages = 30;
    const pageSize = 200;
    const pending = client.replay('thread-1', 0);
    for (let page = 0; page < pages; page += 1) {
      const start = page * pageSize + 1;
      const events = Array.from({ length: pageSize }, (_, offset) => structuralRow(start + offset));
      await respondToFrame(socket, page, { events, hasMore: page < pages - 1 });
    }

    await expect(pending).resolves.toEqual({ hasMore: false });
    const rows = store.getState().events['thread-1'] ?? [];
    expect(rows).toHaveLength(pages * pageSize);
    expect(rows[0]?.seq).toBe(1);
    expect(rows.at(-1)?.seq).toBe(pages * pageSize);
    // Structural rows are exempt from the 5000-row cap, so all 6000 survive:
    // this proves replay drained every page, not that trimming kept the tail.
    expect(rows.every((row) => row.type === 'tool.started')).toBe(true);

    const requests = socket.sent.map((_, index) =>
      ClientRequestSchema.parse(sentFrame(socket, index)),
    );
    const cursors = requests.map(
      (request) => methods['threads.events'].params.parse(request.params).sinceSeq,
    );
    expect(cursors).toEqual(Array.from({ length: pages }, (_, page) => page * pageSize));
    client.close();
  });
});

describe('reconnectDelay', () => {
  it('starts at 500 ms, doubles, and caps at 10 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelay(attempt, 0))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });

  it('adds bounded jitter without exceeding the cap', () => {
    expect(reconnectDelay(0, 0.5)).toBe(550);
    expect(reconnectDelay(0, 1)).toBe(600);
    expect(reconnectDelay(20, 1)).toBe(10_000);
  });
});

interface RecordedCall {
  method: 'started' | 'event' | 'finished';
  input: unknown;
}

function recordingSink(): { calls: RecordedCall[]; sink: EventSink } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    sink: {
      getState: () => ({
        appendEvent: () => undefined,
        subagentStarted: (input) => calls.push({ method: 'started', input }),
        subagentEvent: (input) => calls.push({ method: 'event', input }),
        subagentFinished: (input) => calls.push({ method: 'finished', input }),
        subagentTelemetry: () => undefined,
        subagentMessage: () => undefined,
        subagentQuestion: () => undefined,
        subagentAnswered: () => undefined,
        setTodos: () => undefined,
        setPlugins: () => undefined,
      }),
    },
  };
}

function createRoutingClient(store: EventSink) {
  return createRpcClient({
    url: 'ws://127.0.0.1:9999/ws',
    token: 'test-token',
    socketFactory: (url, protocols) => new FakeSocket(url, protocols),
    requestTimeoutMs: 1000,
    jitter: () => 0,
    logger: { warn: vi.fn() },
    store,
  });
}

describe('rpc client subagent routing', () => {
  it('routes started, event and finished frames into the store sink', () => {
    const { calls, sink } = recordingSink();
    const client = createRoutingClient(sink);
    const socket = lastSocket();
    socket.open();

    socket.message({
      kind: 'event',
      type: 'subagent.started',
      payload: { childId: 'child-1', threadId: 'thread-1', type: 'explorer', model: 'm1' },
    });
    socket.message({
      kind: 'event',
      type: 'subagent.event',
      payload: {
        childId: 'child-1',
        threadId: 'thread-1',
        event: { type: 'text.delta', turnId: 'turn-child', text: 'hello' },
      },
    });
    socket.message({
      kind: 'event',
      type: 'subagent.finished',
      payload: { childId: 'child-1', threadId: 'thread-1', status: 'done', summary: 'ok' },
    });

    expect(calls).toEqual([
      {
        method: 'started',
        input: { childId: 'child-1', threadId: 'thread-1', type: 'explorer', model: 'm1' },
      },
      {
        method: 'event',
        input: {
          childId: 'child-1',
          threadId: 'thread-1',
          event: { type: 'text.delta', turnId: 'turn-child', text: 'hello' },
        },
      },
      {
        method: 'finished',
        input: { childId: 'child-1', threadId: 'thread-1', status: 'done', summary: 'ok' },
      },
    ]);

    client.close();
  });

  it('still notifies onEvent listeners after routing and drops a malformed frame', () => {
    const { calls, sink } = recordingSink();
    const client = createRoutingClient(sink);
    const socket = lastSocket();
    socket.open();

    const seen: string[] = [];
    client.onEvent((event) => seen.push(event.type));

    socket.message({
      kind: 'event',
      type: 'subagent.started',
      payload: { childId: 'child-1', threadId: 'thread-1', type: 'explorer', model: 'm1' },
    });
    socket.message({ kind: 'event', type: 'subagent.started', payload: { childId: '' } });

    expect(seen).toEqual(['subagent.started']);
    expect(calls).toHaveLength(1);
    expect(client.getStatus()).toBe('protocol-error');

    client.close();
  });

  it('ignores unrelated events in the sink', () => {
    const { calls, sink } = recordingSink();
    const client = createRoutingClient(sink);
    const socket = lastSocket();
    socket.open();

    socket.message({
      kind: 'event',
      type: 'thread.updated',
      payload: {
        id: 'thread-1',
        projectId: 'project-1',
        parentThreadId: null,
        title: 'Thread',
        providerId: 'provider-1',
        modelId: 'model-1',
        executionMode: 'work',
        permissionMode: 'ask',
        status: 'idle',
        worktreePath: 'C:/worktree',
        branch: 'tuffcode/thread-1',
        baseBranch: 'main',
        prUrl: null,
        reasoningEffort: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastSeq: 0,
      },
    });

    expect(calls).toEqual([]);
    client.close();
  });
});

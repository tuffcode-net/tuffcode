import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterDeps, AdapterEvent, AdapterLogger, TurnContext } from '@tuffcode/contracts';
import type { AnthropicMessage, AnthropicRequestBody, MessagesStreamer } from './client.js';
import { compactHistory, mapStopReason, runTurn } from './loop.js';
import { createToolSessionState } from '../openai/tools.js';

const LF = String.fromCharCode(10);
const encoder = new TextEncoder();

const logger: AdapterLogger = { debug() {}, info() {}, warn() {}, error() {} };
const deps: AdapterDeps = { logger, resolveCommand: async () => null, env: {} };

let root: string;

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 'turn_1',
    cwd: root,
    systemPrompt: 'You are Tuffcode.',
    permissionMode: 'full-auto',
    model: 'claude-test',
    brainSlice: '',
    attachments: [],
    vision: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface FixtureEvent {
  event: string;
  data: unknown;
}

function fixture(name: string): FixtureEvent[] {
  const url = new URL('../fixtures/anthropic/' + name + '.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as FixtureEvent[];
}

/** Splits the SSE text every `splitEvery` bytes when set, to exercise buffering. */
function streamOf(events: FixtureEvent[], splitEvery = 0): ReadableStream<Uint8Array> {
  const text = events
    .map((entry) => 'event: ' + entry.event + LF + 'data: ' + JSON.stringify(entry.data) + LF + LF)
    .join('');
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  if (splitEvery > 0) {
    for (let offset = 0; offset < bytes.length; offset += splitEvery) {
      chunks.push(bytes.slice(offset, offset + splitEvery));
    }
  } else {
    chunks.push(bytes);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tuffcode-anthropic-loop-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

class FakeClient implements MessagesStreamer {
  readonly requests: AnthropicRequestBody[] = [];
  private index = 0;

  constructor(private readonly streams: ReadableStream<Uint8Array>[]) {}

  async stream(request: AnthropicRequestBody): Promise<ReadableStream<Uint8Array>> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const next = this.streams[this.index];
    this.index += 1;
    if (next === undefined) throw new Error('unexpected request');
    return next;
  }
}

async function collect(iterable: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** One complete `write` tool_use block, distinct per `index`, with no assistant text. */
function toolUseEvents(index: number): FixtureEvent[] {
  const args = JSON.stringify({ path: 'out.txt', content: 'v' + index });
  return [
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_' + index, name: 'write', input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: args },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 1 },
      },
    },
  ];
}

/** Several complete tool_use blocks in one assistant step, in the model's order. */
function multiToolUseEvents(
  calls: readonly { id: string; name: string; args: unknown }[],
): FixtureEvent[] {
  const events: FixtureEvent[] = [];
  for (const [index, call] of calls.entries()) {
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      },
    });
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) },
      },
    });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  }
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 1 },
    },
  });
  return events;
}

/** A promise plus its resolver, so a test can hold a tool call open mid-flight. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  // The package targets ES2023, which has no Promise.withResolvers, so this is the
  // only way to capture the resolver.
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A body whose first read rejects, standing in for a dropped provider connection. */
function failingStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(message));
    },
  });
}

describe('runTurn', () => {
  it('stops a turn that never finishes with a visible reason', async () => {
    const streams = Array.from({ length: 61 }, (_unused, index) =>
      streamOf(toolUseEvents(index)),
    );
    const client = new FakeClient(streams);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'loop forever' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' ? error.message : '').toContain('tool steps');
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'error' });
  });

  it('reports a reply cut by max_tokens instead of finishing quietly', async () => {
    const truncated = fixture('text-stream').map((entry) =>
      entry.event === 'message_delta'
        ? {
            event: entry.event,
            data: {
              ...(entry.data as Record<string, unknown>),
              delta: { stop_reason: 'max_tokens' },
            },
          }
        : entry,
    );
    const client = new FakeClient([streamOf(truncated)]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' ? error.message : '').toContain('output token limit');
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'error' });
  });

  it('assembles text across arbitrary SSE chunk splits and reports usage', async () => {
    const client = new FakeClient([streamOf(fixture('text-stream'), 7)]);
    const messages: AnthropicMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    const deltas = events.filter((event) => event.type === 'text.delta');
    expect(deltas).toEqual([
      { type: 'text.delta', turnId: 'turn_1', text: 'Hel' },
      { type: 'text.delta', turnId: 'turn_1', text: 'lo' },
    ]);
    expect(events).toContainEqual({
      type: 'usage',
      turnId: 'turn_1',
      inputTokens: 12,
      outputTokens: 5,
    });
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });
    expect(messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(client.requests[0]?.system).toBe('You are Tuffcode.');
    expect(client.requests[0]?.max_tokens).toBe(256);
  });

  it('assembles a split tool_use block, runs the tool, and sends the result back', async () => {
    const client = new FakeClient([
      streamOf(fixture('tool-use-stream'), 11),
      streamOf(fixture('text-stream')),
    ]);
    const messages: AnthropicMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    const started = events.find((event) => event.type === 'tool.started');
    expect(started).toMatchObject({
      type: 'tool.started',
      turnId: 'turn_1',
      toolCallId: 'toolu_1',
      name: 'write',
      input: { path: 'out.txt', content: 'hello' },
    });
    expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
      type: 'tool.finished',
      toolCallId: 'toolu_1',
      output: 'wrote out.txt (5 bytes)',
      isError: false,
    });
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('hello');
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });

    expect(client.requests).toHaveLength(2);
    const second = client.requests[1]?.messages ?? [];
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Writing.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'write',
          input: { path: 'out.txt', content: 'hello' },
        },
      ],
    });
    expect(second[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'wrote out.txt (5 bytes)',
        },
      ],
    });
  });

  it('runs two read-only calls of one step concurrently and keeps results in call order', async () => {
    const gates = [gate<string>(), gate<string>()];
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const withRunner: AdapterDeps = {
      ...deps,
      extraTool: async (_name, args) => {
        const index = args.query === 'first' ? 0 : 1;
        started.push(String(args.query));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const output = await gates[index]?.promise;
        inFlight -= 1;
        return output ?? '';
      },
    };
    const client = new FakeClient([
      streamOf(
        multiToolUseEvents([
          { id: 'toolu_a', name: 'memory', args: { action: 'search', query: 'first' } },
          { id: 'toolu_b', name: 'memory', args: { action: 'search', query: 'second' } },
        ]),
      ),
      streamOf(fixture('text-stream')),
    ]);
    const messages: AnthropicMessage[] = [{ role: 'user', content: 'go' }];
    const events: AdapterEvent[] = [];
    const collecting = (async () => {
      for await (const event of runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      })) {
        events.push(event);
      }
    })();

    // Both calls must be running before either one is allowed to finish.
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    expect(maxInFlight).toBe(2);
    gates[1]?.resolve('second result');
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(1),
    );
    expect(events.filter((event) => event.type === 'tool.finished')[0]).toMatchObject({
      toolCallId: 'toolu_b',
      output: 'second result',
    });
    gates[0]?.resolve('first result');
    await collecting;

    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished.map((event) => event.toolCallId)).toEqual(['toolu_b', 'toolu_a']);
    expect(
      events.filter((event) => event.type === 'tool.started').map((event) => event.toolCallId),
    ).toEqual(['toolu_a', 'toolu_b']);
    // The tool_result blocks follow the model's call order, not the completion order.
    expect(client.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'first result' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'second result' },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });
  });

  it('serializes the step when one call needs approval', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const withRunner: AdapterDeps = {
      ...deps,
      extraTool: async (_name, args) => {
        order.push(String(args.query ?? args.action));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return 'ran ' + String(args.query ?? args.action);
      },
    };
    const client = new FakeClient([
      streamOf(
        multiToolUseEvents([
          { id: 'toolu_read', name: 'memory', args: { action: 'search', query: 'first' } },
          {
            id: 'toolu_cfg',
            name: 'config',
            args: { action: 'settings.set', key: 'a', value: 1 },
          },
        ]),
      ),
      streamOf(fixture('text-stream')),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask' }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => {
          order.push('approval');
          return 'allow';
        },
      }),
    );

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['first', 'approval', 'settings.set']);
    const types = events
      .filter(
        (event) =>
          event.type === 'tool.started' ||
          event.type === 'tool.finished' ||
          event.type === 'approval.requested',
      )
      .map((event) => event.type);
    expect(types).toEqual([
      'tool.started',
      'tool.finished',
      'tool.started',
      'approval.requested',
      'tool.finished',
    ]);
  });

  it('does not cancel a sibling when one parallel call fails', async () => {
    const withRunner: AdapterDeps = {
      ...deps,
      extraTool: async (_name, args) => {
        if (args.query === 'boom') throw new Error('memory offline');
        return 'ok';
      },
    };
    const client = new FakeClient([
      streamOf(
        multiToolUseEvents([
          { id: 'toolu_boom', name: 'memory', args: { action: 'search', query: 'boom' } },
          { id: 'toolu_ok', name: 'memory', args: { action: 'search', query: 'fine' } },
        ]),
      ),
      streamOf(fixture('text-stream')),
    ]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished).toHaveLength(2);
    expect(finished.find((event) => event.toolCallId === 'toolu_boom')).toMatchObject({
      output: 'memory offline',
      isError: true,
    });
    expect(finished.find((event) => event.toolCallId === 'toolu_ok')).toMatchObject({
      output: 'ok',
      isError: false,
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'complete' });
  });

  it('denies a tool when approval is denied', async () => {
    const client = new FakeClient([
      streamOf(fixture('tool-use-stream')),
      streamOf(fixture('text-stream')),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask' }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'deny',
      }),
    );

    const approval = events.find((event) => event.type === 'approval.requested');
    expect(approval).toMatchObject({
      type: 'approval.requested',
      turnId: 'turn_1',
      toolCallId: 'toolu_1',
      name: 'write',
      input: { path: 'out.txt', content: 'hello' },
    });
    expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
      output: 'denied by user',
      isError: true,
    });
    await expect(readFile(join(root, 'out.txt'), 'utf8')).rejects.toThrow();
  });

  it('redacts a secret in the approval event and executes the raw arguments', async () => {
    const calls: { name: string; args: Record<string, unknown>; cwd: string }[] = [];
    const withRunner: AdapterDeps = {
      ...deps,
      extraTool: async (name, args, ctx) => {
        calls.push({ name, args, cwd: ctx.cwd });
        return 'created';
      },
    };
    const client = new FakeClient([
      streamOf([
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: {
              id: 'msg_cfg',
              model: 'claude-test',
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_cfg', name: 'config', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"action":"provider.add","label":"Remote","apiKey":"sk-approval"}',
            },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        {
          event: 'message_delta',
          data: {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 12 },
          },
        },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
      streamOf(fixture('text-stream')),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask' }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(events.find((event) => event.type === 'approval.requested')).toMatchObject({
      type: 'approval.requested',
      toolCallId: 'toolu_cfg',
      name: 'config',
      input: { action: 'provider.add', label: 'Remote', apiKey: '[redacted]' },
    });
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({
      input: { action: 'provider.add', label: 'Remote', apiKey: '[redacted]' },
    });
    expect(JSON.stringify(events)).not.toContain('sk-approval');
    expect(calls).toEqual([
      {
        name: 'config',
        args: { action: 'provider.add', label: 'Remote', apiKey: 'sk-approval' },
        cwd: root,
      },
    ]);
  });

  it('maps a refusal stop_reason to an error turn', async () => {
    const client = new FakeClient([streamOf(fixture('refusal-stream'))]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'error',
    });
  });

  it('runs a long productive turn without a call cap', async () => {
    const streams = Array.from({ length: 50 }, (_, index) => streamOf(toolUseEvents(index)));
    const client = new FakeClient([...streams, streamOf(fixture('text-stream'))]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests).toHaveLength(51);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(50);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });
  });

  it('stops when the same tool call repeats three times with no new text', async () => {
    const events = toolUseEvents(0);
    const client = new FakeClient([streamOf(events), streamOf(events), streamOf(events)]);
    const result = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests).toHaveLength(3);
    expect(result.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
    expect(result.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'anthropic: repeated identical tool call', retryable: false },
    ]);
    expect(result.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'error',
    });
  });

  it('reports interrupted when the signal aborts mid loop', async () => {
    const controller = new AbortController();
    const client = new FakeClient([streamOf(toolUseEvents(0))]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask', signal: controller.signal }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: controller.signal,
        maxTokens: 256,
        requestApproval: async () => {
          controller.abort();
          return 'allow';
        },
      }),
    );

    expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
      type: 'tool.finished',
      output: '[interrupted]',
      isError: true,
    });
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'interrupted',
    });
  });

  it('reports a stream failure as one error and one finish', async () => {
    const client = new FakeClient([failingStream('socket closed')]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'anthropic: socket closed', retryable: true },
    ]);
    expect(events.filter((event) => event.type === 'turn.finished')).toEqual([
      { type: 'turn.finished', turnId: 'turn_1', reason: 'error' },
    ]);
  });

  it('offers only the allowlisted tools and rejects a disabled call', async () => {
    const client = new FakeClient([
      streamOf(fixture('tool-use-stream')),
      streamOf(fixture('text-stream')),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ toolAllowlist: ['read'] }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests[0]?.toolAllowlist).toEqual(['read']);
    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({
      type: 'tool.finished',
      output: 'tool "write" is disabled in settings',
      isError: true,
    });
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    await expect(readFile(join(root, 'out.txt'), 'utf8')).rejects.toThrow();
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });
  });

  it('offers the extra tools and runs a memory search through the runner', async () => {
    const calls: { name: string; args: Record<string, unknown>; cwd: string }[] = [];
    const withRunner: AdapterDeps = {
      ...deps,
      extraTool: async (name, args, ctx) => {
        calls.push({ name, args, cwd: ctx.cwd });
        return 'two entries: build uses pnpm';
      },
    };
    const client = new FakeClient([
      streamOf([
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: {
              id: 'msg_mem',
              model: 'claude-test',
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_mem', name: 'memory', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"action":"search","query":"build"}',
            },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        {
          event: 'message_delta',
          data: {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 12 },
          },
        },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]),
      streamOf(fixture('text-stream')),
    ]);
    const messages: AnthropicMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests[0]?.toolOptions?.extra).toBe(true);
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({
      type: 'tool.started',
      toolCallId: 'toolu_mem',
      name: 'memory',
      input: { action: 'search', query: 'build' },
    });
    expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
      type: 'tool.finished',
      toolCallId: 'toolu_mem',
      output: 'two entries: build uses pnpm',
      isError: false,
    });
    expect(calls).toEqual([
      { name: 'memory', args: { action: 'search', query: 'build' }, cwd: root },
    ]);
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_mem', content: 'two entries: build uses pnpm' },
      ],
    });
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });
  });

  it('does not offer the extra tools without a runner', async () => {
    const client = new FakeClient([streamOf(fixture('text-stream'))]);
    await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests[0]?.toolOptions?.extra).toBe(false);
  });
});

describe('mapStopReason', () => {
  it('completes on normal stops and errors only on refusal', () => {
    expect(mapStopReason('end_turn')).toBe('complete');
    expect(mapStopReason('tool_use')).toBe('complete');
    expect(mapStopReason('max_tokens')).toBe('complete');
    expect(mapStopReason('stop_sequence')).toBe('complete');
    expect(mapStopReason(null)).toBe('complete');
    expect(mapStopReason('refusal')).toBe('error');
  });
});

describe('compactHistory', () => {
  it('folds all but the last two messages into one system message', async () => {
    const client = new FakeClient([streamOf(fixture('text-stream'))]);
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];

    const result = await compactHistory({
      client,
      messages,
      model: 'claude-test',
      maxTokens: 256,
      deps,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ removed: 2 });
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Hello');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ]);
    expect(client.requests[0]?.toolAllowlist).toEqual([]);
    expect(client.requests[0]?.system).toContain('compress conversation history');
  });

  it('keeps a leading tool result with the tool_use it answers', async () => {
    const client = new FakeClient([streamOf(fixture('text-stream'))]);
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'one' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'a' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'file body' }],
      },
      { role: 'assistant', content: 'done' },
    ];

    const result = await compactHistory({
      client,
      messages,
      model: 'claude-test',
      maxTokens: 256,
      deps,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ removed: 1 });
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('keeps history and reports zero when the summary request fails', async () => {
    const client = new FakeClient([]);
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];

    const result = await compactHistory({
      client,
      messages,
      model: 'claude-test',
      maxTokens: 256,
      deps,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ removed: 0 });
    expect(messages).toHaveLength(4);
  });

  it('sends the turn output cap when it is set', async () => {
    const client = new FakeClient([streamOf(fixture('text-stream'))]);
    await collect(
      runTurn({
        ctx: context({ maxOutputTokens: 512 }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        maxTokens: 256,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests[0]?.max_tokens).toBe(512);
  });
});

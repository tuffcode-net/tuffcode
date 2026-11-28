import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterDeps, AdapterEvent, AdapterLogger, TurnContext } from '@tuffcode/contracts';
import { SUBAGENT_TOOL_PROFILES } from '@tuffcode/prompt';
import type { ChatMessage, ChatRequestBody, ChatStreamer } from './client.js';
import { createOpenAIChatAdapter } from './index.js';
import { compactHistory, runTurn } from './loop.js';
import { createToolSessionState } from './tools.js';

const LF = String.fromCharCode(10);
const DONE = 'data: ' + String.fromCharCode(91, 68, 79, 78, 69, 93) + LF + LF;
const encoder = new TextEncoder();

/** A 1x1 PNG: the smallest payload that is a real image to base64. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

const logger: AdapterLogger = { debug() {}, info() {}, warn() {}, error() {} };
const deps: AdapterDeps = { logger, resolveCommand: async () => null, env: {} };

let root: string;

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 'turn_1',
    cwd: root,
    systemPrompt: 'You are Tuffcode.',
    permissionMode: 'full-auto',
    model: 'test-model',
    brainSlice: '',
    attachments: [],
    vision: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function fixture(name: string): unknown[] {
  const url = new URL('../fixtures/openai/' + name + '.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown[];
}

function streamOf(payloads: unknown[]): ReadableStream<Uint8Array> {
  const text = payloads.map((payload) => 'data: ' + JSON.stringify(payload) + LF + LF).join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text + DONE));
      controller.close();
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tuffcode-openai-loop-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

class FakeClient implements ChatStreamer {
  readonly requests: ChatRequestBody[] = [];
  private index = 0;

  constructor(private readonly streams: ReadableStream<Uint8Array>[]) {}

  async stream(request: ChatRequestBody): Promise<ReadableStream<Uint8Array>> {
    this.requests.push(request);
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

/** One complete `write` tool call in a single delta, distinct per `index`. */
function toolCallPayload(index: number): unknown[] {
  const args = JSON.stringify({ path: 'out.txt', content: 'v' + index });
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_' + index,
                function: { name: 'write', arguments: args },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ];
}

/** Several complete tool calls in one delta, in the model's order. */
function multiToolCallPayload(
  calls: readonly { id: string; name: string; args: unknown }[],
): unknown[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ];
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
  it('accumulates tool call deltas and executes the tool', async () => {
    const client = new FakeClient([
      streamOf(fixture('tool-call-stream')),
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );
    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({
      type: 'tool.finished',
      output: 'wrote out.txt (5 bytes)',
    });
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('hello');
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });
    expect(client.requests).toHaveLength(2);
    expect(messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('stops a turn that never finishes with a visible reason', async () => {
    const streams = Array.from({ length: 61 }, (_unused, index) =>
      streamOf(toolCallPayload(index)),
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
        requestApproval: async () => 'allow',
      }),
    );
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ type: 'error' });
    expect(error?.type === 'error' ? error.message : '').toContain('tool steps');
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'error' });
  });

  it('reports a reply cut by the output cap instead of finishing quietly', async () => {
    const client = new FakeClient([
      streamOf([{ choices: [{ delta: { content: 'half an ans' }, finish_reason: 'length' }] }]),
    ]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' ? error.message : '').toContain('output token limit');
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'error' });
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
        multiToolCallPayload([
          { id: 'call_a', name: 'memory', args: { action: 'search', query: 'first' } },
          { id: 'call_b', name: 'memory', args: { action: 'search', query: 'second' } },
        ]),
      ),
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const events: AdapterEvent[] = [];
    const collecting = (async () => {
      for await (const event of runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      })) {
        events.push(event);
      }
    })();

    // Both calls must be running before either one is allowed to finish.
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    expect(maxInFlight).toBe(2);
    // The second call finishes first, and its finished event is the first one emitted.
    gates[1]?.resolve('second result');
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(1),
    );
    expect(events.filter((event) => event.type === 'tool.finished')[0]).toMatchObject({
      toolCallId: 'call_b',
      output: 'second result',
    });
    gates[0]?.resolve('first result');
    await collecting;

    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished.map((event) => event.toolCallId)).toEqual(['call_b', 'call_a']);
    const startedEvents = events.filter((event) => event.type === 'tool.started');
    expect(startedEvents.map((event) => event.toolCallId)).toEqual(['call_a', 'call_b']);
    // The model reads the results in the order it asked, not the order they finished.
    expect(
      messages.filter((message) => message.role === 'tool').map((message) => message.content),
    ).toEqual(['first result', 'second result']);
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'complete',
    });
  });

  it('runs a read-only command in read-only mode and refuses a write', async () => {
    const client = new FakeClient([
      streamOf(
        multiToolCallPayload([
          { id: 'call_ls', name: 'bash', args: { command: 'ls' } },
          { id: 'call_commit', name: 'bash', args: { command: 'git commit -m x' } },
        ]),
      ),
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'read-only' }),
        client,
        messages: [{ role: 'user', content: 'map the repo' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );
    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished).toHaveLength(2);
    expect(finished[0]).toMatchObject({ toolCallId: 'call_ls', isError: false });
    expect(finished[1]).toMatchObject({ toolCallId: 'call_commit', isError: true });
    expect(finished[1]?.output).toContain('not allowed in read-only mode');
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
        multiToolCallPayload([
          { id: 'call_read', name: 'memory', args: { action: 'search', query: 'first' } },
          {
            id: 'call_cfg',
            name: 'config',
            args: { action: 'settings.set', key: 'a', value: 1 },
          },
        ]),
      ),
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask' }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        requestApproval: async () => {
          order.push('approval');
          return 'allow';
        },
      }),
    );

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['first', 'approval', 'settings.set']);
    const types = events
      .filter((event) => event.type === 'tool.started' || event.type === 'tool.finished' || event.type === 'approval.requested')
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
        multiToolCallPayload([
          { id: 'call_boom', name: 'memory', args: { action: 'search', query: 'boom' } },
          { id: 'call_ok', name: 'memory', args: { action: 'search', query: 'fine' } },
        ]),
      ),
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );

    const finished = events.filter((event) => event.type === 'tool.finished');
    expect(finished).toHaveLength(2);
    expect(finished.find((event) => event.toolCallId === 'call_boom')).toMatchObject({
      output: 'memory offline',
      isError: true,
    });
    expect(finished.find((event) => event.toolCallId === 'call_ok')).toMatchObject({
      output: 'ok',
      isError: false,
    });
    expect(
      messages.filter((message) => message.role === 'tool').map((message) => message.content),
    ).toEqual(['memory offline', 'ok']);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'complete' });
  });

  it('denies a tool when approval is denied', async () => {
    const client = new FakeClient([
      streamOf(fixture('tool-call-stream')),
      streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask' }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => 'deny',
      }),
    );
    expect(events.some((event) => event.type === 'approval.requested')).toBe(true);
    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({ output: 'denied by user', isError: true });
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
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_cfg',
                    function: {
                      name: 'config',
                      arguments:
                        '{"action":"provider.add","label":"Remote","apiKey":"sk-approval"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask' }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );

    expect(events.find((event) => event.type === 'approval.requested')).toMatchObject({
      type: 'approval.requested',
      toolCallId: 'call_cfg',
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

  it('runs a long productive turn without a call cap', async () => {
    const streams = Array.from({ length: 50 }, (_, index) => streamOf(toolCallPayload(index)));
    const client = new FakeClient([
      ...streams,
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
    ]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
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
    const payload = toolCallPayload(0);
    const client = new FakeClient([streamOf(payload), streamOf(payload), streamOf(payload)]);
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests).toHaveLength(3);
    expect(events.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'openai: repeated identical tool call', retryable: false },
    ]);
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'error',
    });
  });

  it('reports interrupted when the signal aborts mid loop', async () => {
    const controller = new AbortController();
    const client = new FakeClient([streamOf(toolCallPayload(0))]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask', signal: controller.signal }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: controller.signal,
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
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'openai: socket closed', retryable: true },
    ]);
    expect(events.filter((event) => event.type === 'turn.finished')).toEqual([
      { type: 'turn.finished', turnId: 'turn_1', reason: 'error' },
    ]);
  });

  it('offers only the allowlisted tools and rejects a disabled call', async () => {
    const client = new FakeClient([
      streamOf(fixture('tool-call-stream')),
      streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({ toolAllowlist: ['read'] }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
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
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_mem',
                    function: {
                      name: 'memory',
                      arguments: '{"action":"search","query":"build"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
      streamOf([{ choices: [{ delta: { content: 'found' }, finish_reason: 'stop' }] }]),
    ]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(
      runTurn({
        ctx: context(),
        client,
        messages,
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests[0]?.toolOptions?.extra).toBe(true);
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({
      type: 'tool.started',
      toolCallId: 'call_mem',
      name: 'memory',
      input: { action: 'search', query: 'build' },
    });
    expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
      type: 'tool.finished',
      toolCallId: 'call_mem',
      output: 'two entries: build uses pnpm',
      isError: false,
    });
    expect(calls).toEqual([
      { name: 'memory', args: { action: 'search', query: 'build' }, cwd: root },
    ]);
    expect(messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call_mem',
      content: 'two entries: build uses pnpm',
    });
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
  });

  it('does not offer the extra tools without a runner', async () => {
    const client = new FakeClient([
      streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    ]);
    await collect(
      runTurn({
        ctx: context(),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests[0]?.toolOptions?.extra).toBe(false);
  });
});

describe('tool profile', () => {
  /** One complete `write` call, so the profile sees the path it must judge. */
  function writePayload(path: string): unknown[] {
    return multiToolCallPayload([
      { id: 'call_write', name: 'write', args: { path, content: 'body' } },
    ]);
  }

  const stop = (): unknown[] => [
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
  ];

  it('refuses a tool the profile does not offer and forwards the profile', async () => {
    const withRunner: AdapterDeps = { ...deps, extraTool: async () => 'ran' };
    const client = new FakeClient([
      streamOf(
        multiToolCallPayload([
          { id: 'call_cfg', name: 'config', args: { action: 'settings.set', key: 'a', value: 1 } },
        ]),
      ),
      streamOf(stop()),
    ]);
    const events = await collect(
      runTurn({
        ctx: context({
          toolOptions: {
            subagent: true,
            extra: true,
            todo: true,
            skill: true,
            webFetch: true,
            mcp: true,
          },
          toolProfile: SUBAGENT_TOOL_PROFILES.explorer,
        }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps: withRunner,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );
    expect(client.requests[0]?.toolProfile).toBe(SUBAGENT_TOOL_PROFILES.explorer);
    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({ isError: true });
    expect(finished?.type === 'tool.finished' ? finished.output : '').toContain(
      'tool "config" is not offered to this agent',
    );
  });

  it('answers a write outside the profile and never asks for approval', async () => {
    let approvals = 0;
    const client = new FakeClient([streamOf(writePayload('src/a.ts')), streamOf(stop())]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask', toolProfile: SUBAGENT_TOOL_PROFILES.explorer }),
        client,
        messages,
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => {
          approvals += 1;
          return 'allow';
        },
      }),
    );
    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({ isError: true });
    expect(finished?.type === 'tool.finished' ? finished.output : '').toContain(
      'write may touch only these paths: **/*.md',
    );
    expect(finished?.type === 'tool.finished' ? finished.output : '').toContain('src/a.ts');
    expect(approvals).toBe(0);
    await expect(readFile(join(root, 'src/a.ts'), 'utf8')).rejects.toThrow();
  });

  it('runs a write inside the profile without asking', async () => {
    let approvals = 0;
    const client = new FakeClient([streamOf(writePayload('docs/a.md')), streamOf(stop())]);
    const events = await collect(
      runTurn({
        ctx: context({ permissionMode: 'ask', toolProfile: SUBAGENT_TOOL_PROFILES.explorer }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => {
          approvals += 1;
          return 'allow';
        },
      }),
    );
    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({ isError: false });
    expect(approvals).toBe(0);
    expect(await readFile(join(root, 'docs/a.md'), 'utf8')).toBe('body');
  });
});

describe('compactHistory', () => {
  it('folds all but the last two messages into one system message', async () => {
    const client = new FakeClient([
      streamOf([{ choices: [{ delta: { content: 'summary text' }, finish_reason: 'stop' }] }]),
    ]);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];

    const result = await compactHistory({
      client,
      messages,
      model: 'test-model',
      deps,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ removed: 2 });
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('summary text');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ]);
    expect(client.requests[0]?.toolAllowlist).toEqual([]);
    expect(client.requests[0]?.messages[0]?.role).toBe('system');
  });

  it('keeps a leading tool result with the assistant call it answers', async () => {
    const client = new FakeClient([
      streamOf([{ choices: [{ delta: { content: 'summary' }, finish_reason: 'stop' }] }]),
    ]);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'one' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'assistant', content: 'done' },
    ];

    const result = await compactHistory({
      client,
      messages,
      model: 'test-model',
      deps,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ removed: 1 });
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('keeps history and reports zero when the summary request fails', async () => {
    const client = new FakeClient([]);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];

    const result = await compactHistory({
      client,
      messages,
      model: 'test-model',
      deps,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ removed: 0 });
    expect(messages).toHaveLength(4);
  });
});

describe('max tokens', () => {
  it('sends the turn output cap on the request', async () => {
    const client = new FakeClient([
      streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    ]);
    await collect(
      runTurn({
        ctx: context({ maxOutputTokens: 777 }),
        client,
        messages: [{ role: 'user', content: 'go' }],
        state: createToolSessionState(),
        deps,
        signal: new AbortController().signal,
        requestApproval: async () => 'allow',
      }),
    );

    expect(client.requests[0]?.maxTokens).toBe(777);
  });
});

describe('createOpenAIChatAdapter', () => {
  it('runs two turns against a fake fetch and keeps history', async () => {
    const bodies: unknown[] = [];
    const responses = [
      streamOf(fixture('tool-call-stream')),
      streamOf([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
      streamOf([{ choices: [{ delta: { content: 'again' }, finish_reason: 'stop' }] }]),
    ];
    const fetchFn = async (_input: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)));
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      return new Response(next, { status: 200 });
    };
    const adapter = await createOpenAIChatAdapter(
      {
        id: 'p',
        kind: 'openai-compatible',
        label: 'Local',
        config: { baseUrl: 'http://127.0.0.1:1234/v1' },
        secret: null,
      },
      deps,
      { fetchFn },
    );

    const first = await collect(adapter.send('go', context()));
    expect(first.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'complete' });
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('hello');

    const second = await collect(adapter.send('again', context({ turnId: 'turn_2' })));
    expect(second.at(-1)).toMatchObject({ type: 'turn.finished', reason: 'complete' });
    expect(second).toContainEqual({ type: 'text.delta', turnId: 'turn_2', text: 'again' });

    const lastBody = bodies.at(-1) as { messages: { role: string }[] };
    expect(lastBody.messages[0]?.role).toBe('system');
    expect(lastBody.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(lastBody.messages.at(-1)).toMatchObject({ role: 'user' });
    await adapter.dispose();
  });

  it('sends an attached image as an image_url part when the model has vision', async () => {
    const bodies: unknown[] = [];
    const fetchFn = async (_input: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(streamOf([{ choices: [{ delta: { content: 'seen' }, finish_reason: 'stop' }] }]), {
        status: 200,
      });
    };
    const adapter = await createOpenAIChatAdapter(
      {
        id: 'p',
        kind: 'openai-compatible',
        label: 'Local',
        config: { baseUrl: 'http://127.0.0.1:1234/v1' },
        secret: null,
      },
      deps,
      { fetchFn },
    );

    await collect(
      adapter.send(
        'what is in this image?',
        context({
          vision: true,
          attachments: [
            { kind: 'image', name: 'shot.png', mimeType: 'image/png', data: TINY_PNG },
          ],
        }),
      ),
    );

    const body = bodies[0] as { messages: { role: string; content: unknown }[] };
    const user = body.messages.at(-1);
    expect(user?.role).toBe('user');
    expect(user?.content).toEqual([
      { type: 'text', text: 'what is in this image?' },
      { type: 'text', text: 'Image file: shot.png' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + TINY_PNG } },
    ]);
    await adapter.dispose();
  });

  it('names the image instead of sending it when the model has no vision', async () => {
    const bodies: unknown[] = [];
    const fetchFn = async (_input: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(streamOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]), {
        status: 200,
      });
    };
    const adapter = await createOpenAIChatAdapter(
      {
        id: 'p',
        kind: 'openai-compatible',
        label: 'Local',
        config: { baseUrl: 'http://127.0.0.1:1234/v1' },
        secret: null,
      },
      deps,
      { fetchFn },
    );

    await collect(
      adapter.send(
        'look',
        context({
          vision: false,
          attachments: [{ kind: 'image', name: 'shot.png', mimeType: 'image/png', data: TINY_PNG }],
        }),
      ),
    );

    const body = bodies[0] as { messages: { role: string; content: unknown }[] };
    const content = body.messages.at(-1)?.content;
    expect(typeof content).toBe('string');
    expect(String(content)).toContain('[Image attached: shot.png - this model cannot view images]');
    await adapter.dispose();
  });
});

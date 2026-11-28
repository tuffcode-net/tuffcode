import { describe, expect, it } from 'vitest';
import { AdapterUnavailableError, type ProviderConfig } from '@tuffcode/contracts';
import {
  ANTHROPIC_VERSION,
  AnthropicClient,
  AnthropicRequestError,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_MAX_TOKENS,
  readAnthropicConfig,
  streamAnthropicSse,
  type AnthropicRequestBody,
} from './client.js';

const encoder = new TextEncoder();
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function provider(
  config: Record<string, unknown> = {},
  secret: string | null = 'sk-ant-test',
): ProviderConfig {
  return { id: 'prov-anthropic', kind: 'anthropic', label: 'Anthropic', config, secret };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseText(events: { event: string; data: unknown }[]): string {
  return events
    .map((entry) => 'event: ' + entry.event + LF + 'data: ' + JSON.stringify(entry.data) + LF + LF)
    .join('');
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<{ event: string | null; data: unknown }[]> {
  const events: { event: string | null; data: unknown }[] = [];
  for await (const event of streamAnthropicSse(stream)) events.push(event);
  return events;
}

const request: AnthropicRequestBody = {
  model: 'claude-test',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 128,
};

describe('readAnthropicConfig', () => {
  it('requires an API key', () => {
    expect(() => readAnthropicConfig(provider({}, null))).toThrow(AdapterUnavailableError);
    expect(() => readAnthropicConfig(provider({}, '   '))).toThrow(AdapterUnavailableError);
    try {
      readAnthropicConfig(provider({}, null));
    } catch (error) {
      expect((error as AdapterUnavailableError).hint).toContain('API key');
    }
  });

  it('defaults the base URL, strips a trailing /v1, and reads limits', () => {
    const fallback = readAnthropicConfig(provider({}));
    expect(fallback.baseUrl).toBe(DEFAULT_ANTHROPIC_BASE_URL);
    expect(fallback.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(fallback.secret).toBe('sk-ant-test');

    const configured = readAnthropicConfig(
      provider({
        baseUrl: 'https://gateway.example.com/v1/',
        headers: { 'X-Title': 'Tuffcode', bad: 5 },
        maxTokens: 512,
        temperature: 0.3,
      }),
    );
    expect(configured.baseUrl).toBe('https://gateway.example.com');
    expect(configured.headers).toEqual({ 'x-title': 'Tuffcode' });
    expect(configured.maxTokens).toBe(512);
    expect(configured.temperature).toBe(0.3);
  });
});

describe('AnthropicClient', () => {
  it('posts to /v1/messages with the Messages headers and tools', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(streamOf(''));
    };
    const client = new AnthropicClient(
      {
        baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
        headers: { 'x-extra': '1' },
        secret: 'sk-ant-test',
        maxTokens: 128,
        temperature: 0.2,
      },
      { fetchFn, sleep: async () => {}, logger },
    );

    await client.stream({ ...request, system: 'You are Tuffcode.' }, new AbortController().signal);

    expect(calls[0]?.url).toBe(DEFAULT_ANTHROPIC_BASE_URL + '/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('text/event-stream');
    expect(headers['x-extra']).toBe('1');

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-test');
    expect(body.max_tokens).toBe(128);
    expect(body.stream).toBe(true);
    expect(body.system).toBe('You are Tuffcode.');
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    const tools = body.tools as { name: string; input_schema: unknown }[];
    expect(tools).toHaveLength(6);
    expect(tools[0]?.input_schema).toBeDefined();
  });

  it('marks the static system head and the last tool as cache breakpoints', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(streamOf(''));
    };
    const client = new AnthropicClient(
      { baseUrl: DEFAULT_ANTHROPIC_BASE_URL, headers: {}, secret: 'sk-ant-test', maxTokens: 128 },
      { fetchFn, sleep: async () => {}, logger },
    );
    const staticHead = 'You are Tuffcode.';
    const dynamic = '## Brain notes\n- prefer pnpm';

    await client.stream(
      { ...request, system: `${staticHead}\n\n${dynamic}`, systemStatic: staticHead },
      new AbortController().signal,
    );

    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: staticHead, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `\n\n${dynamic}` },
    ]);
    const blocks = bodies[0]?.system as { text: string }[];
    expect(blocks.map((block) => block.text).join('')).toBe(`${staticHead}\n\n${dynamic}`);
    const tools = bodies[0]?.tools as { name: string; cache_control?: unknown }[];
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools[0]?.cache_control).toBeUndefined();
  });

  it('offers only the allowlisted tools, and none when the allowlist is empty', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(streamOf(''));
    };
    const client = new AnthropicClient(
      { baseUrl: DEFAULT_ANTHROPIC_BASE_URL, headers: {}, secret: 'key', maxTokens: 64 },
      { fetchFn, sleep: async () => {}, logger },
    );

    await client.stream({ ...request, toolAllowlist: ['read'] }, new AbortController().signal);
    const filtered = bodies[0]?.tools as { name: string }[];
    expect(filtered.map((tool) => tool.name)).toEqual(['read']);

    await client.stream({ ...request, toolAllowlist: [] }, new AbortController().signal);
    expect(bodies[1]?.tools).toBeUndefined();
  });

  it('sends adaptive thinking with an effort level on 4.7 and later', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(streamOf(''));
    };
    const client = new AnthropicClient(
      { baseUrl: DEFAULT_ANTHROPIC_BASE_URL, headers: {}, secret: 'key', maxTokens: 1024 },
      { fetchFn, sleep: async () => {}, logger },
    );

    await client.stream(
      { ...request, model: 'claude-opus-4-7', reasoningEffort: 'high' },
      new AbortController().signal,
    );
    await client.stream(
      { ...request, model: 'claude-sonnet-5-5', reasoningEffort: 'xhigh' },
      new AbortController().signal,
    );
    await client.stream(
      { ...request, model: 'claude-haiku-5-5', reasoningEffort: 'medium' },
      new AbortController().signal,
    );

    // 4.7 and later reject the manual shape with a 400, so no budget is sent at all.
    for (const body of bodies) {
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(JSON.stringify(body)).not.toContain('budget_tokens');
    }
    expect(bodies[0]?.output_config).toEqual({ effort: 'high' });
    expect(bodies[1]?.output_config).toEqual({ effort: 'xhigh' });
    expect(bodies[2]?.output_config).toEqual({ effort: 'medium' });
    // Adaptive thinking has no budget, so max_tokens stays the caller's 128.
    expect(bodies[0]?.max_tokens).toBe(128);
  });

  it('keeps the manual thinking budget on 4.5 and earlier', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(streamOf(''));
    };
    const client = new AnthropicClient(
      { baseUrl: DEFAULT_ANTHROPIC_BASE_URL, headers: {}, secret: 'key', maxTokens: 1024 },
      { fetchFn, sleep: async () => {}, logger },
    );

    await client.stream(
      { ...request, model: 'claude-opus-4-5-20251101', reasoningEffort: 'high' },
      new AbortController().signal,
    );
    await client.stream(
      { ...request, model: 'claude-3-7-sonnet-20250219', reasoningEffort: 'low' },
      new AbortController().signal,
    );

    expect(bodies[0]?.thinking).toEqual({ type: 'enabled', budget_tokens: 24000 });
    expect(bodies[0]?.output_config).toBeUndefined();
    expect(bodies[0]?.max_tokens).toBe(24000 + 4096);
    expect(bodies[1]?.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('uses adaptive thinking on 4.6 and drops xhigh where the model lacks it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(streamOf(''));
    };
    const client = new AnthropicClient(
      { baseUrl: DEFAULT_ANTHROPIC_BASE_URL, headers: {}, secret: 'key', maxTokens: 64 },
      { fetchFn, sleep: async () => {}, logger },
    );

    await client.stream(
      { ...request, model: 'claude-sonnet-4-6', reasoningEffort: 'xhigh' },
      new AbortController().signal,
    );
    // No effort means no thinking, which keeps temperature usable.
    await client.stream({ ...request, model: 'claude-opus-4-7' }, new AbortController().signal);

    expect(bodies[0]?.thinking).toEqual({ type: 'adaptive' });
    expect(bodies[0]?.output_config).toEqual({ effort: 'high' });
    expect(bodies[1]?.thinking).toBeUndefined();
    expect(bodies[1]?.output_config).toBeUndefined();
  });

  it('retries once on 429 and honours retry-after', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = async (): Promise<Response> => {
      calls.push('call');
      return calls.length === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
        : new Response(streamOf(''));
    };
    const client = new AnthropicClient(
      { baseUrl: 'https://api.anthropic.com', headers: {}, secret: 'key', maxTokens: 64 },
      {
        fetchFn,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        logger,
      },
    );

    const stream = await client.stream(request, new AbortController().signal);
    expect(stream).toBeDefined();
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('retries 529 twice and then surfaces the error', async () => {
    let calls = 0;
    const client = new AnthropicClient(
      { baseUrl: 'https://api.anthropic.com', headers: {}, secret: 'key', maxTokens: 64 },
      {
        fetchFn: async () => {
          calls += 1;
          return new Response('overloaded', { status: 529 });
        },
        sleep: async () => {},
        logger,
      },
    );

    await expect(client.stream(request, new AbortController().signal)).rejects.toMatchObject({
      name: 'AnthropicRequestError',
      status: 529,
      retryable: true,
    });
    expect(calls).toBe(3);
  });

  it('doubles the backoff between attempts and recovers', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new AnthropicClient(
      { baseUrl: 'https://api.anthropic.com', headers: {}, secret: 'key', maxTokens: 64 },
      {
        fetchFn: async () => {
          calls += 1;
          return calls <= 2
            ? new Response('overloaded', { status: 529 })
            : new Response(streamOf(''));
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        logger,
      },
    );

    await client.stream(request, new AbortController().signal);

    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('maps 401 to a non-retryable error without retrying', async () => {
    let calls = 0;
    const client = new AnthropicClient(
      { baseUrl: 'https://api.anthropic.com', headers: {}, secret: 'bad', maxTokens: 64 },
      {
        fetchFn: async () => {
          calls += 1;
          return new Response('nope', { status: 401 });
        },
        sleep: async () => {},
        logger,
      },
    );

    try {
      await client.stream(request, new AbortController().signal);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicRequestError);
      expect((error as AnthropicRequestError).retryable).toBe(false);
      expect((error as AnthropicRequestError).message).toContain('unauthorized');
    }
    expect(calls).toBe(1);
  });
});

describe('streamAnthropicSse', () => {
  it('survives CRLF and byte-at-a-time chunks with event names', async () => {
    const text =
      'event: message_start' +
      CR +
      LF +
      'data: {"type":"message_start","message":{"id":"msg_1"}}' +
      CR +
      LF +
      CR +
      LF +
      'event: content_block_delta' +
      LF +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"h' +
      String.fromCharCode(233) +
      'llo"}}' +
      LF +
      LF;
    const bytes = encoder.encode(text);
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const events = await collect(stream);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe('message_start');
    expect(events[0]?.data).toEqual({
      type: 'message_start',
      message: { id: 'msg_1' },
    });
    expect(events[1]?.event).toBe('content_block_delta');
    expect(events[1]?.data).toMatchObject({
      delta: { type: 'text_delta', text: 'h' + String.fromCharCode(233) + 'llo' },
    });
  });

  it('joins data lines, skips comments and invalid json, and flushes a final block', async () => {
    const text =
      ': keep-alive' +
      LF +
      'event: ping' +
      LF +
      'data: {"a":' +
      LF +
      'data: 1}' +
      LF +
      LF +
      'event: broken' +
      LF +
      'data: {not json' +
      LF +
      LF +
      'event: tail' +
      LF +
      'data: {"done":true}';
    const events = await collect(streamOf(text));
    expect(events).toEqual([
      { event: 'ping', data: { a: 1 } },
      { event: 'tail', data: { done: true } },
    ]);
  });
});

describe('sseText helper', () => {
  it('formats events the client parser reads back', async () => {
    const events = await collect(
      streamOf(sseText([{ event: 'message_stop', data: { type: 'message_stop' } }])),
    );
    expect(events).toEqual([{ event: 'message_stop', data: { type: 'message_stop' } }]);
  });
});

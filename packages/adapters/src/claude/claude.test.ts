import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AdapterUnavailableError,
  type AdapterDeps,
  type AdapterEvent,
  type AdapterLogger,
  type ApprovalChoice,
  type PermissionMode,
  type ProviderConfig,
  type TurnContext,
} from '@tuffcode/contracts';
import { SUBAGENT_TOOL_PROFILES } from '@tuffcode/prompt';
import {
  createClaudeAdapter,
  type ClaudePermissionResult,
  type ClaudeQueryFn,
  type ClaudeQueryOptions,
} from './adapter.js';
import { mapSdkMessage, type ClaudeMappingState } from './map.js';

const logger: AdapterLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const deps: AdapterDeps = {
  logger,
  resolveCommand: async (name) => (name === 'claude' ? 'C:/fake/claude.exe' : null),
  env: {},
};

const provider: ProviderConfig = {
  id: 'prov-claude',
  kind: 'claude',
  label: 'Claude',
  config: {},
  secret: null,
};

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 'turn_1',
    cwd: 'C:/work/tuffcode',
    systemPrompt: 'You are Tuffcode.',
    permissionMode: 'ask',
    model: 'claude-opus-4-5',
    brainSlice: '',
    attachments: [],
    vision: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function loadFixture(name: string): unknown[] {
  const url = new URL(`../fixtures/claude/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown[];
}

function mappingState(): ClaudeMappingState {
  return { turnId: 'turn_1', sessionId: null, toolCallIds: new Set() };
}

function initMessage(sessionId: string): unknown {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.1.325',
    cwd: 'C:/work/tuffcode',
    tools: ['Bash', 'Read'],
    mcp_servers: [],
    model: 'claude-opus-4-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: `uuid-init-${sessionId}`,
    session_id: sessionId,
  };
}

function assistantText(text: string): unknown {
  return {
    type: 'assistant',
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
    parent_tool_use_id: null,
    uuid: 'uuid-asst-fake',
    session_id: 'sess_fake',
  };
}

interface RecordedCall {
  prompt: string;
  options: ClaudeQueryOptions;
}

function recordingQuery(messages: unknown[], calls: RecordedCall[]): ClaudeQueryFn {
  return ({ prompt, options }) => {
    calls.push({ prompt, options });
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
    };
  };
}

async function drain(iterable: AsyncIterable<AdapterEvent>): Promise<void> {
  for await (const event of iterable) {
    void event;
  }
}

function approvalQuery(outcomes: ClaudePermissionResult[]): ClaudeQueryFn {
  return ({ options }) => ({
    async *[Symbol.asyncIterator]() {
      yield initMessage('sess_approval');
      outcomes.push(
        await options.canUseTool(
          'Bash',
          { command: 'rm -rf build' },
          { signal: options.abortController.signal, toolUseID: 'toolu_99' },
        ),
      );
      yield assistantText('ok');
    },
  });
}

describe('mapSdkMessage', () => {
  it('maps session init and assistant text', () => {
    const state = mappingState();
    const events = loadFixture('init-text').flatMap((message) => mapSdkMessage(message, state));

    expect(events).toEqual([
      {
        type: 'session.started',
        sessionId: 'sess_01',
        model: 'claude-opus-4-5',
        capabilities: { tools: true, approvals: true, resume: true },
      },
      { type: 'text.delta', turnId: 'turn_1', text: 'Hello from Claude.' },
    ]);
    expect(state.sessionId).toBe('sess_01');
  });

  it('maps a tool use to tool.started', () => {
    const state = mappingState();
    const events = loadFixture('tool-use').flatMap((message) => mapSdkMessage(message, state));

    expect(events).toEqual([
      {
        type: 'tool.started',
        turnId: 'turn_1',
        toolCallId: 'toolu_01',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ]);
    expect(state.toolCallIds.has('toolu_01')).toBe(true);
  });

  it('redacts a secret-shaped tool input before tool.started', () => {
    const state = mappingState();
    const events = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_cfg',
              name: 'mcp__tuffcode__config',
              input: {
                action: 'provider.add',
                label: 'Remote',
                secret: 'sk-map-secret',
                apiKey: 'sk-map-alias',
              },
            },
          ],
        },
      },
      state,
    );

    expect(events).toEqual([
      {
        type: 'tool.started',
        turnId: 'turn_1',
        toolCallId: 'toolu_cfg',
        name: 'mcp__tuffcode__config',
        input: {
          action: 'provider.add',
          label: 'Remote',
          secret: '[redacted]',
          apiKey: '[redacted]',
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('sk-map-secret');
    expect(JSON.stringify(events)).not.toContain('sk-map-alias');
  });

  it('maps a tool result to tool.finished', () => {
    const state = mappingState();
    const events = loadFixture('tool-result').flatMap((message) => mapSdkMessage(message, state));

    expect(events).toEqual([
      {
        type: 'tool.started',
        turnId: 'turn_1',
        toolCallId: 'toolu_02',
        name: 'Read',
        input: { file_path: 'notes.txt' },
      },
      {
        type: 'tool.finished',
        turnId: 'turn_1',
        toolCallId: 'toolu_02',
        output: 'alpha\nbeta\n',
        isError: false,
      },
    ]);
    expect(state.toolCallIds.size).toBe(0);
  });

  it('maps a success result to usage', () => {
    const state = mappingState();
    const events = loadFixture('usage-result').flatMap((message) => mapSdkMessage(message, state));

    expect(events).toEqual([
      { type: 'text.delta', turnId: 'turn_1', text: 'Done.' },
      { type: 'usage', turnId: 'turn_1', inputTokens: 1200, outputTokens: 85, costUsd: 0.0421 },
    ]);
  });

  it('maps assistant and result errors', () => {
    const state = mappingState();
    const events = loadFixture('error').flatMap((message) => mapSdkMessage(message, state));

    expect(events).toEqual([
      { type: 'error', message: 'claude: rate_limit', retryable: true },
      { type: 'usage', turnId: 'turn_1', inputTokens: 30, outputTokens: 0, costUsd: 0 },
      { type: 'error', message: 'claude: API rate limit reached', retryable: false },
    ]);
  });

  it('maps a worker shutdown to session.ended', () => {
    const state = mappingState();
    const events = loadFixture('session-end').flatMap((message) => mapSdkMessage(message, state));

    expect(events).toEqual([{ type: 'session.ended', reason: 'host_exit' }]);
  });

  it('ignores unknown messages', () => {
    expect(mapSdkMessage({ type: 'future_frame' }, mappingState())).toEqual([]);
    expect(mapSdkMessage(null, mappingState())).toEqual([]);
  });
});

describe('createClaudeAdapter', () => {
  it('throws AdapterUnavailableError with an install hint when claude is missing', async () => {
    const missing: AdapterDeps = { ...deps, resolveCommand: async () => null };

    let caught: unknown;
    try {
      await createClaudeAdapter(provider, missing);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdapterUnavailableError);
    const unavailable = caught as AdapterUnavailableError;
    expect(unavailable.providerId).toBe('prov-claude');
    expect(unavailable.hint).toBe('Install Claude Code, then run claude auth login');
  });

  it('brackets the recorded stream with turn events', async () => {
    const calls: RecordedCall[] = [];
    const adapter = await createClaudeAdapter(provider, deps, {
      queryFn: recordingQuery(loadFixture('init-text'), calls),
    });

    const events: AdapterEvent[] = [];
    for await (const event of adapter.send('hello', turnContext())) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'session.started',
      'text.delta',
      'turn.finished',
    ]);
    expect(events.at(-1)).toEqual({ type: 'turn.finished', turnId: 'turn_1', reason: 'complete' });
  });

  it('passes enabled MCP servers to the query as stdio configs', async () => {
    const calls: RecordedCall[] = [];
    const mcpDeps: AdapterDeps = {
      ...deps,
      mcpServers: () => ({
        files: { command: 'npx', args: ['-y', 'files-mcp'], env: { ROOT: 'C:/work' } },
        notes: { command: 'node', args: [], env: {} },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
      }),
    };
    const adapter = await createClaudeAdapter(provider, mcpDeps, {
      queryFn: recordingQuery([], calls),
    });

    await drain(adapter.send('hi', turnContext()));

    expect(calls.at(-1)?.options.mcpServers).toEqual({
      files: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'files-mcp'],
        env: { ROOT: 'C:/work' },
      },
      notes: { type: 'stdio', command: 'node', args: [], env: {} },
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
    });
  });

  it('names an attachment in the prompt instead of dropping it', async () => {
    const calls: RecordedCall[] = [];
    const adapter = await createClaudeAdapter(provider, deps, {
      queryFn: recordingQuery([], calls),
    });

    await drain(
      adapter.send('what is this?', {
        ...turnContext(),
        attachments: [
          { kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'AAAA' },
        ],
      }),
    );

    const prompt = calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain('what is this?');
    expect(prompt).toContain('Attachments:');
    expect(prompt).toContain('shot.png (inline image; this provider cannot receive image bytes)');
  });

  it('passes the reasoning level as the SDK effort', async () => {
    const calls: RecordedCall[] = [];
    const adapter = await createClaudeAdapter(provider, deps, {
      queryFn: recordingQuery([], calls),
    });
    await drain(adapter.send('hi', { ...turnContext(), reasoningEffort: 'xhigh' }));
    expect(calls.at(-1)?.options.effort).toBe('xhigh');
    await drain(adapter.send('hi', { ...turnContext(), reasoningEffort: 'none' }));
    expect(calls.at(-1)?.options.effort).toBeUndefined();
  });

  it('omits the mcpServers option when no servers are configured', async () => {
    const calls: RecordedCall[] = [];
    const emptyDeps: AdapterDeps = { ...deps, mcpServers: () => ({}) };
    const adapter = await createClaudeAdapter(provider, emptyDeps, {
      queryFn: recordingQuery([], calls),
    });

    await drain(adapter.send('hi', turnContext()));

    expect(calls.at(-1)?.options).not.toHaveProperty('mcpServers');
  });

  it('removes Write and Edit for a read-only child and keeps them for a worker', async () => {
    const calls: RecordedCall[] = [];
    const adapter = await createClaudeAdapter(provider, deps, {
      queryFn: recordingQuery([], calls),
    });

    await drain(
      adapter.send('hi', {
        ...turnContext(),
        permissionMode: 'read-only',
        toolProfile: SUBAGENT_TOOL_PROFILES.explorer,
      }),
    );
    const explorerTools = calls.at(-1)?.options.disallowedTools ?? [];
    expect(explorerTools).toContain('Write');
    expect(explorerTools).toContain('Edit');

    await drain(
      adapter.send('hi', {
        ...turnContext(),
        permissionMode: 'accept-edits',
        toolProfile: SUBAGENT_TOOL_PROFILES.worker,
      }),
    );
    expect(calls.at(-1)?.options).not.toHaveProperty('disallowedTools');
  });

  it('uses the configured executable and maps every permission mode', async () => {
    const calls: RecordedCall[] = [];
    let resolved = 0;
    const countingDeps: AdapterDeps = {
      ...deps,
      resolveCommand: async () => {
        resolved += 1;
        return 'C:/fake/claude.exe';
      },
    };
    const configured: ProviderConfig = {
      ...provider,
      config: { pathToClaudeCodeExecutable: 'C:/custom/claude.exe' },
    };
    const adapter = await createClaudeAdapter(configured, countingDeps, {
      queryFn: recordingQuery([], calls),
    });

    const modes: [PermissionMode, ClaudeQueryOptions['permissionMode']][] = [
      ['read-only', 'plan'],
      ['ask', 'default'],
      ['accept-edits', 'acceptEdits'],
      ['full-auto', 'bypassPermissions'],
    ];
    for (const [mode, expected] of modes) {
      await drain(adapter.send('hi', turnContext({ permissionMode: mode })));
      const call = calls.at(-1);
      expect(call?.options.permissionMode).toBe(expected);
      expect(call?.options.pathToClaudeCodeExecutable).toBe('C:/custom/claude.exe');
    }

    expect(resolved).toBe(0);
  });

  it('resumes with the session id reported by the SDK', async () => {
    const calls: RecordedCall[] = [];
    const adapter = await createClaudeAdapter(provider, deps, {
      queryFn: recordingQuery([initMessage('sess_resume')], calls),
    });

    await drain(adapter.send('first', turnContext()));
    await drain(adapter.send('second', turnContext()));

    expect(calls[0]?.options.resume).toBeUndefined();
    expect(calls[1]?.options.resume).toBe('sess_resume');
  });

  it.each([
    ['allow', { behavior: 'allow' }],
    ['allow-thread', { behavior: 'allow' }],
    ['deny', { behavior: 'deny', message: 'Denied by user' }],
  ] as [ApprovalChoice, ClaudePermissionResult][])(
    'resolves a %s approval decision',
    async (decision, expected) => {
      const outcomes: ClaudePermissionResult[] = [];
      const adapter = await createClaudeAdapter(provider, deps, {
        queryFn: approvalQuery(outcomes),
      });

      const events: AdapterEvent[] = [];
      for await (const event of adapter.send('run it', turnContext())) {
        events.push(event);
        if (event.type === 'approval.requested') {
          expect(event.name).toBe('Bash');
          expect(event.toolCallId).toBe('toolu_99');
          expect(event.input).toEqual({ command: 'rm -rf build' });
          adapter.approve(event.approvalId, decision);
        }
      }

      expect(outcomes).toEqual([expected]);
      expect(events.map((event) => event.type)).toEqual([
        'turn.started',
        'session.started',
        'approval.requested',
        'text.delta',
        'turn.finished',
      ]);
    },
  );

  it('redacts a secret in an approval request', async () => {
    const outcomes: ClaudePermissionResult[] = [];
    const queryFn: ClaudeQueryFn = ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        yield initMessage('sess_secret_approval');
        outcomes.push(
          await options.canUseTool(
            'mcp__tuffcode__config',
            { action: 'provider.add', label: 'Remote', secret: 'sk-approval-secret' },
            { signal: options.abortController.signal, toolUseID: 'toolu_secret' },
          ),
        );
        yield assistantText('ok');
      },
    });
    const adapter = await createClaudeAdapter(provider, deps, { queryFn });
    const events: AdapterEvent[] = [];

    for await (const event of adapter.send('add it', turnContext())) {
      events.push(event);
      if (event.type === 'approval.requested') adapter.approve(event.approvalId, 'allow');
    }

    expect(events.find((event) => event.type === 'approval.requested')).toMatchObject({
      name: 'mcp__tuffcode__config',
      input: { action: 'provider.add', label: 'Remote', secret: '[redacted]' },
    });
    expect(JSON.stringify(events)).not.toContain('sk-approval-secret');
    expect(outcomes).toEqual([{ behavior: 'allow' }]);
  });

  it('ignores unknown approval ids', async () => {
    const outcomes: ClaudePermissionResult[] = [];
    const adapter = await createClaudeAdapter(provider, deps, { queryFn: approvalQuery(outcomes) });

    for await (const event of adapter.send('run it', turnContext())) {
      if (event.type === 'approval.requested') {
        adapter.approve('apr_unknown', 'allow');
        adapter.approve(event.approvalId, 'deny');
      }
    }

    expect(outcomes).toEqual([{ behavior: 'deny', message: 'Denied by user' }]);
  });

  it('interrupts the in-flight turn and calls the SDK interrupt', async () => {
    let sdkInterrupts = 0;
    const queryFn: ClaudeQueryFn = ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        yield initMessage('sess_interrupt');
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      interrupt: async () => {
        sdkInterrupts += 1;
      },
    });
    const adapter = await createClaudeAdapter(provider, deps, { queryFn });

    const events: AdapterEvent[] = [];
    for await (const event of adapter.send('wait', turnContext())) {
      events.push(event);
      if (event.type === 'session.started') await adapter.interrupt();
    }

    expect(sdkInterrupts).toBe(1);
    expect(events.at(-1)).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'interrupted',
    });
  });

  it('finishes a failed result as an error turn', async () => {
    const adapter = await createClaudeAdapter(provider, deps, {
      queryFn: recordingQuery(loadFixture('error'), []),
    });

    const events: AdapterEvent[] = [];
    for await (const event of adapter.send('hello', turnContext())) events.push(event);

    expect(events.filter((event) => event.type === 'error')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'turn.finished', turnId: 'turn_1', reason: 'error' });
  });

  it('denies a pending approval when interrupted', async () => {
    const outcomes: ClaudePermissionResult[] = [];
    const seen: { resolve: () => void } = { resolve: () => {} };
    const decisionSeen = new Promise<void>((resolve) => {
      seen.resolve = resolve;
    });
    const queryFn: ClaudeQueryFn = ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        yield initMessage('sess_deny_on_interrupt');
        outcomes.push(
          await options.canUseTool(
            'Bash',
            { command: 'ls' },
            { signal: options.abortController.signal, toolUseID: 'toolu_7' },
          ),
        );
        seen.resolve();
        yield assistantText('after');
      },
    });
    const adapter = await createClaudeAdapter(provider, deps, { queryFn });
    const iterator = adapter.send('wait', turnContext())[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ type: 'turn.started' });
    expect((await iterator.next()).value).toMatchObject({ type: 'session.started' });
    expect((await iterator.next()).value).toMatchObject({
      type: 'approval.requested',
      toolCallId: 'toolu_7',
    });

    await adapter.interrupt();
    await decisionSeen;

    expect((await iterator.next()).value).toEqual({
      type: 'turn.finished',
      turnId: 'turn_1',
      reason: 'interrupted',
    });
    expect(outcomes).toEqual([{ behavior: 'deny', message: 'Denied by user' }]);
    await iterator.return?.();
  });

  it('disposes idempotently and rejects later sends', async () => {
    const adapter = await createClaudeAdapter(provider, deps, {
      queryFn: recordingQuery([], []),
    });

    await adapter.dispose();
    await adapter.dispose();

    const iterator = adapter.send('x', turnContext())[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow('claude adapter disposed');
  });
});

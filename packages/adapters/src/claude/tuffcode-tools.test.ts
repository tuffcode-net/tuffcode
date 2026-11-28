import type { AdapterDeps, AdapterLogger, TurnContext, TurnToolOptions } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  TUFFCODE_SERVER_NAME,
  classifyTuffcodeTool,
  tuffcodeServer,
  tuffcodeToolSpecs,
} from './tuffcode-tools.js';

const logger: AdapterLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  threadId?: string;
}

function recordingDeps(): { deps: AdapterDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const deps: AdapterDeps = {
    logger,
    resolveCommand: async () => null,
    env: {},
    extraTool: async (name, args, ctx) => {
      calls.push({
        name,
        args,
        cwd: ctx.cwd,
        ...(ctx.threadId === undefined ? {} : { threadId: ctx.threadId }),
      });
      return `${name} ok`;
    },
  };
  return { deps, calls };
}

function options(overrides: Partial<TurnToolOptions> = {}): TurnToolOptions {
  return {
    subagent: false,
    extra: true,
    todo: false,
    skill: false,
    webFetch: false,
    mcp: true,
    ...overrides,
  };
}

function context(overrides: Partial<TurnContext> = {}): TurnContext {
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
    threadId: 'thr_1',
    toolOptions: options(),
    ...overrides,
  };
}

describe('tuffcodeToolSpecs', () => {
  it('registers config and mcp alongside the existing extra tools', () => {
    const { deps } = recordingDeps();

    const names = tuffcodeToolSpecs(deps, context()).map((spec) => spec.name);

    expect(names).toEqual(['memory', 'config', 'mcp']);
  });

  it('offers config with extra alone and mcp only when the connectors capability is on', () => {
    const { deps } = recordingDeps();

    expect(
      tuffcodeToolSpecs(deps, context({ toolOptions: options({ mcp: false }) })).map(
        (spec) => spec.name,
      ),
    ).toEqual(['memory', 'config']);
    expect(
      tuffcodeToolSpecs(deps, context({ toolOptions: options({ extra: false }) })).map(
        (spec) => spec.name,
      ),
    ).toEqual(['mcp']);
    expect(
      tuffcodeToolSpecs(deps, context({ toolOptions: options({ extra: false, mcp: false }) })).map(
        (spec) => spec.name,
      ),
    ).toEqual([]);
    expect(
      tuffcodeToolSpecs({ logger, resolveCommand: async () => null, env: {} }, context()),
    ).toEqual([]);
  });

  it('routes a config call through the runner with the turn scope and the secret intact', async () => {
    const { deps, calls } = recordingDeps();
    const config = tuffcodeToolSpecs(deps, context()).find((spec) => spec.name === 'config');
    if (config === undefined) throw new Error('config is not registered');

    const result = await config.run({
      action: 'provider.add',
      kind: 'openai-compatible',
      label: 'Remote',
      secret: 'sk-claude-key',
    });

    expect(result).toEqual({ content: [{ type: 'text', text: 'config ok' }] });
    expect(calls[0]).toEqual({
      name: 'config',
      args: {
        action: 'provider.add',
        kind: 'openai-compatible',
        label: 'Remote',
        secret: 'sk-claude-key',
      },
      cwd: 'C:/work/tuffcode',
      threadId: 'thr_1',
    });
  });

  it('routes an mcp call through the runner', async () => {
    const { deps, calls } = recordingDeps();
    const mcp = tuffcodeToolSpecs(deps, context()).find((spec) => spec.name === 'mcp');
    if (mcp === undefined) throw new Error('mcp is not registered');

    const result = await mcp.run({ action: 'list' });

    expect(result.content[0]?.text).toBe('mcp ok');
    expect(calls[0]).toMatchObject({ name: 'mcp', args: { action: 'list' } });
  });

  it('wraps the specs in the in-process server', () => {
    const { deps } = recordingDeps();

    const server = tuffcodeServer(deps, context());

    expect(server).toBeDefined();
    expect(Object.keys(server ?? {})).toEqual([TUFFCODE_SERVER_NAME]);
  });
});

describe('classifyTuffcodeTool', () => {
  it('keeps the config ladder: ask and accept-edits approve, full-auto asks once', () => {
    const input = { action: 'provider.add' };

    expect(classifyTuffcodeTool('mcp__tuffcode__config', input, 'ask')).toBe('approve');
    expect(classifyTuffcodeTool('mcp__tuffcode__config', input, 'accept-edits')).toBe('approve');
    expect(classifyTuffcodeTool('mcp__tuffcode__config', input, 'read-only')).toBe('deny');
    // A config write changes provider rows and settings, so it asks even in full-auto.
    expect(classifyTuffcodeTool('mcp__tuffcode__config', input, 'full-auto')).toBe('approve');
  });

  it('allows an mcp list and asks before an mcp call', () => {
    expect(classifyTuffcodeTool('mcp__tuffcode__mcp', { action: 'list' }, 'ask')).toBe('allow');
    expect(classifyTuffcodeTool('mcp__tuffcode__mcp', { action: 'call' }, 'ask')).toBe('approve');
    expect(classifyTuffcodeTool('mcp__tuffcode__mcp', { action: 'list' }, 'read-only')).toBe(
      'deny',
    );
  });

  it('denies an unknown tuffcode tool and ignores tools outside the server', () => {
    expect(classifyTuffcodeTool('mcp__tuffcode__nope', {}, 'ask')).toBe('deny');
    expect(classifyTuffcodeTool('Bash', { command: 'ls' }, 'ask')).toBeNull();
  });
});

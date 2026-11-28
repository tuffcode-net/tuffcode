import type {
  AdapterDeps,
  AdapterSession,
  ProviderConfig,
  ProviderKind,
} from '@tuffcode/contracts';
import { AdapterUnavailableError } from '@tuffcode/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRecord } from '../db/repos/index.js';
import { silentLogger } from '../test-support.js';
import {
  createAdapterDeps,
  createAdapterForProvider,
  type AdapterFactory,
  type AdapterFactoryOverrides,
} from './factory.js';
import { createResolveCommand } from './resolveCommand.js';

const ISO = '2026-11-24T10:00:00.000Z';

function provider(
  kind: ProviderKind,
  config: Record<string, unknown> = {},
  id = 'prv_a',
): ProviderRecord {
  return {
    id,
    kind,
    label: `${kind} provider`,
    config,
    secretRef: null,
    enabled: true,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

function adapterDeps(): AdapterDeps {
  return {
    logger: silentLogger(),
    resolveCommand: async () => null,
    env: {},
  };
}

function fakeSession(providerId: string): AdapterSession {
  return {
    id: `sess_${providerId}`,
    providerId,
    capabilities: { tools: true, approvals: true, resume: false, models: false },
    send: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    }),
    approve: () => undefined,
    interrupt: async () => undefined,
    dispose: async () => undefined,
  };
}

interface Captured {
  provider: ProviderConfig;
  session: AdapterSession;
}

function capture(store: Captured[], name: string): AdapterFactory {
  return async (config) => {
    const session = fakeSession(name);
    store.push({ provider: config, session });
    return session;
  };
}

describe('adapter factory', () => {
  it('routes every kind to its matching factory with the contract descriptor', async () => {
    const captured: Captured[] = [];
    const overrides: AdapterFactoryOverrides = {
      factories: {
        claude: capture(captured, 'claude'),
        codex: capture(captured, 'codex'),
        acp: capture(captured, 'acp'),
        opencode: capture(captured, 'opencode'),
        'openai-compatible': capture(captured, 'openai'),
        anthropic: capture(captured, 'anthropic'),
      },
    };
    const deps = adapterDeps();

    const claude = await createAdapterForProvider(
      provider('claude', { pathToClaudeCodeExecutable: 'C:/claude.exe' }),
      deps,
      null,
      overrides,
    );
    const codex = await createAdapterForProvider(provider('codex', { model: 'gpt-5' }), deps, null, overrides);
    const acp = await createAdapterForProvider(provider('acp', { command: 'agy' }), deps, null, overrides);
    const opencode = await createAdapterForProvider(provider('opencode'), deps, null, overrides);
    const openai = await createAdapterForProvider(
      provider('openai-compatible', { baseUrl: 'https://api.example.com' }),
      deps,
      null,
      overrides,
    );
    const anthropic = await createAdapterForProvider(
      provider('anthropic', { model: 'claude-sonnet-4-5' }),
      deps,
      'sk-ant-test',
      overrides,
    );

    expect(captured.map((entry) => entry.session.id)).toEqual([
      'sess_claude',
      'sess_codex',
      'sess_acp',
      'sess_opencode',
      'sess_openai',
      'sess_anthropic',
    ]);
    expect([claude, codex, acp, opencode, openai, anthropic]).toHaveLength(6);
    expect(captured[0]?.provider).toEqual({
      id: 'prv_a',
      kind: 'claude',
      label: 'claude provider',
      config: { pathToClaudeCodeExecutable: 'C:/claude.exe' },
      secret: null,
    });
    expect(captured[3]?.provider.config).toEqual({ command: 'opencode', args: ['acp'] });
  });

  it('routes opencode through the ACP factory with the opencode acp command', async () => {
    const captured: Captured[] = [];
    const overrides: AdapterFactoryOverrides = { factories: { acp: capture(captured, 'acp') } };

    const session = await createAdapterForProvider(provider('opencode'), adapterDeps(), null, overrides);

    expect(session.id).toBe('sess_acp');
    expect(captured[0]?.provider.kind).toBe('opencode');
    expect(captured[0]?.provider.config).toEqual({ command: 'opencode', args: ['acp'] });
  });

  it('forwards the resolved secret and keeps null when there is none', async () => {
    const captured: Captured[] = [];
    const overrides: AdapterFactoryOverrides = { factories: { claude: capture(captured, 'claude') } };

    await createAdapterForProvider(provider('claude'), adapterDeps(), 'sk-resolved', overrides);
    await createAdapterForProvider(provider('claude'), adapterDeps(), null, overrides);

    expect(captured[0]?.provider.secret).toBe('sk-resolved');
    expect(captured[1]?.provider.secret).toBeNull();
  });

  it('loads the real vendor adapter when no override is supplied', async () => {
    // Every adapter is behind `await import()`, so this is the test that a subpath
    // export, a vitest alias and a build chunk all still resolve.
    const session = await createAdapterForProvider(
      provider('claude', { pathToClaudeCodeExecutable: 'C:/claude.exe' }),
      adapterDeps(),
      null,
    );

    expect(session.providerId).toBe('prv_a');
    expect(session.id).toMatch(/^sess_/);
    expect(typeof session.dispose).toBe('function');
  });

  it('throws AdapterUnavailableError for an unknown kind', async () => {
    const unknown = { ...provider('claude'), kind: 'mystery' } as unknown as ProviderRecord;
    const failure = await createAdapterForProvider(unknown, adapterDeps(), null).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AdapterUnavailableError);
    expect((failure as AdapterUnavailableError).hint).toContain('mystery');
  });

  it('builds adapter deps from a logger, resolver and filtered environment', async () => {
    const deps = createAdapterDeps({
      logger: silentLogger(),
      env: { KEEP: 'yes', DROP: undefined },
    });
    expect(deps.env).toEqual({ KEEP: 'yes' });
    await expect(deps.resolveCommand('definitely-not-installed')).resolves.toBeNull();
  });
});

describe('resolveCommand', () => {
  it('uses where on win32 and caches hits and misses', async () => {
    const probe = vi.fn(async (_file: string, _args: string[]) => 'C:\\bin\\tool.exe\nC:\\other\\tool.exe\n');
    const resolve = createResolveCommand({ platform: 'win32', probe });

    await expect(resolve('tool')).resolves.toBe('C:\\bin\\tool.exe');
    await expect(resolve('tool')).resolves.toBe('C:\\bin\\tool.exe');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('where', ['tool']);
  });

  it('uses which elsewhere and returns null for a missing binary', async () => {
    const probe = vi.fn(async (file: string, args: string[]) => {
      if (args[0] === 'present') return '/usr/local/bin/present\n';
      throw new Error('not found');
    });
    const resolve = createResolveCommand({ platform: 'linux', probe });

    await expect(resolve('present')).resolves.toBe('/usr/local/bin/present');
    await expect(resolve('absent')).resolves.toBeNull();
    await expect(resolve('absent')).resolves.toBeNull();
    expect(probe).toHaveBeenCalledWith('which', ['present']);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

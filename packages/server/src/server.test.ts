import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterDeps, AdapterSession } from '@tuffcode/contracts';
import { serverJsonPath } from '@tuffcode/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, migrate, openDb } from './db/index.js';
import { createRepos } from './db/repos/index.js';
import { dispatch } from './rpc.js';
import { startServer, type RunningServer } from './server.js';
import type { SecretPort } from './secrets/bridge.js';
import { createTempEnv, type TempEnv } from './test-support.js';

const ISO = '2026-11-24T10:00:00.000Z';

interface FakePort extends SecretPort {
  sent: unknown[];
  reply(message: unknown): void;
}

function createFakePort(): FakePort {
  const listeners: ((message?: unknown) => void)[] = [];
  const sent: unknown[] = [];
  return {
    sent,
    postMessage: (message) => {
      sent.push(message);
    },
    on: (event, listener) => {
      if (event === 'message') listeners.push(listener);
    },
    reply: (message) => {
      // Electron's utility process delivers parentPort payloads as a MessageEvent.
      for (const listener of listeners) listener(new MessageEvent('message', { data: message }));
    },
  };
}

/** Seeds one thread with a running turn, as a crash mid-turn would leave it. */
function seedOrphan(dbFile: string): void {
  const db = openDb(dbFile);
  migrate(db);
  const repos = createRepos(db);
  repos.projects.add({
    id: 'prj_a',
    name: 'alpha',
    path: 'C:/tmp/alpha',
    defaultBranch: 'main',
    createdAt: ISO,
  });
  repos.providers.upsert({ id: 'prv_a', kind: 'claude', label: 'Test', config: {} });
  repos.threads.create({
    id: 'thr_a',
    projectId: 'prj_a',
    parentThreadId: null,
    title: 'thread',
    providerId: 'prv_a',
    modelId: 'model-x',
    executionMode: 'work',
    permissionMode: 'ask',
    status: 'running',
    worktreePath: 'C:/tmp/alpha',
    branch: null,
    baseBranch: null,
    createdAt: ISO,
    updatedAt: ISO,
  });
  repos.turns.create({
    id: 'turn_a',
    threadId: 'thr_a',
    status: 'running',
    injectedIds: [],
    createdAt: ISO,
  });
  closeDb(db);
}

/** Seeds one idle thread plus MCP servers: two sharing a label, one solo, one disabled. */
function seedMcpServers(dbFile: string, root: string): void {
  const db = openDb(dbFile);
  migrate(db);
  const repos = createRepos(db);
  repos.projects.add({
    id: 'prj_a',
    name: 'alpha',
    path: root,
    defaultBranch: 'main',
    createdAt: ISO,
  });
  repos.providers.upsert({ id: 'prv_a', kind: 'claude', label: 'Test', config: {} });
  repos.threads.create({
    id: 'thr_a',
    projectId: 'prj_a',
    parentThreadId: null,
    title: 'thread',
    providerId: 'prv_a',
    modelId: 'model-x',
    executionMode: 'work',
    permissionMode: 'ask',
    status: 'idle',
    worktreePath: root,
    branch: null,
    baseBranch: null,
    createdAt: ISO,
    updatedAt: ISO,
  });
  repos.mcp.upsert({
    id: 'mcp_on',
    label: 'files',
    command: 'node',
    args: ['server.js'],
    env: { ROOT: 'C:/work' },
  });
  repos.mcp.upsert({ id: 'mcp_dup', label: 'files', command: 'npx' });
  repos.mcp.upsert({ id: 'mcp_solo', label: 'solo', command: 'solo-mcp', args: ['--x'] });
  repos.mcp.upsert({ id: 'mcp_off', label: 'off', command: 'node', enabled: false });
  closeDb(db);
}

/** Seeds one provider whose stored model row carries the pre-fix default capability shape. */
function seedStaleCapabilities(dbFile: string): void {
  const db = openDb(dbFile);
  migrate(db);
  const repos = createRepos(db);
  repos.providers.upsert({
    id: 'prv_a',
    kind: 'openai-compatible',
    label: 'Gateway',
    config: { baseUrl: 'https://gateway.test' },
  });
  repos.providers.replaceModels('prv_a', [
    {
      modelId: 'gpt-6.1-sol',
      label: 'GPT 6.1 Sol',
      contextWindow: null,
      capabilities: { tools: true, vision: false, reasoning: false, reasoningEfforts: [] },
      isDefault: true,
    },
  ]);
  closeDb(db);
}

describe('server bootstrap', () => {
  let env: TempEnv | undefined;
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
    env?.dispose();
    env = undefined;
  });

  it('writes the server.json handshake and serves health on the bound port', async () => {
    env = createTempEnv();
    running = await startServer({ version: '2.0.0', dbFile: join(env.root, 'server.db') });

    const file = serverJsonPath();
    const info = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(info['port']).toBe(running.port);
    expect(info['token']).toBe(running.token);
    expect(info['pid']).toBe(process.pid);
    expect(typeof info['startedAt']).toBe('number');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }

    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['version']).toBe('2.0.0');
  });

  it('repairs a stale default capability row at boot so the provider toggle applies', async () => {
    env = createTempEnv();
    const dbFile = join(env.root, 'server.db');
    seedStaleCapabilities(dbFile);
    running = await startServer({ dbFile, writeServerJson: false });

    // The row predates the "unknown stays unknown" discovery contract, so boot must drop
    // the object instead of letting it keep answering for the model.
    const [row] = running.repos.providers.listModels('prv_a');
    expect(row?.modelId).toBe('gpt-6.1-sol');
    expect(row).not.toHaveProperty('capabilities');
  });

  it('closes idempotently', async () => {
    env = createTempEnv();
    running = await startServer({
      version: '2.0.0',
      dbFile: join(env.root, 'server.db'),
      writeServerJson: false,
    });
    const server = running;
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    expect(server.httpServer.listening).toBe(false);
    expect(server.runner.listActive()).toEqual([]);
  });

  it('registers the terminal handlers from the pty slice', async () => {
    env = createTempEnv();
    running = await startServer({
      dbFile: join(env.root, 'server.db'),
      writeServerJson: false,
    });

    for (const method of ['terminal.open', 'terminal.input', 'terminal.resize', 'terminal.close']) {
      expect(running.handlers.has(method)).toBe(true);
    }
  });

  it('registers the council handlers', async () => {
    env = createTempEnv();
    running = await startServer({
      dbFile: join(env.root, 'server.db'),
      writeServerJson: false,
    });

    for (const method of [
      'council.start',
      'council.cancel',
      'council.status',
      'council.approvePlan',
      'council.revisePlan',
      'council.answerEscalation',
    ]) {
      expect(running.handlers.has(method)).toBe(true);
    }
  });

  it('exposes the MCP service and answers mcp.list with no servers', async () => {
    env = createTempEnv();
    running = await startServer({
      dbFile: join(env.root, 'server.db'),
      writeServerJson: false,
    });

    expect(running.mcp.list()).toEqual([]);
    await expect(
      dispatch(running.handlers, { id: 'mcp-list', method: 'mcp.list', params: {} }),
    ).resolves.toEqual({ id: 'mcp-list', ok: true, result: [] });
  });

  it('passes only enabled MCP servers to the adapter with unique keys', async () => {
    env = createTempEnv();
    const dbFile = join(env.root, 'server.db');
    seedMcpServers(dbFile, env.root);

    let captured: AdapterDeps | undefined;
    const session: AdapterSession = {
      id: 'sess_mcp',
      providerId: 'prv_a',
      capabilities: { tools: true, approvals: true, resume: false, models: false },
      send: () => ({
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
      }),
      approve: () => undefined,
      interrupt: async () => undefined,
      dispose: async () => undefined,
    };
    running = await startServer({
      dbFile,
      writeServerJson: false,
      adapterOverrides: {
        factories: {
          claude: async (_provider, deps) => {
            captured = deps;
            return session;
          },
        },
      },
    });

    const response = await dispatch(running.handlers, {
      id: 'send',
      method: 'threads.send',
      params: { id: 'thr_a', text: 'hello' },
    });
    expect(response.ok).toBe(true);
    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(captured?.mcpServers?.()).toEqual({
      'files-mcp_on': { command: 'node', args: ['server.js'], env: { ROOT: 'C:/work' } },
      'files-mcp_dup': { command: 'npx', args: [], env: {} },
      solo: { command: 'solo-mcp', args: ['--x'], env: {} },
    });
  });

  it('wires the secret bridge and the runner from a parent port', async () => {
    env = createTempEnv();
    const port = createFakePort();
    running = await startServer({
      dbFile: join(env.root, 'server.db'),
      writeServerJson: false,
      parentPort: port,
    });

    expect(running.secrets.available).toBe(true);
    expect(running.runner.listActive()).toEqual([]);
    expect(running.providers.list()).toEqual([]);

    const pending = running.secrets.get('provider:prv_a');
    const request = port.sent[0] as Record<string, unknown>;
    expect(request).toMatchObject({ type: 'secret.get', key: 'provider:prv_a' });
    port.reply({ id: request['id'], type: 'secret.result', ok: true, value: 'sk-from-main' });
    await expect(pending).resolves.toBe('sk-from-main');
  });

  it('fails an orphaned running turn during startup recovery', async () => {
    env = createTempEnv();
    const dbFile = join(env.root, 'server.db');
    seedOrphan(dbFile);

    running = await startServer({ dbFile, writeServerJson: false });

    expect(running.repos.turns.get('turn_a')).toMatchObject({ status: 'failed' });
    expect(running.repos.threads.get('thr_a')?.status).toBe('failed');
    const rows = running.repos.events.since('thr_a', 0, 10);
    expect(rows.map((row) => row.type)).toEqual(['error', 'turn.finished']);
    expect(rows[1]?.payload).toEqual({
      type: 'turn.finished',
      turnId: 'turn_a',
      reason: 'error',
    });
  });
});

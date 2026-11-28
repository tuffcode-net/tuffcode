import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  PairClaimResultSchema,
  PairCreateResultSchema,
  REMOTE_SESSION_COOKIE,
} from '@tuffcode/contracts';
import { tokenPath } from '@tuffcode/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { startServer, type RunningServer } from './server.js';
import { createTempEnv, type TempEnv } from './test-support.js';

interface Frame {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
  kind?: unknown;
  type?: unknown;
  payload?: unknown;
}

function parseFrame(data: RawData): Frame {
  const value: unknown = JSON.parse(data.toString());
  if (typeof value !== 'object' || value === null) throw new Error('frame is not an object');
  return value as Frame;
}

function openSocket(url: string, protocols?: string[]): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const socket = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
  return promise;
}

function openSocketWithHeaders(
  url: string,
  headers: Record<string, string>,
  protocols?: string[],
): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const socket = new WebSocket(url, protocols ?? [], { headers });
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
  return promise;
}

function rejectionStatus(url: string, protocol: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const socket = new WebSocket(url, [protocol]);
  socket.once('unexpected-response', (_request, response) => {
    const status = response.statusCode ?? 0;
    response.resume();
    socket.terminate();
    resolve(status);
  });
  socket.once('error', (error) => {
    const match = /(\d{3})/.exec(error.message);
    if (match?.[1] !== undefined) resolve(Number(match[1]));
    else reject(error);
  });
  socket.once('open', () => {
    socket.terminate();
    reject(new Error('unexpected connection'));
  });
  return promise;
}

/** Raw upgrade so the test can control Host and Origin exactly as a browser would. */
function rawUpgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const socket = connect(port, '127.0.0.1', () => {
    const lines = [
      'GET /ws HTTP/1.1',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ];
    socket.write(lines.join('\r\n'));
  });
  let buffer = '';
  let settled = false;
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const match = /^HTTP\/1\.1 (\d{3})/.exec(buffer);
    if (match?.[1] === undefined || settled) return;
    settled = true;
    socket.destroy();
    resolve(Number(match[1]));
  });
  socket.on('error', (error) => {
    if (!settled) reject(error);
  });
  socket.on('close', () => {
    if (!settled) reject(new Error('upgrade closed without a status line'));
  });
  return promise;
}

async function pairDevice(server: RunningServer, deviceName = 'Phone'): Promise<string> {
  const create = await fetch(`http://127.0.0.1:${server.port}/pair/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}` },
  });
  expect(create.status).toBe(201);
  const { code } = PairCreateResultSchema.parse(await create.json());
  const claim = await fetch(`http://127.0.0.1:${server.port}/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName }),
  });
  expect(claim.status).toBe(201);
  PairClaimResultSchema.parse(await claim.json());
  const header = claim.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${REMOTE_SESSION_COOKIE}=([0-9a-f]{64})`).exec(header);
  if (match?.[1] === undefined) throw new Error(`no session cookie in ${header}`);
  return match[1];
}

function waitFor(socket: WebSocket, predicate: (frame: Frame) => boolean): Promise<Frame> {
  const { promise, resolve } = Promise.withResolvers<Frame>();
  function onMessage(data: RawData): void {
    const frame = parseFrame(data);
    if (!predicate(frame)) return;
    socket.off('message', onMessage);
    resolve(frame);
  }
  socket.on('message', onMessage);
  return promise;
}

function errorCode(frame: Frame): unknown {
  const error = frame.error;
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)['code']
    : undefined;
}

function rpc(socket: WebSocket, id: string, method: string, params: unknown): Promise<Frame> {
  const reply = waitFor(socket, (frame) => frame.id === id && typeof frame.ok === 'boolean');
  socket.send(JSON.stringify({ id, method, params }));
  return reply;
}

describe('websocket transport', () => {
  let env: TempEnv | undefined;
  let running: RunningServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await running?.close();
    running = undefined;
    env?.dispose();
    env = undefined;
  });

  async function boot(remoteEnabled = false): Promise<RunningServer> {
    env = createTempEnv();
    running = await startServer({
      version: '1.2.3',
      dbFile: join(env.root, 'ws.db'),
      writeServerJson: false,
      remoteOverrides: remoteEnabled
        ? {
            enabled: true,
            bindHost: '127.0.0.1',
            port: 0,
            publicUrl: 'http://192.168.1.20:4310',
            allowedOrigins: [],
          }
        : undefined,
    });
    return running;
  }

  function remotePortOf(server: RunningServer): number {
    if (server.remotePort === undefined) throw new Error('the remote listener is not open');
    return server.remotePort;
  }

  function remoteSocketUrl(server: RunningServer): string {
    return `ws://127.0.0.1:${remotePortOf(server)}/ws`;
  }

  function waitForClose(socket: WebSocket): Promise<number> {
    const { promise, resolve } = Promise.withResolvers<number>();
    if (socket.readyState === WebSocket.CLOSED) {
      resolve(1006);
      return promise;
    }
    socket.once('close', (code) => resolve(code));
    return promise;
  }

  async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition did not become true in time');
  }

  it('answers app.health over a subprotocol-authenticated socket', async () => {
    const server = await boot();
    const socket = await openSocket(`ws://127.0.0.1:${server.port}/ws`, [
      `tuffcode.bearer.${server.token}`,
    ]);
    sockets.push(socket);

    const response = await rpc(socket, 'req-1', 'app.health', {});
    expect(response.ok).toBe(true);
    const result = response.result as Record<string, unknown>;
    expect(result['version']).toBe('1.2.3');
    expect(result['pid']).toBe(process.pid);
    expect(result['dbPath']).toBe(server.dbPath);
    expect(typeof result['uptimeMs']).toBe('number');
  });

  it('accepts an Authorization bearer header', async () => {
    const server = await boot();
    const socket = await openSocketWithHeaders(`ws://127.0.0.1:${server.port}/ws`, {
      authorization: `Bearer ${server.token}`,
    });
    sockets.push(socket);
    const response = await rpc(socket, 'req-header', 'app.health', {});
    expect(response.ok).toBe(true);
  });

  it('accepts a paired session cookie on the remote listener', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const socket = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(socket);
    const response = await rpc(socket, 'req-cookie', 'app.health', {});
    expect(response.ok).toBe(true);
    expect(server.repos.remoteSessions.list()).toHaveLength(1);
  });

  it('refuses a session cookie on the desktop loopback listener', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const status = await rawUpgradeStatus(server.port, {
      Host: `127.0.0.1:${server.port}`,
      Cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    // The cookie door only exists on the listener remote access opened, so turning
    // the feature off removes the path instead of leaving a second entrance.
    expect(status).toBe(401);
  });

  it('rejects a wrong token with 401 and never connects', async () => {
    const server = await boot();
    const status = await rejectionStatus(
      `ws://127.0.0.1:${server.port}/ws`,
      `tuffcode.bearer.${'0'.repeat(64)}`,
    );
    expect(status).toBe(401);
    expect(server.httpServer.listening).toBe(true);
  });

  it('rejects a non-loopback Host on upgrade when remote access is off', async () => {
    const server = await boot();
    const status = await rawUpgradeStatus(server.port, {
      Host: 'evil.example',
      Origin: `http://evil.example`,
      'Sec-WebSocket-Protocol': `tuffcode.bearer.${server.token}`,
    });
    expect(status).toBe(403);
  });

  it('rejects a foreign Origin even with a valid token', async () => {
    const server = await boot();
    const status = await rawUpgradeStatus(server.port, {
      Host: `127.0.0.1:${server.port}`,
      Origin: 'http://evil.example',
      'Sec-WebSocket-Protocol': `tuffcode.bearer.${server.token}`,
    });
    expect(status).toBe(403);
  });

  it('accepts the desktop file origin with the file token', async () => {
    const server = await boot();
    const socket = await openSocketWithHeaders(`ws://127.0.0.1:${server.port}/ws`, {
      origin: 'null',
      authorization: `Bearer ${server.token}`,
    });
    sockets.push(socket);
    const response = await rpc(socket, 'req-file-origin', 'app.health', {});
    expect(response.ok).toBe(true);
  });

  it('rejects a foreign Origin for a cookie session when remote access is on', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const status = await rawUpgradeStatus(remotePortOf(server), {
      Host: `127.0.0.1:${remotePortOf(server)}`,
      Origin: 'http://evil.example',
      Cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    expect(status).toBe(403);
  });

  it('accepts a same-origin cookie session when remote access is on', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const socket = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
      origin: `http://127.0.0.1:${remotePortOf(server)}`,
    });
    sockets.push(socket);
    const response = await rpc(socket, 'req-lan', 'app.health', {});
    expect(response.ok).toBe(true);
  });

  it('revokes a cookie session when the file token rotates', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    writeFileSync(tokenPath(), 'f'.repeat(64), 'utf8');
    const status = await rawUpgradeStatus(remotePortOf(server), {
      Host: `127.0.0.1:${remotePortOf(server)}`,
      Cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    expect(status).toBe(401);
    expect(server.repos.remoteSessions.list().every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('rejects unknown methods and invalid params with bad-request', async () => {
    const server = await boot();
    const socket = await openSocket(`ws://127.0.0.1:${server.port}/ws`, [
      `tuffcode.bearer.${server.token}`,
    ]);
    sockets.push(socket);

    const unknown = await rpc(socket, 'req-2', 'threads.send', {});
    expect(unknown.ok).toBe(false);
    expect((unknown.error as Record<string, unknown>)['code']).toBe('bad-request');

    const invalid = await rpc(socket, 'req-3', 'projects.add', {});
    expect(invalid.ok).toBe(false);
    expect((invalid.error as Record<string, unknown>)['code']).toBe('bad-request');
  });

  it('refuses every desktop-only method to a paired device', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const socket = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(socket);

    const denied: readonly (readonly [string, unknown])[] = [
      ['terminal.open', { threadId: 'thr_x' }],
      ['terminal.input', { terminalId: 'trm_x', data: 'whoami' }],
      ['settings.set', { patch: { theme: 'light' } }],
      ['providers.upsert', { kind: 'openai-compatible', label: 'x', config: {} }],
      ['mcp.upsert', { name: 'x', command: 'cmd' }],
      ['files.read', { projectId: 'prj_x', path: '.tuffcode/token' }],
      ['files.tree', { projectId: 'prj_x' }],
      ['git.push', { threadId: 'thr_x' }],
      ['plugins.install', { id: 'x' }],
      ['diagnostics.export', {}],
      ['council.start', { projectId: 'prj_x', goal: 'x' }],
    ];
    for (const [method, params] of denied) {
      const response = await rpc(socket, `deny-${method}`, method, params);
      expect(errorCode(response), method).toBe('permission-denied');
    }

    expect((await rpc(socket, 'ok-list', 'threads.list', {})).ok).toBe(true);
    expect((await rpc(socket, 'ok-settings', 'settings.get', {})).ok).toBe(true);

    // The owner of the machine keeps full authority over the same registry.
    const desktop = await openSocket(`ws://127.0.0.1:${server.port}/ws`, [
      `tuffcode.bearer.${server.token}`,
    ]);
    sockets.push(desktop);
    const allowed = await rpc(desktop, 'desk-1', 'settings.set', { patch: { theme: 'light' } });
    expect(allowed.ok).toBe(true);
  });

  it('refuses a permission escalation through threads.create and threads.update', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const socket = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(socket);

    const escalated = await rpc(socket, 'create-wide', 'threads.create', {
      projectId: 'prj_x',
      providerId: 'prv_x',
      modelId: 'm',
      executionMode: 'work',
      permissionMode: 'full-auto',
    });
    expect(errorCode(escalated)).toBe('permission-denied');

    const council = await rpc(socket, 'create-council', 'threads.create', {
      projectId: 'prj_x',
      providerId: 'prv_x',
      modelId: 'm',
      executionMode: 'council',
      permissionMode: 'ask',
    });
    expect(errorCode(council)).toBe('permission-denied');

    const rewrite = await rpc(socket, 'update-mode', 'threads.update', {
      id: 'thr_x',
      permissionMode: 'full-auto',
    });
    expect(errorCode(rewrite)).toBe('permission-denied');

    // The same call without the escalating field reaches the handler, which answers
    // not-found for a thread that does not exist.
    const reached = await rpc(socket, 'update-title', 'threads.update', {
      id: 'thr_x',
      title: 'renamed from a phone',
    });
    expect(errorCode(reached)).toBe('not-found');
  });

  it('cuts a live socket the moment the device is revoked', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const socket = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(socket);
    expect((await rpc(socket, 'before', 'app.health', {})).ok).toBe(true);

    const sessionId = server.repos.remoteSessions.list()[0]?.id;
    if (sessionId === undefined) throw new Error('the session was not stored');
    const closed = waitForClose(socket);
    const revoked = await fetch(`http://127.0.0.1:${server.port}/remote/sessions/revoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: sessionId }),
    });
    expect(await revoked.json()).toEqual({ revoked: 1 });
    await expect(closed).resolves.toBeTypeOf('number');
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('cuts live sockets and closes the listener when remote access is switched off', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const phone = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(phone);
    const desktop = await openSocket(`ws://127.0.0.1:${server.port}/ws`, [
      `tuffcode.bearer.${server.token}`,
    ]);
    sockets.push(desktop);
    const oldPort = remotePortOf(server);
    const closed = waitForClose(phone);

    const response = await rpc(desktop, 'disable', 'settings.set', {
      // The boot override used port 0 to take a free port; a stored value must be a
      // real port, and only the enabled flag matters here.
      patch: { remote: { ...server.remote, port: 4310, enabled: false } },
    });
    expect(response.ok, JSON.stringify(response.error)).toBe(true);
    await expect(closed).resolves.toBeTypeOf('number');
    await waitUntil(() => server.remotePort === undefined);
    await expect(fetch(`http://127.0.0.1:${oldPort}/health`)).rejects.toThrow();
    // The desktop listener is untouched, so the app keeps working.
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(health.status).toBe(200);
  });

  it('cuts a live socket when the session expires', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const socket = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(socket);
    server.db
      .prepare('UPDATE remote_sessions SET expires_at = ?')
      .run(new Date(Date.now() - 60_000).toISOString());
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ id: 'after-expiry', method: 'app.health', params: {} }));
    await expect(closed).resolves.toBeTypeOf('number');
  });

  it('cuts a live socket when the bearer token rotates', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const socket = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(socket);
    writeFileSync(tokenPath(), 'e'.repeat(64), 'utf8');
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({ id: 'after-rotation', method: 'app.health', params: {} }));
    await expect(closed).resolves.toBeTypeOf('number');
  });

  it('never fans terminal output or provider login output out to a paired device', async () => {
    const server = await boot(true);
    const token = await pairDevice(server);
    const phone = await openSocketWithHeaders(remoteSocketUrl(server), {
      cookie: `${REMOTE_SESSION_COOKIE}=${token}`,
    });
    sockets.push(phone);
    const desktop = await openSocket(`ws://127.0.0.1:${server.port}/ws`, [
      `tuffcode.bearer.${server.token}`,
    ]);
    sockets.push(desktop);

    const phoneTypes: string[] = [];
    const desktopTypes: string[] = [];
    phone.on('message', (data) => {
      const frame = parseFrame(data);
      if (typeof frame.type === 'string') phoneTypes.push(frame.type);
    });
    desktop.on('message', (data) => {
      const frame = parseFrame(data);
      if (typeof frame.type === 'string') desktopTypes.push(frame.type);
    });

    server.bus.emit({
      kind: 'event',
      type: 'terminal.data',
      threadId: 'thr_x',
      payload: { terminalId: 'trm_x', data: 'secret-shell-output' },
    });
    server.bus.emit({
      kind: 'event',
      type: 'provider.login.output',
      payload: { loginId: 'lgn_x', providerId: 'prv_x', chunk: 'device code' },
    });
    server.bus.emit({ kind: 'event', type: 'server.warning', payload: { message: 'heads up' } });

    await waitUntil(() => desktopTypes.includes('server.warning'));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(desktopTypes).toEqual(
      expect.arrayContaining(['terminal.data', 'provider.login.output', 'server.warning']),
    );
    expect(phoneTypes).toContain('server.warning');
    expect(phoneTypes).not.toContain('terminal.data');
    expect(phoneTypes).not.toContain('provider.login.output');
  });

  it('broadcasts server events to connected clients', async () => {
    const server = await boot();
    const socket = await openSocket(`ws://127.0.0.1:${server.port}/ws`, [
      `tuffcode.bearer.${server.token}`,
    ]);
    sockets.push(socket);
    const frame = waitFor(
      socket,
      (candidate) => candidate.kind === 'event' && candidate.type === 'server.warning',
    );
    server.bus.emit({
      kind: 'event',
      type: 'server.warning',
      payload: { message: 'heads up' },
    });
    const event = await frame;
    expect(event.payload).toEqual({ message: 'heads up' });
  });
});

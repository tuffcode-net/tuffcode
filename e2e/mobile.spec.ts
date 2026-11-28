import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile shell proof: the served build the way a phone uses it. The server comes from
 * scripts/mobile-test-server.mjs, which seeds a project, a mock provider and a thread
 * and writes the bearer token to a state file. Nothing here registers the service
 * worker by hand: the app has to do it, which is the point of the test.
 */
const STATE_PATH = join(tmpdir(), 'tuffcode-mobile-e2e.json');

/** The desktop socket uses `ws`, whose client accepts the bearer subprotocol. */
interface WsClient {
  on(event: 'message', listener: (data: unknown) => void): void;
  once(event: 'open', listener: () => void): void;
  once(event: 'error', listener: (error: unknown) => void): void;
  once(
    event: 'unexpected-response',
    listener: (request: unknown, response: { statusCode?: number }) => void,
  ): void;
  once(event: 'close', listener: (code: number) => void): void;
  off(event: 'message', listener: (data: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

function desktopSocket(): WsClient {
  const load = createRequire(join(process.cwd(), 'packages/server/package.json'));
  const ws = load('ws') as { WebSocket: new (url: string, protocols: string[]) => WsClient };
  // The desktop talks to its own loopback listener; the remote one is what gets closed.
  return new ws.WebSocket('ws://127.0.0.1:' + state().port + '/ws', [
    'tuffcode.bearer.' + state().token,
  ]);
}

interface MobileState {
  token: string;
  port: number;
  remotePort: number;
  projectId: string;
  threadId: string;
  baseUrl: string;
}

/** JSON from the server is unknown; the guard names the boundary once. */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(what + ' is not an object');
  return value as Record<string, unknown>;
}

function state(): MobileState {
  const value = asRecord(JSON.parse(readFileSync(STATE_PATH, 'utf8')), 'state file');
  const text = (key: string): string => {
    const field = value[key];
    if (typeof field !== 'string') throw new Error('state file has no ' + key + ' string');
    return field;
  };
  const number = (key: string): number => {
    const field = value[key];
    if (typeof field !== 'number') throw new Error('state file has no ' + key + ' number');
    return field;
  };
  return {
    token: text('token'),
    port: number('port'),
    remotePort: number('remotePort'),
    projectId: text('projectId'),
    threadId: text('threadId'),
    baseUrl: text('baseUrl'),
  };
}

function base(): string {
  return state().baseUrl;
}

function served(path: string): string {
  return new URL(path, base()).toString();
}

/** Desktop actions go to the loopback listener; a LAN peer may not create a code. */
function desktop(path: string): string {
  return 'http://127.0.0.1:' + state().port + path;
}

async function createCode(): Promise<string> {
  const response = await fetch(desktop('/pair/create'), {
    method: 'POST',
    headers: { authorization: `Bearer ${state().token}` },
  });
  expect(response.status, 'the desktop must be able to create a pairing code').toBe(201);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('code' in body)) {
    throw new Error('pair/create did not return a code');
  }
  const code = body.code;
  if (typeof code !== 'string') throw new Error('pair/create returned a non string code');
  return code;
}

async function claimViaApi(code: string): Promise<{ status: number; cookie: string }> {
  const response = await fetch(served('/pair/claim'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'API phone' }),
  });
  const cookie = /tuffcode_session=([0-9a-f]{64})/.exec(response.headers.get('set-cookie') ?? '');
  return { status: response.status, cookie: cookie?.[1] ?? '' };
}

async function statusOf(page: Page): Promise<string> {
  return (await page.getByTestId('connection-status').getAttribute('data-status')) ?? 'missing';
}

async function pair(page: Page): Promise<void> {
  const code = await createCode();
  await page.goto(served('/pair?code=' + code), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 20_000,
  });
}

test('serves the shell with a linked, valid manifest', async ({ page }) => {
  await page.goto(served('/'), { waitUntil: 'domcontentloaded' });
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href, 'index.html must link the manifest').toBeTruthy();
  const raw: unknown = await (await fetch(new URL(href ?? '/', served('/')))).json();
  const manifest = asRecord(raw, 'manifest');
  expect(manifest['name']).toBe('Tuffcode');
  const icons = Array.isArray(manifest['icons']) ? manifest['icons'] : [];
  const sizes = icons.map((icon: unknown) =>
    typeof icon === 'object' && icon !== null && 'sizes' in icon ? String(icon.sizes) : '',
  );
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
});

test('pairs a phone, registers the worker and drives a turn', async ({ page }) => {
  await pair(page);
  // The app has to register the worker itself; nothing in this spec calls register.
  // A plain HTTP LAN address is not a secure context, so the worker is only expected
  // there when the origin qualifies (loopback or HTTPS, for example Tailscale).
  const secure = await page.evaluate(() => window.isSecureContext);
  if (secure) {
    await page.waitForFunction(
      async () => (await navigator.serviceWorker.getRegistrations()).length > 0,
      null,
      { timeout: 20_000 },
    );
  }
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Remote chat' }).first()).toBeVisible();
  await page.goto(served('/project/' + state().projectId + '/thread/' + state().threadId), {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 20_000,
  });
  const input = page.getByTestId('composer-input');
  await expect(input).toBeEnabled({ timeout: 20_000 });
  await input.fill('Say hello');
  await expect(input).toHaveValue('Say hello', { timeout: 5_000 });
  await page.getByTestId('composer-send').click();
  await expect(
    page.getByTestId('assistant-message').filter({ hasText: 'Hello from the mock provider.' }).last(),
  ).toBeVisible({ timeout: 30_000 });
});

test('stops a running turn from the phone', async ({ page }) => {
  await pair(page);
  await page.goto(served('/project/' + state().projectId + '/thread/' + state().threadId), {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open', {
    timeout: 20_000,
  });
  const input = page.getByTestId('composer-input');
  await expect(input).toBeEnabled({ timeout: 20_000 });
  await input.fill('SLOW please count');
  await expect(input).toHaveValue('SLOW please count', { timeout: 5_000 });
  await page.getByTestId('composer-send').click();
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible({ timeout: 20_000 });
  await stop.click();
  await expect(page.getByTestId('composer-send')).toBeVisible({ timeout: 20_000 });
});

test('reconnects after the network drops', async ({ page, context, browserName }) => {
  // WebKit's offline emulation does not stop traffic on an already open socket, so the
  // heartbeat has nothing to notice there. The missed-probe reset is covered by a fake
  // timer unit test in apps/web/src/rpc/client.test.ts.
  test.skip(browserName !== 'chromium', 'WebKit does not cut an open socket offline');
  await pair(page);
  await context.setOffline(true);
  // The heartbeat notices a silent socket within two intervals.
  await expect
    .poll(async () => statusOf(page), { timeout: 45_000 })
    .not.toBe('open');
  await context.setOffline(false);
  await expect
    .poll(async () => statusOf(page), { timeout: 45_000 })
    .toBe('open');
});

test('pairs a second device and revoke cuts only that one', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const one = await first.newPage();
    const two = await second.newPage();
    await pair(one);
    await pair(two);

    const listed = await fetch(desktop('/remote/sessions'), {
      headers: { authorization: `Bearer ${state().token}` },
    });
    const sessions = (await listed.json()) as { sessions: { id: string; connected: boolean }[] };
    expect(sessions.sessions.filter((session) => session.connected)).toHaveLength(2);
    const newest = sessions.sessions[0];
    if (newest === undefined) throw new Error('no paired sessions were listed');

    const revoked = await fetch(desktop('/remote/sessions/revoke'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${state().token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: newest.id }),
    });
    expect(await revoked.json()).toEqual({ revoked: 1 });
    await expect.poll(async () => statusOf(two), { timeout: 10_000 }).not.toBe('open');
    expect(await statusOf(one)).toBe('open');
  } finally {
    await first.close();
    await second.close();
  }
});

test('refuses a reused pairing code', async () => {
  const code = await createCode();
  expect((await claimViaApi(code)).status).toBe(201);
  expect((await claimViaApi(code)).status).toBe(401);
});

test('disabling remote access cuts every paired device', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const one = await first.newPage();
    const two = await second.newPage();
    await pair(one);
    await pair(two);

    const socket = desktopSocket();
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => fail(new Error('the desktop socket did not open')), 10_000);
      socket.once('open', () => {
        clearTimeout(timer);
        ready();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        fail(new Error('upgrade answered HTTP ' + String(response.statusCode)));
      });
      socket.once('close', (code) => {
        clearTimeout(timer);
        fail(new Error('socket closed before open with code ' + code));
      });
    });
    const request = (id: string, method: string, params: unknown): Promise<Record<string, unknown>> => {
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
      const onMessage = (data: unknown): void => {
        const frame = JSON.parse(String(data)) as { id?: string };
        if (frame.id !== id) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(frame as Record<string, unknown>);
      };
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        reject(new Error('no reply to ' + method));
      }, 5_000);
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ id, method, params }));
      return promise;
    };
    const settings = await request('get', 'settings.get', {});
    const result = settings['result'];
    if (typeof result !== 'object' || result === null || !('remote' in result)) {
      throw new Error('settings.get did not return the remote block');
    }
    const remote = result.remote;
    if (typeof remote !== 'object' || remote === null) throw new Error('remote is not an object');
    const saved = await request('set', 'settings.set', {
      patch: { remote: { ...remote, enabled: false } },
    });
    expect(saved['ok']).toBe(true);
    socket.close();

    await expect.poll(async () => statusOf(one), { timeout: 10_000 }).not.toBe('open');
    await expect.poll(async () => statusOf(two), { timeout: 10_000 }).not.toBe('open');
    await expect(fetch(served('/health'))).rejects.toThrow();
  } finally {
    await first.close();
    await second.close();
  }
});

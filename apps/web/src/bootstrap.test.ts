import { describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_PATH,
  WS_PATH,
  browserWsUrl,
  createBrowserBridge,
  electronWsUrl,
  resolveBootstrap,
} from './bootstrap';
import type { BootstrapInfo } from './types';

const BROWSER_PAYLOAD = {
  port: 8787,
  version: '0.4.0',
  platform: 'linux',
  home: '/home/ada',
  wsPath: '/ws',
};

interface FetchCall {
  input: string;
  init: RequestInit | undefined;
}

function stubFetch(body: unknown, status = 200): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const BROWSER_LOCATION = { protocol: 'http:', host: '10.0.0.5:8787' };

describe('socket URL selection', () => {
  it('keeps the desktop loopback socket', () => {
    expect(electronWsUrl(8787)).toBe('ws://127.0.0.1:8787/ws');
  });

  it('dials the served origin over ws for an http page', () => {
    expect(browserWsUrl({ protocol: 'http:', host: '192.168.1.20:8787' })).toBe(
      'ws://192.168.1.20:8787/ws',
    );
  });

  it('dials the served origin over wss for an https page', () => {
    expect(browserWsUrl({ protocol: 'https:', host: 'tuff.example.com' })).toBe(
      'wss://tuff.example.com/ws',
    );
  });

  it('uses the path the server reports and adds a missing slash', () => {
    expect(browserWsUrl({ protocol: 'http:', host: 'box:8787' }, 'socket')).toBe(
      'ws://box:8787/socket',
    );
  });

  it('falls back to the default path when the server reports a blank one', () => {
    expect(browserWsUrl({ protocol: 'http:', host: 'box:8787' }, '   ')).toBe(
      `ws://box:8787${WS_PATH}`,
    );
  });
});

describe('bootstrap resolution', () => {
  it('uses the preload bridge in Electron and never touches the network', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolved = await resolveBootstrap({
      bridge: {
        getBootstrap: () =>
          Promise.resolve({
            port: 9999,
            token: 'secret',
            version: '1.0.0',
            platform: 'win32',
            home: 'C:/Users/ada',
          }),
      },
      fetchImpl,
      location: { protocol: 'http:', host: 'ignored:1' },
    });

    expect(resolved.wsUrl).toBe('ws://127.0.0.1:9999/ws');
    expect(resolved.bootstrap.token).toBe('secret');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks the served origin for bootstrap and dials its location', async () => {
    const { impl, calls } = stubFetch(BROWSER_PAYLOAD);
    const resolved = await resolveBootstrap({ fetchImpl: impl, location: BROWSER_LOCATION });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(BOOTSTRAP_PATH);
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(resolved.bootstrap).toEqual({
      port: 8787,
      version: '0.4.0',
      platform: 'linux',
      home: '/home/ada',
    });
    expect(resolved.bootstrap.token).toBeUndefined();
    expect(resolved.wsUrl).toBe('ws://10.0.0.5:8787/ws');
  });

  it('uses the wsPath from the response', async () => {
    const { impl } = stubFetch({ ...BROWSER_PAYLOAD, wsPath: '/socket' });
    const resolved = await resolveBootstrap({ fetchImpl: impl, location: BROWSER_LOCATION });

    expect(resolved.wsUrl).toBe('ws://10.0.0.5:8787/socket');
  });

  it('carries a token when the server hands one to the page', async () => {
    const { impl } = stubFetch({ ...BROWSER_PAYLOAD, token: 'page-token' });
    const resolved = await resolveBootstrap({ fetchImpl: impl, location: BROWSER_LOCATION });

    expect(resolved.bootstrap.token).toBe('page-token');
  });

  it('falls back to the served origin when the bridge has no getBootstrap', async () => {
    const { impl, calls } = stubFetch(BROWSER_PAYLOAD);
    const resolved = await resolveBootstrap({
      bridge: {},
      fetchImpl: impl,
      location: BROWSER_LOCATION,
    });

    expect(calls).toHaveLength(1);
    expect(resolved.wsUrl).toBe('ws://10.0.0.5:8787/ws');
  });

  it('keeps the served origin when the browser shim is already installed', async () => {
    const { impl, calls } = stubFetch(BROWSER_PAYLOAD);
    const shim = createBrowserBridge({ port: 1, version: '1', platform: 'browser', home: '/' });
    const resolved = await resolveBootstrap({
      bridge: shim,
      fetchImpl: impl,
      location: BROWSER_LOCATION,
    });

    expect(calls).toHaveLength(1);
    expect(resolved.wsUrl).toBe('ws://10.0.0.5:8787/ws');
  });

  it('rejects a bootstrap response that is not ok', async () => {
    const { impl } = stubFetch({}, 500);

    await expect(
      resolveBootstrap({ fetchImpl: impl, location: BROWSER_LOCATION }),
    ).rejects.toThrow('HTTP 500');
  });

  it('rejects a bootstrap response without a usable port', async () => {
    const { impl } = stubFetch({ ...BROWSER_PAYLOAD, port: 0 });

    await expect(
      resolveBootstrap({ fetchImpl: impl, location: BROWSER_LOCATION }),
    ).rejects.toThrow('usable port');
  });

  it('rejects a bootstrap response that is not an object', async () => {
    const { impl } = stubFetch('not json');

    await expect(
      resolveBootstrap({ fetchImpl: impl, location: BROWSER_LOCATION }),
    ).rejects.toThrow('JSON object');
  });
});

describe('browser bridge', () => {
  const bootstrap: BootstrapInfo = {
    port: 8787,
    version: '0.4.0',
    platform: 'browser',
    home: '/home/ada',
  };

  it('answers the bootstrap it was built with', async () => {
    const bridge = createBrowserBridge(bootstrap);
    await expect(bridge.getBootstrap()).resolves.toBe(bootstrap);
  });

  it('reports the unavailable folder picker and cancels', async () => {
    const messages: string[] = [];
    const bridge = createBrowserBridge(bootstrap, (message) => messages.push(message));

    await expect(bridge.pickFolder()).resolves.toBeNull();
    expect(messages).toEqual(['Adding a folder needs the desktop app.']);
  });

  it('cancels the folder picker quietly by default', async () => {
    const bridge = createBrowserBridge(bootstrap);
    await expect(bridge.pickFolder()).resolves.toBeNull();
  });

  it('keeps the menu subscription and native chrome calls inert', () => {
    const bridge = createBrowserBridge(bootstrap);
    const unsubscribe = bridge.onMenuAction(() => undefined);

    expect(unsubscribe()).toBeUndefined();
    expect(bridge.setTheme('dark')).toBeUndefined();
  });

  it('leaves native only features absent so their UI hides itself', () => {
    const bridge = createBrowserBridge(bootstrap);

    expect(bridge.checkForUpdates).toBeUndefined();
    expect(bridge.pickFile).toBeUndefined();
    expect(bridge.notify).toBeUndefined();
    expect(bridge.notifyTest).toBeUndefined();
    expect(bridge.setKeepAwake).toBeUndefined();
    expect(bridge.openExternal).toBeUndefined();
    expect(bridge.getPathForFile).toBeUndefined();
  });
});

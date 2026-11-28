import type { BootstrapInfo, BootstrapResponse, TuffcodeBridge } from './types';

/** Path the browser uses to learn how to reach the server that served the page. */
export const BOOTSTRAP_PATH = '/bootstrap';
/** Socket path the server names in its bootstrap response, and the default. */
export const WS_PATH = '/ws';

export interface BootstrapLocation {
  protocol: string;
  host: string;
}

export interface ResolvedBootstrap {
  bootstrap: BootstrapInfo;
  /** Absolute WebSocket URL the RPC client connects to. */
  wsUrl: string;
}

export interface BootstrapSources {
  /** Electron preload bridge; read from `window` when omitted. */
  bridge?: Partial<TuffcodeBridge>;
  fetchImpl?: typeof fetch;
  location?: BootstrapLocation;
}

/** The desktop server listens on loopback with an OS assigned port. */
export function electronWsUrl(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

/** A served page reaches the origin it was loaded from, over ws or wss. */
export function browserWsUrl(location: BootstrapLocation, wsPath: string = WS_PATH): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${normalizeWsPath(wsPath)}`;
}

function normalizeWsPath(wsPath: string): string {
  const trimmed = wsPath.trim();
  if (trimmed.length === 0) return WS_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function readText(source: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new Error(`${BOOTSTRAP_PATH} did not report a ${key} string.`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`${BOOTSTRAP_PATH} reported an empty ${key}.`);
  }
  return value;
}

/** Validates the served origin's answer before anything trusts it. */
export function parseBootstrapResponse(raw: unknown): BootstrapResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${BOOTSTRAP_PATH} did not return a JSON object.`);
  }
  // Every property read below is checked, so the assertion only names the container.
  const source = raw as Record<string, unknown>;
  const port = source.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${BOOTSTRAP_PATH} did not report a usable port.`);
  }
  const token = source.token;
  if (token !== undefined && typeof token !== 'string') {
    throw new Error(`${BOOTSTRAP_PATH} reported a token that is not a string.`);
  }
  const home = typeof source.home === 'string' ? source.home : undefined;
  const remote = source.remote === true;
  const deviceName = typeof source.deviceName === 'string' ? source.deviceName : undefined;
  return {
    port,
    version: readText(source, 'version'),
    platform: readText(source, 'platform'),
    ...(home === undefined ? {} : { home }),
    wsPath: typeof source.wsPath === 'string' ? source.wsPath : WS_PATH,
    ...(typeof token === 'string' && token.length > 0 ? { token } : {}),
    ...(remote ? { remote } : {}),
    ...(deviceName === undefined ? {} : { deviceName }),
  };
}

async function fetchBootstrap(fetchImpl: typeof fetch): Promise<BootstrapResponse> {
  const response = await fetchImpl(BOOTSTRAP_PATH, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${BOOTSTRAP_PATH} answered with HTTP ${response.status}.`);
  }
  return parseBootstrapResponse(await response.json());
}

/**
 * The preload installs the bridge before the renderer script runs, so a served page
 * is the only case where the property is missing. Reflect keeps the absence honest
 * even though the global is declared for every page.
 */
export function readBridge(): Partial<TuffcodeBridge> | undefined {
  if (typeof window === 'undefined') return undefined;
  const candidate: unknown = Reflect.get(window, 'tuffcode');
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return candidate as Partial<TuffcodeBridge>;
}

/**
 * Electron answers over IPC and keeps the loopback socket URL it always used. A
 * browser asks the server that served the page, then dials that same origin so a
 * reverse proxy or a LAN address works without configuration.
 */
export async function resolveBootstrap(
  sources: BootstrapSources = {},
): Promise<ResolvedBootstrap> {
  const bridge = sources.bridge ?? readBridge();
  if (bridge?.browser !== true && typeof bridge?.getBootstrap === 'function') {
    const bootstrap = await bridge.getBootstrap();
    return { bootstrap, wsUrl: electronWsUrl(bootstrap.port) };
  }

  const fetchImpl = sources.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(`No bridge and no fetch, so ${BOOTSTRAP_PATH} is unreachable.`);
  }
  const payload = await fetchBootstrap(fetchImpl);

  const location =
    sources.location ?? (typeof window === 'undefined' ? undefined : window.location);
  if (location === undefined) {
    throw new Error('No window location, so the socket URL cannot be built.');
  }

  const bootstrap: BootstrapInfo = {
    port: payload.port,
    version: payload.version,
    platform: payload.platform,
    ...(payload.home === undefined ? {} : { home: payload.home }),
    ...(payload.token === undefined ? {} : { token: payload.token }),
    ...(payload.remote === true ? { remote: true } : {}),
    ...(payload.deviceName === undefined ? {} : { deviceName: payload.deviceName }),
  };
  return { bootstrap, wsUrl: browserWsUrl(location, payload.wsPath) };
}

/**
 * A served page has no Electron preload. The shim keeps the renderer's bridge calls
 * safe: features that need native APIs stay absent so their UI hides itself, and a
 * folder picker reports a cancel because a browser cannot reach the server's disk.
 */
export function createBrowserBridge(
  bootstrap: BootstrapInfo,
  reportUnavailable: (message: string) => void = () => undefined,
): TuffcodeBridge {
  return {
    browser: true,
    getBootstrap: () => Promise.resolve(bootstrap),
    pickFolder: () => {
      reportUnavailable('Adding a folder needs the desktop app.');
      return Promise.resolve(null);
    },
    onMenuAction: () => () => undefined,
    setTheme: () => undefined,
  };
}

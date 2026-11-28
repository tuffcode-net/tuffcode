import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  ClientRequestSchema,
  REMOTE_SESSION_COOKIE,
  ServerResponseSchema,
  type RemoteSettings,
  type ServerResponse,
  type Settings,
} from '@tuffcode/contracts';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { readCookie, type SessionAuth } from './auth.js';
import type { EventBus } from './events.js';
import { isAllowedHost, isAllowedOrigin } from './http.js';
import { isRemoteEventAllowed, type RemotePrincipal } from './remote-policy.js';
import type { RemoteSockets } from './remote-sockets.js';
import { dispatch, type RpcHandlers } from './rpc.js';

const WS_PATH = '/ws';
const BEARER_PROTOCOL_PREFIX = 'tuffcode.bearer.';
/** How often a paired device socket is re-checked against its row and the token file. */
const DEFAULT_SESSION_SWEEP_MS = 15_000;

export interface WebSocketDeps {
  handlers: RpcHandlers;
  bus: EventBus;
  verifyToken: (candidate: string | undefined | null) => boolean;
  verifySession: SessionAuth['verify'];
  getRemote: () => RemoteSettings;
  getSettings: () => Settings;
  /** Shared across listeners so revoke and disable cut every socket. */
  sockets: RemoteSockets;
  /**
   * False on the desktop loopback listener: a session cookie is only accepted on the
   * listener remote access opened, so turning the feature off closes that door.
   */
  allowSessionAuth: boolean;
  sessionSweepMs?: number;
}

export interface AttachedWebSocket {
  wss: WebSocketServer;
  close(): Promise<void>;
}

interface SocketAuth {
  readonly principal: RemotePrincipal;
  readonly sessionId?: string;
  readonly sessionToken?: string;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * Reads the bearer token from `Authorization: Bearer <token>` or from a
 * `tuffcode.bearer.<token>` entry in `Sec-WebSocket-Protocol`. Browsers cannot set
 * arbitrary WS headers, so the subprotocol form is the renderer's path.
 */
export function extractToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  const protocolHeader = request.headers['sec-websocket-protocol'];
  const values = Array.isArray(protocolHeader)
    ? protocolHeader
    : protocolHeader === undefined
      ? []
      : [protocolHeader];
  for (const value of values) {
    for (const part of value.split(',')) {
      const protocol = part.trim();
      if (protocol.startsWith(BEARER_PROTOCOL_PREFIX)) {
        return protocol.slice(BEARER_PROTOCOL_PREFIX.length);
      }
    }
  }
  return undefined;
}

/** The paired device cookie, which browsers send on the upgrade request automatically. */
export function extractSessionToken(request: IncomingMessage): string | undefined {
  return readCookie(request.headers.cookie, REMOTE_SESSION_COOKIE);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function idOf(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = value.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'invalid';
}

function sendResponse(client: WebSocket, response: ServerResponse): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify(ServerResponseSchema.parse(response)));
}

/**
 * Attaches the authenticated WebSocket server to an existing HTTP server on `/ws`.
 * Each frame is parsed as a `ClientRequest` and dispatched with the principal that
 * authenticated the upgrade: the bearer token is the desktop, a session cookie is a
 * paired device and is allowlisted per method. Events from the bus fan out to every
 * desktop socket, and only the allowlisted types reach a paired device.
 */
export function attachWebSocket(server: Server, deps: WebSocketDeps): AttachedWebSocket {
  const wss = new WebSocketServer({ noServer: true });
  const auth = new Map<WebSocket, SocketAuth>();

  function drop(client: WebSocket): void {
    auth.delete(client);
    deps.sockets.unregister(client);
    client.terminate();
  }

  async function handleFrame(client: WebSocket, data: RawData): Promise<void> {
    const who = auth.get(client);
    if (who === undefined) return;
    if (who.principal === 'remote') {
      // A revoked row, an expired row or a rotated bearer token must stop this socket
      // even when nobody has touched the desktop UI. The cookie is re-resolved per
      // frame, so the kill switch is immediate rather than sweep-latency.
      const stillValid =
        who.sessionToken === undefined ? undefined : deps.verifySession(who.sessionToken);
      if (stillValid === undefined || stillValid.id !== who.sessionId) {
        drop(client);
        return;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data)) as unknown;
    } catch {
      sendResponse(client, {
        id: 'invalid',
        ok: false,
        error: { code: 'bad-request', message: 'malformed JSON' },
      });
      return;
    }
    const request = ClientRequestSchema.safeParse(parsed);
    if (!request.success) {
      sendResponse(client, {
        id: idOf(parsed),
        ok: false,
        error: { code: 'bad-request', message: 'invalid request' },
      });
      return;
    }
    sendResponse(
      client,
      await dispatch(deps.handlers, request.data, {
        principal: who.principal,
        defaultPermissionMode: deps.getSettings().defaultPermissionMode,
      }),
    );
  }

  const unsubscribe = deps.bus.subscribe((event) => {
    const frame = JSON.stringify(event);
    const remoteAllowed = isRemoteEventAllowed(event.type);
    for (const [client, who] of auth) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (who.principal === 'remote' && !remoteAllowed) continue;
      client.send(frame);
    }
  });

  // Expiry and token rotation are silent database changes, so a socket that is idle
  // would otherwise stay open until its next frame. The sweep is the backstop.
  const sweep = setInterval(() => {
    for (const entry of deps.sockets.remoteEntries()) {
      const valid =
        entry.sessionToken === undefined ? undefined : deps.verifySession(entry.sessionToken);
      if (valid === undefined || valid.id !== entry.sessionId) {
        auth.delete(entry.client);
        deps.sockets.unregister(entry.client);
        entry.client.terminate();
      }
    }
  }, deps.sessionSweepMs ?? DEFAULT_SESSION_SWEEP_MS);
  sweep.unref?.();

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const remote = deps.getRemote();
    if (!isAllowedHost(request.headers.host, remote)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const token = extractToken(request);
    const fileToken = deps.verifyToken(token);
    // A browser always sends Origin here; refusing a foreign one blocks cross-site
    // WebSocket hijacking when the session cookie is attached automatically. The
    // desktop renderer is a file:// origin and authenticates with the file token,
    // which a foreign page cannot read, so the token itself is the boundary there.
    const origin = request.headers.origin;
    const desktopOrigin =
      origin === undefined || origin === 'null' || origin.startsWith('file://');
    if (
      !(fileToken && desktopOrigin) &&
      !isAllowedOrigin(origin, request.headers.host, remote)
    ) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    let who: SocketAuth | undefined;
    if (fileToken) {
      who = { principal: 'desktop' };
    } else if (token === undefined && deps.allowSessionAuth) {
      const cookieToken = extractSessionToken(request);
      const session = deps.verifySession(cookieToken);
      if (session !== undefined && cookieToken !== undefined) {
        who = { principal: 'remote', sessionId: session.id, sessionToken: cookieToken };
      }
    }
    if (who === undefined) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const resolved = who;
    try {
      wss.handleUpgrade(request, socket, head, (client) => {
        auth.set(client, resolved);
        deps.sockets.register({
          client,
          principal: resolved.principal,
          sessionId: resolved.sessionId,
          sessionToken: resolved.sessionToken,
        });
        client.on('close', () => {
          auth.delete(client);
          deps.sockets.unregister(client);
        });
        client.on('error', () => {
          auth.delete(client);
          deps.sockets.unregister(client);
        });
        client.on('message', (data) => {
          void handleFrame(client, data);
        });
      });
    } catch {
      socket.destroy();
    }
  });

  return {
    wss,
    close: () => {
      clearInterval(sweep);
      unsubscribe();
      for (const client of auth.keys()) {
        deps.sockets.unregister(client);
        client.terminate();
      }
      auth.clear();
      const { promise, resolve } = Promise.withResolvers<void>();
      wss.close(() => {
        resolve();
      });
      return promise;
    },
  };
}

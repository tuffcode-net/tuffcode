import { randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import {
  PairClaimRequestSchema,
  REMOTE_SESSION_COOKIE,
  REMOTE_SESSION_TTL_MS,
  RemoteSessionListSchema,
  RevokeSessionsRequestSchema,
  type PairClaimResult,
  type PairCreateResult,
  type RemoteSessionView,
  type RemoteSettings,
} from '@tuffcode/contracts';
import { newId } from '@tuffcode/shared';
import {
  hashSecret,
  readCookie,
  type PairingStore,
  type SessionAuth,
} from './auth.js';
import {
  remoteAddressKey,
  remoteTransportAllowsCookie,
  resolvePairingBase,
} from './remote-policy.js';
import type { RemoteSockets } from './remote-sockets.js';
import type {
  RemoteSessionRecord,
  RemoteSessionsRepo,
} from './db/repos/remote-sessions.js';

export interface HealthBody {
  ok: true;
  version: string;
  pid: number;
  uptimeMs: number;
}

export interface HttpServerOptions {
  version: string;
  startedAt: number;
  /** Built renderer directory. Absent means the static surface is not mounted. */
  webRoot?: string | undefined;
  /** Read per request, so disabling remote access takes effect without a restart. */
  getRemote: () => RemoteSettings;
  sessions: RemoteSessionsRepo;
  pairing: PairingStore;
  verifyToken: (candidate: string | undefined | null) => boolean;
  verifySession: SessionAuth['verify'];
  /** Shared socket registry, so revoke and the device list see live connections. */
  sockets: RemoteSockets;
  /**
   * True only on the listener remote access opened. A session cookie is refused on the
   * desktop loopback listener, so switching the feature off closes that path entirely.
   */
  allowSessionAuth: boolean;
}

const IPV4_LOOPBACK = /^127\./;
const IPV6_MAPPED_LOOPBACK = /^::ffff:127\./i;
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const PAIRING_BODY_LIMIT = 4096;
// Creating a code needs the bearer token, so this bounds abuse rather than guessing;
// the claim limiter below is the guess boundary and stays tight.
const PAIRING_CREATE_LIMIT = 20;
const PAIRING_CLAIM_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const INDEX_FILE = 'index.html';
const META_CSP = /<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    IPV4_LOOPBACK.test(address) ||
    IPV6_MAPPED_LOOPBACK.test(address)
  );
}

function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * True for `127.x`, `localhost` and `[::1]`, with or without a port. A missing Host
 * header (HTTP/1.0) is accepted because the socket itself is already loopback.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0) return true;
  const hostname = hostnameOf(host).toLowerCase();
  return hostname === 'localhost' || isLoopbackAddress(hostname);
}

function isIpLiteral(hostname: string): boolean {
  return IPV4_LITERAL.test(hostname) || hostname.includes(':');
}

function isWildcardBind(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/** Origin header value as a URL, or undefined when it is missing, `null` or malformed. */
function parseOrigin(origin: string | undefined): URL | undefined {
  if (origin === undefined || origin.length === 0 || origin === 'null') return undefined;
  try {
    return new URL(origin);
  } catch {
    return undefined;
  }
}

/**
 * Host header policy. Loopback is always accepted. When remote access is on, the
 * configured bind host and the allowed origins are accepted, and a wildcard bind also
 * accepts IP literals so DNS rebinding names are still refused.
 */
export function isAllowedHost(
  host: string | undefined,
  remote: RemoteSettings,
): boolean {
  if (isLoopbackHost(host)) return true;
  if (!remote.enabled) return false;
  if (host === undefined || host.length === 0) return false;
  const hostname = hostnameOf(host).toLowerCase();
  if (hostname === remote.bindHost.toLowerCase()) return true;
  if (isWildcardBind(remote.bindHost) && isIpLiteral(hostname)) return true;
  const origin = `http://${host.toLowerCase()}`;
  return remote.allowedOrigins.some((allowed) => normalizeOrigin(allowed) === origin);
}

/**
 * WebSocket and state changing HTTP requests carry an Origin header from a browser.
 * Loopback origins are always trusted. Otherwise the request must be same-origin or
 * listed in `remote.allowedOrigins`; a missing Origin (non-browser client) passes,
 * because the bearer token or session cookie still has to be valid.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  remote: RemoteSettings,
): boolean {
  if (origin === undefined || origin.length === 0) return true;
  if (origin === 'null') return false;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || isLoopbackAddress(hostname)) return true;
  if (!remote.enabled) return false;
  if (host !== undefined && host.length > 0) {
    const sameOrigin = `http://${host.toLowerCase()}`;
    if (normalizeOrigin(origin) === sameOrigin) return true;
  }
  const requested = normalizeOrigin(origin);
  return remote.allowedOrigins.some((allowed) => normalizeOrigin(allowed) === requested);
}

/**
 * CSP for the page served from this origin. `connect-src 'self'` does not match
 * WebSocket schemes in every browser, so the ws origin is listed explicitly.
 */
export function buildContentSecurityPolicy(origin: string | undefined): string {
  const connect = ["'self'"];
  if (origin !== undefined && origin.length > 0) {
    connect.push(origin.replace(/^http/, 'ws'));
    connect.push(origin);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    'frame-src http: https:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Scheme and host of the request as the browser sees them. A reverse proxy in front of
 * the loopback listener (Tailscale Serve) terminates TLS, so the forwarded scheme is
 * honoured under the same rule as the cookie: only for a loopback peer and only when a
 * public address is configured.
 */
function originOf(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (typeof host !== 'string' || host.length === 0) return undefined;
  // Display only: this builds the CSP and a fallback pairing origin for the host the
  // browser already used. It grants nothing, so the forwarded scheme is fine here; the
  // cookie decision uses the strict isSecureRequest rule instead.
  const forwarded = request.headers['x-forwarded-proto'];
  const secure =
    typeof forwarded === 'string' &&
    forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
  return `${secure ? 'https' : 'http'}://${host}`;
}

function securityHeaders(csp: string): Record<string, string> {
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
  };
}

/** A desktop renderer is a file:// origin, so its pairing calls arrive as Origin: null. */
function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  if (origin === undefined) return {};
  if (origin === 'null') {
    return {
      'access-control-allow-origin': 'null',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      vary: 'origin',
    };
  }
  try {
    if (isLoopbackHost(new URL(origin).host)) {
      return {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        vary: 'origin',
      };
    }
  } catch {
    return {};
  }
  return {};
}

function writeJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...securityHeaders(buildContentSecurityPolicy(originOf(request))),
    ...corsHeaders(request),
    ...extra,
  });
  if (request.method === 'HEAD') response.end();
  else response.end(payload);
}

function writeError(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error: string,
): void {
  writeJson(request, response, status, { error });
}

function writeErrorDetail(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(request, response, status, { error: code, message });
}

function extractBearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

interface RateLimiter {
  take(key: string): boolean;
}

/** Fixed window limiter keyed by socket address, pruned so a scan cannot grow it forever. */
function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    take: (key) => {
      const at = now();
      if (buckets.size > 512) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetAt <= at) buckets.delete(bucketKey);
        }
      }
      const bucket = buckets.get(key);
      if (bucket === undefined || bucket.resetAt <= at) {
        buckets.set(key, { count: 1, resetAt: at + windowMs });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
  };
}

type JsonRead = { ok: true; value: unknown } | { ok: false; status: number };

function readJsonBody(request: IncomingMessage, limit: number): Promise<JsonRead> {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<JsonRead>();
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const finish = (result: JsonRead): void => {
    if (settled) return;
    settled = true;
    resolvePromise(result);
  };
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      finish({ ok: false, status: 413 });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (size === 0) {
      finish({ ok: false, status: 400 });
      return;
    }
    try {
      finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
    } catch {
      finish({ ok: false, status: 400 });
    }
  });
  request.on('error', () => {
    finish({ ok: false, status: 400 });
  });
  return promise;
}

function toView(session: RemoteSessionRecord, connected: ReadonlySet<string>): RemoteSessionView {
  return {
    id: session.id,
    deviceName: session.deviceName,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    connected: connected.has(session.id),
  };
}

function renderIndexHtml(html: string, csp: string): string {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('"', '&quot;')}" />`;
  if (META_CSP.test(html)) return html.replace(META_CSP, tag);
  return html.replace('</head>', `  ${tag}\n  </head>`);
}

interface StaticFile {
  path: string;
  contentType: string;
}

function staticFile(webRoot: string, pathname: string): StaticFile | undefined {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0')) return undefined;
  const filePath = resolve(webRoot, `.${decoded}`);
  if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${sep}`)) return undefined;
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  const extension = extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';
  return { path: filePath, contentType };
}

function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: StaticFile,
  cacheControl: string,
  extra: Record<string, string> = {},
): void {
  const size = statSync(file.path).size;
  response.writeHead(200, {
    'content-type': file.contentType,
    'content-length': size,
    'cache-control': cacheControl,
    ...securityHeaders(buildContentSecurityPolicy(originOf(request))),
    ...extra,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(file.path);
  stream.on('error', () => {
    response.destroy();
  });
  stream.pipe(response);
}

function serveIndex(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
  extra: Record<string, string> = {},
): void {
  const indexPath = resolve(webRoot, INDEX_FILE);
  let html: string;
  try {
    html = readFileSync(indexPath, 'utf8');
  } catch {
    writeError(request, response, 404, 'not-found');
    return;
  }
  const csp = buildContentSecurityPolicy(originOf(request));
  const body = renderIndexHtml(html, csp);
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...securityHeaders(csp),
    ...extra,
  });
  if (request.method === 'HEAD') response.end();
  else response.end(body);
}

function hasExtension(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

function pairingUrl(origin: string, code: string): string {
  return `${origin}/pair?code=${encodeURIComponent(code)}`;
}

/**
 * True when the browser reached this server over TLS. The Node listener itself is plain
 * HTTP, so TLS always comes from a proxy in front of it. `x-forwarded-proto` is
 * client-controlled on a LAN, so it is only believed when a public address is
 * configured and the request itself arrived over loopback.
 */
function isSecureRequest(request: IncomingMessage, remote: RemoteSettings): boolean {
  if (remote.publicUrl.trim().length === 0) return false;
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  const forwarded = request.headers['x-forwarded-proto'];
  return (
    typeof forwarded === 'string' &&
    forwarded.split(',')[0]?.trim().toLowerCase() === 'https'
  );
}

function sessionCookie(token: string, secure: boolean): string {
  const maxAge = Math.floor(REMOTE_SESSION_TTL_MS / 1000);
  const flags = secure ? '; Secure' : '';
  return `${REMOTE_SESSION_COOKIE}=${token}; Path=/; HttpOnly${flags}; SameSite=Strict; Max-Age=${maxAge}`;
}

/**
 * The plain HTTP surface: `/health` for readiness probes, the built renderer with an
 * SPA fallback, and the remote access endpoints. The WS upgrade is handled in `ws.ts`.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const pairing = options.pairing;
  const getRemote = options.getRemote;
  const createLimiter = createRateLimiter(PAIRING_CREATE_LIMIT, RATE_WINDOW_MS);
  const claimLimiter = createRateLimiter(PAIRING_CLAIM_LIMIT, RATE_WINDOW_MS);
  const webRoot = options.webRoot === undefined ? undefined : resolve(options.webRoot);

  function handleBootstrap(request: IncomingMessage, response: ServerResponse): void {
    if (!options.allowSessionAuth) {
      writeError(request, response, 401, 'unauthorized');
      return;
    }
    const session = options.verifySession(
      readCookie(request.headers.cookie, REMOTE_SESSION_COOKIE),
    );
    if (session === undefined) {
      writeError(request, response, 401, 'unauthorized');
      return;
    }
    // The OS home path is not part of what a paired device needs, and it is the first
    // fact a shell would use to find the token and the provider keys. It stays out.
    writeJson(request, response, 200, {
      port: request.socket.localPort ?? 0,
      version: options.version,
      platform: process.platform,
      wsPath: '/ws',
      remote: true,
      deviceName: session.deviceName,
    });
  }

  async function handlePairCreate(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!isLoopbackAddress(request.socket.remoteAddress) || !isLoopbackHost(request.headers.host)) {
      writeError(request, response, 403, 'forbidden');
      return;
    }
    if (!options.verifyToken(extractBearer(request))) {
      writeError(request, response, 401, 'unauthorized');
      return;
    }
    const remote = getRemote();
    if (!remote.enabled) {
      writeErrorDetail(
        request,
        response,
        400,
        'remote-disabled',
        'Turn on remote access before creating a pairing link',
      );
      return;
    }
    if (!createLimiter.take(remoteAddressKey(request.socket.remoteAddress))) {
      writeError(request, response, 429, 'rate-limited');
      return;
    }
    const base = resolvePairingBase(remote, originOf(request));
    if (base.url === undefined) {
      writeErrorDetail(
        request,
        response,
        400,
        base.error?.code ?? 'no-public-url',
        base.error?.message ?? 'no address a phone can reach is configured',
      );
      return;
    }
    const issued = pairing.issue();
    const result: PairCreateResult = {
      code: issued.code,
      url: pairingUrl(base.url, issued.code),
      expiresAt: issued.expiresAt,
    };
    writeJson(request, response, 201, result);
  }

  async function handlePairClaim(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const remote = getRemote();
    if (!isAllowedOrigin(request.headers.origin, request.headers.host, remote)) {
      writeError(request, response, 403, 'forbidden');
      return;
    }
    const loopbackPeer = isLoopbackAddress(request.socket.remoteAddress);
    const secure = isSecureRequest(request, remote);
    if (!remoteTransportAllowsCookie(loopbackPeer, secure, remote)) {
      writeErrorDetail(
        request,
        response,
        400,
        'insecure-transport',
        'Pairing over plain HTTP on a network address would send the session cookie in the clear. Use an HTTPS address, or turn on the plain HTTP option in Settings > Remote access.',
      );
      return;
    }
    if (!claimLimiter.take(remoteAddressKey(request.socket.remoteAddress))) {
      writeError(request, response, 429, 'rate-limited');
      return;
    }
    const body = await readJsonBody(request, PAIRING_BODY_LIMIT);
    if (!body.ok) {
      writeError(request, response, body.status, 'bad-request');
      return;
    }
    const parsed = PairClaimRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      writeError(request, response, 400, 'bad-request');
      return;
    }
    if (!pairing.consume(parsed.data.code)) {
      writeError(request, response, 401, 'invalid-code');
      return;
    }
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const session = options.sessions.create({
      id: newId('ses'),
      tokenHash: hashSecret(token),
      deviceName: parsed.data.deviceName,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REMOTE_SESSION_TTL_MS).toISOString(),
    });
    const result: PairClaimResult = { session: toView(session, options.sockets.connectedSessionIds()) };
    writeJson(request, response, 201, result, {
      'set-cookie': sessionCookie(token, secure),
    });
  }

  function handleListSessions(request: IncomingMessage, response: ServerResponse): void {
    if (!options.verifyToken(extractBearer(request))) {
      writeError(request, response, 401, 'unauthorized');
      return;
    }
    const connected = options.sockets.connectedSessionIds();
    const result = RemoteSessionListSchema.parse({
      sessions: options.sessions.list().map((session) => toView(session, connected)),
    });
    writeJson(request, response, 200, result);
  }

  async function handleRevokeSessions(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!options.verifyToken(extractBearer(request))) {
      writeError(request, response, 401, 'unauthorized');
      return;
    }
    const body = await readJsonBody(request, PAIRING_BODY_LIMIT);
    if (!body.ok) {
      writeError(request, response, body.status, 'bad-request');
      return;
    }
    const parsed = RevokeSessionsRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      writeError(request, response, 400, 'bad-request');
      return;
    }
    const now = new Date().toISOString();
    const revoked =
      parsed.data.all === true
        ? options.sessions.revokeAll(now)
        : parsed.data.id === undefined
          ? 0
          : options.sessions.revoke(parsed.data.id, now)
            ? 1
            : 0;
    // The row is the record; the socket is the access. Revoke is the only kill switch
    // the user has, so it closes the connection in the same request.
    if (parsed.data.all === true) options.sockets.disconnectAllRemote();
    else if (parsed.data.id !== undefined) options.sockets.disconnectSession(parsed.data.id);
    writeJson(request, response, 200, { revoked });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const remote = getRemote();
    if (!remote.enabled && !isLoopbackAddress(request.socket.remoteAddress)) {
      writeError(request, response, 403, 'forbidden');
      return;
    }
    if (!isAllowedHost(request.headers.host, remote)) {
      writeError(request, response, 403, 'forbidden');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = request.method ?? 'GET';

    if (
      method === 'OPTIONS' &&
      (url.pathname === '/pair/create' || url.pathname.startsWith('/remote/sessions'))
    ) {
      response.writeHead(204, {
        ...securityHeaders(buildContentSecurityPolicy(originOf(request))),
        ...corsHeaders(request),
      });
      response.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/bootstrap') {
      handleBootstrap(request, response);
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      const body: HealthBody = {
        ok: true,
        version: options.version,
        pid: process.pid,
        uptimeMs: Date.now() - options.startedAt,
      };
      writeJson(request, response, 200, body);
      return;
    }
    if (method === 'POST' && url.pathname === '/pair/create') {
      await handlePairCreate(request, response);
      return;
    }
    if (method === 'POST' && url.pathname === '/pair/claim') {
      await handlePairClaim(request, response);
      return;
    }
    if (method === 'GET' && url.pathname === '/remote/sessions') {
      handleListSessions(request, response);
      return;
    }
    if (method === 'POST' && url.pathname === '/remote/sessions/revoke') {
      await handleRevokeSessions(request, response);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      writeError(request, response, 404, 'not-found');
      return;
    }
    if (webRoot === undefined) {
      writeError(request, response, 404, 'not-found');
      return;
    }
    let file: StaticFile | undefined;
    try {
      file = staticFile(webRoot, url.pathname);
    } catch {
      writeError(request, response, 400, 'bad-request');
      return;
    }
    if (file !== undefined) {
      const isHtml = file.contentType.startsWith('text/html');
      if (isHtml) serveIndex(request, response, webRoot);
      else serveFile(request, response, file, 'public, max-age=3600');
      return;
    }
    // SPA fallback: extensionless paths are client routes, so they get the shell.
    if (!hasExtension(url.pathname)) {
      serveIndex(request, response, webRoot);
      return;
    }
    writeError(request, response, 404, 'not-found');
  }

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) writeError(request, response, 500, 'internal');
      else response.destroy();
    });
  });
}

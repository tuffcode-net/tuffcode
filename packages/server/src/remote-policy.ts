import type { PermissionMode, RemoteSettings, Settings } from '@tuffcode/contracts';

/**
 * Which principal opened a socket. The desktop renderer presents the bearer token from
 * `~/.tuffcode/token`; a paired phone presents only its session cookie. The bearer token
 * is the owner of the machine, the cookie is a guest, so the two get different authority.
 */
export type RemotePrincipal = 'desktop' | 'remote';

/**
 * Methods a paired device may call. Allowlist, default deny: a method added to the
 * registry later is closed to remote sessions until someone lists it here on purpose.
 *
 * What a phone needs to drive a turn: read threads and their transcripts, create a
 * thread, send, stream, stop, answer approvals and subagent questions, and read the
 * catalogs the composer needs. Everything that changes the machine's configuration,
 * reaches a shell, reads arbitrary files or moves git is desktop only.
 */
export const REMOTE_ALLOWED_METHODS: Readonly<Record<string, true>> = {
  'app.health': true,
  'checkpoints.list': true,
  'commands.list': true,
  'comments.add': true,
  'comments.list': true,
  'comments.resolve': true,
  'council.latest': true,
  'council.status': true,
  'diff.get': true,
  'memory.search': true,
  'messages.list': true,
  'models.list': true,
  'projects.list': true,
  'providers.list': true,
  'settings.get': true,
  'skills.list': true,
  'subagents.answer': true,
  'subagents.cancel': true,
  'subagents.get': true,
  'subagents.list': true,
  'subagents.listAll': true,
  'subagents.message': true,
  'subagents.messages': true,
  'subagents.questions': true,
  'threads.approve': true,
  'threads.context': true,
  'threads.create': true,
  'threads.dashboard': true,
  'threads.events': true,
  'threads.get': true,
  'threads.interrupt': true,
  'threads.list': true,
  'threads.search': true,
  'threads.send': true,
  'threads.update': true,
  'todos.get': true,
};

/**
 * Server events a paired device may receive. `terminal.data` carries a shell stream and
 * `provider.login.*` carries provider sign-in output, so both stay on the desktop.
 */
export const REMOTE_ALLOWED_EVENTS: Readonly<Record<string, true>> = {
  'approval.requested': true,
  'commands.updated': true,
  'context.updated': true,
  'council.updated': true,
  'providers.updated': true,
  'server.warning': true,
  'settings.updated': true,
  'skills.updated': true,
  'subagent.answered': true,
  'subagent.event': true,
  'subagent.finished': true,
  'subagent.message': true,
  'subagent.question': true,
  'subagent.started': true,
  'subagent.telemetry': true,
  'thread.event': true,
  'thread.updated': true,
  'todo.updated': true,
};

export interface PolicyDenial {
  readonly code: 'permission-denied';
  readonly message: string;
}

/** Ranked so a remote thread can never start wider than the desktop default. */
const PERMISSION_RANK: Readonly<Record<PermissionMode, number>> = {
  'read-only': 0,
  ask: 1,
  'accept-edits': 2,
  'full-auto': 3,
};

export function isRemoteMethodAllowed(method: string): boolean {
  return Object.hasOwn(REMOTE_ALLOWED_METHODS, method);
}

export function isRemoteEventAllowed(type: string): boolean {
  return Object.hasOwn(REMOTE_ALLOWED_EVENTS, type);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && value in PERMISSION_RANK;
}

/**
 * Per method parameter guards for the methods a phone may call. A method can be safe to
 * call and still carry a field that escalates: `threads.update` can rewrite the
 * permission mode, and `threads.create` can start a thread in full auto.
 */
export function remoteRequestViolation(
  method: string,
  params: unknown,
  settings: Pick<Settings, 'defaultPermissionMode'>,
): PolicyDenial | undefined {
  const record = asRecord(params);
  if (record === undefined) return undefined;

  if (method === 'threads.update') {
    if (record['permissionMode'] !== undefined) {
      return {
        code: 'permission-denied',
        message: 'a paired device cannot change a thread permission mode',
      };
    }
    if (record['executionMode'] === 'council') {
      return {
        code: 'permission-denied',
        message: 'a paired device cannot move a thread into council mode',
      };
    }
    return undefined;
  }

  if (method === 'threads.create') {
    if (record['executionMode'] === 'council') {
      return {
        code: 'permission-denied',
        message: 'a paired device cannot start a council goal',
      };
    }
    const requested = record['permissionMode'];
    if (!isPermissionMode(requested)) return undefined;
    if (PERMISSION_RANK[requested] > PERMISSION_RANK[settings.defaultPermissionMode]) {
      return {
        code: 'permission-denied',
        message:
          'a paired device cannot start a thread with more permission than the desktop default',
      };
    }
  }
  return undefined;
}

/**
 * True when a request over this connection may carry the session cookie. A plain HTTP
 * request that did not arrive over loopback is readable by anyone on the network, so the
 * cookie is only handed out there when the user has explicitly allowed it.
 */
export function remoteTransportAllowsCookie(
  loopbackPeer: boolean,
  secure: boolean,
  remote: RemoteSettings,
): boolean {
  return secure || loopbackPeer || remote.allowInsecureLan;
}

export interface PairingLinkResult {
  readonly url?: string;
  readonly error?: { code: string; message: string };
}

/**
 * The link a phone opens. A loopback URL is useless to a phone, so the link comes from
 * the configured public address or from a concrete bound address, and the request is
 * refused with a message when neither exists.
 */
export function resolvePairingBase(
  remote: RemoteSettings,
  requestOrigin: string | undefined,
): PairingLinkResult {
  const publicUrl = remote.publicUrl.trim().replace(/\/+$/, '');
  if (publicUrl.length > 0) {
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { url: publicUrl };
      }
    } catch {
      // Fall through to the refusal below.
    }
    return {
      error: {
        code: 'invalid-public-url',
        message: 'the configured public address is not an http or https URL',
      },
    };
  }
  const bind = remote.bindHost.trim();
  const loopbackBind =
    bind.replace(/^\[|\]$/g, '').toLowerCase() === 'localhost' ||
    bind === '::1' ||
    bind.startsWith('127.');
  const concrete = bind.length > 0 && bind !== '0.0.0.0' && bind !== '::' && bind !== '[::]';
  if (concrete && !loopbackBind) {
    const host = bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind;
    return { url: `http://${host}:${remote.port}` };
  }
  if (requestOrigin !== undefined && requestOrigin.length > 0) {
    try {
      const parsed = new URL(requestOrigin);
      if (parsed.hostname !== 'localhost' && !parsed.hostname.startsWith('127.')) {
        return { url: requestOrigin.replace(/\/+$/, '') };
      }
    } catch {
      // Fall through to the refusal below.
    }
  }
  return {
    error: {
      code: 'no-public-url',
      message:
        'Set "Address phones use" to an address a phone can reach, or bind to a LAN or Tailscale address, before creating a pairing link',
    },
  };
}

/**
 * Rate limiter key for a source address. A single client usually owns a whole IPv6 /64,
 * so keying on the full address would hand it a fresh bucket per attempt. IPv4 and IPv6
 * are reduced to their network prefix.
 */
export function remoteAddressKey(address: string | undefined): string {
  if (address === undefined || address.length === 0) return 'unknown';
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (bare.includes('.')) {
    const parts = bare.split('.');
    if (parts.length === 4) return parts.slice(0, 3).join('.') + '.0/24';
    return bare;
  }
  const groups = bare.split(':').filter((group) => group.length > 0);
  if (groups.length < 3) return bare;
  return groups.slice(0, 4).join(':') + '::/64';
}

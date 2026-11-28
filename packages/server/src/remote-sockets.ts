import type { WebSocket } from 'ws';
import type { RemotePrincipal } from './remote-policy.js';

export interface RemoteSocketEntry {
  readonly client: WebSocket;
  readonly principal: RemotePrincipal;
  /** Set for a paired device, absent for the desktop bearer token. */
  readonly sessionId?: string;
  /** The raw session cookie, kept in memory so the sweep can re-resolve the row. */
  readonly sessionToken?: string;
}

export interface RemoteSockets {
  register(entry: RemoteSocketEntry): void;
  unregister(client: WebSocket): void;
  /** Session ids with an open socket right now, for the desktop device list. */
  connectedSessionIds(): ReadonlySet<string>;
  /** Closes every socket that belongs to one session. Returns how many it cut. */
  disconnectSession(sessionId: string): number;
  /** Closes every paired device socket, leaving desktop sockets alone. */
  disconnectAllRemote(): number;
  /** Paired device sockets, for the periodic expiry and rotation sweep. */
  remoteEntries(): readonly RemoteSocketEntry[];
}

/**
 * One registry shared by the loopback listener and the remote listener, so revoking a
 * device cuts its socket whichever listener it arrived on.
 */
export function createRemoteSockets(): RemoteSockets {
  const entries = new Map<WebSocket, RemoteSocketEntry>();

  function terminate(predicate: (entry: RemoteSocketEntry) => boolean): number {
    let cut = 0;
    for (const [client, entry] of entries) {
      if (!predicate(entry)) continue;
      entries.delete(client);
      client.terminate();
      cut += 1;
    }
    return cut;
  }

  return {
    register: (entry) => {
      entries.set(entry.client, entry);
    },
    unregister: (client) => {
      entries.delete(client);
    },
    connectedSessionIds: () => {
      const ids = new Set<string>();
      for (const entry of entries.values()) {
        if (entry.sessionId !== undefined) ids.add(entry.sessionId);
      }
      return ids;
    },
    disconnectSession: (sessionId) => terminate((entry) => entry.sessionId === sessionId),
    disconnectAllRemote: () => terminate((entry) => entry.principal === 'remote'),
    remoteEntries: () =>
      [...entries.values()].filter((entry) => entry.principal === 'remote'),
  };
}

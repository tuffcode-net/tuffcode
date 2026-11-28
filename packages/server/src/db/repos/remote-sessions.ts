import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../index.js';
import { asRow, nullableText, text, type SqlRow } from '../rows.js';

export interface RemoteSessionRecord {
  id: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CreateRemoteSessionInput {
  id: string;
  /** SHA-256 of the cookie token. The token itself is never stored. */
  tokenHash: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
}

export interface RemoteSessionsRepo {
  create(input: CreateRemoteSessionInput): RemoteSessionRecord;
  /**
   * Resolves an active session by token hash and records the visit. Returns undefined
   * for an unknown, revoked or expired session, which the caller treats as signed out.
   */
  touch(tokenHash: string, now: string): RemoteSessionRecord | undefined;
  list(): RemoteSessionRecord[];
  revoke(id: string, now: string): boolean;
  revokeAll(now: string): number;
  deleteExpired(now: string): number;
  /**
   * Remembers the fingerprint of the current file token. A different fingerprint means
   * the token was rotated, so every paired device is revoked and `true` is returned.
   */
  syncTokenFingerprint(fingerprint: string, now: string): boolean;
  tokenFingerprint(): string | undefined;
}

const SESSION_COLUMNS = 'id, token_hash, device_name, created_at, last_seen_at, expires_at, revoked_at';
const FINGERPRINT_KEY = 'token_fingerprint';

function mapSession(row: SqlRow): RemoteSessionRecord {
  return {
    id: text(row, 'id'),
    deviceName: text(row, 'device_name'),
    createdAt: text(row, 'created_at'),
    lastSeenAt: text(row, 'last_seen_at'),
    expiresAt: text(row, 'expires_at'),
    revokedAt: nullableText(row, 'revoked_at'),
  };
}

/**
 * Paired devices live in their own table. Reads filter on both `revoked_at` and
 * `expires_at`, so a stale row can never authenticate even before it is pruned.
 */
export function createRemoteSessionsRepo(db: DatabaseSync): RemoteSessionsRepo {
  const insert = db.prepare(
    'INSERT INTO remote_sessions (id, token_hash, device_name, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  );
  const selectOne = db.prepare(`SELECT ${SESSION_COLUMNS} FROM remote_sessions WHERE id = ?`);
  const selectByHash = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM remote_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  );
  const selectAll = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM remote_sessions ORDER BY created_at DESC, rowid DESC`,
  );
  const touchRow = db.prepare('UPDATE remote_sessions SET last_seen_at = ? WHERE id = ?');
  const revokeRow = db.prepare(
    'UPDATE remote_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  );
  const revokeAllRows = db.prepare(
    'UPDATE remote_sessions SET revoked_at = ? WHERE revoked_at IS NULL',
  );
  const deleteExpiredRows = db.prepare('DELETE FROM remote_sessions WHERE expires_at <= ?');
  const selectFingerprint = db.prepare('SELECT value FROM remote_state WHERE key = ?');
  const upsertFingerprint = db.prepare(
    'INSERT INTO remote_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  return {
    create: (input) => {
      insert.run(
        input.id,
        input.tokenHash,
        input.deviceName,
        input.createdAt,
        input.createdAt,
        input.expiresAt,
      );
      const row = selectOne.get(input.id);
      if (row === undefined) throw new Error('remote session insert did not persist');
      return mapSession(asRow(row));
    },
    touch: (tokenHash, now) => {
      const raw = selectByHash.get(tokenHash, now);
      if (raw === undefined) return undefined;
      const session = mapSession(asRow(raw));
      touchRow.run(now, session.id);
      return { ...session, lastSeenAt: now };
    },
    list: () => selectAll.all().map((raw) => mapSession(asRow(raw))),
    revoke: (id, now) => {
      const result = revokeRow.run(now, id);
      return Number(result.changes) > 0;
    },
    revokeAll: (now) => {
      const result = revokeAllRows.run(now);
      return Number(result.changes);
    },
    deleteExpired: (now) => {
      const result = deleteExpiredRows.run(now);
      return Number(result.changes);
    },
    syncTokenFingerprint: (fingerprint, now) => {
      return transaction(db, () => {
        const raw = selectFingerprint.get(FINGERPRINT_KEY);
        const previous = raw === undefined ? undefined : text(asRow(raw), 'value');
        if (previous === fingerprint) return false;
        if (previous !== undefined) revokeAllRows.run(now);
        upsertFingerprint.run(FINGERPRINT_KEY, fingerprint);
        return previous !== undefined;
      });
    },
    tokenFingerprint: () => {
      const raw = selectFingerprint.get(FINGERPRINT_KEY);
      return raw === undefined ? undefined : text(asRow(raw), 'value');
    },
  };
}

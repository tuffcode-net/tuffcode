import { statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PAIRING_CODE_TTL_MS, REMOTE_SESSION_TTL_MS } from '@tuffcode/contracts';
import { tokenPath } from '@tuffcode/shared';
import {
  createPairingStore,
  createSessionAuth,
  ensureToken,
  hashSecret,
  pairingCodeKey,
  readCookie,
  verifyToken,
} from './auth.js';
import { createTempEnv, createTestContext, type TempEnv } from './test-support.js';

describe('auth token', () => {
  let env: TempEnv | undefined;

  afterEach(() => {
    env?.dispose();
    env = undefined;
  });

  it('creates a 32 byte hex token once and reuses it', () => {
    env = createTempEnv();
    const first = ensureToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken()).toBe(first);
    const file = tokenPath();
    expect(statSync(file).size).toBe(64);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('accepts only the exact token', () => {
    env = createTempEnv();
    const token = ensureToken();
    expect(verifyToken(token)).toBe(true);
    expect(verifyToken(`${token}0`)).toBe(false);
    expect(verifyToken(token.slice(0, -1))).toBe(false);
    expect(verifyToken('')).toBe(false);
    expect(verifyToken(undefined)).toBe(false);
    expect(verifyToken(null)).toBe(false);
  });

  it('reads the token file on every check', () => {
    env = createTempEnv();
    ensureToken();
    writeFileSync(tokenPath(), 'abc123', 'utf8');
    expect(verifyToken('abc123')).toBe(true);
    expect(verifyToken('abc124')).toBe(false);
    expect(verifyToken('abc1234')).toBe(false);
  });
});

describe('remote auth primitives', () => {
  let env: TempEnv | undefined;
  let ctx: ReturnType<typeof createTestContext> | undefined;

  afterEach(() => {
    ctx?.dispose();
    ctx = undefined;
    env?.dispose();
    env = undefined;
  });

  function context(): ReturnType<typeof createTestContext> {
    ctx = createTestContext();
    env = ctx.env;
    return ctx;
  }

  it('hashes secrets deterministically and reads one cookie', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
    expect(hashSecret('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'));
    expect(readCookie('a=1; tuffcode_session=deadbeef; b=2', 'tuffcode_session')).toBe('deadbeef');
    expect(readCookie('a=1', 'tuffcode_session')).toBeUndefined();
    expect(readCookie(undefined, 'tuffcode_session')).toBeUndefined();
  });

  it('issues a single-use pairing code that expires', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = createPairingStore({ now: () => now });
    const issued = store.issue();
    expect(issued.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(issued.expiresAt).toBe(new Date(now + PAIRING_CODE_TTL_MS).toISOString());
    expect(store.pending()).toBe(1);

    expect(store.consume('AAAAAAAA')).toBe(false);
    expect(store.consume(issued.code.toLowerCase())).toBe(true);
    expect(store.consume(issued.code)).toBe(false);
    expect(store.pending()).toBe(0);

    const expired = store.issue();
    now += PAIRING_CODE_TTL_MS + 1;
    expect(store.consume(expired.code)).toBe(false);
    expect(store.pending()).toBe(0);
  });

  it('keys stored pairing codes with the store secret', () => {
    const code = 'ABCD2345';
    const keyed = pairingCodeKey(code, 'server-secret');
    expect(keyed).toMatch(/^[0-9a-f]{64}$/);
    // A heap dump of the map cannot be turned back into a live code by hashing the
    // 40 bit space, because the stored value is keyed and the bare hash is not it.
    expect(keyed).not.toBe(hashSecret(code));
    expect(keyed).not.toBe(hashSecret(code.toLowerCase()));
    expect(pairingCodeKey(code, 'other-secret')).not.toBe(keyed);
    expect(pairingCodeKey(' abcd2345 ', 'server-secret')).toBe(keyed);

    // The store still round-trips its own codes and refuses everything else.
    const store = createPairingStore({ secret: 'server-secret' });
    const issued = store.issue();
    expect(store.consume(issued.code)).toBe(true);
    expect(store.consume(issued.code)).toBe(false);
  });

  it('verifies a session, touches it, and refuses expired or revoked rows', () => {
    const { repos } = context();
    const token = ensureToken();
    const sessions = createSessionAuth(repos.remoteSessions);
    const now = new Date();
    const created = repos.remoteSessions.create({
      id: 'ses_1',
      tokenHash: hashSecret('cookie-token'),
      deviceName: 'Phone',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REMOTE_SESSION_TTL_MS).toISOString(),
    });
    expect(sessions.verify('cookie-token')?.id).toBe(created.id);
    expect(sessions.verify('wrong')).toBeUndefined();
    expect(sessions.verify(undefined)).toBeUndefined();

    repos.remoteSessions.create({
      id: 'ses_expired',
      tokenHash: hashSecret('expired-token'),
      deviceName: 'Old phone',
      createdAt: new Date(now.getTime() - REMOTE_SESSION_TTL_MS * 2).toISOString(),
      expiresAt: new Date(now.getTime() - 1000).toISOString(),
    });
    expect(sessions.verify('expired-token')).toBeUndefined();

    expect(repos.remoteSessions.revoke(created.id, new Date().toISOString())).toBe(true);
    expect(sessions.verify('cookie-token')).toBeUndefined();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('revokes every session when the file token rotates', () => {
    const { repos } = context();
    ensureToken();
    const sessions = createSessionAuth(repos.remoteSessions);
    const now = new Date();
    for (const [id, token] of [
      ['ses_a', 'token-a'],
      ['ses_b', 'token-b'],
    ] as const) {
      repos.remoteSessions.create({
        id,
        tokenHash: hashSecret(token),
        deviceName: id,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + REMOTE_SESSION_TTL_MS).toISOString(),
      });
    }
    expect(sessions.verify('token-a')?.id).toBe('ses_a');

    writeFileSync(tokenPath(), 'e'.repeat(64), 'utf8');
    expect(sessions.verify('token-a')).toBeUndefined();
    expect(sessions.verify('token-b')).toBeUndefined();
    expect(repos.remoteSessions.list().every((row) => row.revokedAt !== null)).toBe(true);
  });
});

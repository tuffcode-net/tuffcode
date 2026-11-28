import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
} from '@tuffcode/contracts';
import { tokenPath } from '@tuffcode/shared';
import type { RemoteSessionRecord, RemoteSessionsRepo } from './db/repos/remote-sessions.js';

/**
 * Reads the bearer token from `tokenPath()`, creating a 32 byte random token with
 * mode 0600 when the file is missing or empty. The file is the single source of
 * truth, so the server and the renderer bootstrap never disagree.
 */
export function ensureToken(): string {
  const file = tokenPath();
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    // Missing file: create one below.
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX mode bits; the ACL inherits from the user profile.
  }
  return token;
}

/**
 * Constant-time comparison against the token file. A length mismatch returns false
 * before `timingSafeEqual`, which throws on unequal buffer lengths.
 */
export function verifyToken(candidate: string | undefined | null): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  let expected: string;
  try {
    expected = readFileSync(tokenPath(), 'utf8').trim();
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const provided = Buffer.from(candidate, 'utf8');
  const stored = Buffer.from(expected, 'utf8');
  if (provided.length !== stored.length) return false;
  return timingSafeEqual(provided, stored);
}

/** SHA-256 hex of a secret. Sessions and pairing codes are stored only in this form. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Stored form of a pairing code: an HMAC under the store secret, so the map never
 * holds anything that can be reversed to a live code without the secret. Exported so
 * the keying is testable without exposing the map.
 */
export function pairingCodeKey(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code.trim().toUpperCase(), 'utf8').digest('hex');
}

/** Fingerprint of the current bearer token, or undefined when the file is missing. */
export function currentTokenFingerprint(): string | undefined {
  try {
    const token = readFileSync(tokenPath(), 'utf8').trim();
    return token.length === 0 ? undefined : hashSecret(token);
  } catch {
    return undefined;
  }
}

export interface IssuedPairingCode {
  code: string;
  expiresAt: string;
}

export interface PairingStore {
  /** Issues one code and forgets it after `ttlMs`. Codes are held in memory only. */
  issue(): IssuedPairingCode;
  /**
   * Consumes a code. A wrong, expired or already used code returns false; a match is
   * deleted before returning true, so two claims can never share one code.
   */
  consume(code: string): boolean;
  pending(): number;
}

export interface PairingStoreOptions {
  ttlMs?: number;
  now?: () => number;
  /**
   * Key for the HMAC that protects stored pairing codes. Defaults to a fresh random
   * secret per process, which is enough because codes never outlive the process.
   */
  secret?: string;
}

/**
 * One-time pairing codes. The map holds an HMAC of each code under a per-process
 * secret, so a heap dump or a debugger does not hand out a live code without also
 * recovering the secret. Nothing survives a restart, which is the point.
 */
export function createPairingStore(options: PairingStoreOptions = {}): PairingStore {
  const ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
  const now = options.now ?? Date.now;
  const secret = options.secret ?? randomBytes(32).toString('hex');
  const keyOf = (code: string): string => pairingCodeKey(code, secret);
  const codes = new Map<string, number>();

  function prune(at: number): void {
    for (const [hash, expiresAt] of codes) {
      if (expiresAt <= at) codes.delete(hash);
    }
  }

  function generate(): string {
    const bytes = randomBytes(PAIRING_CODE_LENGTH);
    let code = '';
    for (const byte of bytes) {
      code += PAIRING_CODE_ALPHABET.charAt(byte % PAIRING_CODE_ALPHABET.length);
    }
    return code;
  }

  return {
    issue: () => {
      const at = now();
      prune(at);
      let code = generate();
      // A collision is vanishingly rare, but a duplicate would silently replace a code.
      while (codes.has(keyOf(code))) code = generate();
      const expiresAt = at + ttlMs;
      codes.set(keyOf(code), expiresAt);
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    },
    consume: (code) => {
      const at = now();
      prune(at);
      const hash = keyOf(code);
      const expiresAt = codes.get(hash);
      if (expiresAt === undefined) return false;
      codes.delete(hash);
      return expiresAt > at;
    },
    pending: () => {
      prune(now());
      return codes.size;
    },
  };
}

export interface SessionAuth {
  /**
   * Resolves a cookie token to an active session. A rotated bearer token revokes every
   * session before the lookup, so a paired device cannot outlive the token file.
   */
  verify(presented: string | undefined | null): RemoteSessionRecord | undefined;
}

export function createSessionAuth(sessions: RemoteSessionsRepo): SessionAuth {
  return {
    verify: (presented) => {
      if (typeof presented !== 'string' || presented.length === 0) return undefined;
      const fingerprint = currentTokenFingerprint();
      if (fingerprint === undefined) return undefined;
      const now = new Date().toISOString();
      sessions.syncTokenFingerprint(fingerprint, now);
      return sessions.touch(hashSecret(presented), now);
    },
  };
}

/**
 * Reads one cookie from a `Cookie` header. Values are not decoded: session tokens are
 * hex and pairing codes never travel as cookies.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

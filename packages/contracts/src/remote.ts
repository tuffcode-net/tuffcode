import { z } from 'zod';

/**
 * Remote access is off by default. Loopback stays the only reachable interface until
 * the user turns it on, and even then a browser has to pair once for a session cookie.
 */
export const RemoteSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Interface the HTTP and WS server bind to when remote access is enabled. */
  bindHost: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /**
   * Address a phone should open, for example `http://192.168.1.20:4310` or a
   * Tailscale `https://host.ts.net` URL. Empty means use the pairing request origin.
   */
  publicUrl: z.string(),
  /**
   * Extra browser origins allowed to open a WebSocket, for example
   * `http://192.168.1.20:4310`. Same-origin and loopback origins are always allowed.
   */
  allowedOrigins: z.string().array(),
  /**
   * Off by default. A plain HTTP request to a network address is readable by anyone on
   * that network, so the session cookie is only handed out there when the user has
   * explicitly accepted that. The normal path is an HTTPS public URL.
   */
  allowInsecureLan: z.boolean().default(false),
});
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = {
  enabled: false,
  bindHost: '127.0.0.1',
  port: 4310,
  publicUrl: '',
  allowedOrigins: [],
  allowInsecureLan: false,
};

/** Name of the cookie that carries a paired device session. */
export const REMOTE_SESSION_COOKIE = 'tuffcode_session';

/** A pairing code is short lived because it is read off a screen or a QR image. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** A paired device that goes unused for this long has to pair again. */
export const REMOTE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Unambiguous uppercase alphabet, so a code read off a screen has no O/0 or I/1 mixups. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;

export const PairingCodeSchema = z
  .string()
  .trim()
  .transform((code) => code.toUpperCase())
  .pipe(
    z
      .string()
      .regex(
        new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`),
        'pairing code has the wrong shape',
      ),
  );

export const PairCreateResultSchema = z.object({
  code: z.string(),
  /** Absolute URL a phone opens to claim the code. */
  url: z.string(),
  expiresAt: z.string(),
});
export type PairCreateResult = z.infer<typeof PairCreateResultSchema>;

export const PairClaimRequestSchema = z.object({
  code: PairingCodeSchema,
  deviceName: z.string().trim().min(1).max(120),
});
export type PairClaimRequest = z.infer<typeof PairClaimRequestSchema>;

export const RemoteSessionViewSchema = z.object({
  id: z.string(),
  deviceName: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  /** True while this device holds an open socket right now. */
  connected: z.boolean(),
});
export type RemoteSessionView = z.infer<typeof RemoteSessionViewSchema>;

export const PairClaimResultSchema = z.object({ session: RemoteSessionViewSchema });
export type PairClaimResult = z.infer<typeof PairClaimResultSchema>;

export const RemoteSessionListSchema = z.object({ sessions: RemoteSessionViewSchema.array() });
export type RemoteSessionList = z.infer<typeof RemoteSessionListSchema>;

/** Revoke one session by id, or every session with `all: true`. */
export const RevokeSessionsRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => value.all === true || value.id !== undefined, {
    message: 'pass an id or all: true',
  });
export type RevokeSessionsRequest = z.infer<typeof RevokeSessionsRequestSchema>;

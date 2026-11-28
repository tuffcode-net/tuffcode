import type { Logger } from '@tuffcode/shared';
import type { SecretStore } from './secrets';

export interface BootstrapInfo {
  port: number;
  token: string;
  version: string;
  platform: string;
  home: string;
}

export type Theme = 'dark' | 'light' | 'system';

export type UpdateStatus = 'available' | 'current' | 'unavailable' | 'error';

/** Result of one update check requested from the renderer. */
export interface UpdateCheckOutcome {
  status: UpdateStatus;
  version: string | null;
  detail: string;
  checkedAt: string;
}

/** A desktop notification; `route` is where a click takes the window. */
export interface NotifyRequest {
  title: string;
  body: string;
  route?: string;
  silent?: boolean;
}

/** The options one notification is constructed with. */
export interface NotificationShowOptions {
  title: string;
  body: string;
  silent: boolean;
}

/** The Electron surface needed to deliver one notification; faked in tests. */
export interface NotificationDelivery {
  isSupported(): boolean;
  /** Constructs the notification, wires its click to `route`, and shows it. */
  show(options: NotificationShowOptions, route: string | undefined): void;
}

/**
 * What actually happened to a test notification. `shown` means the notification was
 * constructed and `show()` returned; it does not mean a banner became visible,
 * because Windows Focus Assist and quiet hours can still suppress it.
 */
export interface NotifyTestResult {
  supported: boolean;
  shown: boolean;
  error?: string;
}

export interface PickFileRequest {
  title?: string;
  /** Extensions without the dot, for example ['zip', 'skill', 'md']. */
  extensions: string[];
}

/** The only surface exposed to the renderer through the preload bridge (spec section 10). */
export interface TuffcodeBridge {
  getBootstrap(): Promise<BootstrapInfo>;
  pickFolder(): Promise<string | null>;
  pickFile(request: PickFileRequest): Promise<string | null>;
  /** The filesystem path behind a picked or dropped File; Electron 32 removed `File.path`. */
  getPathForFile(file: File): string;
  onMenuAction(callback: (action: string) => void): () => void;
  setTheme(theme: Theme): void;
  checkForUpdates(): Promise<UpdateCheckOutcome>;
  notify(request: NotifyRequest): void;
  notifyTest(request: NotifyRequest): Promise<NotifyTestResult>;
  setKeepAwake(on: boolean): void;
  openExternal(url: string): void;
}

export const BOOTSTRAP_CHANNEL = 'bootstrap:get';
export const CHECK_UPDATES_CHANNEL = 'updates:check';
export const PICK_FOLDER_CHANNEL = 'dialog:pick-folder';
export const MENU_ACTION_CHANNEL = 'menu:action';
export const SET_THEME_CHANNEL = 'theme:set';
export const NOTIFY_CHANNEL = 'notify:show';
export const NOTIFY_TEST_CHANNEL = 'notify:test';
export const KEEP_AWAKE_CHANNEL = 'power:keep-awake';
export const OPEN_EXTERNAL_CHANNEL = 'shell:open-external';
export const PICK_FILE_CHANNEL = 'dialog:pick-file';

/** Menu action prefix for a notification click: the renderer navigates to the rest. */
export const NAVIGATE_ACTION_PREFIX = 'navigate:';

const ROUTE = /^\/[A-Za-z0-9/_{}$.-]{0,300}$/;

/** The renderer clips to these; anything longer is malformed and dropped. */
const TITLE_LIMIT = 120;
const BODY_LIMIT = 400;

/** Validates what the renderer asked to show; anything malformed is dropped. */
export function parseNotifyRequest(value: unknown): NotifyRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
  const body = typeof record['body'] === 'string' ? record['body'].trim() : '';
  if (title.length === 0 || title.length > TITLE_LIMIT || body.length > BODY_LIMIT) return null;
  const route =
    typeof record['route'] === 'string' && ROUTE.test(record['route'])
      ? record['route']
      : undefined;
  return {
    title,
    body,
    ...(route === undefined ? {} : { route }),
    silent: record['silent'] === true,
  };
}

/**
 * Delivers one already-validated notification and reports what happened. The click
 * route is forwarded untouched; only `parseNotifyRequest` may produce one.
 */
export function deliverNotification(
  request: NotifyRequest,
  delivery: NotificationDelivery,
): NotifyTestResult {
  if (!delivery.isSupported()) return { supported: false, shown: false };
  try {
    delivery.show(
      { title: request.title, body: request.body, silent: request.silent === true },
      request.route,
    );
    return { supported: true, shown: true };
  } catch (error) {
    return {
      supported: true,
      shown: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Only web links leave the app; file:, javascript: and custom schemes are refused. */
export function isExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function parsePickFileRequest(value: unknown): PickFileRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const raw = Array.isArray(record['extensions']) ? record['extensions'] : [];
  const extensions = raw
    .filter((entry): entry is string => typeof entry === 'string' && /^[A-Za-z0-9]{1,10}$/.test(entry))
    .slice(0, 10);
  if (extensions.length === 0) return null;
  const title = typeof record['title'] === 'string' ? record['title'].slice(0, 80) : undefined;
  return { extensions, ...(title === undefined ? {} : { title }) };
}

export const THEMES: readonly Theme[] = ['dark', 'light', 'system'];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Requests the server sends over the utilityProcess message port (D12). */
export interface SecretGetRequest {
  id: string;
  type: 'secret.get';
  key: string;
}

export interface SecretSetRequest {
  id: string;
  type: 'secret.set';
  key: string;
  value: string;
}

export type SecretRequest = SecretGetRequest | SecretSetRequest;

/** Replies main sends back to the server. A set reply never carries the value. */
export type SecretReply =
  | { id: string; ok: true; value?: string }
  | { id: string; ok: false; error: string };

export interface SecretBridgeChild {
  postMessage(message: unknown): void;
}

export interface SecretBridgeHost extends SecretBridgeChild {
  on(event: 'message', listener: (message: unknown) => void): void;
}

export type SecretBridgeLogger = Pick<Logger, 'warn'>;

const UNAVAILABLE_ERROR = 'OS encryption is unavailable, so Tuffcode cannot read or store secrets.';
const UNKNOWN_TYPE_ERROR = 'Unknown secret message type.';
const MISSING_KEY_ERROR = 'The secret request is missing its key.';
const MISSING_VALUE_ERROR = 'The secret request is missing its value.';
const GET_FAILED_ERROR = 'The secret could not be read.';
const SET_FAILED_ERROR = 'The secret could not be stored.';

function readId(message: unknown): string | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const { id } = message as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function unavailableReply(
  id: string,
  secretStore: SecretStore,
  logger: SecretBridgeLogger | undefined,
): SecretReply | null {
  let available: boolean;
  try {
    available = secretStore.available();
  } catch {
    available = false;
  }
  if (available) return null;
  logger?.warn('refused a secret request because OS encryption is unavailable', { id });
  return { id, ok: false, error: UNAVAILABLE_ERROR };
}

function resolveRequest(
  id: string,
  message: Record<string, unknown>,
  secretStore: SecretStore,
  logger: SecretBridgeLogger | undefined,
): SecretReply {
  const { type } = message;

  if (type === 'secret.get') {
    const { key } = message;
    if (typeof key !== 'string' || key.length === 0) {
      return { id, ok: false, error: MISSING_KEY_ERROR };
    }

    const unavailable = unavailableReply(id, secretStore, logger);
    if (unavailable !== null) return unavailable;

    try {
      const value = secretStore.get(key);
      return value === undefined ? { id, ok: true } : { id, ok: true, value };
    } catch (error) {
      logger?.warn('secret read failed', { id, error: errorName(error) });
      return { id, ok: false, error: GET_FAILED_ERROR };
    }
  }

  if (type === 'secret.set') {
    const { key, value } = message;
    if (typeof key !== 'string' || key.length === 0) {
      return { id, ok: false, error: MISSING_KEY_ERROR };
    }
    if (typeof value !== 'string') return { id, ok: false, error: MISSING_VALUE_ERROR };

    const unavailable = unavailableReply(id, secretStore, logger);
    if (unavailable !== null) return unavailable;

    try {
      secretStore.set(key, value);
      return { id, ok: true };
    } catch (error) {
      logger?.warn('secret write failed', { id, error: errorName(error) });
      return { id, ok: false, error: SET_FAILED_ERROR };
    }
  }

  logger?.warn('rejected an unknown secret message type', { id });
  return { id, ok: false, error: UNKNOWN_TYPE_ERROR };
}

/**
 * Handles one message from the server's utilityProcess. Only `secret.get` and `secret.set`
 * are accepted; everything else is answered with `ok: false`. Values are never logged and
 * never echoed back, and no reply is sent for a message that has no usable id.
 */
export function handleChildMessage(
  child: SecretBridgeChild,
  message: unknown,
  secretStore: SecretStore,
  logger?: SecretBridgeLogger,
): SecretReply | null {
  const id = readId(message);
  if (id === null) {
    logger?.warn('ignored a secret message without a usable id');
    return null;
  }

  const reply = resolveRequest(id, message as Record<string, unknown>, secretStore, logger);
  try {
    // Electron's utilityProcess message port has no targetOrigin; the rule targets window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    child.postMessage(reply);
  } catch (error) {
    logger?.warn('could not reply to the server secret request', { id, error: errorName(error) });
  }
  return reply;
}

/** Routes messages from the spawned server process to the secret bridge. */
export function attachSecretBridge(
  host: SecretBridgeHost,
  secretStore: SecretStore,
  logger?: SecretBridgeLogger,
): void {
  host.on('message', (message) => {
    handleChildMessage(host, message, secretStore, logger);
  });
}

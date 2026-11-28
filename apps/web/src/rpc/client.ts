/* oxlint-disable unicorn/prefer-add-event-listener -- handler properties are cleared on close so late events cannot fire */
import {
  ClientRequestSchema,
  RpcErrorSchema,
  ServerEventSchema,
  ServerResponseSchema,
  methods,
  type RpcErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type InstalledPlugin,
  type ServerEvent,
  type ThreadEventRow,
  type TodoPhase,
} from '@tuffcode/contracts';
import {
  useAppStore,
  type SubagentAnsweredInput,
  type SubagentEventInput,
  type SubagentFinishedInput,
  type SubagentMessageInput,
  type SubagentQuestionInput,
  type SubagentStartedInput,
  type SubagentTelemetryInput,
} from '../store/app-store';
import type { ConnectionStatus } from '../types';

export const REQUEST_TIMEOUT_MS = 30_000;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
/**
 * A socket can stay "open" after the network is gone: the browser only notices on the
 * next write, and an idle phone writes nothing. A health probe every interval, and a
 * reset when one goes unanswered for a full interval, makes the loss visible.
 */
export const HEARTBEAT_MS = 8_000;
export const RECONNECT_JITTER_RATIO = 0.2;
/** Upper bound on `threads.events` pages one replay drains, so a bug cannot spin. */
export const REPLAY_MAX_PAGES = 200;

export function reconnectDelay(attempt: number, jitter: number): number {
  const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  const boundedJitter = Math.min(1, Math.max(0, jitter));
  const jittered = exponential + boundedJitter * exponential * RECONNECT_JITTER_RATIO;
  return Math.min(RECONNECT_MAX_MS, Math.round(jittered));
}

export class RpcRequestError extends Error {
  readonly code: RpcErrorCode;
  readonly details: unknown;

  constructor(code: RpcErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'RpcRequestError';
    this.code = code;
    this.details = details;
  }
}

export interface RpcSocket {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RpcSocketFactory = (url: string, protocols: string[]) => RpcSocket;

export interface EventSink {
  getState(): {
    appendEvent(threadId: string, event: ThreadEventRow): void;
    subagentStarted(input: SubagentStartedInput): void;
    subagentEvent(input: SubagentEventInput): void;
    subagentFinished(input: SubagentFinishedInput): void;
    subagentTelemetry(input: SubagentTelemetryInput): void;
    subagentMessage(input: SubagentMessageInput): void;
    subagentQuestion(input: SubagentQuestionInput): void;
    subagentAnswered(input: SubagentAnsweredInput): void;
    setTodos(threadId: string, phases: TodoPhase[]): void;
    setPlugins(plugins: InstalledPlugin[]): void;
  };
}

export interface RpcClientOptions {
  url: string;
  /** Desktop bearer token. A browser omits it and authenticates the upgrade with
   * the session cookie the served origin set, so no subprotocol is requested. */
  token?: string;
  socketFactory?: RpcSocketFactory;
  requestTimeoutMs?: number;
  jitter?: () => number;
  store?: EventSink;
  logger?: Pick<Console, 'warn'>;
}

export interface RpcClient {
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  onEvent(callback: (event: ServerEvent) => void): () => void;
  onStatus(callback: (status: ConnectionStatus) => void): () => void;
  replay(threadId: string, sinceSeq?: number): Promise<{ hasMore: boolean }>;
  getStatus(): ConnectionStatus;
  close(): void;
}

interface PendingRequest {
  method: RpcMethod;
  frame: string;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: RpcRequestError): void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultSocketFactory: RpcSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as RpcSocket;

let nextRequestId = 1;

function createRequestId(): string {
  nextRequestId += 1;
  return `req-${Date.now().toString(36)}-${nextRequestId.toString(36)}`;
}

export function createRpcClient(options: RpcClientOptions): RpcClient {
  const {
    url,
    token,
    socketFactory = defaultSocketFactory,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    jitter = Math.random,
    store = useAppStore,
    logger = console,
  } = options;

  const protocols =
    token === undefined || token.length === 0 ? [] : [`tuffcode.bearer.${token}`];

  const eventListeners = new Set<(event: ServerEvent) => void>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const pending = new Map<string, PendingRequest>();

  let socket: RpcSocket | null = null;
  let status: ConnectionStatus = 'connecting';
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByUser = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;

  function emitStatus(next: ConnectionStatus): void {
    status = next;
    for (const listener of statusListeners) listener(next);
  }

  function signalProtocolError(message: string, frame: unknown): void {
    logger.warn(`[rpc] ${message}`, frame);
    emitStatus('protocol-error');
  }

  function sendPending(): void {
    if (!socket) return;
    for (const entry of pending.values()) {
      if (entry.sent) continue;
      entry.sent = true;
      socket.send(entry.frame);
    }
  }

  function settlePending(keepUnsent: boolean): void {
    for (const [id, entry] of pending) {
      if (keepUnsent && !entry.sent) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(
        new RpcRequestError(
          'internal',
          keepUnsent
            ? 'Connection closed before the server responded.'
            : 'The RPC client was closed.',
        ),
      );
    }
  }

  function scheduleReconnect(): void {
    if (closedByUser || reconnectTimer) return;
    const delay = reconnectDelay(attempt, jitter());
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleResponseFrame(frame: unknown): void {
    const response = ServerResponseSchema.safeParse(frame);
    if (!response.success) {
      signalProtocolError('Dropped an invalid response frame.', frame);
      return;
    }

    const entry = pending.get(response.data.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(response.data.id);

    if (!response.data.ok) {
      const error = RpcErrorSchema.safeParse(response.data.error);
      if (!error.success) {
        signalProtocolError('Dropped an invalid RPC error.', response.data.error);
        entry.reject(new RpcRequestError('internal', 'The server sent an invalid error.'));
        return;
      }
      entry.reject(new RpcRequestError(error.data.code, error.data.message, error.data.details));
      return;
    }

    const parsed = methods[entry.method].result.safeParse(response.data.result);
    if (!parsed.success) {
      signalProtocolError(`Dropped an invalid ${entry.method} result.`, response.data.result);
      entry.reject(
        new RpcRequestError('internal', `The server sent an invalid ${entry.method} result.`),
      );
      return;
    }

    entry.resolve(parsed.data);
  }

  /**
   * Subagent frames are routed into the store here, next to thread replay, so every
   * surface reads one child registry and a pane does not need its own subscription.
   */
  function routeEvent(event: ServerEvent): void {
    const state = store.getState();
    switch (event.type) {
      case 'subagent.started':
        state.subagentStarted(event.payload);
        break;
      case 'subagent.event':
        state.subagentEvent(event.payload);
        break;
      case 'subagent.finished':
        state.subagentFinished(event.payload);
        break;
      case 'subagent.telemetry':
        state.subagentTelemetry(event.payload);
        break;
      case 'subagent.message':
        state.subagentMessage(event.payload);
        break;
      case 'subagent.question':
        state.subagentQuestion(event.payload);
        break;
      case 'subagent.answered':
        state.subagentAnswered(event.payload);
        break;
      case 'todo.updated':
        state.setTodos(event.payload.threadId, event.payload.phases);
        break;
      case 'plugins.updated':
        state.setPlugins(event.payload);
        break;
      default:
        break;
    }
  }

  function handleEventFrame(frame: unknown): void {
    const event = ServerEventSchema.safeParse(frame);
    if (!event.success) {
      signalProtocolError('Dropped an invalid server event.', frame);
      return;
    }
    routeEvent(event.data);
    for (const listener of eventListeners) listener(event.data);
  }

  function handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      signalProtocolError('Dropped a non-text frame.', data);
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      signalProtocolError('Dropped a frame that was not JSON.', data);
      return;
    }

    if (typeof frame === 'object' && frame !== null && 'kind' in frame && frame.kind === 'event') {
      handleEventFrame(frame);
      return;
    }

    handleResponseFrame(frame);
  }

  function connect(): void {
    if (closedByUser) return;
    emitStatus('connecting');

    let next: RpcSocket;
    try {
      next = socketFactory(url, protocols);
    } catch (error) {
      logger.warn('[rpc] Could not create the WebSocket.', error);
      emitStatus('closed');
      scheduleReconnect();
      return;
    }

    socket = next;

    next.onopen = () => {
      attempt = 0;
      emitStatus('open');
      sendPending();
      startHeartbeat();
    };

    next.onmessage = (event) => {
      handleMessage(event.data);
    };

    next.onerror = (event) => {
      logger.warn('[rpc] WebSocket error.', event);
    };

    next.onclose = () => {
      stopHeartbeat();
      if (socket === next) socket = null;
      if (closedByUser) {
        emitStatus('closed');
        return;
      }
      settlePending(true);
      emitStatus('closed');
      scheduleReconnect();
    };
  }

  /**
   * Drops the current socket without waiting for its close event. Handlers are cleared
   * first so a late onclose cannot schedule a second reconnect, and pending requests are
   * rejected so their callers see the loss instead of a 30 second timeout.
   */
  function resetConnection(): void {
    if (closedByUser) return;
    stopHeartbeat();
    const current = socket;
    socket = null;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        current.close();
      } catch {
        // The socket was already gone.
      }
    }
    settlePending(true);
    emitStatus('closed');
    scheduleReconnect();
  }

  function stopHeartbeat(): void {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    heartbeatInFlight = false;
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (status !== 'open') return;
      if (heartbeatInFlight) {
        resetConnection();
        return;
      }
      heartbeatInFlight = true;
      // Only an answer clears the flag. A rejected or timed out probe means the socket
      // is silent, so the next tick resets it instead of sending another one.
      void request('app.health', {}).then(
        () => {
          heartbeatInFlight = false;
        },
        () => undefined,
      );
    }, HEARTBEAT_MS);
  }

  function request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const parsedParams = methods[method].params.safeParse(params);
    if (!parsedParams.success) {
      return Promise.reject(
        new RpcRequestError('bad-request', `Invalid params for ${method}.`, parsedParams.error),
      );
    }

    const id = createRequestId();
    const frame = ClientRequestSchema.parse({
      id,
      method,
      params: parsedParams.data,
    });

    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new RpcRequestError(
            'internal',
            `The ${method} request timed out after ${requestTimeoutMs} ms.`,
          ),
        );
      }, requestTimeoutMs);

      pending.set(id, {
        method,
        frame: JSON.stringify(frame),
        sent: false,
        resolve: (value) => resolve(value as RpcResult<M>),
        reject,
        timer,
      });

      if (status === 'open') sendPending();
    });
  }

  async function replay(threadId: string, sinceSeq = 0): Promise<{ hasMore: boolean }> {
    let cursor = sinceSeq;
    for (let page = 0; page < REPLAY_MAX_PAGES; page += 1) {
      const result = await request('threads.events', { id: threadId, sinceSeq: cursor });
      // An empty page means the server has nothing past the cursor; stop even if
      // it still reports more, so a server bug cannot spin this loop.
      if (result.events.length === 0) return { hasMore: false };
      for (const event of result.events) store.getState().appendEvent(threadId, event);
      const nextCursor = result.events[result.events.length - 1]?.seq ?? cursor;
      // A page that does not advance the cursor would be fetched forever.
      if (nextCursor <= cursor) return { hasMore: result.hasMore };
      cursor = nextCursor;
      if (!result.hasMore) return { hasMore: false };
    }
    return { hasMore: true };
  }

  function close(): void {
    closedByUser = true;
    stopHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    settlePending(false);
    const current = socket;
    socket = null;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close();
    }
    emitStatus('closed');
  }

  connect();

  return {
    request,
    onEvent: (callback) => {
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },
    onStatus: (callback) => {
      statusListeners.add(callback);
      return () => statusListeners.delete(callback);
    },
    replay,
    getStatus: () => status,
    close,
  };
}

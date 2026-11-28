import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  AdapterUnavailableError,
  type AdapterDeps,
  type AdapterEvent,
  type AdapterSession,
  type PermissionMode,
  type ProviderConfig,
  type TurnContext,
} from '@tuffcode/contracts';
import { asRecord, readString } from './guards.js';
import {
  createJsonlRpcClient,
  type JsonlRpcClient,
  type RpcId,
} from './jsonrpc.js';
import {
  createTurnState,
  isApprovalMethod,
  mapApprovalRequest,
  mapNotification,
  type ApprovalWireDecision,
  type CodexTurnState,
  type TurnReason,
} from './mapping.js';
import { CODEX_METHODS, UNSUPPORTED_SERVER_REQUEST } from './protocol.js';

/** Client identity reported in the app-server `initialize` handshake. */
const CLIENT_NAME = 'tuffcode';
const CLIENT_TITLE = 'Tuffcode';
const CLIENT_VERSION = '0.0.0';

/** `codex login status` exits within a moment; never block adapter creation longer. */
const LOGIN_PROBE_TIMEOUT_MS = 5_000;

/** Only classification needs stderr; the text is never logged or persisted. */
const STDERR_SNIFF_LIMIT = 4_096;

/**
 * The subset of a child process this adapter uses. Tests provide a fake with
 * in-memory streams so no real CLI is spawned.
 */
export interface CodexChild {
  readonly pid: number | null;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type CodexSpawn = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => CodexChild;

export interface CodexAdapterOverrides {
  /** Test seam: replace the real `child_process.spawn` wrapper. */
  spawn?: CodexSpawn;
  /** Skip the `codex login status` probe (tests, or offline local models). */
  skipLoginCheck?: boolean;
  requestTimeoutMs?: number;
}

class EventQueue<T> {
  private readonly items: T[] = [];
  private waitPromise: Promise<void> | null = null;
  private resolveWait: (() => void) | null = null;

  push(item: T): void {
    this.items.push(item);
    const resolve = this.resolveWait;
    this.waitPromise = null;
    this.resolveWait = null;
    resolve?.();
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  wait(): Promise<void> {
    if (this.items.length > 0) return Promise.resolve();
    if (this.waitPromise === null) {
      this.waitPromise = new Promise<void>((resolve) => {
        this.resolveWait = resolve;
      });
    }
    return this.waitPromise;
  }
}

interface PendingApproval {
  rpcId: RpcId;
  method: string;
  turnId: string;
  kind: string | null;
}

interface ActiveTurn {
  turnId: string;
  mode: PermissionMode;
  state: CodexTurnState;
  queue: EventQueue<AdapterEvent>;
  interrupted: boolean;
}

/** Approval policy values accepted by `thread/start` and `turn/start`. */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/** Sandbox mode values accepted by `thread/start`. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** The approval policy one Tuffcode mode maps to. */
export function codexApprovalPolicy(mode: PermissionMode): CodexApprovalPolicy {
  switch (mode) {
    case 'read-only':
      return 'never';
    case 'full-auto':
      return 'never';
    case 'ask':
    case 'accept-edits':
      return 'on-request';
  }
}

/** The sandbox mode one Tuffcode mode maps to. */
export function codexSandboxMode(mode: PermissionMode): CodexSandboxMode {
  switch (mode) {
    case 'read-only':
      return 'read-only';
    case 'ask':
    case 'accept-edits':
      return 'workspace-write';
    case 'full-auto':
      return 'danger-full-access';
  }
}

const CODEX_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** `turn/start` effort override; levels Codex does not know are left to its default. */
export function codexEffort(effort: string | undefined): { effort?: string } {
  return effort !== undefined && CODEX_EFFORTS.has(effort) ? { effort } : {};
}

/** Sandbox policy object accepted by `turn/start` overrides. */
export function codexSandboxPolicy(mode: PermissionMode, cwd: string): Record<string, unknown> {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'ask':
    case 'accept-edits':
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'full-auto':
      return { type: 'dangerFullAccess' };
  }
}

class CodexAdapter implements AdapterSession {
  readonly id: string;
  readonly providerId: string;
  readonly capabilities = { tools: true, approvals: true, resume: true, models: true };

  private readonly client: JsonlRpcClient;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly closedPromise: Promise<void>;
  private closedResolve: () => void = () => {};
  private closed = false;
  private disposed = false;
  private started = false;
  private threadId: string | null = null;
  private activeTurn: ActiveTurn | null = null;
  private stderrBytes = 0;

  constructor(
    private readonly provider: ProviderConfig,
    private readonly deps: AdapterDeps,
    private readonly child: CodexChild,
    requestTimeoutMs?: number,
  ) {
    this.id = `sess_${randomUUID()}`;
    this.providerId = provider.id;
    this.closedPromise = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });

    this.child.onExit((code, signal) => {
      this.markClosed(`app-server exited (${code ?? signal ?? 'unknown'})`);
    });
    this.child.onError(() => {
      this.markClosed('app-server failed to start');
    });
    this.watchStderr();

    this.client = createJsonlRpcClient({
      input: this.child.stdout,
      output: this.child.stdin,
      requestTimeoutMs,
      logger: deps.logger,
      handlers: {
        onNotification: (method, params) => this.handleNotification(method, params),
        onRequest: (id, method, params) => this.handleServerRequest(id, method, params),
        onClose: (reason) => this.markClosed(reason),
      },
    });
  }

  /** Send `initialize`, then the `initialized` notification the server expects. */
  async handshake(): Promise<void> {
    await this.client.request(CODEX_METHODS.initialize, {
      clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: CLIENT_VERSION },
      capabilities: null,
    });
    this.client.notify(CODEX_METHODS.initialized);
    this.deps.logger.debug('codex app-server initialized');
  }

  async *send(text: string, ctx: TurnContext): AsyncIterable<AdapterEvent> {
    if (this.disposed) throw new Error('codex adapter disposed');
    if (this.activeTurn !== null) throw new Error('codex adapter already has an active turn');

    const state = createTurnState(ctx.turnId);
    state.threadId = this.threadId;
    const turn: ActiveTurn = {
      turnId: ctx.turnId,
      mode: ctx.permissionMode,
      state,
      queue: new EventQueue<AdapterEvent>(),
      interrupted: false,
    };
    this.activeTurn = turn;

    let sawFinish = false;
    let reason: TurnReason = 'complete';
    let abortHandler: (() => void) | null = null;
    const abortPromise = new Promise<void>((resolve) => {
      abortHandler = () => resolve();
      if (ctx.signal.aborted) {
        resolve();
        return;
      }
      ctx.signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      if (!this.started) {
        this.started = true;
        yield {
          type: 'session.started',
          sessionId: this.id,
          model: this.modelFor(ctx) ?? 'codex',
          capabilities: { tools: true, approvals: true, resume: true },
        };
      }
      yield { type: 'turn.started', turnId: ctx.turnId };

      if (ctx.signal.aborted || turn.interrupted) {
        reason = 'interrupted';
      } else {
        const threadId = await this.ensureThread(ctx);
        state.threadId = threadId;

        if (ctx.signal.aborted || turn.interrupted) {
          reason = 'interrupted';
        } else {
          const startResult = await this.client.request(
            CODEX_METHODS.turnStart,
            this.turnParams(threadId, text, ctx),
          );
          const codexTurnId = readString(asRecord(asRecord(startResult)?.turn)?.id);
          if (codexTurnId !== null && state.codexTurnId === null) state.codexTurnId = codexTurnId;
          this.deps.logger.debug('codex turn started', { turnId: ctx.turnId });

          // interrupt() may have fired while turn/start was in flight, before
          // the vendor turn id was known.
          if (turn.interrupted) this.interruptTurn(turn);

          while (true) {
            const event = turn.queue.shift();
            if (event !== undefined) {
              yield event;
              if (event.type === 'turn.finished') {
                sawFinish = true;
                break;
              }
              continue;
            }

            if (ctx.signal.aborted || turn.interrupted) {
              reason = 'interrupted';
              break;
            }
            if (this.closed) {
              reason = 'error';
              break;
            }

            await Promise.race([turn.queue.wait(), abortPromise, this.closedPromise]);
          }

          if (ctx.signal.aborted || turn.interrupted) reason = 'interrupted';
        }
      }
    } catch (error) {
      if (ctx.signal.aborted || turn.interrupted) {
        reason = 'interrupted';
      } else {
        const message = error instanceof Error ? error.message : 'turn failed';
        this.deps.logger.warn('codex turn failed', { turnId: ctx.turnId });
        yield { type: 'error', message: `codex: ${message}`, retryable: false };
        reason = 'error';
      }
    } finally {
      if (abortHandler !== null) ctx.signal.removeEventListener('abort', abortHandler);
      this.denyPendingApprovals(turn.turnId);
      if (this.activeTurn === turn) this.activeTurn = null;
      if (!sawFinish && !turn.state.finished) {
        // The consumer stopped reading; stop the vendor turn too.
        this.interruptTurn(turn);
      }
    }

    if (!sawFinish) {
      yield { type: 'turn.finished', turnId: ctx.turnId, reason };
    }
  }

  approve(approvalId: string, decision: 'allow' | 'allow-thread' | 'deny'): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (pending === undefined) return;
    this.pendingApprovals.delete(approvalId);

    const wire: ApprovalWireDecision =
      decision === 'allow' ? 'accept' : decision === 'allow-thread' ? 'acceptForSession' : 'decline';
    this.respondApproval(pending, wire);
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (turn === null || this.disposed) return;

    turn.interrupted = true;
    this.denyPendingApprovals(turn.turnId);
    this.interruptTurn(turn);
    turn.queue.push({ type: 'turn.finished', turnId: turn.turnId, reason: 'interrupted' });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const turn = this.activeTurn;
    if (turn !== null) {
      this.denyPendingApprovals(turn.turnId);
      turn.queue.push({ type: 'turn.finished', turnId: turn.turnId, reason: 'interrupted' });
    }
    this.activeTurn = null;
    this.closed = true;
    this.closedResolve();
    this.client.dispose('codex adapter disposed');

    try {
      this.child.kill();
    } catch {
      // The process is already gone.
    }
    if (this.stderrBytes > 0) {
      this.deps.logger.debug('codex app-server stderr discarded', { bytes: this.stderrBytes });
    }
  }

  private async ensureThread(ctx: TurnContext): Promise<string> {
    if (this.threadId !== null) return this.threadId;

    const model = this.modelFor(ctx);
    const result = await this.client.request(CODEX_METHODS.threadStart, {
      cwd: ctx.cwd,
      approvalPolicy: codexApprovalPolicy(ctx.permissionMode),
      sandbox: codexSandboxMode(ctx.permissionMode),
      ...(model === null ? {} : { model }),
      ...(ctx.systemPrompt.trim().length === 0 ? {} : { baseInstructions: ctx.systemPrompt }),
      ...(ctx.brainSlice.trim().length === 0 ? {} : { developerInstructions: ctx.brainSlice }),
    });

    const threadId = readString(asRecord(asRecord(result)?.thread)?.id);
    if (threadId === null) {
      throw new Error('app-server did not return a thread id');
    }
    this.threadId = threadId;
    this.deps.logger.debug('codex thread created');
    return threadId;
  }

  private turnParams(threadId: string, text: string, ctx: TurnContext): Record<string, unknown> {
    const input: Record<string, unknown>[] = [{ type: 'text', text }];
    for (const attachment of ctx.attachments) {
      if (attachment.kind === 'image') {
        // Inline bytes travel as a data URL; a path is read by the app-server itself.
        if (attachment.data !== undefined && ctx.vision) {
          input.push({
            type: 'image',
            url: `data:${attachment.mimeType ?? 'image/png'};base64,${attachment.data}`,
          });
        } else if (attachment.data !== undefined) {
          input.push({
            type: 'text',
            text: `[Image attached: ${attachment.name ?? 'image'} - this model cannot view images]`,
          });
        } else if (attachment.path !== undefined) {
          input.push({ type: 'localImage', path: attachment.path });
        }
        continue;
      }
      if (attachment.path !== undefined) {
        input.push({ type: 'mention', name: basename(attachment.path), path: attachment.path });
      }
    }

    const model = this.modelFor(ctx);
    return {
      threadId,
      input,
      cwd: ctx.cwd,
      approvalPolicy: codexApprovalPolicy(ctx.permissionMode),
      sandboxPolicy: codexSandboxPolicy(ctx.permissionMode, ctx.cwd),
      ...(model === null ? {} : { model }),
      ...codexEffort(ctx.reasoningEffort),
    };
  }

  private modelFor(ctx: TurnContext): string | null {
    return ctx.model.trim().length > 0 ? ctx.model : readString(this.provider.config.model);
  }

  private interruptTurn(turn: ActiveTurn): void {
    const threadId = turn.state.threadId ?? this.threadId;
    const codexTurnId = turn.state.codexTurnId;
    if (threadId === null || codexTurnId === null) return;

    this.client.request(CODEX_METHODS.turnInterrupt, { threadId, turnId: codexTurnId }).catch(() => {
      this.deps.logger.warn('codex turn interrupt failed', { turnId: turn.turnId });
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === CODEX_METHODS.serverRequestResolved) {
      const requestId = asRecord(params)?.requestId;
      if (typeof requestId === 'number' || typeof requestId === 'string') {
        this.resolvePendingByRpcId(requestId);
      }
      return;
    }

    const turn = this.activeTurn;
    if (turn === null) return;

    for (const event of mapNotification(method, params, turn.state)) {
      turn.queue.push(event);
    }
  }

  private handleServerRequest(id: RpcId, method: string, params: unknown): void {
    const turn = this.activeTurn;
    if (turn === null || !isApprovalMethod(method)) {
      this.client.respondError(id, UNSUPPORTED_SERVER_REQUEST, `unsupported server request: ${method}`);
      return;
    }

    const mapping = mapApprovalRequest(method, params, turn.mode, turn.turnId);
    if (mapping === null) {
      this.client.respondError(id, UNSUPPORTED_SERVER_REQUEST, `unsupported server request: ${method}`);
      return;
    }

    const kind = readString(asRecord(params)?.kind);
    if (mapping.autoDecision !== null) {
      this.respondApproval({ rpcId: id, method, turnId: turn.turnId, kind }, mapping.autoDecision);
      return;
    }

    let approvalId = mapping.approvalId;
    if (this.pendingApprovals.has(approvalId)) {
      approvalId = `${approvalId}:${String(id)}`;
    }
    this.pendingApprovals.set(approvalId, { rpcId: id, method, turnId: turn.turnId, kind });

    if (mapping.event !== null && mapping.event.type === 'approval.requested') {
      turn.queue.push({ ...mapping.event, approvalId });
    }
  }

  private respondApproval(pending: PendingApproval, decision: ApprovalWireDecision): void {
    if (pending.method === CODEX_METHODS.legacyExecApproval || pending.method === CODEX_METHODS.legacyPatchApproval) {
      const legacyDecision =
        decision === 'accept'
          ? 'approved'
          : decision === 'acceptForSession'
            ? 'approved_for_session'
            : decision === 'cancel'
              ? 'abort'
              : { denied: { rejection: 'denied by user' } };
      this.client.respond(pending.rpcId, { decision: legacyDecision });
      return;
    }

    const wireDecision = pending.kind === 'humanCommand' && decision === 'acceptForSession' ? 'accept' : decision;
    this.client.respond(pending.rpcId, { decision: wireDecision });
  }

  private denyPendingApprovals(turnId: string): void {
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.turnId !== turnId) continue;
      this.pendingApprovals.delete(approvalId);
      this.respondApproval(pending, 'decline');
    }
  }

  private resolvePendingByRpcId(requestId: RpcId): void {
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.rpcId !== requestId) continue;
      this.pendingApprovals.delete(approvalId);
      return;
    }
  }

  private markClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedResolve();

    const turn = this.activeTurn;
    if (turn !== null && !turn.state.finished) {
      turn.queue.push({ type: 'error', message: `codex: ${reason}`, retryable: false });
    }
  }

  private watchStderr(): void {
    const stderr = this.child.stderr;
    if (stderr === null) return;

    stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBytes += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    });
    stderr.on('error', () => {
      // A broken stderr pipe must not take the adapter down.
    });
  }
}

/**
 * Create a Codex adapter backed by the installed `codex` executable. The
 * app-server child is spawned immediately and `initialize` is awaited, so a
 * broken install or an unauthenticated CLI surfaces as
 * `AdapterUnavailableError` instead of a failing first turn.
 */
export async function createCodexAdapter(
  provider: ProviderConfig,
  deps: AdapterDeps,
  overrides: CodexAdapterOverrides = {},
): Promise<AdapterSession> {
  const configured = readString(provider.config.command);
  const command = configured ?? (await deps.resolveCommand('codex'));
  if (command === null) {
    throw new AdapterUnavailableError(
      provider.id,
      'Codex CLI not found. Install it with `npm install -g @openai/codex`, then run `codex login`.',
    );
  }

  const spawnChild = overrides.spawn ?? spawnCodex;
  const env = mergeEnv(deps.env);

  if (overrides.skipLoginCheck !== true) {
    const login = await probeLogin(spawnChild, command, env);
    if (login === 'unauthenticated') {
      throw new AdapterUnavailableError(provider.id, 'Codex CLI is not logged in. Run `codex login`.');
    }
  }

  const child = spawnChild(command, ['app-server'], env);
  const adapter = new CodexAdapter(provider, deps, child, overrides.requestTimeoutMs);
  try {
    await adapter.handshake();
  } catch (error) {
    await adapter.dispose();
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new AdapterUnavailableError(
      provider.id,
      `Codex app-server handshake failed: ${message.slice(0, 300)}`,
    );
  }
  return adapter;
}

function mergeEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Probe `codex login status`. Exit code 0 means authenticated; the verified
 * "Not logged in" stderr line means unauthenticated. Anything else (older CLI,
 * spawn failure, timeout) is unknown and left to the app-server handshake.
 */
async function probeLogin(
  spawnChild: CodexSpawn,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
  let child: CodexChild;
  try {
    child = spawnChild(command, ['login', 'status'], env);
  } catch {
    return 'unknown';
  }

  const resultPromise = new Promise<'authenticated' | 'unauthenticated' | 'unknown'>((resolve) => {
    let stderrText = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: 'authenticated' | 'unauthenticated' | 'unknown') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderrText.length >= STDERR_SNIFF_LIMIT) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrText += text.slice(0, STDERR_SNIFF_LIMIT - stderrText.length);
    });
    child.stderr?.on('error', () => {});
    child.onError(() => finish('unknown'));
    child.onExit((code) => {
      if (code === 0) {
        finish('authenticated');
        return;
      }
      finish(stderrText.includes('Not logged in') ? 'unauthenticated' : 'unknown');
    });

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      finish('unknown');
    }, LOGIN_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });

  return resultPromise;
}

function spawnCodex(command: string, args: string[], env: NodeJS.ProcessEnv): CodexChild {
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
  const child = isBatch
    ? spawn(comspec, ['/d', '/s', '/c', `""${command}" ${args.join(' ')}"`], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  if (child.stdin === null || child.stdout === null) {
    child.kill();
    throw new Error('codex app-server did not expose stdio pipes');
  }

  return {
    pid: child.pid ?? null,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill(signal) {
      return child.kill(signal);
    },
    onExit(listener) {
      child.once('exit', listener);
    },
    onError(listener) {
      child.once('error', listener);
    },
  };
}

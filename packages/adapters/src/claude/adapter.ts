import { query } from '@anthropic-ai/claude-agent-sdk';
import { basename } from 'node:path';
import {
  AdapterUnavailableError,
  type AdapterDeps,
  type AdapterEvent,
  type AdapterSession,
  type ApprovalChoice,
  type McpServerLaunch,
  type PermissionMode,
  type ProviderConfig,
  type ToolProfile,
  type TurnContext,
} from '@tuffcode/contracts';
import { newId } from '@tuffcode/shared';
import { redactToolInput } from '../redact.js';
import { profileAllows, profileOffers } from '../tool-policy.js';
import { mapSdkMessage, type ClaudeMappingState } from './map.js';
import { classifyTuffcodeTool, claudeHarnessToolName, tuffcodeServer } from './tuffcode-tools.js';

/** Permission modes understood by the Claude Agent SDK. */
export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

export interface ClaudeCanUseToolOptions {
  signal: AbortSignal;
  toolUseID?: string;
}

export type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: ClaudeCanUseToolOptions,
) => Promise<ClaudePermissionResult>;

/**
 * The subset of `query()` options this adapter sets. Declared locally so the
 * vendor SDK types stay out of the exported adapter surface.
 */
export interface ClaudeQueryOptions {
  cwd: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  systemPrompt: { type: 'preset'; preset: 'claude_code'; append: string };
  resume?: string;
  pathToClaudeCodeExecutable: string;
  abortController: AbortController;
  allowDangerouslySkipPermissions?: boolean;
  /** Vendor tools removed from the model's context, which a child's profile drives. */
  disallowedTools?: string[];
  canUseTool: ClaudeCanUseTool;
  effort?: ClaudeEffort;
  mcpServers?: Record<
    string,
    | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
    | { type: 'http'; url: string; headers: Record<string, string> }
    | unknown
  >;
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeQueryHandle extends AsyncIterable<unknown> {
  interrupt?: () => Promise<unknown>;
}

export type ClaudeQueryFn = (params: {
  prompt: string;
  options: ClaudeQueryOptions;
}) => ClaudeQueryHandle;

/**
 * The turn text plus one line per attachment. The Claude Agent SDK is driven with a
 * string prompt here, so inline image bytes cannot reach the model; naming the files
 * keeps an attachment from vanishing silently, and a worktree path stays readable.
 */
export function promptWithAttachments(text: string, ctx: TurnContext): string {
  if (ctx.attachments.length === 0) return text;
  const lines = ctx.attachments.map((attachment) => {
    const name =
      attachment.name ?? (attachment.path === undefined ? 'attachment' : basename(attachment.path));
    if (attachment.path !== undefined) return `- ${name}: ${attachment.path}`;
    return `- ${name} (inline image; this provider cannot receive image bytes)`;
  });
  return `${text}\n\nAttachments:\n${lines.join('\n')}`;
}

/** Test seam: inject a recorded query stream instead of spawning the CLI. */
export interface ClaudeAdapterOverrides {
  queryFn?: ClaudeQueryFn;
}

// The local option type mirrors the SDK fields this adapter sets; in-process servers are
// opaque instances the SDK built, so the cast stays at this single boundary.
const defaultQueryFn: ClaudeQueryFn = ({ prompt, options }) =>
  query({ prompt, options: options as Parameters<typeof query>[0]['options'] });

type TurnReason = 'complete' | 'interrupted' | 'error';

interface PendingApproval {
  resolve: (choice: ApprovalChoice) => void;
  cleanup: () => void;
}

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  query: ClaudeQueryHandle | null;
  approvalIds: Set<string>;
}

class EventQueue {
  private items: AdapterEvent[] = [];
  private waitPromise: Promise<void> | null = null;
  private resolveWait: (() => void) | null = null;

  push(event: AdapterEvent): void {
    this.items.push(event);
    this.wake();
  }

  shift(): AdapterEvent | undefined {
    return this.items.shift();
  }

  wait(): Promise<void> {
    if (this.items.length > 0) return Promise.resolve();
    const existing = this.waitPromise;
    if (existing) return existing;
    const { promise, resolve } = deferred<void>();
    this.waitPromise = promise;
    this.resolveWait = resolve;
    return promise;
  }

  wake(): void {
    const resolve = this.resolveWait;
    this.waitPromise = null;
    this.resolveWait = null;
    resolve?.();
  }
}

class ClaudeAdapter implements AdapterSession {
  readonly id: string;
  readonly providerId: string;
  readonly capabilities = { tools: true, approvals: true, resume: true, models: true };

  private readonly approvals = new Map<string, PendingApproval>();
  private readonly active = new Set<ActiveTurn>();
  private sessionId: string | null = null;
  private disposed = false;

  constructor(
    private readonly provider: ProviderConfig,
    private readonly deps: AdapterDeps,
    private readonly executable: string,
    private readonly queryFn: ClaudeQueryFn,
  ) {
    this.id = newId('sess');
    this.providerId = provider.id;
  }

  async *send(text: string, ctx: TurnContext): AsyncIterable<AdapterEvent> {
    if (this.disposed) throw new Error('claude adapter disposed');

    const turn: ActiveTurn = {
      turnId: ctx.turnId,
      controller: new AbortController(),
      query: null,
      approvalIds: new Set(),
    };
    this.active.add(turn);

    const queue = new EventQueue();
    const state: ClaudeMappingState = {
      turnId: ctx.turnId,
      sessionId: this.sessionId,
      toolCallIds: new Set(),
    };

    const onAbort = () => {
      turn.controller.abort();
      queue.wake();
    };
    if (ctx.signal.aborted) turn.controller.abort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });

    const signalAbort = abortSignalPromise(turn.controller.signal);
    let reason: TurnReason = 'complete';
    let iterator: AsyncIterator<unknown> | null = null;

    yield { type: 'turn.started', turnId: ctx.turnId };

    try {
      // disallowedTools is the only lever that removes a vendor tool from the model's
      // list; writeGlobs stays on canUseTool because a vendor list cannot express a path.
      const vendorLaunches = this.deps.mcpServers?.();
      const disallowed =
        ctx.toolProfile === undefined
          ? []
          : disallowedToolsForProfile(
              ctx.toolProfile,
              ctx.permissionMode,
              Object.keys(vendorLaunches ?? {}),
            );
      const vendorServers =
        ctx.toolOptions?.mcp === false ||
        (ctx.toolProfile !== undefined && !profileOffers(ctx.toolProfile, 'mcp'))
          ? undefined
          : vendorLaunches;
      const handle = this.queryFn({
        prompt: promptWithAttachments(text, ctx),
        options: {
          cwd: ctx.cwd,
          ...(ctx.model ? { model: ctx.model } : {}),
          permissionMode: mapPermissionMode(ctx.permissionMode),
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: appendSystemPrompt(ctx),
          },
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          pathToClaudeCodeExecutable: this.executable,
          abortController: turn.controller,
          ...(ctx.permissionMode === 'full-auto' ? { allowDangerouslySkipPermissions: true } : {}),
          ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
          canUseTool: (toolName, input, options) => {
            // A child's profile decides first: a refused call never reaches the approval
            // path, and an allowed one runs, because nothing answers a child's approval.
            if (ctx.toolProfile !== undefined) {
              const mapped = claudeHarnessToolName(toolName);
              if (mapped !== null) {
                const verdict = profileAllows(mapped, input, ctx.toolProfile, ctx.cwd);
                if (!verdict.allowed) {
                  return Promise.resolve({ behavior: 'deny' as const, message: verdict.reason });
                }
                return Promise.resolve({ behavior: 'allow' as const });
              }
            }
            // Tuffcode's own tools follow the harness ladder: reads and the task list
            // never ask, spawning and stopping children do in ask mode.
            const decision = classifyTuffcodeTool(toolName, input, ctx.permissionMode);
            if (decision === 'allow') return Promise.resolve({ behavior: 'allow' as const });
            if (decision === 'deny') {
              return Promise.resolve({
                behavior: 'deny' as const,
                message: `${toolName} is not allowed in ${ctx.permissionMode} mode`,
              });
            }
            return this.requestApproval(turn, queue, toolName, input, options);
          },
          ...claudeEffort(ctx.reasoningEffort),
          ...mcpServerOptions(vendorServers, tuffcodeServer(this.deps, ctx)),
        },
      });
      turn.query = handle;
      iterator = handle[Symbol.asyncIterator]();

      this.deps.logger.debug('claude turn started', {
        turnId: ctx.turnId,
        model: ctx.model,
        permissionMode: ctx.permissionMode,
      });

      let pending: Promise<IteratorResult<unknown>> | null = null;
      while (true) {
        const queued = queue.shift();
        if (queued) {
          yield queued;
          continue;
        }
        if (turn.controller.signal.aborted) {
          reason = 'interrupted';
          break;
        }

        pending ??= iterator.next();
        const outcome = await Promise.race([
          pending.then((result) => ({ kind: 'message' as const, result })),
          queue.wait().then(() => ({ kind: 'event' as const })),
          signalAbort.then(() => ({ kind: 'abort' as const })),
        ]);

        if (outcome.kind === 'abort') {
          reason = 'interrupted';
          break;
        }
        if (outcome.kind === 'event') continue;

        pending = null;
        if (outcome.result.done) break;

        const message = outcome.result.value;
        if (isErrorResult(message)) reason = 'error';
        for (const event of mapSdkMessage(message, state)) yield event;
        if (state.sessionId) this.sessionId = state.sessionId;
      }

      if (turn.controller.signal.aborted) reason = 'interrupted';
      yield { type: 'turn.finished', turnId: ctx.turnId, reason };
    } catch (error) {
      if (turn.controller.signal.aborted || isAbortError(error)) {
        yield { type: 'turn.finished', turnId: ctx.turnId, reason: 'interrupted' };
      } else {
        const message = error instanceof Error ? error.message : 'claude query failed';
        this.deps.logger.warn('claude query failed', { turnId: ctx.turnId });
        yield { type: 'error', message: `claude: ${message}`, retryable: false };
        yield { type: 'turn.finished', turnId: ctx.turnId, reason: 'error' };
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      this.denyApprovals(turn);
      this.active.delete(turn);
      try {
        const closing = iterator?.return?.();
        if (closing) {
          void closing.catch(() => {
            // The SDK stream is already closed; nothing to clean up.
          });
        }
      } catch {
        // The SDK stream is already closed; nothing to clean up.
      }
    }
  }

  approve(approvalId: string, decision: ApprovalChoice): void {
    this.resolveApproval(approvalId, decision);
  }

  async interrupt(): Promise<void> {
    for (const turn of this.active) {
      this.denyApprovals(turn);
      turn.controller.abort();
      const handle = turn.query;
      if (handle?.interrupt) {
        void handle.interrupt().catch(() => {
          this.deps.logger.debug('claude interrupt failed', { turnId: turn.turnId });
        });
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.interrupt();
    for (const turn of this.active) this.denyApprovals(turn);
    this.active.clear();
    this.approvals.clear();
    this.sessionId = null;
    this.deps.logger.debug('claude adapter disposed', { providerId: this.provider.id });
  }

  private requestApproval(
    turn: ActiveTurn,
    queue: EventQueue,
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudeCanUseToolOptions,
  ): Promise<ClaudePermissionResult> {
    const approvalId = newId('apr');
    const toolCallId = options.toolUseID ?? approvalId;
    const { promise, resolve } = deferred<ClaudePermissionResult>();

    if (options.signal.aborted) {
      resolve({ behavior: 'deny', message: 'Denied by user' });
      return promise;
    }

    const onAbort = () => this.resolveApproval(approvalId, 'deny');
    options.signal.addEventListener('abort', onAbort, { once: true });

    this.approvals.set(approvalId, {
      resolve: (choice) => {
        if (choice === 'deny') resolve({ behavior: 'deny', message: 'Denied by user' });
        else resolve({ behavior: 'allow' });
      },
      cleanup: () => options.signal.removeEventListener('abort', onAbort),
    });
    turn.approvalIds.add(approvalId);

    queue.push({
      type: 'approval.requested',
      turnId: turn.turnId,
      approvalId,
      toolCallId,
      name: toolName,
      input: redactToolInput(input),
    });
    this.deps.logger.debug('claude approval requested', { approvalId, toolName });

    if (turn.controller.signal.aborted) this.resolveApproval(approvalId, 'deny');
    return promise;
  }

  private resolveApproval(approvalId: string, choice: ApprovalChoice): void {
    const pending = this.approvals.get(approvalId);
    if (!pending) return;
    this.approvals.delete(approvalId);
    pending.cleanup();
    pending.resolve(choice);
  }

  private denyApprovals(turn: ActiveTurn): void {
    for (const approvalId of turn.approvalIds) {
      this.resolveApproval(approvalId, 'deny');
    }
    turn.approvalIds.clear();
  }
}

/**
 * Create a Claude subscription adapter backed by the installed Claude Code
 * executable. Throws `AdapterUnavailableError` when no executable can be
 * resolved so the UI can show an install hint instead of an error toast.
 */
export async function createClaudeAdapter(
  provider: ProviderConfig,
  deps: AdapterDeps,
  overrides: ClaudeAdapterOverrides = {},
): Promise<AdapterSession> {
  const configuredPath =
    typeof provider.config.pathToClaudeCodeExecutable === 'string'
      ? provider.config.pathToClaudeCodeExecutable.trim()
      : '';
  const executable = configuredPath || (await deps.resolveCommand('claude'));

  if (!executable) {
    throw new AdapterUnavailableError(
      provider.id,
      'Install Claude Code, then run claude auth login',
    );
  }

  deps.logger.debug('claude adapter created', { providerId: provider.id });
  return new ClaudeAdapter(provider, deps, executable, overrides.queryFn ?? defaultQueryFn);
}

/** The SDK permission mode one Tuffcode mode maps to. Exported for the parity tests. */
export function mapPermissionMode(mode: PermissionMode): ClaudePermissionMode {
  switch (mode) {
    case 'read-only':
      return 'plan';
    case 'accept-edits':
      return 'acceptEdits';
    case 'full-auto':
      return 'bypassPermissions';
    case 'ask':
    default:
      return 'default';
  }
}

function appendSystemPrompt(ctx: TurnContext): string {
  return [ctx.systemPrompt.trim(), ctx.brainSlice.trim()]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** The SDK's effort ladder; `minimal` rounds up to low and `none` keeps the CLI default. */
export function claudeEffort(effort: string | undefined): Pick<ClaudeQueryOptions, 'effort'> {
  if (effort === undefined) return {};
  const mapped = effort === 'minimal' ? 'low' : effort;
  return CLAUDE_EFFORTS.has(mapped) ? { effort: mapped as ClaudeEffort } : {};
}

/**
 * The vendor tools a child's profile removes from the model's context. `disallowedTools`
 * is the only option that drops a tool from the list the model sees; the callback below
 * is the second layer, and the only place a path limit can live. A read-only child maps
 * to the SDK's `plan` mode, which refuses edits before the callback, so Write and Edit
 * leave the list there instead of becoming a declined call.
 */
function disallowedToolsForProfile(
  profile: ToolProfile,
  permissionMode: PermissionMode,
  vendorServers: readonly string[],
): string[] {
  const names: string[] = [];
  if (profile.writeGlobs === undefined || permissionMode === 'read-only') {
    names.push('Write', 'Edit');
  }
  if (profile.bash === 'none') names.push('Bash');
  // Server-level specs name the vendor servers only, so the in-process `tuffcode`
  // server stays reachable: a child still needs subagent:report even when it may not
  // call a vendor MCP tool.
  if (!profileOffers(profile, 'mcp')) names.push(...vendorServers.map((name) => 'mcp__' + name));
  return names;
}

/**
 * MCP servers for the SDK: the user's stdio and http servers plus Tuffcode's own
 * in-process server (todo, subagent, memory, skill, web_fetch). Omitted when empty.
 */
function mcpServerOptions(
  servers: Record<string, McpServerLaunch> | undefined,
  inProcess: Record<string, unknown> | undefined,
): Pick<ClaudeQueryOptions, 'mcpServers'> {
  const entries = Object.entries(servers ?? {});
  const extra = Object.entries(inProcess ?? {});
  if (entries.length === 0 && extra.length === 0) return {};
  return {
    mcpServers: Object.fromEntries([
      ...entries.map(([name, server]) => [
        name,
        server.type === 'http'
          ? { type: 'http' as const, url: server.url, headers: server.headers }
          : { type: 'stdio' as const, command: server.command, args: server.args, env: server.env },
      ]),
      ...extra,
    ]),
  };
}

function abortSignalPromise(signal: AbortSignal): Promise<void> {
  const { promise, resolve } = deferred<void>();
  if (signal.aborted) resolve();
  else signal.addEventListener('abort', () => resolve(), { once: true });
  return promise;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.includes('aborted');
  }
  return false;
}

function isErrorResult(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return record.type === 'result' && (record.is_error === true || record.subtype !== 'success');
}

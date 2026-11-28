import {
  AdapterUnavailableError,
  type AdapterEvent,
  type AdapterSession,
  type ApprovalChoice,
  type Attachment,
  type Project,
  type Settings,
  type Thread,
  type ThreadStatus,
  type TurnContext,
} from '@tuffcode/contracts';
import { SUBAGENT_TOOL_PROFILES } from '@tuffcode/prompt';
import { newId, resolveWithin, type Logger } from '@tuffcode/shared';
import {
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_SEND_BASE64_CHARS,
  persistAttachments,
  readStoredAttachment,
} from '../attachments/store.js';
import { captureStandingRules } from '../brain/rules.js';
import { threadLimits, threadVision, type ModelLimits } from '../context/limits.js';
import { measureContext } from '../context/service.js';
import type { ContextSectionInput } from '../context/usage.js';
import type { ProviderRecord, Repos, TurnStatus } from '../db/repos/index.js';
import { badRequest, conflict, notFound, RpcError } from '../errors.js';
import type { EventBus } from '../events.js';
import { planPrompt } from '../prompt/service.js';
import { deriveTitle, isPlaceholderTitle } from '../titles.js';
import {
  HANDOFF_TOKEN_BUDGET,
  buildHandoffDigest,
  handoffChildren,
  isCouncilThread,
  subagentChildFor,
  turnReasoningEffort,
  turnToolPolicy,
} from './turn-options.js';
import type { Secrets } from '../secrets/bridge.js';

export interface RunnerDeps {
  repos: Repos;
  bus: EventBus;
  logger: Logger;
  createAdapter: (provider: ProviderRecord, secret: string | null) => Promise<AdapterSession>;
  secrets: Secrets;
  settings: () => Settings;
}

export interface ActiveRunInfo {
  threadId: string;
  turnId: string;
  adapterKey: string;
}

export interface Runner {
  /** `queued` marks a send that joined the backlog of a thread with a live turn. */
  send(
    threadId: string,
    text: string,
    attachments?: Attachment[],
  ): Promise<{ turnId: string; queued?: boolean }>;
  interrupt(threadId: string): Promise<void>;
  approve(threadId: string, approvalId: string, decision: ApprovalChoice): Promise<void>;
  disposeThread(threadId: string): Promise<void>;
  disposeAll(): Promise<void>;
  recoverOrphanedRuns(): void;
  listActive(): ActiveRunInfo[];
}

interface CachedSession {
  session: AdapterSession;
  adapterKey: string;
}

interface ActiveRun {
  /** Null while a reserved turn is still assembling, before its adapter exists. */
  session: AdapterSession | null;
  turnId: string;
  controller: AbortController;
  adapterKey: string;
}

/**
 * A message accepted while another turn owned the thread. The turn id and the user
 * message row are allocated at send time, so delivery only has to start the run.
 */
interface QueuedTurn {
  turnId: string;
  text: string;
  attachments: Attachment[];
  createdAt: string;
}

/**
 * Per-turn state that outlives a single settle attempt. `settled` makes the settle path
 * idempotent, and `cancelled` is the fence that keeps a stopped run from writing again.
 */
interface TurnState {
  text: string;
  persisted: boolean;
  settled: boolean;
  cancelled: boolean;
}

/**
 * Streamed text and reasoning waiting to be written as one row. A turn that streams in
 * 300 pieces writes one row per flush instead of 300, while the renderer keeps showing
 * the same characters: the joined text is byte-identical to the unbatched stream.
 */
interface DeltaBuffer {
  threadId: string;
  turnId: string;
  type: 'text.delta' | 'reasoning.delta';
  parts: string[];
  timer: NodeJS.Timeout | null;
}

/** How long a streamed delta may wait for company before it is written on its own. */
const DELTA_FLUSH_MS = 50;

/** A backlog deeper than this is a runaway client, not a user typing ahead. */
const MAX_QUEUED_TURNS = 8;

type SettleReason = 'complete' | 'interrupted' | 'error';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function turnStatusFor(reason: SettleReason): TurnStatus {
  if (reason === 'complete') return 'complete';
  if (reason === 'interrupted') return 'interrupted';
  return 'failed';
}

/** Written alone when a turn is stopped before any text streamed. */
const INTERRUPTED_LABEL = '[interrupted]';

/** Appended to whatever streamed when the user interrupts, so the row is not read as final. */
export const INTERRUPTED_MARKER = `\n\n${INTERRUPTED_LABEL}`;

/** Message ids derive from the turn, so replaying a turn insert can never duplicate a row. */
function userMessageId(turnId: string): string {
  return `msg_${turnId}_user`;
}

function assistantMessageId(turnId: string): string {
  return `msg_${turnId}_assistant`;
}

export interface TurnStartInput {
  threadId: string;
  turnId: string;
  text: string;
  injectedIds: string[];
  /** Stored form of the user's attachments; omitted when the message carried none. */
  attachments?: readonly Attachment[];
  createdAt: string;
}

/**
 * Creates the turn row and its user message in one transaction. A replay of the same
 * turn start (a retried request, a re-run) leaves the message untouched instead of
 * inserting a second copy.
 */
export function recordTurnStart(repos: Repos, input: TurnStartInput): void {
  repos.transaction(() => {
    if (repos.turns.get(input.turnId) === undefined) {
      repos.turns.create({
        id: input.turnId,
        threadId: input.threadId,
        status: 'running',
        injectedIds: input.injectedIds,
        createdAt: input.createdAt,
      });
    }
    repos.messages.addIfAbsent({
      id: userMessageId(input.turnId),
      threadId: input.threadId,
      role: 'user',
      content: input.text,
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      createdAt: input.createdAt,
    });
  });
}

interface ResolvedAttachments {
  attachments: TurnContext['attachments'];
  /** Notes for the user about an attachment that was dropped, in order. */
  warnings: string[];
}

/**
 * Resolves each attachment into the shape an adapter reads. A path attachment must stay
 * inside the worktree; an inline attachment is already bytes and only needs its kind; a
 * stored id is read back from the attachment store so a retry or replay still works.
 * One bad attachment is dropped with a warning instead of failing the whole message,
 * because the user's text and the other files are still worth sending.
 */
async function resolveAttachments(
  worktreePath: string,
  attachments: readonly Attachment[],
): Promise<ResolvedAttachments> {
  const resolved: TurnContext['attachments'] = [];
  const warnings: string[] = [];
  let inlineChars = 0;
  for (const attachment of attachments) {
    const kind = attachment.mimeType?.startsWith('image/') === true ? 'image' : 'file';
    const name = attachment.name.length > 0 ? { name: attachment.name } : {};
    const size =
      attachment.width === undefined || attachment.height === undefined
        ? {}
        : { width: attachment.width, height: attachment.height };
    let data: string | undefined = attachment.data;
    let mimeType = attachment.mimeType;
    if (data === undefined && attachment.id !== undefined) {
      const stored = await readStoredAttachment(attachment.id, attachment.mimeType);
      if (stored === null) {
        warnings.push(`${attachment.name} could not be found and was not sent.`);
        continue;
      }
      data = stored.data;
      mimeType = stored.mimeType;
    }
    if (data !== undefined) {
      if (data.length > MAX_ATTACHMENT_BASE64_CHARS) {
        warnings.push(`${attachment.name} is too large and was not sent.`);
        continue;
      }
      if (inlineChars + data.length > MAX_SEND_BASE64_CHARS) {
        warnings.push(`${attachment.name} was not sent: this message is over the image budget.`);
        continue;
      }
      inlineChars += data.length;
      resolved.push({
        ...name,
        data,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...size,
        kind,
      });
      continue;
    }
    if (attachment.path === undefined) {
      warnings.push(`${attachment.name} had no file to send.`);
      continue;
    }
    let target: string;
    try {
      target = resolveWithin(worktreePath, attachment.path);
    } catch {
      warnings.push(`${attachment.name} is outside the worktree and was not sent.`);
      continue;
    }
    resolved.push({
      ...name,
      path: target,
      ...(mimeType === undefined ? {} : { mimeType }),
      kind,
    });
  }
  return { attachments: resolved, warnings };
}

/**
 * The turn runner: one adapter session per thread, one active turn at a time.
 *
 * Every adapter event is appended to the event table before it is broadcast, so a
 * reconnect or a restart replays exactly what the renderer saw. `send` returns as
 * soon as the turn row exists; the run itself is an async generator consumed in the
 * background, and a generator failure becomes events instead of a rejected RPC.
 */
export function createRunner(deps: RunnerDeps): Runner {
  const { repos, bus, logger } = deps;
  const sessions = new Map<string, CachedSession>();
  const active = new Map<string, ActiveRun>();
  /** Messages accepted while a turn was live, drained in order as each turn settles. */
  const queued = new Map<string, QueuedTurn[]>();
  /** Streamed text plus settlement and cancellation state per in-flight turn. */
  const turnState = new Map<string, TurnState>();
  /** Streamed deltas waiting to be written as one row, keyed by turn. */
  const deltaBuffers = new Map<string, DeltaBuffer>();

  function emitThread(thread: Thread): void {
    bus.emit({ kind: 'event', type: 'thread.updated', threadId: thread.id, payload: thread });
  }

  /**
   * Recomputes usage from the turn's assembled sections plus the conversation and
   * broadcasts it. Compaction never touches persisted rows, so this is the only signal
   * that the in-memory history shrank.
   */
  function emitContext(
    thread: Thread,
    sections: readonly ContextSectionInput[],
    options: { excludeMessageId?: string; compacted: boolean; limits: ModelLimits },
  ): void {
    const usage = measureContext(repos, thread, sections, {
      ...(options.excludeMessageId === undefined
        ? {}
        : { excludeMessageId: options.excludeMessageId }),
      limits: options.limits,
    });
    bus.emit({
      kind: 'event',
      type: 'context.updated',
      threadId: thread.id,
      payload: {
        threadId: thread.id,
        usedTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
        percent: usage.percent,
        limitSource: usage.limitSource,
        compacted: options.compacted,
      },
    });
  }

  function setThreadStatus(thread: Thread, status: ThreadStatus): Thread {
    const updated = repos.threads.update(thread.id, { status, updatedAt: nowIso() });
    const next = updated ?? { ...thread, status };
    emitThread(next);
    return next;
  }

  function appendEvent(threadId: string, event: AdapterEvent): number {
    // One timestamp per event, so the persisted row and the live frame agree.
    const createdAt = nowIso();
    const seq = repos.events.append(threadId, event.type, event, createdAt);
    bus.emit({
      kind: 'event',
      type: 'thread.event',
      threadId,
      seq,
      createdAt,
      payload: event,
    });
    return seq;
  }

  /**
   * Writes whatever the turn buffered as one row, at the seq it gets now. The entry is
   * dropped before the write, so a timer that fires mid-write finds nothing to flush
   * and no path can append the same text twice.
   */
  function flushDeltas(turnId: string): void {
    const buffer = deltaBuffers.get(turnId);
    if (buffer === undefined) return;
    deltaBuffers.delete(turnId);
    // The timer may already have fired, which leaves null here.
    clearTimeout(buffer.timer ?? undefined);
    if (buffer.parts.length === 0) return;
    appendEvent(buffer.threadId, {
      type: buffer.type,
      turnId,
      text: buffer.parts.join(''),
    });
  }

  /** Buffers one delta, flushing first when the type changes so the order is kept. */
  function recordDelta(
    threadId: string,
    event: Extract<AdapterEvent, { type: 'text.delta' | 'reasoning.delta' }>,
  ): void {
    const existing = deltaBuffers.get(event.turnId);
    if (existing !== undefined && existing.type === event.type) {
      existing.parts.push(event.text);
      return;
    }
    if (existing !== undefined) flushDeltas(event.turnId);
    const buffer: DeltaBuffer = {
      threadId,
      turnId: event.turnId,
      type: event.type,
      parts: [event.text],
      timer: null,
    };
    // The timer keeps streaming live between structural events; every exit path clears it.
    buffer.timer = setTimeout(() => {
      buffer.timer = null;
      flushDeltas(event.turnId);
    }, DELTA_FLUSH_MS);
    buffer.timer.unref();
    deltaBuffers.set(event.turnId, buffer);
  }

  /** Appends a structural event only after the turn's buffered text is written. */
  function appendAfterDeltas(threadId: string, turnId: string, event: AdapterEvent): void {
    flushDeltas(turnId);
    appendEvent(threadId, event);
  }

  function denyPending(threadId: string): void {
    const at = nowIso();
    for (const approval of repos.approvals.listPending(threadId)) {
      repos.approvals.resolve(approval.id, 'deny', at);
    }
  }

  /**
   * Stores the streamed assistant text once per turn. An interrupted turn always leaves
   * a row, even when nothing streamed, so the timeline shows where the run stopped.
   */
  function persistAssistant(
    threadId: string,
    turnId: string,
    reason: SettleReason,
    state: TurnState | undefined,
  ): void {
    const text = state?.text ?? '';
    if (state !== undefined) {
      if (state.persisted) return;
      state.persisted = true;
    }
    if (text.length === 0 && reason !== 'interrupted') return;
    const content =
      reason === 'interrupted'
        ? `${text}${text.length === 0 ? INTERRUPTED_LABEL : INTERRUPTED_MARKER}`
        : text;
    repos.messages.addIfAbsent({
      id: assistantMessageId(turnId),
      threadId,
      role: 'assistant',
      content,
      createdAt: nowIso(),
    });
  }

  /**
   * The single settle path for a turn. The adapter's own turn.finished, an adapter
   * failure, a failed adapter creation, an interrupt, and orphan recovery all land
   * here, so a turn gets exactly one turn row write, one assistant row, one thread
   * status write, and one turn.finished event. Later calls for the same turn are
   * no-ops, which is what lets a late adapter error lose to an interrupt.
   */
  function settleTurn(
    thread: Thread,
    turnId: string,
    reason: SettleReason,
    state: TurnState | undefined,
  ): void {
    // Nothing structural may be written ahead of the turn's buffered text, and no timer
    // may outlive the turn.
    flushDeltas(turnId);
    if (state !== undefined) {
      if (state.settled) return;
      state.settled = true;
    }
    const existing = repos.turns.get(turnId);
    // Durable fence: a row that already carries finished_at was settled by an earlier
    // call, even when the in-memory state is gone (recovery, a cancelled run that
    // outlived its state).
    if (existing !== undefined && existing.finishedAt !== null) return;
    repos.turns.finish(turnId, turnStatusFor(reason), nowIso());
    persistAssistant(thread.id, turnId, reason, state);
    denyPending(thread.id);
    setThreadStatus(thread, reason === 'error' ? 'failed' : 'ready-to-review');
    appendEvent(thread.id, { type: 'turn.finished', turnId, reason });
  }

  function requestApproval(
    thread: Thread,
    turnId: string,
    event: Extract<AdapterEvent, { type: 'approval.requested' }>,
  ): void {
    const approval = repos.approvals.create({
      id: event.approvalId,
      threadId: thread.id,
      toolCallId: event.toolCallId,
      toolName: event.name,
      input: event.input,
      createdAt: nowIso(),
    });
    repos.turns.setStatus(turnId, 'needs-approval');
    const updated = setThreadStatus(thread, 'needs-approval');
    bus.emit({
      kind: 'event',
      type: 'approval.requested',
      threadId: thread.id,
      payload: approval,
    });
    logger.debug('approval requested', {
      threadId: thread.id,
      turnId,
      approvalId: approval.id,
      status: updated.status,
    });
  }

  async function runTurn(
    thread: Thread,
    kind: string,
    turnId: string,
    session: AdapterSession,
    text: string,
    ctx: TurnContext,
    state: TurnState,
    sections: readonly ContextSectionInput[],
    limits: ModelLimits,
  ): Promise<void> {
    try {
      for await (const event of session.send(text, ctx)) {
        // The fence: a cancelled or settled turn takes no further adapter input. The
        // interrupt already wrote its boundary, so a late delta, approval, or finish
        // must not land in the log or move the thread.
        if (state.cancelled || state.settled) break;
        if (event.type === 'text.delta') state.text += event.text;
        if (event.type === 'turn.finished') {
          // Persist and broadcast the boundary before anything else observes it.
          settleTurn(thread, turnId, event.reason, state);
          continue;
        }
        if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
          recordDelta(thread.id, event);
          continue;
        }
        appendAfterDeltas(thread.id, turnId, event);
        if (event.type === 'approval.requested') requestApproval(thread, turnId, event);
      }
      if (!state.settled && !state.cancelled) {
        appendAfterDeltas(thread.id, turnId, {
          type: 'error',
          message: `${kind}: adapter ended without turn.finished`,
          retryable: false,
        });
        settleTurn(thread, turnId, 'error', state);
      }
    } catch (error) {
      if (state.settled || state.cancelled) {
        // An interrupt or a normal finish already settled this turn; the throw is the
        // cancelled stream unwinding and must not append an error or flip the status.
        logger.warn('adapter failed after the turn settled', {
          threadId: thread.id,
          turnId,
          reason: errorMessage(error),
        });
      } else {
        appendAfterDeltas(thread.id, turnId, {
          type: 'error',
          message: `${kind}: ${errorMessage(error)}`,
          retryable: false,
        });
        settleTurn(thread, turnId, 'error', state);
      }
    } finally {
      // The buffer and its timer must not outlive the turn, even when the stream threw.
      flushDeltas(turnId);
      turnState.delete(turnId);
      // Only this run may clear its own slot: an interrupt followed by a send leaves a
      // newer turn in the map, and this run must not fence it off.
      const current = active.get(thread.id);
      if (current?.turnId === turnId) active.delete(thread.id);
      try {
        emitContext(thread, sections, {
          excludeMessageId: userMessageId(turnId),
          compacted: false,
          limits,
        });
      } catch {
        logger.warn('context accounting failed after turn', { threadId: thread.id, turnId });
      }
      // Only the run that owned the slot may advance the queue: an interrupt followed by
      // a send leaves a newer turn in the map, and that turn owns the next delivery.
      if (current?.turnId === turnId) deliverQueued(thread);
    }
  }

  function failBeforeRun(thread: Thread, turnId: string, kind: string, error: unknown): never {
    const hint = error instanceof AdapterUnavailableError ? ` ${error.hint}` : '';
    const detail = `${errorMessage(error)}${hint}`;
    appendEvent(thread.id, {
      type: 'error',
      message: `${kind}: ${detail}`,
      retryable: false,
    });
    settleTurn(thread, turnId, 'error', undefined);
    if (error instanceof AdapterUnavailableError) {
      throw new RpcError('provider-unavailable', detail);
    }
    throw new Error('adapter creation failed');
  }

  /**
   * Whether this turn still owns the thread's one slot. An interrupt, a dispose or a
   * newer turn takes the slot away, and the turn that lost it must not start.
   */
  function ownsSlot(threadId: string, turnId: string): boolean {
    return active.get(threadId)?.turnId === turnId;
  }

  /**
   * Claims the thread's slot before the first await, so a second send cannot start a
   * turn on top of this one. `startTurn` fills the session in once the adapter exists;
   * until then the entry only marks which turn owns the thread.
   */
  function reserveTurn(threadId: string, turnId: string): AbortController {
    const controller = new AbortController();
    active.set(threadId, { session: null, turnId, controller, adapterKey: '' });
    return controller;
  }

  /**
   * The one turn-start path: every guard has passed, the ids are already allocated and
   * the slot is already reserved by the caller. `send` calls it directly, and the queue
   * calls it again with the ids it allocated at send time, so assembling, persisting,
   * and launching a turn exist once.
   */
  async function startTurn(input: {
    thread: Thread;
    project: Project;
    provider: ProviderRecord;
    worktreePath: string;
    text: string;
    attachments: readonly Attachment[];
    turnId: string;
    createdAt: string;
    /** Created by the reservation, so an interrupt can abort a turn that is assembling. */
    controller: AbortController;
  }): Promise<{ turnId: string }> {
      const {
        thread,
        project,
        provider,
        worktreePath,
        text,
        attachments,
        turnId,
        createdAt,
        controller,
      } = input;
      const resolved = await resolveAttachments(worktreePath, attachments);
      if (resolved.attachments.length === 0 && text.trim().length === 0) {
        throw badRequest(resolved.warnings[0] ?? 'the message has no content');
      }
      const turnAttachments = resolved.attachments;
      const storedAttachments = await persistAttachments(turnAttachments);
      // The slot was claimed before this function ran, so losing it means the user
      // interrupted or disposed the thread while the turn was assembling. Nothing is
      // written yet: drop the user row the queue wrote and never start the run.
      if (!ownsSlot(thread.id, turnId) || controller.signal.aborted) {
        repos.messages.removeMany([userMessageId(turnId)]);
        return { turnId };
      }
      const now = new Date(createdAt);
      const settings = deps.settings();
      const limits = threadLimits(repos, thread, settings);
      const { assembly, brain } = planPrompt(repos, {
        thread,
        project,
        message: text,
        settings,
        now,
      });
      // Token counts only: prompt text can contain user content and never belongs in logs.
      logger.debug('prompt assembled', {
        threadId: thread.id,
        turnId,
        sections: assembly.sections.map(({ name, tokens }) => ({ name, tokens })),
        total: assembly.total,
      });

      recordTurnStart(repos, {
        threadId: thread.id,
        turnId,
        text,
        injectedIds: brain.injectedIds,
        ...(storedAttachments.length === 0 ? {} : { attachments: storedAttachments }),
        createdAt,
      });
      // A dropped attachment is the user's business: the turn still runs, and the
      // transcript names the file that did not make it.
      for (const warning of resolved.warnings) {
        appendEvent(thread.id, { type: 'notice', message: warning, tone: 'warning' });
      }
      // The first message names a thread that still carries its placeholder title; a
      // title the user typed is never touched. setThreadStatus below emits the new row.
      if (isPlaceholderTitle(thread.title)) {
        const title = deriveTitle(text);
        if (title !== null) repos.threads.update(thread.id, { title, updatedAt: createdAt });
      }
      // A rule the user states mid-chat is stored for the following turn; a capture
      // failure is a brain problem, never a reason to fail the turn.
      try {
        // Paused memory (brainCapture off) still recalls; it only stops new writes.
        const captured = !settings.brainEnabled || !settings.brainCapture ? [] : captureStandingRules(repos, {
          text,
          projectId: thread.projectId,
          threadId: thread.id,
        });
        if (captured.length > 0) {
          logger.debug('standing rules captured', { threadId: thread.id, turnId, ids: captured });
        }
      } catch (error) {
        logger.warn('standing rule capture failed', {
          threadId: thread.id,
          turnId,
          reason: errorMessage(error),
        });
      }
      if (brain.injectedIds.length > 0) repos.brain.touch(brain.injectedIds, createdAt);

      const adapterKey = `${provider.id}:${thread.modelId}`;
      let session: AdapterSession;
      // A fresh adapter session has none of the thread's earlier turns (a provider or
      // model switch, or a restart), so its first turn carries a bounded digest.
      let freshSession = false;
      const cached = sessions.get(thread.id);
      if (cached !== undefined && cached.adapterKey === adapterKey) {
        session = cached.session;
      } else {
        freshSession = true;
        if (cached !== undefined) {
          sessions.delete(thread.id);
          await cached.session.dispose().catch(() => {
            logger.warn('cached session dispose failed', { threadId: thread.id });
          });
        }
        let created: AdapterSession;
        try {
          const secret =
            provider.secretRef === null
              ? null
              : await deps.secrets.get(provider.secretRef).catch(() => null);
          created = await deps.createAdapter(provider, secret);
        } catch (error) {
          failBeforeRun(thread, turnId, provider.kind, error);
        }
        session = created;
        sessions.set(thread.id, { session: created, adapterKey });
      }

      // The current user message already lives in the prompt sections, so its row is
      // excluded from the conversation half of the estimate.
      const excludeMessageId = userMessageId(turnId);
      const preUsage = measureContext(repos, thread, assembly.sections, {
        excludeMessageId,
        limits,
      });
      let compacted = false;
      if (
        preUsage.percent >= settings.contextWarningThreshold &&
        settings.autoCompact &&
        session.compact !== undefined
      ) {
        try {
          const result = await session.compact();
          compacted = result.removed > 0;
          logger.debug('context compacted before turn', {
            threadId: thread.id,
            turnId,
            removed: result.removed,
          });
        } catch (error) {
          // Compaction is an optimization: a failed summary keeps history as it was.
          logger.warn('context compaction failed', {
            threadId: thread.id,
            turnId,
            reason: errorMessage(error),
          });
        }
      }
      emitContext(thread, assembly.sections, { excludeMessageId, compacted, limits });

      const handoff = freshSession
        ? buildHandoffDigest(
            repos.messages.list(thread.id).filter((message) => message.id !== excludeMessageId),
            HANDOFF_TOKEN_BUDGET,
            handoffChildren(repos, thread.id),
          )
        : null;
      const subagentChild = subagentChildFor(repos, thread.id);
      const policy = turnToolPolicy({
        settings,
        council: isCouncilThread(repos, thread),
        ...(subagentChild === undefined
          ? {}
          : { profile: SUBAGENT_TOOL_PROFILES[subagentChild.type] }),
      });
      const effort = turnReasoningEffort(thread, provider.config);
      const ctx: TurnContext = {
        turnId,
        threadId: thread.id,
        cwd: worktreePath,
        systemPrompt:
          handoff === null ? assembly.systemPrompt : `${assembly.systemPrompt}\n\n${handoff}`,
        systemPromptStatic: assembly.staticPrefix,
        permissionMode: thread.permissionMode,
        model: thread.modelId,
        brainSlice: '',
        attachments: turnAttachments,
        vision: threadVision(repos, thread),
        signal: controller.signal,
        ...(policy.toolAllowlist === undefined ? {} : { toolAllowlist: policy.toolAllowlist }),
        toolOptions: policy.toolOptions,
        ...(policy.profile === undefined ? {} : { toolProfile: policy.profile }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        maxOutputTokens: limits.maxOutputTokens,
      };
      // The adapter creation awaited, so the slot may have been taken away in the
      // meantime. The turn row exists now, so this one settles instead of vanishing,
      // and the session it built must not outlive a disposed thread.
      if (!ownsSlot(thread.id, turnId) || controller.signal.aborted) {
        if (sessions.get(thread.id)?.session === session) {
          sessions.delete(thread.id);
          await session.dispose().catch(() => undefined);
        }
        settleTurn(thread, turnId, 'interrupted', undefined);
        return { turnId };
      }
      active.set(thread.id, { session, turnId, controller, adapterKey });
      setThreadStatus(thread, 'running');
      const state: TurnState = { text: '', persisted: false, settled: false, cancelled: false };
      turnState.set(turnId, state);
      void runTurn(
        thread,
        provider.kind,
        turnId,
        session,
        text,
        ctx,
        state,
        assembly.sections,
        limits,
      );
      return { turnId };
  }

  /**
   * Starts the next message that arrived while this thread had a live turn. Only the run
   * that owned the slot calls this, and only after it cleared that slot.
   */
  function deliverQueued(thread: Thread): void {
    if (active.has(thread.id)) return;
    const backlog = queued.get(thread.id);
    const next = backlog?.shift();
    if (next === undefined) {
      queued.delete(thread.id);
      return;
    }
    if (backlog !== undefined && backlog.length === 0) queued.delete(thread.id);
    const project = repos.projects.get(thread.projectId);
    const provider = repos.providers.get(thread.providerId);
    const worktreePath = thread.worktreePath;
    if (project === undefined || provider === undefined || worktreePath === null) {
      failQueued(thread, next, 'the thread can no longer start a turn');
      return;
    }
    // Claim the slot before the first await: a send that lands while this turn is
    // assembling must join the backlog, not start a second turn on the same thread.
    const controller = reserveTurn(thread.id, next.turnId);
    void startTurn({
      thread,
      project,
      provider,
      worktreePath,
      text: next.text,
      attachments: next.attachments,
      turnId: next.turnId,
      createdAt: next.createdAt,
      controller,
    }).catch((error: unknown) => {
      logger.warn('queued message could not start', {
        threadId: thread.id,
        turnId: next.turnId,
        reason: errorMessage(error),
      });
      const turn = repos.turns.get(next.turnId);
      if (turn === undefined || turn.finishedAt === null) {
        failQueued(thread, next, errorMessage(error));
      }
      // The failed turn must not keep the slot it reserved, or the backlog stalls.
      if (active.get(thread.id)?.turnId === next.turnId) active.delete(thread.id);
      // One failed delivery must not strand the rest of the backlog; the queue is
      // bounded, so this recursion ends.
      deliverQueued(repos.threads.get(thread.id) ?? thread);
    });
  }

  /**
   * Drops a thread's backlog and the user rows written for it at send time. A queued
   * message the user cancelled must not stay in the transcript as an unanswered prompt.
   */
  function dropQueue(threadId: string): void {
    const entries = queued.get(threadId);
    if (entries === undefined) return;
    queued.delete(threadId);
    repos.messages.removeMany(entries.map((entry) => userMessageId(entry.turnId)));
  }

  /**
   * Fails a queued message whose turn never started. Its user row is already written, so
   * the turn row is created first: the thread must not read as running without one.
   */
  function failQueued(thread: Thread, entry: QueuedTurn, reason: string): void {
    recordTurnStart(repos, {
      threadId: thread.id,
      turnId: entry.turnId,
      text: entry.text,
      injectedIds: [],
      createdAt: entry.createdAt,
    });
    appendEvent(thread.id, {
      type: 'error',
      message: `queued message could not start: ${reason}`,
      retryable: false,
    });
    settleTurn(thread, entry.turnId, 'error', undefined);
  }

  return {
    async send(threadId, text, attachments = []) {
      const thread = repos.threads.get(threadId);
      if (thread === undefined) throw notFound('thread not found');
      const project = repos.projects.get(thread.projectId);
      if (project === undefined) throw notFound('project not found');
      const provider = repos.providers.get(thread.providerId);
      if (provider === undefined) throw notFound('provider not found');
      if (!provider.enabled) throw new RpcError('provider-unavailable', 'provider is disabled');
      if (text.trim().length === 0 && attachments.length === 0) {
        throw badRequest('message text is empty');
      }
      const worktreePath = thread.worktreePath;
      if (worktreePath === null) throw conflict('thread has no worktree');

      if (active.has(thread.id)) {
        // The live turn owns the adapter stream, so this message waits its turn. Its row
        // is written now so it cannot be lost, and the queue starts it on settle.
        const backlog = queued.get(thread.id) ?? [];
        if (backlog.length >= MAX_QUEUED_TURNS) {
          throw conflict(`thread already has ${MAX_QUEUED_TURNS} queued messages`);
        }
        const turnId = newId('turn');
        const createdAt = nowIso();
        const resolved = await resolveAttachments(worktreePath, attachments);
        if (resolved.attachments.length === 0 && text.trim().length === 0) {
          throw badRequest(resolved.warnings[0] ?? 'the message has no content');
        }
        const stored = await persistAttachments(resolved.attachments);
        repos.messages.addIfAbsent({
          id: userMessageId(turnId),
          threadId: thread.id,
          role: 'user',
          content: text,
          ...(stored.length === 0 ? {} : { attachments: stored }),
          createdAt,
        });
        backlog.push({ turnId, text, attachments, createdAt });
        queued.set(thread.id, backlog);
        return { turnId, queued: true };
      }

      // Claim the slot before the first await, so a second send that arrives while this
      // turn is assembling joins the backlog instead of starting a turn of its own.
      const turnId = newId('turn');
      const controller = reserveTurn(thread.id, turnId);
      try {
        return await startTurn({
          thread,
          project,
          provider,
          worktreePath,
          text,
          attachments,
          turnId,
          createdAt: nowIso(),
          controller,
        });
      } catch (error) {
        // A turn that never launched must not keep the slot, or the thread stalls.
        if (active.get(thread.id)?.turnId === turnId) active.delete(thread.id);
        throw error;
      }
    },

    async interrupt(threadId) {
      const thread = repos.threads.get(threadId);
      if (thread === undefined) throw notFound('thread not found');
      // A user who stops a turn does not want the backlog to fire next.
      dropQueue(threadId);
      const run = active.get(threadId);
      if (run === undefined) {
        if (thread.status === 'running' || thread.status === 'needs-approval') {
          throw conflict('no active run to interrupt');
        }
        return;
      }
      // Fence the run before the adapter is asked to stop, and before the first await:
      // the next send() must see no active run and no cached session, so it builds a
      // fresh adapter instead of attaching to the cancelled one. The settle is
      // synchronous and idempotent, so a second interrupt cannot finish twice.
      const state = turnState.get(run.turnId);
      if (state !== undefined) state.cancelled = true;
      denyPending(threadId);
      active.delete(threadId);
      const cached = sessions.get(threadId);
      sessions.delete(threadId);
      // A reserved turn has no row and no stream yet, so there is nothing to settle:
      // startTurn sees the lost slot and drops the message. A turn that ran settles here.
      if (run.session !== null) settleTurn(thread, run.turnId, 'interrupted', state);
      run.controller.abort();

      if (run.session !== null) {
        await run.session.interrupt().catch(() => {
          logger.warn('adapter interrupt failed', { threadId, turnId: run.turnId });
        });
      }
      const disposable = cached?.session ?? run.session;
      if (disposable !== null) {
        await disposable.dispose().catch(() => {
          logger.warn('interrupted session dispose failed', { threadId, turnId: run.turnId });
        });
      }
    },

    async approve(threadId, approvalId, decision) {
      const approval = repos.approvals.get(approvalId);
      if (approval === undefined || approval.threadId !== threadId) {
        throw notFound('approval not found');
      }
      if (approval.decision !== 'pending') throw conflict('approval already resolved');
      const thread = repos.threads.get(threadId);
      if (thread === undefined) throw notFound('thread not found');
      const run = active.get(threadId);
      // A reserved turn has no adapter yet, so it cannot have asked for an approval.
      if (run === undefined || run.session === null) {
        repos.approvals.resolve(approvalId, 'deny', nowIso());
        setThreadStatus(thread, 'failed');
        throw conflict('no active run for this approval');
      }
      repos.approvals.resolve(approvalId, decision, nowIso());
      run.session.approve(approvalId, decision);
      repos.turns.setStatus(run.turnId, 'running');
      setThreadStatus(thread, 'running');
    },

    async disposeThread(threadId) {
      denyPending(threadId);
      // A disposed thread (clear, compact, delete, shutdown) must not keep a backlog.
      dropQueue(threadId);
      const run = active.get(threadId);
      if (run !== undefined) {
        if (run.session !== null) await run.session.interrupt().catch(() => undefined);
        run.controller.abort();
        active.delete(threadId);
      }
      const cached = sessions.get(threadId);
      sessions.delete(threadId);
      if (cached !== undefined) {
        await cached.session.dispose().catch(() => {
          logger.warn('session dispose failed', { threadId });
        });
      }
    },

    async disposeAll() {
      const ids = new Set([...active.keys(), ...sessions.keys(), ...queued.keys()]);
      for (const id of ids) {
        await this.disposeThread(id);
      }
    },

    recoverOrphanedRuns() {
      for (const turn of repos.turns.listActive()) {
        const thread = repos.threads.get(turn.threadId);
        if (thread === undefined) {
          repos.turns.finish(turn.id, 'failed', nowIso());
          continue;
        }
        appendEvent(thread.id, {
          type: 'error',
          message: 'server restarted before the turn finished',
          retryable: false,
        });
        // Recovery has no in-flight state, so the durable finished_at fence keeps a
        // repeated recovery from writing a second boundary.
        settleTurn(thread, turn.id, 'error', undefined);
        logger.warn('orphaned turn failed at startup', {
          threadId: thread.id,
          turnId: turn.id,
        });
      }
    },

    listActive: () =>
      [...active.entries()].map(([threadId, run]) => ({
        threadId,
        turnId: run.turnId,
        adapterKey: run.adapterKey,
      })),
  };
}

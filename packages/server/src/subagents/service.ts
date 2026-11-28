import type {
  AdapterEvent,
  PermissionMode,
  Settings,
  SubagentControlRequest,
  SubagentFooterStatus,
  SubagentMessage,
  SubagentQuestionView,
  SubagentSpec,
  SubagentStatus,
  SubagentType,
  SubagentView,
  Thread,
} from '@tuffcode/contracts';
import {
  SUBAGENT_REWORK_LIMIT,
  SUBAGENT_RUN_MINUTES,
  buildSubagentMessage,
  estimateTokens,
  parseNotetakerFacts,
  parseSubagentFooter,
} from '@tuffcode/prompt';
import { newId, worktreesRoot, type Logger } from '@tuffcode/shared';
import { createBrainStore, type BrainStore } from '../brain/store.js';
import type { Repos, SubagentRecord } from '../db/repos/index.js';
import { toSubagentView } from '../db/repos/index.js';
import { badRequest, conflict, notFound, RpcError } from '../errors.js';
import type { EventBus } from '../events.js';
import { provisionWorktree, removeWorktree, resolveBaseRef, tryRunGit } from '../git/index.js';
import type { Runner } from '../runner/runner.js';
import { subagentTitle } from '../titles.js';
import type {
  SubagentChildRequest,
  SubagentPorts,
  SubagentSpawnInput,
  SubagentTarget,
  SubagentTargetSource,
  SubagentTurnInput,
  SubagentTurnResult,
  Subagents,
} from './types.js';

export interface SubagentDeps {
  repos: Repos;
  bus: EventBus;
  runner: Runner;
  logger: Logger;
  settings: () => Settings;
  /** Test seam: any port may be replaced by a fake. */
  ports?: Partial<SubagentPorts>;
  brain?: BrainStore;
}

/** A child that never states a budget is capped here, so one run cannot burn the thread. */
export const DEFAULT_SUBAGENT_BUDGET_TOKENS = 120_000;

/** Summaries travel through events and the subagents table, so they stay bounded. */
const SUMMARY_LIMIT = 4000;

/** Read-only types can only inspect the parent worktree; only a worker gets a checkout. */
const READ_ONLY_TYPES: Partial<Record<SubagentType, true>> = {
  explorer: true,
  reviewer: true,
  notetaker: true,
  planner: true,
};

export function permissionForSubagent(type: SubagentType): PermissionMode {
  return READ_ONLY_TYPES[type] === true ? 'read-only' : 'accept-edits';
}

export function subagentWorktree(type: SubagentType): boolean {
  return type === 'worker';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 3)}...`;
}

/**
 * Picks the provider and model for one child. Order: an explicit spec model, the
 * per-type setting, that setting's fallback model, then the parent thread's own model.
 * A candidate whose provider is missing or disabled is skipped; when the configured
 * provider is unusable the fallback model runs on the parent thread's provider, so a
 * stale settings entry degrades instead of failing the spawn.
 *
 * The effort follows the type's model choice, not the candidate that wins, so an
 * explicit `spec.model` override still runs at the type's configured effort. Null
 * means inherit, which leaves the child on the provider's own default.
 */
export function resolveSubagentTarget(input: {
  spec: SubagentSpec;
  thread: Thread;
  settings: Settings;
  providerUsable: (providerId: string) => boolean;
}): SubagentTarget {
  const choice = input.settings.subagentModels[input.spec.type];
  const effort = choice.effort ?? null;
  const parentProvider = input.thread.providerId;
  const configured = choice.providerId?.trim();
  const configuredUsable = configured !== undefined && input.providerUsable(configured);
  const candidates: SubagentTarget[] = [];
  const push = (
    model: string | undefined,
    providerId: string,
    source: SubagentTargetSource,
  ): void => {
    if (model === undefined || model.trim().length === 0) return;
    candidates.push({ providerId, model: model.trim(), source, effort });
  };

  const specProvider = input.spec.providerId?.trim();
  push(
    input.spec.model,
    specProvider === undefined || specProvider.length === 0
      ? (configured ?? parentProvider)
      : specProvider,
    'spec',
  );
  push(choice.model, configured ?? parentProvider, 'settings');
  push(choice.fallbackModel, configuredUsable ? configured : parentProvider, 'fallback');
  push(input.thread.modelId, parentProvider, 'thread');

  const usable = candidates.find((candidate) => input.providerUsable(candidate.providerId));
  if (usable === undefined) {
    throw new RpcError(
      'provider-unavailable',
      `no usable provider for the ${input.spec.type} subagent`,
    );
  }
  return usable;
}

/**
 * Runs one child turn by watching the bus, the same shape the council turn runner
 * uses. The runner owns the turn, so the service subscribes before `send`, buffers
 * text, forwards every adapter event, and settles on the `turn.finished` frame for
 * the turn id `send` returned. Abort settles as interrupted without waiting.
 */
function createChildTurnRunner(deps: { bus: EventBus; runner: Runner }) {
  return async (input: SubagentTurnInput): Promise<SubagentTurnResult> => {
    if (input.signal.aborted) return { status: 'interrupted', text: '' };

    let buffer = '';
    let errorText: string | null = null;
    let currentTurnId: string | null = null;
    const finished: { value: { turnId: string; reason: SubagentTurnResult['status'] } | null } = {
      value: null,
    };
    let settled = false;
    const { promise, resolve } = Promise.withResolvers<SubagentTurnResult>();
    const settle = (result: SubagentTurnResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const unsubscribe = deps.bus.subscribe((event) => {
      if (event.type !== 'thread.event' || event.threadId !== input.threadId) return;
      const payload = event.payload;
      input.onEvent(payload);
      if (payload.type === 'text.delta') {
        buffer += payload.text;
        return;
      }
      // The adapter reports a provider failure as an `error` frame, not a rejection;
      // keeping its text is what makes a failed child actionable for the parent.
      if (payload.type === 'error') {
        errorText = payload.message;
        return;
      }
      if (payload.type !== 'turn.finished') return;
      finished.value = { turnId: payload.turnId, reason: payload.reason };
      if (currentTurnId === payload.turnId) {
        settle({
          status: payload.reason,
          text: buffer,
          ...(errorText === null ? {} : { error: errorText }),
        });
      }
    });

    const onAbort = (): void => {
      settle({ status: 'interrupted', text: buffer });
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const sent = await deps.runner.send(input.threadId, input.text);
      currentTurnId = sent.turnId;
      if (finished.value !== null && finished.value.turnId === sent.turnId) {
        settle({ status: finished.value.reason, text: buffer });
      }
    } catch (error) {
      settle({ status: 'error', text: buffer, error: errorMessage(error) });
    }

    try {
      return await promise;
    } finally {
      unsubscribe();
      input.signal.removeEventListener('abort', onAbort);
    }
  };
}

interface ChildRun {
  childId: string;
  parentThreadId: string;
  controller: AbortController;
  cancelled: boolean;
  childThreadId: string | null;
}

/**
 * One child blocked on a question. It settles exactly once, by the parent's answer,
 * by a stop or close, by shutdown, or by the timeout; every path clears the timer and
 * removes the entry, so a stopped child can never hang on a question.
 */
interface PendingQuestion {
  questionId: string;
  childId: string;
  /** The parent thread the question was posted to. */
  threadId: string;
  text: string;
  createdAt: string;
  resolve: (text: string) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

/** Live counters for one child; flushed to the row and the bus at most every 500 ms. */
interface Telemetry {
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  activity: string | null;
  flushedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const TELEMETRY_FLUSH_MS = 500;
const ACTIVITY_CHARS = 160;
/** Follow-ups queued for one child before new ones are refused. */
const INBOX_LIMIT = 20;
export const DEFAULT_WAIT_SECONDS = 120;
export const MAX_WAIT_SECONDS = 600;
/** A child waits this long for an answer before it states an assumption and continues. */
export const QUESTION_TIMEOUT_MS = 300_000;
export const QUESTION_TIMEOUT_TEXT =
  'no answer; state your assumption and continue, or return BLOCKED';
export const QUESTION_STOPPED_TEXT = 'the parent stopped this child';
export const QUESTION_SHUTDOWN_TEXT = 'Tuffcode stopped';
/** Mailbox rows one `read` call returns, both directions included. */
export const READ_PAGE_LIMIT = 20;

const ACTIVITY_KEYS = ['command', 'path', 'pattern', 'url', 'task', 'query', 'name', 'action'] as const;

/** "bash: pnpm test" from a tool.started frame: the tool and its most telling argument. */
export function describeActivity(name: string, input: unknown): string {
  let detail = '';
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ACTIVITY_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        detail = value.replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }
  const line = detail.length === 0 ? name : `${name}: ${detail}`;
  return line.length <= ACTIVITY_CHARS ? line : `${line.slice(0, ACTIVITY_CHARS - 3)}...`;
}

function elapsedLabel(view: SubagentView, now: number): string {
  const start = view.startedAt ?? view.createdAt;
  const end = view.finishedAt ?? null;
  const ms = (end === null ? now : Date.parse(end)) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** One status line per child, the format `status` and `wait` hand back to the model. */
export function formatChildLine(view: SubagentView, now = Date.now()): string {
  const usage =
    view.toolCount === undefined
      ? 'usage -'
      : `${view.toolCount} tools, ${view.inputTokens ?? 0} in / ${view.outputTokens ?? 0} out tokens`;
  const activity = view.activity ? `, now ${view.activity}` : '';
  const unread = (view.unread ?? 0) > 0 ? `, ${view.unread} unread` : '';
  return `${view.childId} ${view.type} [${view.status}] ${view.model}: ${usage}, ${elapsedLabel(view, now)}${activity}${unread}`;
}

/** The row close left behind, plus a note when its worktree was kept. */
interface CloseResult {
  view: SubagentView;
  note: string | null;
}

/**
 * Typed subagent runtime: one persisted row and one child session per spawn, a
 * per-parent queue capped by `subagentConcurrency`, a per-child token budget, and
 * events routed to the parent thread under the child id. A failed child never fails
 * the parent turn; cancel is per child.
 */
export function createSubagents(deps: SubagentDeps): Subagents {
  const { repos, bus, logger } = deps;
  const overrides = deps.ports ?? {};
  const brain = deps.brain ?? createBrainStore(repos.brain);
  const runTurn = createChildTurnRunner({ bus, runner: deps.runner });

  const ports: SubagentPorts = {
    createChildThread:
      overrides.createChildThread?.bind(overrides) ??
      ((request) => createChildThread(repos, deps.settings(), request)),
    runTurn: overrides.runTurn?.bind(overrides) ?? runTurn,
  };

  /** Parent thread id -> child ids waiting for a slot, in spawn order. */
  const queues = new Map<string, string[]>();
  /** Parent thread id -> children currently holding a slot. */
  const running = new Map<string, number>();
  const active = new Map<string, ChildRun>();
  const settled = new Set<string>();
  const waiters = new Map<string, (view: SubagentView) => void>();
  const telemetry = new Map<string, Telemetry>();
  /** Follow-ups waiting for the child's current turn to end, oldest first. */
  const inboxes = new Map<string, string[]>();
  /** Open child questions, keyed by question id, in ask order. */
  const pendingQuestions = new Map<string, PendingQuestion>();
  /** Parent thread id -> resolvers waiting for the next question of that thread. */
  const questionWaiters = new Map<string, Set<() => void>>();

  function telemetryFor(record: SubagentRecord): Telemetry {
    const existing = telemetry.get(record.childId);
    if (existing !== undefined) return existing;
    const created: Telemetry = {
      toolCount: record.toolCount ?? 0,
      inputTokens: record.inputTokens ?? 0,
      outputTokens: record.outputTokens ?? 0,
      activity: record.activity ?? null,
      flushedAt: 0,
      timer: null,
    };
    telemetry.set(record.childId, created);
    return created;
  }

  function flushTelemetry(childId: string, parentThreadId: string): void {
    const state = telemetry.get(childId);
    if (state === undefined) return;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.flushedAt = Date.now();
    const counters = {
      toolCount: state.toolCount,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      activity: state.activity,
    };
    try {
      repos.subagents.recordTelemetry(childId, counters);
    } catch (error) {
      // A late timer after shutdown finds the database closed; the counters are advisory.
      logger.debug('subagent telemetry not persisted', { childId, reason: errorMessage(error) });
      return;
    }
    bus.emit({
      kind: 'event',
      type: 'subagent.telemetry',
      threadId: parentThreadId,
      payload: { childId, threadId: parentThreadId, ...counters },
    });
  }

  /** Coalesces bursts: the first change after a quiet period writes at once, the rest wait. */
  function touchTelemetry(childId: string, parentThreadId: string): void {
    const state = telemetry.get(childId);
    if (state === undefined) return;
    const wait = TELEMETRY_FLUSH_MS - (Date.now() - state.flushedAt);
    if (wait <= 0) {
      flushTelemetry(childId, parentThreadId);
      return;
    }
    if (state.timer === null) {
      state.timer = setTimeout(() => flushTelemetry(childId, parentThreadId), wait);
      state.timer.unref?.();
    }
  }

  function recordEvent(childId: string, parentThreadId: string, event: AdapterEvent): void {
    const state = telemetry.get(childId);
    if (state === undefined) return;
    if (event.type === 'tool.started') {
      state.toolCount += 1;
      state.activity = describeActivity(event.name, event.input);
      touchTelemetry(childId, parentThreadId);
    } else if (event.type === 'usage') {
      state.inputTokens += event.inputTokens ?? 0;
      state.outputTokens += event.outputTokens ?? 0;
      touchTelemetry(childId, parentThreadId);
    }
  }

  function postMessage(
    record: Pick<SubagentRecord, 'childId' | 'threadId'>,
    direction: SubagentMessage['direction'],
    text: string,
    options: { id?: string; kind?: SubagentMessage['kind'] } = {},
  ): SubagentMessage {
    const message = repos.subagents.addMessage({
      id: options.id ?? newId('smsg'),
      childId: record.childId,
      direction,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      // A mailbox row is what one agent said to another, so it is stored whole. Only
      // the row summary is bounded, and a truncated summary names the report.
      text,
      createdAt: nowIso(),
    });
    bus.emit({
      kind: 'event',
      type: 'subagent.message',
      threadId: record.threadId,
      payload: { childId: record.childId, threadId: record.threadId, message },
    });
    return message;
  }

  function requireRecord(childId: string): SubagentRecord {
    const record = repos.subagents.get(childId);
    if (record === undefined) throw notFound('subagent not found');
    return record;
  }

  /** Wakes every `wait` blocked on this parent thread: a question arrived. */
  function notifyQuestion(threadId: string): void {
    const waiters = questionWaiters.get(threadId);
    if (waiters === undefined) return;
    questionWaiters.delete(threadId);
    for (const resolve of waiters) resolve();
  }

  /** Settles one open question exactly once, whatever unblocks the child. */
  function settleQuestion(questionId: string, text: string): boolean {
    const pending = pendingQuestions.get(questionId);
    if (pending === undefined || pending.settled) return false;
    pending.settled = true;
    clearTimeout(pending.timer);
    pendingQuestions.delete(questionId);
    pending.resolve(text);
    return true;
  }

  /** Every open question of one child settles with `text`, so a stop never hangs it. */
  function settleChildQuestions(childId: string, text: string): void {
    for (const pending of pendingQuestions.values()) {
      if (pending.childId === childId) settleQuestion(pending.questionId, text);
    }
  }

  function openQuestions(threadId?: string): SubagentQuestionView[] {
    return [...pendingQuestions.values()]
      .filter((pending) => threadId === undefined || pending.threadId === threadId)
      .map((pending) => ({
        questionId: pending.questionId,
        childId: pending.childId,
        threadId: pending.threadId,
        text: pending.text,
        createdAt: pending.createdAt,
      }));
  }

  /**
   * A child posts one blocking question to its parent and waits. The promise resolves
   * with the answer text, with the stopped text when the child is stopped or closed,
   * or with the fallback text after the timeout; it never rejects, so a child turn is
   * never left waiting on a question.
   */
  async function askParent(childId: string, text: string): Promise<string> {
    const record = requireRecord(childId);
    const body = text.trim();
    if (body.length === 0) throw badRequest('question text is empty');
    if (record.closedAt !== null) throw conflict('subagent is closed');
    for (const pending of pendingQuestions.values()) {
      if (pending.childId === childId) throw conflict('a question is already open');
    }
    const questionId = newId('sq');
    const { promise, resolve } = Promise.withResolvers<string>();
    const timer = setTimeout(
      () => settleQuestion(questionId, QUESTION_TIMEOUT_TEXT),
      QUESTION_TIMEOUT_MS,
    );
    timer.unref?.();
    pendingQuestions.set(questionId, {
      questionId,
      childId,
      threadId: record.threadId,
      text: body,
      createdAt: nowIso(),
      resolve,
      timer,
      settled: false,
    });
    postMessage(record, 'to-parent', body, { id: questionId, kind: 'question' });
    bus.emit({
      kind: 'event',
      type: 'subagent.question',
      threadId: record.threadId,
      payload: { childId, threadId: record.threadId, questionId, text: body },
    });
    notifyQuestion(record.threadId);
    return promise;
  }

  /** The parent's or the user's reply: writes the answer row, announces it, unblocks the child. */
  async function answerQuestion(
    questionId: string,
    text: string,
    by: 'parent' | 'user',
    threadId?: string,
  ): Promise<{ childId: string }> {
    const pending = pendingQuestions.get(questionId);
    if (pending === undefined || pending.settled) {
      // A question that was settled by closing its child is not unknown: say so, so the
      // parent knows the transcript survived and the id is simply final.
      const row = repos.subagents.message(questionId);
      const owner = row === undefined ? undefined : repos.subagents.get(row.childId);
      if (owner !== undefined && owner.closedAt !== null) throw conflict('subagent is closed');
      throw notFound(`no open question ${questionId}`);
    }
    if (threadId !== undefined && pending.threadId !== threadId) {
      throw notFound(`no open question ${questionId} under this thread`);
    }
    const record = requireRecord(pending.childId);
    if (record.closedAt !== null) {
      settleQuestion(questionId, QUESTION_STOPPED_TEXT);
      throw conflict('subagent is closed');
    }
    const body = text.trim();
    if (body.length === 0) throw badRequest('answer text is empty');
    postMessage(record, 'to-child', body, { kind: 'answer' });
    bus.emit({
      kind: 'event',
      type: 'subagent.answered',
      threadId: record.threadId,
      payload: {
        childId: record.childId,
        threadId: record.threadId,
        questionId,
        text: body,
        by,
      },
    });
    settleQuestion(questionId, body);
    return { childId: record.childId };
  }

  /**
   * The full report first, then one page of every mailbox row in both directions. A
   * cursor names the last message already read, so the next page starts after it; the
   * report itself is only repeated on the first page, because it is already whole there.
   */
  function readReports(record: SubagentRecord, cursor?: string): string {
    const all = repos.subagents.listMessages(record.childId);
    const trimmed = cursor?.trim() ?? '';
    let from = 0;
    if (trimmed.length > 0) {
      const index = all.findIndex((message) => message.id === trimmed);
      if (index === -1) throw notFound(`no report ${trimmed} under ${record.childId}`);
      from = index + 1;
    }
    const page = all.slice(from, from + READ_PAGE_LIMIT);
    const report = repos.subagents.latestReport(record.childId);
    const parts: string[] = [];
    if (report !== undefined && trimmed.length === 0) {
      parts.push(
        `${record.childId} full report ${report.id} (${report.text.length} chars):\n\n${report.text}`,
      );
    } else {
      parts.push(`${record.childId} summary: ${record.summary ?? '(no summary yet)'}`);
      if (report !== undefined) {
        parts.push(`Full report ${report.id} (${report.text.length} chars) precedes this page.`);
      }
    }
    for (const message of page) {
      const to = message.direction === 'to-child' ? 'to child' : 'to parent';
      parts.push(`${message.id} [${message.kind}] ${to}: ${message.text}`);
    }
    // The cursor names the last message already read, so the next page starts after it.
    const next = from + page.length < all.length ? page[page.length - 1]?.id : undefined;
    if (next !== undefined) parts.push(`Next cursor: ${next}`);
    if (page.length === 0) parts.push(from === 0 ? 'No reports yet.' : 'No more reports.');
    return parts.join('\n\n');
  }

  function emitFinished(record: SubagentRecord): void {
    bus.emit({
      kind: 'event',
      type: 'subagent.finished',
      threadId: record.threadId,
      payload: {
        childId: record.childId,
        threadId: record.threadId,
        status: record.status,
        ...(record.summary === undefined ? {} : { summary: record.summary }),
      },
    });
  }

  /**
   * Settles a child exactly once, whatever the caller (run loop, cancel, failure).
   * The answer is written to `subagent_reports` before the row summary is bounded, so a
   * long answer is never lost: the summary then names the report that holds the rest.
   */
  function finish(
    childId: string,
    status: SubagentStatus,
    summary: string | null = null,
    footerStatus: SubagentFooterStatus | null = null,
  ): SubagentRecord | undefined {
    const existing = repos.subagents.get(childId);
    if (existing === undefined) return undefined;
    if (settled.has(childId)) return existing;
    settled.add(childId);
    flushTelemetry(childId, existing.threadId);
    // A settled child has no live turn, so its cached adapter session only holds a
    // subprocess and memory until the next resume rebuilds it from the transcript.
    if (existing.childThreadId !== null) {
      void deps.runner.disposeThread(existing.childThreadId).catch((error: unknown) => {
        logger.warn('subagent session not disposed', { childId, reason: errorMessage(error) });
      });
    }
    inboxes.delete(childId);
    // A child can never finish while a question is open, but a stop, a budget abort or a
    // restart can land first; resolving here guarantees the pending map never leaks.
    settleChildQuestions(childId, QUESTION_STOPPED_TEXT);
    const full = summary?.trim() ?? '';
    let stored: string | null = null;
    if (summary !== null && full.length > 0) {
      const report = repos.subagents.addReport({
        id: newId('srep'),
        childId,
        text: summary,
        createdAt: nowIso(),
      });
      const body = truncate(summary, SUMMARY_LIMIT);
      // truncate shortens only when the trimmed answer exceeds the limit, so that is
      // exactly when the summary must name the report that holds the whole answer.
      stored =
        full.length > SUMMARY_LIMIT
          ? `${body}\n\n(${body.length} of ${report.text.length} chars); full report ${report.id}: subagent read ${childId}`
          : body;
      logger.debug('subagent report stored', {
        childId,
        reportId: report.id,
        chars: report.text.length,
      });
    }
    const record = repos.subagents.finish(childId, {
      status,
      summary: stored,
      footerStatus,
      updatedAt: nowIso(),
    });
    const view = toSubagentView(record ?? existing);
    const waiter = waiters.get(childId);
    if (waiter !== undefined) {
      waiters.delete(childId);
      waiter(view);
    }
    if (record !== undefined) emitFinished(record);
    return record;
  }

  function pump(parentThreadId: string): void {
    const cap = Math.max(1, deps.settings().subagentConcurrency);
    for (;;) {
      if ((running.get(parentThreadId) ?? 0) >= cap) return;
      const queue = queues.get(parentThreadId);
      const childId = queue?.shift();
      if (childId === undefined) return;
      running.set(parentThreadId, (running.get(parentThreadId) ?? 0) + 1);
      void runChild(childId)
        .catch((error: unknown) => {
          // A throw after the row was marked running would leave it running forever and
          // surface as an unhandled rejection; the row is the record, so settle it here.
          // Shutdown may already have closed the database, which makes settling impossible.
          try {
            finish(childId, 'failed', `child run failed: ${errorMessage(error)}`);
          } catch {
            // The process is stopping; the next start repairs unfinished rows.
          }
        })
        .finally(() => {
          running.set(parentThreadId, Math.max(0, (running.get(parentThreadId) ?? 1) - 1));
          // Nothing may wait: settle after shutdown finds the database closed and stops here.
          if ((queues.get(parentThreadId)?.length ?? 0) === 0) return;
          try {
            pump(parentThreadId);
          } catch (error) {
            logger.warn('subagent queue could not advance', {
              parentThreadId,
              reason: errorMessage(error),
            });
          }
        });
    }
  }

  async function runChild(childId: string): Promise<void> {
    const record = repos.subagents.get(childId);
    if (record === undefined || record.status !== 'queued') return;
    const parent = repos.threads.get(record.threadId);
    if (parent === undefined) {
      finish(childId, 'failed', 'parent thread no longer exists');
      return;
    }

    const run: ChildRun = {
      childId,
      parentThreadId: parent.id,
      controller: new AbortController(),
      cancelled: false,
      childThreadId: null,
    };
    active.set(childId, run);
    repos.subagents.setRunning(childId, null, nowIso());
    bus.emit({
      kind: 'event',
      type: 'subagent.started',
      threadId: parent.id,
      payload: {
        childId,
        threadId: parent.id,
        type: record.type,
        model: record.model,
      },
    });

    try {
      let child: Thread;
      try {
        child = await ports.createChildThread({
          parent,
          type: record.type,
          providerId: record.providerId,
          modelId: record.model,
          permissionMode: permissionForSubagent(record.type),
          worktree: subagentWorktree(record.type),
          task: record.task,
          effort: deps.settings().subagentModels[record.type].effort ?? null,
          ...(record.depth === null ? {} : { depth: record.depth }),
        });
      } catch (error) {
        finish(childId, 'failed', `child session could not start: ${errorMessage(error)}`);
        return;
      }
      run.childThreadId = child.id;
      // Cancel can land while the checkout is being provisioned; the row must stay
      // cancelled and the child turn must never start.
      if (run.cancelled || run.controller.signal.aborted) {
        finish(childId, 'cancelled', 'cancelled before the child turn started');
        await discardChildThread(child, parent);
        return;
      }
      repos.subagents.setRunning(childId, child.id, nowIso());
      const runningRecord = repos.subagents.get(childId) ?? record;
      telemetryFor(runningRecord);
      flushTelemetry(childId, parent.id);

      const project = repos.projects.get(parent.projectId);
      const text = buildSubagentMessage({
        type: record.type,
        task: record.task,
        ...(child.worktreePath === null ? {} : { cwd: child.worktreePath }),
        ...(child.worktreePath === null ? {} : { worktree: child.worktreePath }),
        ...(child.branch === null ? {} : { branch: child.branch }),
        ...(runningRecord.depth === null ? {} : { depth: runningRecord.depth }),
        ...(project === undefined ? {} : { projectName: project.name }),
        parentTitle: parent.title,
      });
      await driveTurns(run, child.id, record, parent, text);
    } finally {
      active.delete(childId);
    }
  }

  /**
   * Runs the child's first turn, then every follow-up that arrived meanwhile, and
   * settles once. Each completed turn's answer is posted to the parent's mailbox, so a
   * steered child reports every round, not only the last one. A child that runs past its
   * type's wall clock limit is stopped, because an adapter exposes no turn counter.
   */
  async function driveTurns(
    run: ChildRun,
    childThreadId: string,
    record: SubagentRecord,
    parent: Thread,
    firstText: string,
  ): Promise<void> {
    const childId = record.childId;
    const budget = record.budgetTokens ?? DEFAULT_SUBAGENT_BUDGET_TOKENS;
    const limitMinutes = SUBAGENT_RUN_MINUTES[record.type];
    let used = 0;
    let exceeded = false;
    let timedOut = false;
    const onEvent = (event: AdapterEvent): void => {
      bus.emit({
        kind: 'event',
        type: 'subagent.event',
        threadId: parent.id,
        payload: { childId, threadId: parent.id, event },
      });
      recordEvent(childId, parent.id, event);
      if (event.type !== 'text.delta') return;
      used += estimateTokens(event.text);
      if (used <= budget || exceeded) return;
      exceeded = true;
      logger.warn('subagent token budget exceeded', { childId, budget });
      run.controller.abort();
      void deps.runner.interrupt(childThreadId).catch(() => undefined);
    };

    const limit = setTimeout(() => {
      timedOut = true;
      logger.warn('subagent minute limit reached', { childId, minutes: limitMinutes });
      run.controller.abort();
      void deps.runner.interrupt(childThreadId).catch(() => undefined);
      finish(childId, 'failed', `child reached its ${limitMinutes} minute limit`);
    }, limitMinutes * 60_000);
    limit.unref?.();

    try {
      let text = firstText;
      for (;;) {
        const result = await ports.runTurn({
          threadId: childThreadId,
          text,
          signal: run.controller.signal,
          onEvent,
        });
        if (timedOut) return;
        if (exceeded) {
          finish(
            childId,
            'failed',
            `Token budget of ${budget} exceeded before the child finished.\n\n${result.text}`,
          );
          return;
        }
        if (run.cancelled) {
          // An aborted turn often returns no text. A cancelled child must still carry a
          // reason the parent and the UI can show, so fall back to the stop reason.
          const stopped = result.text.trim();
          finish(childId, 'cancelled', stopped.length > 0 ? stopped : 'cancelled by the parent');
          return;
        }
        if (result.status !== 'complete') {
          finish(
            childId,
            'failed',
            result.status === 'interrupted'
              ? 'child turn was interrupted'
              : (result.error ?? result.text),
          );
          return;
        }
        const queued = inboxes.get(childId) ?? [];
        const next = queued.shift();
        if (next === undefined) {
          // A turn that completed with no text is not a report: the parent would show a
          // done child with nothing to read, so it settles as a failure instead.
          if (result.text.trim().length === 0) {
            const reason = 'child returned no output';
            postMessage(record, 'to-parent', reason);
            finish(childId, 'failed', reason);
            return;
          }
          // The footer narrows the outcome; it never replaces the answer. A child that
          // declares `blocked` did not finish, so the row settles as failed with its
          // summary; `partial` still counts as done, because the enum has no partial.
          const footer = parseSubagentFooter(result.text);
          const summary = await summarize(record, parent, result.text);
          if (summary.trim().length > 0) {
            postMessage(record, 'to-parent', summary, { kind: 'report' });
          }
          finish(
            childId,
            footer.status === 'blocked' ? 'failed' : 'done',
            summary,
            footer.status,
          );
          return;
        }
        if (result.text.trim().length > 0) {
          postMessage(record, 'to-parent', result.text, { kind: 'report' });
        }
        text = followUpText(next);
      }
    } finally {
      clearTimeout(limit);
    }
  }

  function followUpText(message: string): string {
    return `Follow-up from your parent agent. Continue in the same worktree and answer with a self-contained report.\n\n${message.trim()}`;
  }

  /** A follow-up for a settled done or failed child: reopen it and run one more round. */
  async function resumeChild(record: SubagentRecord, message: string): Promise<void> {
    const parent = repos.threads.get(record.threadId);
    if (parent === undefined || record.childThreadId === null) {
      throw conflict('the child has no session to resume');
    }
    const reopened = repos.subagents.reopen(record.childId, nowIso());
    if (reopened === undefined || reopened.status !== 'running') {
      throw conflict('the child could not be reopened');
    }
    settled.delete(record.childId);
    telemetryFor(reopened);
    const run: ChildRun = {
      childId: record.childId,
      parentThreadId: parent.id,
      controller: new AbortController(),
      cancelled: false,
      childThreadId: record.childThreadId,
    };
    active.set(record.childId, run);
    bus.emit({
      kind: 'event',
      type: 'subagent.started',
      threadId: parent.id,
      payload: { childId: record.childId, threadId: parent.id, type: record.type, model: record.model },
    });
    const childThreadId = record.childThreadId;
    void driveTurns(run, childThreadId, reopened, parent, followUpText(message))
      .catch((error: unknown) => {
        finish(record.childId, 'failed', `follow-up failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (active.get(record.childId) === run) active.delete(record.childId);
      });
  }

  async function sendMessage(
    childId: string,
    text: string,
    options: { rework?: boolean } = {},
  ): Promise<{ delivered: 'queued' | 'started' }> {
    const record = requireRecord(childId);
    const body = text.trim();
    if (body.length === 0) throw badRequest('message text is empty');
    if (record.closedAt !== null) throw conflict('subagent is closed');
    if (record.status === 'cancelled') throw conflict('subagent was stopped');
    if (options.rework === true) {
      if (record.reworkRound >= SUBAGENT_REWORK_LIMIT) {
        const report = repos.subagents.latestReport(childId);
        const where = report === undefined ? '' : `; the last findings are in report ${report.id}`;
        throw conflict(
          `rework limit reached after ${SUBAGENT_REWORK_LIMIT} rounds${where}`,
        );
      }
      repos.subagents.setReworkRound(childId, record.reworkRound + 1);
    }
    postMessage(record, 'to-child', body);
    if (record.status === 'queued' || record.status === 'running') {
      const queue = inboxes.get(childId) ?? [];
      if (queue.length >= INBOX_LIMIT) throw conflict('the child already has 20 queued messages');
      queue.push(body);
      inboxes.set(childId, queue);
      return { delivered: 'queued' };
    }
    await resumeChild(record, body);
    return { delivered: 'started' };
  }

  function parentFor(request: SubagentControlRequest): { thread: Thread; isChild: boolean } {
    if (request.threadId !== undefined) {
      const thread = repos.threads.get(request.threadId);
      if (thread !== undefined) {
        const isChild = repos.subagents
          .listAll()
          .some((entry) => entry.childThreadId === thread.id);
        return { thread, isChild };
      }
    }
    const thread = resolveThreadForCwd(request.cwd);
    if (thread === undefined) throw new RpcError('bad-request', 'no thread owns this worktree');
    return { thread, isChild: false };
  }

  function ownChild(parentThreadId: string, childId: string | undefined): SubagentRecord {
    if (childId === undefined) throw badRequest('id is required');
    const record = repos.subagents.get(childId);
    if (record === undefined || record.threadId !== parentThreadId) {
      throw notFound(`no subagent ${childId} under this thread`);
    }
    return record;
  }

  function childrenOf(parentThreadId: string, childId: string | undefined): SubagentRecord[] {
    return childId === undefined
      ? repos.subagents.listByThread(parentThreadId)
      : [ownChild(parentThreadId, childId)];
  }

  /**
   * Resolves on the next question posted to this parent thread, or at once when one is
   * already open. `cancel` drops the waiter when the race is lost to a settlement.
   */
  function awaitQuestion(parentThreadId: string): { promise: Promise<void>; cancel: () => void } {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (openQuestions(parentThreadId).length > 0) {
      resolve();
      return { promise, cancel: () => undefined };
    }
    const waiters = questionWaiters.get(parentThreadId) ?? new Set<() => void>();
    waiters.add(resolve);
    questionWaiters.set(parentThreadId, waiters);
    return {
      promise,
      cancel: () => {
        const current = questionWaiters.get(parentThreadId);
        if (current === undefined) return;
        current.delete(resolve);
        if (current.size === 0) questionWaiters.delete(parentThreadId);
      },
    };
  }

  async function waitFor(
    parentThreadId: string,
    records: SubagentRecord[],
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const pending = records.filter((record) => record.status === 'queued' || record.status === 'running');
    // A question wakes the wait even when every child is still running, so the parent
    // never sleeps through the one thing a child is blocked on.
    const question = awaitQuestion(parentThreadId);
    const { promise: timeout, resolve: expire } = Promise.withResolvers<void>();
    const timer = setTimeout(expire, timeoutSeconds * 1000);
    timer.unref?.();
    const onAbort = (): void => expire();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const settledChildren =
        pending.length === 0
          ? Promise.resolve()
          : Promise.all(pending.map((record) => api.awaitChild(record.childId)));
      await Promise.race([settledChildren, timeout, question.promise]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      question.cancel();
    }
  }

  function readInbox(parentThreadId: string, childId: string | undefined): string {
    const records = childrenOf(parentThreadId, childId);
    const lines: string[] = [];
    const now = nowIso();
    for (const record of records) {
      for (const message of repos.subagents.unreadMessages(record.childId)) {
        lines.push(`${record.childId} (${record.type}): ${message.text}`);
      }
      repos.subagents.markRead(record.childId, now);
    }
    return lines.length === 0 ? 'No unread reports.' : lines.join('\n\n');
  }

  async function control(request: SubagentControlRequest): Promise<string> {
    const { thread, isChild } = parentFor(request);
    if (isChild) {
      // A child may report to its parent, ask it one blocking question, page its own
      // reports and read its own status, nothing else.
      const self = repos.subagents.listAll().find((entry) => entry.childThreadId === thread.id);
      if (self === undefined) throw notFound('subagent not found');
      if (request.action === 'report') {
        const text = (request.text ?? '').trim();
        if (text.length === 0) throw badRequest('text is required');
        postMessage(self, 'to-parent', text, { kind: 'report' });
        return 'Report delivered to the parent.';
      }
      if (request.action === 'status') return formatChildLine(toSubagentView(self));
      if (request.action === 'ask') {
        const text = (request.text ?? '').trim();
        if (text.length === 0) throw badRequest('text is required');
        return askParent(self.childId, text);
      }
      if (request.action === 'read') return readReports(self, request.cursor);
      throw new RpcError('permission-denied', `a subagent cannot ${request.action} other subagents`);
    }
    switch (request.action) {
      case 'status': {
        const records = childrenOf(thread.id, request.id);
        if (records.length === 0) return 'No subagents under this thread.';
        return records.map((record) => formatChildLine(toSubagentView(record))).join('\n');
      }
      case 'wait': {
        const seconds = Math.min(
          MAX_WAIT_SECONDS,
          Math.max(1, Math.floor(request.timeoutSeconds ?? DEFAULT_WAIT_SECONDS)),
        );
        await waitFor(thread.id, childrenOf(thread.id, request.id), seconds, request.signal);
        const records = childrenOf(thread.id, request.id);
        if (records.length === 0) return 'No subagents under this thread.';
        const running = records.filter((record) => record.status === 'queued' || record.status === 'running');
        // A blocked child comes first: it is the only thing that cannot make progress.
        const parts = openQuestions(thread.id).map(
          (question) => `${question.childId} ${question.questionId}: ${question.text}`,
        );
        parts.push(
          ...records
            .filter((record) => record.status !== 'queued' && record.status !== 'running')
            .map((record) => `${formatChildLine(toSubagentView(record))}\n${record.summary ?? '(no summary)'}`),
        );
        if (running.length > 0) {
          parts.push(`Still running after ${seconds}s: ${running.map((record) => record.childId).join(', ')}`);
        }
        for (const record of records) {
          if (record.status !== 'queued' && record.status !== 'running') {
            repos.subagents.markRead(record.childId, nowIso());
          }
        }
        return parts.join('\n\n');
      }
      case 'message': {
        const record = ownChild(thread.id, request.id);
        const { delivered } = await sendMessage(record.childId, request.text ?? '', {
          rework: request.rework === true,
        });
        return delivered === 'queued'
          ? `Queued for ${record.childId}; it reads the message when its current turn ends.`
          : `${record.childId} reopened with the message; wait for its next report.`;
      }
      case 'stop': {
        const record = ownChild(thread.id, request.id);
        await api.cancel(record.childId);
        return `${record.childId} stopped.`;
      }
      case 'ask':
        throw badRequest('ask is for subagents; the parent answers with answer and reads with wait');
      case 'answer': {
        const questionId = request.questionId?.trim() ?? '';
        if (questionId.length === 0) throw badRequest('question_id is required');
        const text = (request.text ?? '').trim();
        if (text.length === 0) throw badRequest('text is required');
        const { childId } = await answerQuestion(questionId, text, 'parent', thread.id);
        return `Answered ${questionId}; ${childId} continues with your answer.`;
      }
      case 'close': {
        const record = ownChild(thread.id, request.id);
        const { view, note } = await closeChild(record.childId);
        return `${record.childId} closed (${view.status}); its transcript is kept.${
          note === null ? '' : ` ${note}.`
        }`;
      }
      case 'read': {
        const record = ownChild(thread.id, request.id);
        return readReports(record, request.cursor);
      }
      case 'inbox':
        return readInbox(thread.id, request.id);
      case 'report':
        throw badRequest('report is for subagents; the parent reads reports with inbox');
    }
  }

  /**
   * A notetaker's answer is a JSON fact list; the service owns the brain write so a
   * read-only child never needs a write tool. Other types return their text as is.
   * Each new fact is linked `about` the project's existing brain entry, resolved
   * before the write so a fresh fact can never become its own anchor.
   */
  async function summarize(record: SubagentRecord, parent: Thread, text: string): Promise<string> {
    if (record.type !== 'notetaker') return text;
    const facts = parseNotetakerFacts(text);
    const settings = deps.settings();
    if (facts.length === 0 || !settings.brainEnabled || !settings.brainCapture) return text;
    const anchor = repos.brain.list({
      kind: 'project',
      projectId: parent.projectId,
      limit: 1,
    })[0];
    let stored = 0;
    for (const fact of facts) {
      try {
        const entry = brain.upsert({
          kind: 'project',
          scope: 'project',
          projectId: parent.projectId,
          text: fact.text,
          tags: fact.tags,
          importance: fact.importance,
        });
        stored += 1;
        if (anchor !== undefined && anchor.id !== entry.id) {
          repos.brain.upsertEdge({ from: entry.id, to: anchor.id, relation: 'about' });
        }
      } catch (error) {
        logger.warn('notetaker fact could not be stored', {
          childId: record.childId,
          message: errorMessage(error),
        });
      }
    }
    return `Recorded ${stored} of ${facts.length} facts in the brain.\n\n${text}`;
  }

  function resolveThreadForCwd(cwd: string): Thread | undefined {
    const childThreads = new Set(
      repos.subagents
        .listAll()
        .map((record) => record.childThreadId)
        .filter((id): id is string => id !== null),
    );
    const normalized = cwd.trim().toLowerCase();
    const candidates = repos.threads
      .list()
      .filter((thread) => thread.worktreePath !== null && !childThreads.has(thread.id))
      .filter((thread) => thread.worktreePath?.trim().toLowerCase() === normalized)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates[0];
  }

  async function spawnChild({
    threadId,
    spec,
    depth,
  }: SubagentSpawnInput): Promise<{ childId: string }> {
    const parent = repos.threads.get(threadId);
    if (parent === undefined) throw notFound('thread not found');
    if (spec.task.trim().length === 0) throw badRequest('subagent task is empty');
    const target = resolveSubagentTarget({
      spec,
      thread: parent,
      settings: deps.settings(),
      providerUsable: (providerId) => repos.providers.get(providerId)?.enabled === true,
    });

    const childId = newId('sub');
    const createdAt = nowIso();
    repos.subagents.create({
      childId,
      threadId: parent.id,
      type: spec.type,
      providerId: target.providerId,
      model: target.model,
      status: 'queued',
      task: spec.task,
      budgetTokens: spec.budgetTokens ?? DEFAULT_SUBAGENT_BUDGET_TOKENS,
      depth: depth ?? null,
      createdAt,
    });
    logger.debug('subagent queued', {
      childId,
      threadId: parent.id,
      type: spec.type,
      model: target.model,
      source: target.source,
    });

    const queue = queues.get(parent.id) ?? [];
    queue.push(childId);
    queues.set(parent.id, queue);
    pump(parent.id);
    return { childId };
  }

  /** `git rev-list --count <base>..HEAD` in one checkout; 0 when git cannot answer. */
  async function commitsAhead(worktreePath: string, base: string): Promise<number> {
    const ref = await resolveBaseRef(worktreePath, base).catch(() => base);
    const count = await tryRunGit(['rev-list', '--count', `${ref}..HEAD`], worktreePath);
    if (!count.ok) return 0;
    const parsed = Number.parseInt(count.stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /**
   * Removes a child thread that was provisioned but never ran: the checkout holds no
   * work by definition, so keeping it would leak a worktree and a top-level thread row.
   */
  async function discardChildThread(child: Thread, parent: Thread): Promise<void> {
    const project = repos.projects.get(parent.projectId);
    if (
      project !== undefined &&
      child.worktreePath !== null &&
      child.worktreePath !== parent.worktreePath
    ) {
      try {
        await removeWorktree(project.path, child.worktreePath, {
          worktreesRoot: deps.settings().worktreeRoot ?? worktreesRoot(),
        });
      } catch (error) {
        logger.warn('cancelled child worktree not removed', {
          childId: child.id,
          reason: errorMessage(error),
        });
      }
    }
    try {
      repos.threads.remove(child.id);
    } catch (error) {
      logger.warn('cancelled child thread not removed', {
        childId: child.id,
        reason: errorMessage(error),
      });
    }
  }

  /**
   * Disposes a child's own checkout only when it holds nothing worth keeping. A
   * read-only child shares the parent checkout, so it is never touched here; a
   * worktree with commits or uncommitted changes is kept and reported.
   */
  async function archiveWorktree(record: SubagentRecord): Promise<string | null> {
    const parent = repos.threads.get(record.threadId);
    const child = record.childThreadId === null ? undefined : repos.threads.get(record.childThreadId);
    if (parent === undefined || child === undefined) return null;
    const worktreePath = child.worktreePath;
    if (worktreePath === null || parent.worktreePath === worktreePath) return null;
    const project = repos.projects.get(parent.projectId);
    if (project === undefined) return null;
    const commits = await commitsAhead(worktreePath, child.baseBranch ?? project.defaultBranch);
    const status = await tryRunGit(['status', '--porcelain'], worktreePath);
    const dirty = status.ok && status.stdout.trim().length > 0;
    if (commits > 0 || dirty) {
      const held = dirty ? 'uncommitted changes' : `${commits} commit${commits === 1 ? '' : 's'}`;
      return `worktree kept at ${worktreePath} (${held})`;
    }
    try {
      await removeWorktree(project.path, worktreePath, {
        worktreesRoot: deps.settings().worktreeRoot ?? worktreesRoot(),
      });
    } catch (error) {
      logger.warn('subagent worktree not disposed', {
        childId: record.childId,
        reason: errorMessage(error),
      });
      return `worktree kept at ${worktreePath} (it could not be removed)`;
    }
    return null;
  }

  /**
   * Final: stops a running child, keeps every message row and marks the row closed.
   * The status stays one of the five values, so the transcript keeps its outcome. A
   * second close is a no-op, and a closed child refuses message, ask and answer.
   */
  async function closeChild(childId: string): Promise<CloseResult> {
    const record = requireRecord(childId);
    if (record.closedAt !== null) return { view: toSubagentView(record), note: null };
    if (record.status === 'queued' || record.status === 'running') {
      await api.cancel(childId);
    }
    settleChildQuestions(childId, QUESTION_STOPPED_TEXT);
    const note = await archiveWorktree(record);
    const final = repos.subagents.close(childId, nowIso()) ?? requireRecord(childId);
    const view = toSubagentView(final);
    // A queued or running child already emitted finished from cancel; a settled one
    // emits here so the UI refreshes its row and learns closedAt.
    if (record.status !== 'queued' && record.status !== 'running') emitFinished(final);
    return { view, note };
  }

  const api: Subagents = {
    spawn: spawnChild,
    control,
    message: sendMessage,
    ask: askParent,
    async answer(questionId, text, by = 'parent', threadId) {
      await answerQuestion(questionId, text, by, threadId);
    },
    openQuestions,
    async close(childId) {
      return (await closeChild(childId)).view;
    },
    read: (childId, cursor) => readReports(requireRecord(childId), cursor),
    messages: (childId) => {
      requireRecord(childId);
      return repos.subagents.listMessages(childId);
    },
    get: (childId) => toSubagentView(requireRecord(childId)),

    async spawnFromTool(request) {
      const known = request.threadId === undefined ? undefined : repos.threads.get(request.threadId);
      if (
        known !== undefined &&
        repos.subagents.listAll().some((entry) => entry.childThreadId === known.id)
      ) {
        throw new RpcError('permission-denied', 'subagents cannot spawn their own subagents');
      }
      const parent = known ?? resolveThreadForCwd(request.cwd);
      if (parent === undefined) {
        throw new RpcError('bad-request', 'no thread owns this worktree');
      }
      if (parent.permissionMode === 'read-only') {
        throw new RpcError('bad-request', 'subagents cannot be spawned from a read-only turn');
      }
      const spec: SubagentSpec = {
        type: request.type,
        task: request.task,
        ...(request.model === undefined ? {} : { model: request.model }),
      };
      const { childId } = await spawnChild({
        threadId: parent.id,
        spec,
        ...(request.depth === undefined ? {} : { depth: request.depth }),
      });
      const record = repos.subagents.get(childId);
      return { childId, status: record?.status ?? 'queued' };
    },

    async cancel(childId) {
      const record = requireRecord(childId);
      // Stop answers every open question, whatever the row status, so nothing hangs.
      settleChildQuestions(childId, QUESTION_STOPPED_TEXT);
      if (record.status === 'queued') {
        const queue = queues.get(record.threadId);
        if (queue !== undefined) {
          queues.set(
            record.threadId,
            queue.filter((id) => id !== childId),
          );
        }
        finish(childId, 'cancelled', 'cancelled before it started');
        return;
      }
      if (record.status !== 'running') return;
      const run = active.get(childId);
      if (run === undefined) {
        finish(childId, 'cancelled', 'cancelled before it started');
        return;
      }
      run.cancelled = true;
      run.controller.abort();
      if (run.childThreadId !== null) {
        await deps.runner.interrupt(run.childThreadId).catch(() => undefined);
      }
      finish(childId, 'cancelled', 'cancelled by the parent');
    },

    async cancelAll(threadId) {
      for (const record of repos.subagents.listByThread(threadId)) {
        if (record.status !== 'queued' && record.status !== 'running') continue;
        await api.cancel(record.childId).catch((error: unknown) => {
          logger.warn('child not cancelled with its parent thread', {
            childId: record.childId,
            reason: errorMessage(error),
          });
        });
      }
    },

    list(threadId) {
      return repos.subagents.listByThread(threadId).map(toSubagentView);
    },

    listAll() {
      return repos.subagents.listAll().map(toSubagentView);
    },

    awaitChild(childId) {
      const record = requireRecord(childId);
      if (settled.has(childId) || (record.status !== 'queued' && record.status !== 'running')) {
        return Promise.resolve(toSubagentView(record));
      }
      const { promise, resolve } = Promise.withResolvers<SubagentView>();
      const existing = waiters.get(childId);
      waiters.set(childId, (view) => {
        existing?.(view);
        resolve(view);
      });
      return promise;
    },

    recoverOrphaned() {
      // A child that was running with an open question is failed here like any other
      // orphan; the pending map is empty in a fresh process, and `failUnfinished` never
      // touches `closed_at`, so a closed row keeps its marker across a restart. The
      // question row and every other mailbox row survive, so the parent still reads what
      // the child asked and everything it had already reported.
      const failed = repos.subagents.failUnfinished(
        nowIso(),
        'server restarted before the subagent finished',
      );
      if (failed > 0) logger.warn('orphaned subagents failed at startup', { count: failed });
      return failed;
    },

    async dispose() {
      const childIds = new Set([
        ...active.keys(),
        ...[...queues.values()].flat(),
        ...[...pendingQuestions.values()].map((pending) => pending.childId),
      ]);
      for (const childId of childIds) {
        // Shutdown says so explicitly; cancel's own settle then finds nothing pending.
        settleChildQuestions(childId, QUESTION_SHUTDOWN_TEXT);
        await this.cancel(childId).catch(() => undefined);
      }
      // A question whose child row vanished still gets an answer and loses its timer.
      for (const pending of pendingQuestions.values()) {
        clearTimeout(pending.timer);
        pending.resolve(QUESTION_SHUTDOWN_TEXT);
      }
      pendingQuestions.clear();
      questionWaiters.clear();
      queues.clear();
      active.clear();
      for (const state of telemetry.values()) {
        if (state.timer !== null) clearTimeout(state.timer);
      }
      telemetry.clear();
      inboxes.clear();
    },
  };
  return api;
}

/**
 * Creates the child thread row: a worker gets its own worktree on a
 * `tuffcode/<threadId>` branch; every read-only type shares the parent's checkout so
 * it inspects exactly what the parent sees and never touches the main tree.
 */
async function createChildThread(
  repos: Repos,
  settings: Settings,
  request: SubagentChildRequest,
): Promise<Thread> {
  const project = repos.projects.get(request.parent.projectId);
  if (project === undefined) throw notFound('project not found');
  const provider = repos.providers.get(request.providerId);
  if (provider === undefined) throw notFound('provider not found');
  if (!provider.enabled) throw new RpcError('provider-unavailable', 'provider is disabled');

  const id = newId('thr');
  const now = nowIso();
  const title = subagentTitle(request.type, request.task);
  const base = {
    id,
    projectId: project.id,
    parentThreadId: request.parent.id,
    title,
    providerId: provider.id,
    modelId: request.modelId,
    executionMode: 'work' as const,
    permissionMode: request.permissionMode,
    reasoningEffort: request.effort,
    status: 'idle' as const,
    createdAt: now,
    updatedAt: now,
  };

  if (!request.worktree) {
    if (request.parent.worktreePath === null) {
      throw conflict('parent thread has no worktree');
    }
    return repos.threads.create({
      ...base,
      worktreePath: request.parent.worktreePath,
      branch: request.parent.branch,
      baseBranch: request.parent.baseBranch,
    });
  }

  const root = settings.worktreeRoot ?? worktreesRoot();
  const worktree = await provisionWorktree({
    repoPath: project.path,
    baseBranch: request.parent.baseBranch ?? project.defaultBranch,
    projectId: project.id,
    threadId: id,
    worktreesRoot: root,
  });
  try {
    return repos.threads.create({
      ...base,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
    });
  } catch (error) {
    await removeWorktree(project.path, worktree.path).catch(() => undefined);
    throw error;
  }
}

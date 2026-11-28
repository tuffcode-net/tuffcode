import type { ApprovalChoice, Attachment, Message, ThreadEventRow } from '@tuffcode/contracts';

export type LocalMessageStatus = 'pending' | 'sent' | 'queued' | 'failed';

export interface LocalUserMessage {
  id: string;
  threadId: string;
  turnId: string | null;
  text: string;
  attachments: Attachment[];
  status: LocalMessageStatus;
  createdAt: string;
}

export type ApprovalDecisionMap = Readonly<Record<string, ApprovalChoice>>;

export interface UserItem {
  kind: 'user';
  key: string;
  messageId: string;
  turnId: string | null;
  text: string;
  attachments: Attachment[];
  status: LocalMessageStatus;
}

export interface AssistantItem {
  kind: 'assistant';
  key: string;
  turnId: string;
  text: string;
  streaming: boolean;
}

export interface ReasoningItem {
  kind: 'reasoning';
  key: string;
  turnId: string;
  text: string;
  streaming: boolean;
  /** First reasoning delta, used for the "Thought for Ns" label. */
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ToolItem {
  kind: 'tool';
  key: string;
  turnId: string;
  toolCallId: string;
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Consecutive tool calls folded under one expandable summary row. */
export interface ToolGroupItem {
  kind: 'tool-group';
  key: string;
  turnId: string;
  tools: ToolItem[];
}

export interface ApprovalItem {
  kind: 'approval';
  key: string;
  turnId: string;
  approvalId: string;
  name: string;
  input: unknown;
  decision: ApprovalChoice | null;
}

export interface NoticeItem {
  kind: 'notice';
  key: string;
  tone: 'error' | 'info' | 'warning';
  text: string;
}

export type TimelineItem =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | ToolGroupItem
  | ApprovalItem
  | NoticeItem;

export interface GroupTimelineInput {
  events: readonly ThreadEventRow[];
  /** Rows from `messages.list`; they fill gaps the event replay does not cover. */
  messages?: readonly Message[];
  userMessages: readonly LocalUserMessage[];
  approvals: ApprovalDecisionMap;
  /** Turns replaced by an edited prompt; their rows and events stay hidden. */
  supersededTurns?: ReadonlySet<string>;
}

interface TurnState {
  usersPlaced: boolean;
  /** The assistant segment still receiving text, or null once a tool closes it. */
  assistant: AssistantItem | null;
  /** Text of assistant rows already closed by a tool call, in order. */
  closedTexts: string[];
  /** Distinguishes the prose and answer rows of one turn. */
  assistantSeq: number;
  /** The reasoning segment still receiving deltas, or null once it is closed. */
  reasoning: ReasoningItem | null;
  /** Distinguishes the reasoning segments of one turn. */
  reasoningSeq: number;
  tools: Map<string, ToolItem>;
  /** The assistant text came from the persisted row, so later deltas are stale. */
  assistantFinal: boolean;
}

/** The server derives message ids from the turn, so a row identifies its turn. */
const PERSISTED_MESSAGE_ID = /^msg_(.+)_(user|assistant)$/;

function turnIdForMessage(message: Message): string | null {
  const match = PERSISTED_MESSAGE_ID.exec(message.id);
  if (match === null || match[2] !== message.role) return null;
  return match[1] ?? null;
}

/** Turn ids that already have a persisted row, used to prune resolved echoes. */
export function persistedTurnIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const turnId = turnIdForMessage(message);
    if (turnId !== null) ids.add(turnId);
  }
  return ids;
}

/**
 * The echo and its persisted row are written during one request, so they land
 * within seconds. A tight window keeps two identical sends from merging.
 */
const ECHO_MATCH_WINDOW_MS = 5_000;

function sameEchoText(echo: LocalUserMessage, row: LocalUserMessage): boolean {
  if (echo.text.trim() !== row.text.trim()) return false;
  const echoTime = Date.parse(echo.createdAt);
  const rowTime = Date.parse(row.createdAt);
  if (Number.isNaN(echoTime) || Number.isNaN(rowTime)) return false;
  return Math.abs(echoTime - rowTime) <= ECHO_MATCH_WINDOW_MS;
}

function persistedUserMessage(message: Message): LocalUserMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    turnId: turnIdForMessage(message),
    text: message.content,
    attachments: message.attachments ?? [],
    status: 'sent',
    createdAt: message.createdAt,
  };
}

/**
 * A persisted row is the canonical copy of a sent message; the session-local echo
 * only survives while no row exists, and it keeps its attachments either way.
 * Turn ids claim their row first so a text match cannot steal it.
 */
function mergeUserMessages(
  persisted: LocalUserMessage[],
  echoes: readonly LocalUserMessage[],
): LocalUserMessage[] {
  const merged = persisted.slice();
  const claimed = new Set<string>();
  const loose: LocalUserMessage[] = [];

  for (const echo of echoes) {
    if (echo.turnId === null) {
      loose.push(echo);
      continue;
    }
    const match = merged.find((row) => !claimed.has(row.id) && row.turnId === echo.turnId);
    if (match === undefined) {
      merged.push(echo);
      continue;
    }
    claimed.add(match.id);
    if (echo.attachments.length > 0) match.attachments = echo.attachments;
  }

  for (const echo of loose) {
    const match = merged.find((row) => !claimed.has(row.id) && sameEchoText(echo, row));
    if (match === undefined) {
      merged.push(echo);
      continue;
    }
    claimed.add(match.id);
    if (echo.attachments.length > 0) match.attachments = echo.attachments;
  }

  return merged;
}

function userItem(message: LocalUserMessage): UserItem {
  return {
    kind: 'user',
    key: `user-${message.id}`,
    messageId: message.id,
    turnId: message.turnId,
    text: message.text,
    attachments: message.attachments,
    status: message.status,
  };
}

/**
 * The last-resort order for a row that names no turn the replay covers. It only
 * ever compares against events, and only for rows whose turn has no anchor.
 */
function precedesEvent(message: Message, event: ThreadEventRow): boolean {
  if (message.createdAt === event.createdAt) return message.role === 'user';
  return message.createdAt < event.createdAt;
}

/**
 * Ends the open reasoning segment. A later delta starts a fresh block, so
 * reasoning that a tool or a text delta interrupted stays in event order.
 */
function closeReasoning(state: TurnState, at: string): void {
  if (!state.reasoning) return;
  state.reasoning.streaming = false;
  if (state.reasoning.finishedAt === null) state.reasoning.finishedAt = at;
  state.reasoning = null;
}

/**
 * Folds the per-thread event log into render rows. Persisted message rows are
 * interleaved by `createdAt`, so a reopened thread keeps its user turns and any
 * assistant text the replay does not cover. Reasoning and text deltas accumulate
 * into their open segment until a tool closes both; the persisted row replaces
 * the closing text instead of adding a duplicate.
 */
export function groupTimeline({
  events,
  messages = [],
  userMessages,
  approvals,
  supersededTurns,
}: GroupTimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [];
  const turns = new Map<string, TurnState>();
  const usersByTurn = new Map<string, LocalUserMessage[]>();
  const pending: LocalUserMessage[] = [];
  const superseded = supersededTurns ?? new Set<string>();

  const persistedUsers = messages
    .filter((message) => message.role === 'user')
    .map(persistedUserMessage)
    .filter((message) => message.turnId === null || !superseded.has(message.turnId));
  const users = mergeUserMessages(persistedUsers, userMessages).filter(
    (message) => message.turnId === null || !superseded.has(message.turnId),
  );

  for (const message of users) {
    if (message.turnId === null) {
      pending.push(message);
      continue;
    }
    const list = usersByTurn.get(message.turnId);
    if (list) list.push(message);
    else usersByTurn.set(message.turnId, [message]);
  }

  function turnState(turnId: string): TurnState {
    let state = turns.get(turnId);
    if (!state) {
      state = {
        usersPlaced: false,
        assistant: null,
        closedTexts: [],
        assistantSeq: 0,
        reasoning: null,
        reasoningSeq: 0,
        tools: new Map(),
        assistantFinal: false,
      };
      turns.set(turnId, state);
    }
    return state;
  }

  function placeUsers(turnId: string): void {
    const state = turnState(turnId);
    if (state.usersPlaced) return;
    state.usersPlaced = true;
    for (const message of usersByTurn.get(turnId) ?? []) items.push(userItem(message));
  }

  function placePersistedUser(message: Message): void {
    const turnId = turnIdForMessage(message);
    if (turnId === null) {
      items.push(userItem(persistedUserMessage(message)));
      return;
    }
    placeUsers(turnId);
  }

  function placePersistedAssistant(message: Message): void {
    const turnId = turnIdForMessage(message);
    if (turnId === null) {
      items.push({
        kind: 'assistant',
        key: `assistant-${message.id}`,
        turnId: message.id,
        text: message.content,
        streaming: false,
      });
      return;
    }
    const state = turnState(turnId);
    // The server stores the whole turn text, prose included; the closed rows
    // already show that part, so the answer row keeps only the remainder.
    const closed = state.closedTexts.join('');
    const content =
      closed.length > 0 && message.content.startsWith(closed)
        ? message.content.slice(closed.length)
        : message.content;
    if (state.assistant) {
      state.assistant.text = content;
      state.assistant.streaming = false;
      state.assistantFinal = true;
      return;
    }
    state.assistantFinal = true;
    if (content.length === 0) return;
    state.assistant = {
      kind: 'assistant',
      key: `assistant-${turnId}-${state.assistantSeq}`,
      turnId,
      text: content,
      streaming: false,
    };
    state.assistantSeq += 1;
    items.push(state.assistant);
  }

  // Wall clocks cannot order a live renderer event against a persisted row, so
  // the replay itself anchors both: a user row sits before its turn's first
  // event and an assistant row after its turn's last one.
  const firstEventIndex = new Map<string, number>();
  const lastEventIndex = new Map<string, number>();
  events.forEach((event, index) => {
    const payload = event.payload;
    if (!('turnId' in payload)) return;
    if (!firstEventIndex.has(payload.turnId)) firstEventIndex.set(payload.turnId, index);
    lastEventIndex.set(payload.turnId, index);
  });

  const persisted = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .filter((message) => {
      const turnId = turnIdForMessage(message);
      return turnId === null || !superseded.has(turnId);
    })
    .toSorted((left, right) => {
      if (left.createdAt === right.createdAt) return left.id.localeCompare(right.id);
      return left.createdAt < right.createdAt ? -1 : 1;
    });

  const usersBefore = new Map<number, Message[]>();
  const assistantsAfter = new Map<number, Message[]>();
  const loose: Message[] = [];

  for (const message of persisted) {
    const turnId = turnIdForMessage(message);
    const anchor =
      turnId === null
        ? undefined
        : message.role === 'user'
          ? firstEventIndex.get(turnId)
          : lastEventIndex.get(turnId);
    if (anchor === undefined) {
      loose.push(message);
      continue;
    }
    const bucket = message.role === 'user' ? usersBefore : assistantsAfter;
    const list = bucket.get(anchor);
    if (list) list.push(message);
    else bucket.set(anchor, [message]);
  }

  const entries: (Message | ThreadEventRow)[] = [];
  let nextLoose = 0;
  for (const [index, event] of events.entries()) {
    while (nextLoose < loose.length) {
      const message = loose[nextLoose];
      if (message === undefined || !precedesEvent(message, event)) break;
      entries.push(message);
      nextLoose += 1;
    }
    for (const message of usersBefore.get(index) ?? []) entries.push(message);
    entries.push(event);
    for (const message of assistantsAfter.get(index) ?? []) entries.push(message);
  }
  while (nextLoose < loose.length) {
    const message = loose[nextLoose];
    if (message !== undefined) entries.push(message);
    nextLoose += 1;
  }

  for (const entry of entries) {
    if ('role' in entry) {
      if (entry.role === 'user') placePersistedUser(entry);
      else if (entry.role === 'assistant') placePersistedAssistant(entry);
      continue;
    }

    const event = entry;
    const payload = event.payload;
    if ('turnId' in payload) {
      if (superseded.has(payload.turnId)) continue;
      placeUsers(payload.turnId);
    }

    switch (payload.type) {
      case 'text.delta': {
        if (payload.text.length === 0) break;
        const state = turnState(payload.turnId);
        closeReasoning(state, event.createdAt);
        if (state.assistantFinal) break;
        if (!state.assistant) {
          state.assistant = {
            kind: 'assistant',
            key: `assistant-${payload.turnId}-${state.assistantSeq}`,
            turnId: payload.turnId,
            text: '',
            streaming: true,
          };
          state.assistantSeq += 1;
          items.push(state.assistant);
        }
        state.assistant.text += payload.text;
        break;
      }
      case 'reasoning.delta': {
        if (payload.text.length === 0) break;
        const state = turnState(payload.turnId);
        let segment = state.reasoning;
        if (!segment || segment.finishedAt !== null) {
          segment = {
            kind: 'reasoning',
            key: `reasoning-${payload.turnId}-${state.reasoningSeq}`,
            turnId: payload.turnId,
            text: '',
            streaming: true,
            startedAt: event.createdAt,
            finishedAt: null,
          };
          state.reasoning = segment;
          state.reasoningSeq += 1;
          items.push(segment);
        }
        segment.text += payload.text;
        break;
      }
      case 'tool.started': {
        const state = turnState(payload.turnId);
        closeReasoning(state, event.createdAt);
        // Text before a tool is prose, not the answer; the next delta starts a new row.
        if (state.assistant) {
          state.assistant.streaming = false;
          state.closedTexts.push(state.assistant.text);
        }
        state.assistant = null;
        const item: ToolItem = {
          kind: 'tool',
          key: `tool-${payload.toolCallId}`,
          turnId: payload.turnId,
          toolCallId: payload.toolCallId,
          name: payload.name,
          input: payload.input,
          output: '',
          isError: false,
          running: true,
          startedAt: event.createdAt,
          finishedAt: null,
        };
        state.tools.set(payload.toolCallId, item);
        items.push(item);
        break;
      }
      case 'tool.delta': {
        const item = turnState(payload.turnId).tools.get(payload.toolCallId);
        if (item) item.output += payload.text;
        break;
      }
      case 'tool.finished': {
        const item = turnState(payload.turnId).tools.get(payload.toolCallId);
        if (item) {
          item.output = payload.output;
          item.isError = payload.isError;
          item.running = false;
          item.finishedAt = event.createdAt;
        }
        break;
      }
      case 'approval.requested': {
        items.push({
          kind: 'approval',
          key: `approval-${payload.approvalId}`,
          turnId: payload.turnId,
          approvalId: payload.approvalId,
          name: payload.name,
          input: payload.input,
          decision: approvals[payload.approvalId] ?? null,
        });
        break;
      }
      case 'turn.finished': {
        const state = turns.get(payload.turnId);
        if (state?.assistant) state.assistant.streaming = false;
        if (state?.reasoning) {
          state.reasoning.streaming = false;
          if (state.reasoning.finishedAt === null) state.reasoning.finishedAt = event.createdAt;
        }
        break;
      }
      case 'error': {
        items.push({
          kind: 'notice',
          key: `notice-${event.seq}`,
          tone: 'error',
          text: payload.message,
        });
        break;
      }
      case 'notice': {
        items.push({
          kind: 'notice',
          key: `notice-${event.seq}`,
          tone: payload.tone,
          text: payload.message,
        });
        break;
      }
      case 'session.ended': {
        items.push({
          kind: 'notice',
          key: `notice-${event.seq}`,
          tone: 'info',
          text: `Session ended: ${payload.reason}`,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const [turnId, list] of usersByTurn) {
    if (turns.get(turnId)?.usersPlaced) continue;
    for (const message of list) items.push(userItem(message));
  }
  for (const message of pending) items.push(userItem(message));

  closeStaleStreaming(items, events, superseded);

  return collapseToolRuns(items);
}

/**
 * Only the newest unfinished turn may still stream. A finished turn, a turn that
 * a later send superseded, or a turn the replay lost the end of all close, so a
 * Stop, an error, a stacked send or a reconnect gap cannot leave a spinner up.
 * A tool whose turn closed can never receive its `tool.finished`, so it settles
 * the same way instead of showing a running row forever.
 * This reads the event log alone: no clock and no timer decides it.
 */
function closeStaleStreaming(
  items: TimelineItem[],
  events: readonly ThreadEventRow[],
  superseded: ReadonlySet<string>,
): void {
  const finishedTurns = new Set<string>();
  const lastEventAt = new Map<string, string>();
  let newestTurnId: string | null = null;

  for (const event of events) {
    const payload = event.payload;
    if (!('turnId' in payload)) continue;
    newestTurnId = payload.turnId;
    lastEventAt.set(payload.turnId, event.createdAt);
    if (payload.type === 'turn.finished') finishedTurns.add(payload.turnId);
  }

  const openTurnId =
    newestTurnId !== null && !finishedTurns.has(newestTurnId) && !superseded.has(newestTurnId)
      ? newestTurnId
      : null;
  const fallbackAt = events.at(-1)?.createdAt ?? null;

  for (const item of items) {
    if (item.kind === 'tool') {
      if (!item.running || item.turnId === openTurnId) continue;
      item.running = false;
      if (item.finishedAt === null) {
        item.finishedAt = lastEventAt.get(item.turnId) ?? fallbackAt;
      }
      continue;
    }
    if (item.kind !== 'assistant' && item.kind !== 'reasoning') continue;
    if (!item.streaming || item.turnId === openTurnId) continue;
    item.streaming = false;
    if (item.kind === 'reasoning' && item.finishedAt === null) {
      item.finishedAt = lastEventAt.get(item.turnId) ?? fallbackAt;
    }
  }
}

/** Two or more consecutive tool calls read better as one summary row. */
const TOOL_GROUP_MIN = 2;

/** Folds runs of consecutive tool rows into expandable summary rows. */
export function collapseToolRuns(items: readonly TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  let run: ToolItem[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const [first] = run;
    if (first && run.length >= TOOL_GROUP_MIN) {
      result.push({
        kind: 'tool-group',
        key: `tools-${first.key}`,
        turnId: first.turnId,
        tools: run,
      });
    } else {
      result.push(...run);
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === 'tool') {
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();

  return result;
}

/** "Ran 4 tools" for a collapsed group; the count is always plural here. */
export function toolGroupSummary(count: number): string {
  return `Ran ${count} tools`;
}

const SUMMARY_KEYS = [
  'command',
  'path',
  'file_path',
  'filePath',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
] as const;

function oneLine(value: string, max = 80): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** A short single-line hint for a tool call, taken from its input. */
export function toolSummary(input: unknown): string {
  if (typeof input === 'string') return oneLine(input);
  if (input === null || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return oneLine(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim().length > 0) return oneLine(value);
  }
  return '';
}

export function formatToolInput(input: unknown): string {
  if (input === undefined) return '';
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell'] as const;

/**
 * The human-readable body of a tool call: a shell command stays raw instead of
 * arriving as escaped JSON, and anything else falls back to pretty JSON.
 */
export function toolInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of COMMAND_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
  }
  return formatToolInput(input);
}

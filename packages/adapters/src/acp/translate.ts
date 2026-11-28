import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ContentBlock,
  PermissionOption,
  PlanEntry,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { AdapterEvent, ApprovalChoice, PermissionMode, TurnAttachment } from '@tuffcode/contracts';

/**
 * ACP session updates are normalized onto the contract `AdapterEvent` union.
 *
 * ACP has no plan event in the contract, so plan snapshots are surfaced as a
 * synthetic tool call with a stable `toolCallId` (`plan:<planId>`). A repeated
 * `tool.started` for that id means the plan was replaced and must be rendered
 * from scratch.
 */
export interface ToolSnapshot {
  readonly name: string;
  readonly text: string;
  readonly status: ToolCallStatus | null;
  readonly finished: boolean;
}

export interface TranslationState {
  readonly tools: ReadonlyMap<string, ToolSnapshot>;
  readonly plans: ReadonlySet<string>;
}

export const emptyTranslationState: TranslationState = {
  tools: new Map(),
  plans: new Set(),
};

export interface TranslationResult {
  readonly events: AdapterEvent[];
  readonly state: TranslationState;
}

function toolContentText(content: readonly ToolCallContent[] | null | undefined): string {
  if (!content) {
    return '';
  }
  const parts: string[] = [];
  for (const item of content) {
    switch (item.type) {
      case 'content':
        if (item.content.type === 'text') {
          parts.push(item.content.text);
        } else if (item.content.type === 'resource_link') {
          parts.push(item.content.uri);
        }
        break;
      case 'diff':
        parts.push(item.newText);
        break;
      case 'terminal':
        parts.push(`[terminal ${item.terminalId}]`);
        break;
      case 'session':
        parts.push(`[session ${item.sessionId}]`);
        break;
    }
  }
  return parts.join('\n');
}

function rawOutputText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function renderPlan(entries: readonly PlanEntry[]): string {
  return entries
    .map((entry) => {
      const marker =
        entry.status === 'completed' ? 'x' : entry.status === 'in_progress' ? '~' : ' ';
      return `- [${marker}] ${entry.content}`;
    })
    .join('\n');
}

function toolName(
  call: {
    name?: string | null;
    title?: string | null;
    kind?: ToolKind | null;
  },
  fallback: string,
): string {
  return call.name ?? call.title ?? call.kind ?? fallback;
}

function withTool(state: TranslationState, id: string, snapshot: ToolSnapshot): TranslationState {
  const tools = new Map(state.tools);
  tools.set(id, snapshot);
  return { tools, plans: state.plans };
}

function withPlan(state: TranslationState, planId: string): TranslationState {
  if (state.plans.has(planId)) {
    return state;
  }
  const plans = new Set(state.plans);
  plans.add(planId);
  return { tools: state.tools, plans };
}

function translateToolCall(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>,
  turnId: string,
  state: TranslationState,
): TranslationResult {
  const id = update.toolCallId;
  const text = toolContentText(update.content);
  const status = update.status ?? null;
  const finished = status === 'completed' || status === 'failed';
  const events: AdapterEvent[] = [
    {
      type: 'tool.started',
      turnId,
      toolCallId: id,
      name: toolName(update, id),
      input: update.rawInput ?? null,
    },
  ];
  if (text !== '') {
    events.push({ type: 'tool.delta', turnId, toolCallId: id, text });
  }
  if (finished) {
    events.push({
      type: 'tool.finished',
      turnId,
      toolCallId: id,
      output: text || rawOutputText(update.rawOutput),
      isError: status === 'failed',
    });
  }
  return {
    events,
    state: withTool(state, id, {
      name: toolName(update, id),
      text,
      status,
      finished,
    }),
  };
}

function translateToolCallUpdate(
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>,
  turnId: string,
  state: TranslationState,
): TranslationResult {
  const id = update.toolCallId;
  const previous = state.tools.get(id);
  const name = toolName(update, previous?.name ?? id);
  const contentText = toolContentText(update.content);
  const previousText = previous?.text ?? '';
  const text = contentText === '' ? previousText : contentText;

  const events: AdapterEvent[] = [];
  if (!previous) {
    events.push({
      type: 'tool.started',
      turnId,
      toolCallId: id,
      name,
      input: update.rawInput ?? null,
    });
  }
  if (contentText !== '') {
    // ACP replaces the whole content collection on each update. Emit only the
    // appended text when the new collection extends the previous one.
    const delta = contentText.startsWith(previousText)
      ? contentText.slice(previousText.length)
      : contentText;
    if (delta !== '') {
      events.push({ type: 'tool.delta', turnId, toolCallId: id, text: delta });
    }
  }

  const status = update.status ?? previous?.status ?? null;
  const finished = status === 'completed' || status === 'failed';
  if (finished && !previous?.finished) {
    events.push({
      type: 'tool.finished',
      turnId,
      toolCallId: id,
      output: text || rawOutputText(update.rawOutput),
      isError: status === 'failed',
    });
  }

  return {
    events,
    state: withTool(state, id, {
      name,
      text,
      status,
      finished: finished || (previous?.finished ?? false),
    }),
  };
}

function translatePlanEntries(
  planId: string,
  entries: readonly PlanEntry[],
  turnId: string,
  state: TranslationState,
): TranslationResult {
  const toolCallId = `plan:${planId}`;
  const rendered = renderPlan(entries);
  const complete = entries.every((entry) => entry.status === 'completed');
  const events: AdapterEvent[] = [
    { type: 'tool.started', turnId, toolCallId, name: 'plan', input: { planId, entries } },
  ];
  if (rendered !== '') {
    events.push({ type: 'tool.delta', turnId, toolCallId, text: rendered });
  }
  if (complete) {
    events.push({ type: 'tool.finished', turnId, toolCallId, output: rendered, isError: false });
  }
  return { events, state: withPlan(state, planId) };
}

/**
 * Pure translation of one ACP session update.
 *
 * The returned state must be passed to the next call so tool content deltas and
 * plan snapshots stay consistent.
 */
export function translateSessionUpdate(
  update: SessionUpdate,
  turnId: string,
  state: TranslationState,
): TranslationResult {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type !== 'text' || update.content.text === '') {
        return { events: [], state };
      }
      return {
        events: [{ type: 'text.delta', turnId, text: update.content.text }],
        state,
      };
    }
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text' || update.content.text === '') {
        return { events: [], state };
      }
      return {
        events: [{ type: 'reasoning.delta', turnId, text: update.content.text }],
        state,
      };
    }
    case 'user_message_chunk':
      return { events: [], state };
    case 'tool_call':
      return translateToolCall(update, turnId, state);
    case 'tool_call_update':
      return translateToolCallUpdate(update, turnId, state);
    case 'plan':
      return translatePlanEntries('default', update.entries, turnId, state);
    case 'plan_update': {
      if (update.plan.type === 'items') {
        return translatePlanEntries(update.plan.planId, update.plan.entries, turnId, state);
      }
      const planId = update.plan.planId;
      const toolCallId = `plan:${planId}`;
      const events: AdapterEvent[] = [
        {
          type: 'tool.started',
          turnId,
          toolCallId,
          name: 'plan',
          input: { planId, path: update.plan.path ?? null },
        },
        { type: 'tool.delta', turnId, toolCallId, text: update.plan.content },
      ];
      return { events, state: withPlan(state, planId) };
    }
    case 'plan_removed': {
      if (!state.plans.has(update.planId)) {
        return { events: [], state };
      }
      const plans = new Set(state.plans);
      plans.delete(update.planId);
      return {
        events: [
          {
            type: 'tool.finished',
            turnId,
            toolCallId: `plan:${update.planId}`,
            output: '',
            isError: false,
          },
        ],
        state: { tools: state.tools, plans },
      };
    }
    case 'usage_update': {
      const usd =
        update.cost && update.cost.currency.toUpperCase() === 'USD' && update.cost.amount >= 0
          ? update.cost.amount
          : undefined;
      return {
        events: [
          {
            type: 'usage',
            turnId,
            inputTokens: Math.max(0, Math.trunc(update.used)),
            ...(usd === undefined ? {} : { costUsd: usd }),
          },
        ],
        state,
      };
    }
    default:
      return { events: [], state };
  }
}

/** Maps an ACP stop reason onto the contract turn outcome. */
export function mapStopReason(
  stopReason: StopReason,
  interrupted: boolean,
): 'complete' | 'interrupted' | 'error' {
  if (interrupted || stopReason === 'cancelled') {
    return 'interrupted';
  }
  return 'complete';
}

export type PermissionVerdict = 'allow' | 'deny' | 'ask';

const READ_ONLY_KINDS: Readonly<Partial<Record<ToolKind, true>>> = {
  read: true,
  search: true,
  fetch: true,
  think: true,
};

const EDIT_KINDS: Readonly<Partial<Record<ToolKind, true>>> = {
  edit: true,
  move: true,
  delete: true,
};

/**
 * Decides whether a permission request needs the user, given the thread's
 * permission mode and the kind of tool the agent wants to run.
 */
export function decidePermission(
  mode: PermissionMode,
  kind: ToolKind | null | undefined,
): PermissionVerdict {
  const toolKind = kind ?? 'other';
  switch (mode) {
    case 'full-auto':
      return 'allow';
    case 'ask':
      return 'ask';
    case 'read-only':
      return READ_ONLY_KINDS[toolKind] ? 'allow' : 'deny';
    case 'accept-edits':
      if (READ_ONLY_KINDS[toolKind] || EDIT_KINDS[toolKind]) {
        return 'allow';
      }
      return 'ask';
  }
}

const PREFERRED_OPTION: Readonly<Record<ApprovalChoice, readonly string[]>> = {
  allow: ['allow_once', 'allow_always'],
  'allow-thread': ['allow_always', 'allow_once'],
  deny: ['reject_once', 'reject_always'],
};

/** Picks the ACP permission option that matches a contract approval choice. */
export function choosePermissionOption(
  options: readonly PermissionOption[],
  choice: ApprovalChoice,
): PermissionOption | null {
  for (const kind of PREFERRED_OPTION[choice]) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return null;
}

/** Builds the `approval.requested` event for an ACP permission request. */
export function translatePermissionRequest(
  request: RequestPermissionRequest,
  turnId: string,
  approvalId: string,
): AdapterEvent {
  const call = request.toolCall;
  return {
    type: 'approval.requested',
    turnId,
    approvalId,
    toolCallId: call.toolCallId,
    name: toolName(call, call.toolCallId),
    input: call.rawInput ?? null,
  };
}

/**
 * Converts the turn text and attachments into ACP prompt content blocks. An image
 * becomes an `image` block when the agent declared the `image` prompt capability;
 * otherwise it stays a resource link the agent can read from disk itself.
 */
export function buildPromptBlocks(
  text: string,
  attachments: readonly TurnAttachment[],
  options: { imageCapable?: boolean } = {},
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.data !== undefined && options.imageCapable === true) {
      blocks.push({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mimeType ?? 'image/png',
      });
      continue;
    }
    if (attachment.kind === 'image' && attachment.data !== undefined) {
      // The agent cannot take bytes and has no path to read, so name the image instead
      // of dropping it without a trace.
      blocks.push({
        type: 'text',
        text: `[Image attached: ${attachment.name ?? 'image'} - this agent cannot receive images]`,
      });
      continue;
    }
    if (attachment.path === undefined) continue;
    blocks.push({
      type: 'resource_link',
      name: basename(attachment.path),
      uri: pathToFileURL(attachment.path).href,
      ...(attachment.kind === 'image' ? { mimeType: attachment.mimeType ?? 'image/png' } : {}),
    });
  }
  return blocks;
}

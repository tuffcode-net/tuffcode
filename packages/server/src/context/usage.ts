/**
 * Context accounting for one thread: prompt sections plus the conversation the
 * adapter carries into the next request.
 *
 * The estimate is deliberately cheap and provider-neutral: the shared four
 * characters per token rule, no tokenizer, no network. Persisted messages cover the
 * user and assistant rows; tool output lives only in the event log, so the harness
 * history is read from `tool.finished` payloads. Vendor CLI adapters report their own
 * usage through `usage` events instead.
 */
import { estimateTokens } from '@tuffcode/prompt';

/** Used when a model declares no context window; the same default the contract documents. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** How many recent events feed the harness-history estimate; older output is negligible. */
export const HARNESS_HISTORY_EVENT_LIMIT = 5000;

export interface ContextSectionInput {
  name: string;
  tokens: number;
}

export interface ConversationEntry {
  content: string;
  /** Images the message carries; each costs tokens even with no text. */
  attachments?: readonly { mimeType?: string; width?: number; height?: number }[];
}

/** A provider resizes an image to about 1,568 px and charges about 1,600 tokens. */
const MAX_IMAGE_TOKENS = 1600;

/** Used when an older attachment has no recorded pixel size. */
const UNKNOWN_IMAGE_TOKENS = 1100;

/** The provider-neutral token cost of the images in one message. */
export function imageTokens(
  attachments: ConversationEntry['attachments'],
): number {
  let total = 0;
  for (const attachment of attachments ?? []) {
    if (attachment.mimeType?.startsWith('image/') !== true) continue;
    total +=
      attachment.width === undefined || attachment.height === undefined
        ? UNKNOWN_IMAGE_TOKENS
        : Math.min(MAX_IMAGE_TOKENS, Math.ceil((attachment.width * attachment.height) / 750));
  }
  return total;
}

export interface ContextEstimateInput {
  /** Assembled prompt sections, user message included. */
  sections: readonly ContextSectionInput[];
  /** Persisted messages not already counted in `sections`. */
  messages: readonly ConversationEntry[];
  /** Tool output the harness will replay; empty for a fresh thread. */
  harnessHistory?: readonly string[];
  /** Model context window; `null` or unset falls back to {@link DEFAULT_CONTEXT_WINDOW}. */
  contextWindow?: number | null;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  percent: number;
  segments: ContextSectionInput[];
}

export function resolveContextWindow(contextWindow: number | null | undefined): number {
  return typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0
    ? contextWindow
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Sums the prompt sections, the message rows, and the harness tool output into the
 * contract shape. `percent` is clamped to 1: the meter cannot show more than a full
 * context even when the estimate overshoots the window.
 */
export function estimateContext(input: ContextEstimateInput): ContextUsage {
  const segments: ContextSectionInput[] = input.sections.map((section) => ({
    name: section.name,
    tokens: Math.max(0, Math.ceil(section.tokens)),
  }));

  const messageTokens = input.messages.reduce(
    (sum, message) =>
      sum +
      (message.content.length === 0 ? 0 : estimateTokens(message.content)) +
      imageTokens(message.attachments),
    0,
  );
  segments.push({ name: 'messages', tokens: messageTokens });

  const historyTokens = (input.harnessHistory ?? []).reduce(
    (sum, output) => sum + (output.length === 0 ? 0 : estimateTokens(output)),
    0,
  );
  if (historyTokens > 0) segments.push({ name: 'harness-history', tokens: historyTokens });

  const usedTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const maxTokens = resolveContextWindow(input.contextWindow);
  return {
    usedTokens,
    maxTokens,
    percent: Math.min(1, usedTokens / maxTokens),
    segments,
  };
}

/**
 * Tool output the harness keeps in memory, recovered from the persisted event log.
 * Text deltas are skipped because the assistant message row already holds that text.
 */
export function harnessToolOutputs(rows: readonly { type: string; payload: unknown }[]): string[] {
  const outputs: string[] = [];
  for (const row of rows) {
    if (row.type !== 'tool.finished') continue;
    if (typeof row.payload !== 'object' || row.payload === null) continue;
    if (!('output' in row.payload)) continue;
    const output = row.payload.output;
    if (typeof output === 'string' && output.length > 0) outputs.push(output);
  }
  return outputs;
}

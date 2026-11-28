import {
  AdapterUnavailableError,
  type AdapterLogger,
  type ProviderConfig,
  type ToolProfile,
} from '@tuffcode/contracts';
import type { HarnessToolSchema, ToolListOptions } from '../tool-policy.js';
import { allowedToolSchemas } from '../tool-policy.js';

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

/** A prompt image; the API takes base64 inline and names the format separately. */
export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Extended thinking; the signature must travel back unchanged with tool results. */
export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type AnthropicContentBlock =
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  /**
   * `system` rows are adapter bookkeeping (compaction summaries); the client lifts them
   * into the request's top-level `system` field and strips them from `messages`.
   */
  role: 'system' | 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  /** Cacheable head of `system`; marked with a cache breakpoint when present. */
  systemStatic?: string;
  max_tokens: number;
  temperature?: number;
  /** Settings allowlist for this turn; unset offers every harness tool. */
  toolAllowlist?: string[];
  /** Server tools offered this turn; unset offers none. */
  toolOptions?: ToolListOptions;
  /** A subagent child's profile; unset offers the full harness list. */
  toolProfile?: ToolProfile;
  /** Reasoning level mapped to a thinking budget; `none` or unset leaves thinking off. */
  reasoningEffort?: string;
}

/** Thinking budget per reasoning level; unknown levels leave thinking off. */
export const THINKING_BUDGETS: Readonly<Record<string, number>> = {
  minimal: 2048,
  low: 4096,
  medium: 10000,
  high: 24000,
  xhigh: 48000,
  max: 64000,
};

export function thinkingBudget(effort: string | undefined): number | null {
  if (effort === undefined) return null;
  return THINKING_BUDGETS[effort] ?? null;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface AnthropicClientConfig {
  baseUrl: string;
  headers: Record<string, string>;
  secret: string;
  maxTokens: number;
  temperature?: number;
}

export interface AnthropicClientOptions {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  logger: AdapterLogger;
}

export interface MessagesStreamer {
  stream(request: AnthropicRequestBody, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_MAX_TOKENS = 8192;

const MAX_ERROR_BYTES = 4096;
const MAX_RETRY_DELAY = 10000;
const DEFAULT_RETRY_DELAY = 500;
/** One request plus two retries, with the same backoff the OpenAI client uses. */
const MAX_ATTEMPTS = 3;

export class AnthropicRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'AnthropicRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Trims a configured host and tolerates a trailing `/v1`, which is the OpenAI habit. */
function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_ANTHROPIC_BASE_URL;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return DEFAULT_ANTHROPIC_BASE_URL;
  return trimmed.replace(/\/v1$/, '');
}

export function readAnthropicConfig(provider: ProviderConfig): AnthropicClientConfig {
  const secret = typeof provider.secret === 'string' ? provider.secret.trim() : '';
  if (secret.length === 0) {
    throw new AdapterUnavailableError(
      provider.id,
      'Add an Anthropic API key for this provider, or use the Claude subscription provider instead.',
    );
  }

  const headers: Record<string, string> = {};
  const rawHeaders = provider.config.headers;
  if (typeof rawHeaders === 'object' && rawHeaders !== null) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }
  }

  const rawMaxTokens = provider.config.maxTokens;
  const maxTokens =
    typeof rawMaxTokens === 'number' && Number.isInteger(rawMaxTokens) && rawMaxTokens > 0
      ? rawMaxTokens
      : DEFAULT_MAX_TOKENS;
  const rawTemperature = provider.config.temperature;
  const temperature =
    typeof rawTemperature === 'number' && Number.isFinite(rawTemperature)
      ? rawTemperature
      : undefined;

  return {
    baseUrl: normalizeBaseUrl(provider.config.baseUrl),
    headers,
    secret,
    maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

export function toAnthropicTools(
  allowlist?: readonly string[],
  options: ToolListOptions = {},
  profile?: ToolProfile,
): unknown[] {
  return allowedToolSchemas(allowlist, options, profile).map((schema: HarnessToolSchema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.parameters,
  }));
}

function buildBody(
  config: AnthropicClientConfig,
  request: AnthropicRequestBody,
): Record<string, unknown> {
  const inlineSystem = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content.trim() : ''))
    .filter((part) => part.length > 0)
    .join('\n\n');
  const messages = request.messages.filter((message) => message.role !== 'system');
  const system = [request.system?.trim() ?? '', inlineSystem]
    .filter((part) => part.length > 0)
    .join('\n\n');
  const tools = toAnthropicTools(
    request.toolAllowlist,
    request.toolOptions ?? {},
    request.toolProfile,
  );
  // A cache breakpoint on the last tool lets the provider reuse the whole tool block.
  if (tools.length > 0) {
    tools[tools.length - 1] = {
      ...(tools[tools.length - 1] as Record<string, unknown>),
      cache_control: { type: 'ephemeral' },
    };
  }
  const budget = thinkingBudget(request.reasoningEffort);
  // The API needs max_tokens above the thinking budget and rejects a custom temperature
  // while thinking is on, so both are adjusted only when a budget applies.
  const maxTokens = budget === null ? request.max_tokens : Math.max(request.max_tokens, budget + 4096);
  // The static head is cached on its own so a changing memory block cannot invalidate it.
  const staticSystem = request.systemStatic?.trim() ?? '';
  const cached = staticSystem.length > 0 && system.startsWith(staticSystem);
  const systemPayload = !cached
    ? system
    : [
        { type: 'text', text: staticSystem, cache_control: { type: 'ephemeral' } },
        ...(system.length > staticSystem.length
          ? [{ type: 'text', text: system.slice(staticSystem.length) }]
          : []),
      ];
  return {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    stream: true,
    ...(system.length > 0 ? { system: systemPayload } : {}),
    ...(budget !== null ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
    ...(budget === null && config.temperature !== undefined
      ? { temperature: config.temperature }
      : {}),
  };
}

async function readExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_ERROR_BYTES).trim();
  } catch {
    return '';
  }
}

async function mapResponseError(response: Response): Promise<AnthropicRequestError> {
  const status = response.status;
  const excerpt = await readExcerpt(response);
  if (status === 401 || status === 403) {
    return new AnthropicRequestError('unauthorized (check the provider key)', status, false);
  }
  if (status === 429 || status === 529 || status >= 500) {
    return new AnthropicRequestError('request failed with status ' + status, status, true);
  }
  const detail = excerpt.length > 0 ? ': ' + excerpt.slice(0, 300) : '';
  return new AnthropicRequestError('request failed with status ' + status + detail, status, false);
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY);
    }
  }
  return Math.min(DEFAULT_RETRY_DELAY * 2 ** (attempt - 1), MAX_RETRY_DELAY);
}

export class AnthropicClient implements MessagesStreamer {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: AdapterLogger;

  constructor(
    private readonly config: AnthropicClientConfig,
    options: AnthropicClientOptions,
  ) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger;
  }

  async stream(
    request: AnthropicRequestBody,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    let attempt = 0;
    while (true) {
      const response = await this.fetchFn(this.config.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(buildBody(this.config, request)),
        signal,
      });
      if (response.ok) {
        if (!response.body) {
          throw new AnthropicRequestError('response has no body', response.status, true);
        }
        return response.body;
      }
      const error = await mapResponseError(response);
      this.logger.warn('anthropic request failed', {
        status: response.status,
        retryable: error.retryable,
      });
      if (!error.retryable || attempt >= MAX_ATTEMPTS - 1) throw error;
      attempt += 1;
      await this.sleep(retryDelay(response, attempt));
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': this.config.secret,
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.config.headers,
    };
  }
}

const MAX_EVENT_BYTES = 1024 * 1024;
const LF = String.fromCharCode(10);
const SEPARATORS = ['\r\n\r\n', '\n\n', '\r\r'] as const;

export interface AnthropicSseEvent {
  event: string | null;
  data: unknown;
}

export interface AnthropicSseOptions {
  signal?: AbortSignal;
  logger?: AdapterLogger;
}

type ParsedEvent =
  | { kind: 'data'; event: string | null; value: unknown }
  | { kind: 'invalid' }
  | { kind: 'empty' };

function findSeparator(buffer: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const separator of SEPARATORS) {
    const index = buffer.indexOf(separator);
    if (index === -1) continue;
    if (best === null || index < best.index) best = { index, length: separator.length };
  }
  return best;
}

function parseEvent(block: string): ParsedEvent {
  const data: string[] = [];
  let event: string | null = null;
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith('data:')) continue;
    let value = line.slice(5);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  if (data.length === 0) return { kind: 'empty' };
  try {
    return { kind: 'data', event, value: JSON.parse(data.join(LF).trim()) };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Reads Anthropic's SSE stream. The parser tolerates CRLF, CR, byte splits
 * inside a UTF-8 sequence, comment lines, multi-line data, and an event that
 * overruns the buffer.
 */
export async function* streamAnthropicSse(
  body: ReadableStream<Uint8Array>,
  options: AnthropicSseOptions = {},
): AsyncIterable<AnthropicSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const signal = options.signal;
  const logger = options.logger;
  let buffer = '';
  let overflow = false;

  const drain = function* (): Generator<AnthropicSseEvent> {
    while (true) {
      const separator = findSeparator(buffer);
      if (separator === null) return;
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const parsed = parseEvent(block);
      if (parsed.kind === 'invalid') {
        logger?.debug('anthropic sse payload skipped', { reason: 'invalid json' });
      } else if (parsed.kind === 'data') {
        yield { event: parsed.event, data: parsed.value };
      }
    }
  };

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) return;
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      if (overflow) {
        const separator = findSeparator(buffer);
        if (separator === null) {
          buffer = '';
        } else {
          buffer = buffer.slice(separator.index + separator.length);
          overflow = false;
        }
      }

      if (buffer.length > MAX_EVENT_BYTES) {
        const separator = findSeparator(buffer);
        buffer = separator === null ? '' : buffer.slice(separator.index + separator.length);
        overflow = separator === null;
        logger?.warn('anthropic sse event dropped', { reason: 'event exceeded 1 MiB' });
      }

      yield* drain();
    }

    buffer += decoder.decode();
    if (!overflow && buffer.length > 0) {
      const parsed = parseEvent(buffer);
      if (parsed.kind === 'invalid') {
        logger?.debug('anthropic sse payload skipped', { reason: 'invalid json' });
      } else if (parsed.kind === 'data') {
        yield { event: parsed.event, data: parsed.value };
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
}

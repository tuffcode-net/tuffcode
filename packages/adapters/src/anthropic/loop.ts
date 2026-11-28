import type {
  AdapterDeps,
  AdapterEvent,
  ApprovalChoice,
  TurnContext,
  TurnToolOptions,
} from '@tuffcode/contracts';
import { TOOL_NAMES, SUBAGENT_TOOL_NAME, type ToolName } from '@tuffcode/prompt';
import { newId } from '@tuffcode/shared';
import {
  AnthropicRequestError,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicRedactedThinkingBlock,
  type AnthropicThinkingBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type MessagesStreamer,
  streamAnthropicSse,
} from './client.js';
import {
  classifyExtraTool,
  classifySubagentTool,
  classifyTool,
  executeTool,
  type PermissionDecision,
  type ToolExecResult,
  type ToolSessionState,
} from '../openai/tools.js';
import {
  isParallelSafeTool,
  isServerToolOffered,
  isToolDisabled,
  PARALLEL_TOOL_LIMIT,
  profileAllows,
  RepeatedToolCallGuard,
  resolveToolOptions,
} from '../tool-policy.js';
import { isExtraToolName } from '../extra-tools.js';
import { redactToolInput } from '../redact.js';

const LF = String.fromCharCode(10);

export interface RunTurnOptions {
  ctx: TurnContext;
  client: MessagesStreamer;
  messages: AnthropicMessage[];
  state: ToolSessionState;
  deps: AdapterDeps;
  signal: AbortSignal;
  maxTokens: number;
  requestApproval: (approvalId: string) => Promise<ApprovalChoice>;
}

interface ToolUseAccumulator {
  id: string;
  name: string;
  json: string;
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function systemPrompt(ctx: TurnContext): string {
  return [ctx.systemPrompt.trim(), ctx.brainSlice.trim()]
    .filter((part) => part.length > 0)
    .join(LF + LF);
}

/**
 * Maps an Anthropic `stop_reason` to the turn outcome. A refusal is the only
 * stop that means the model declined to answer; truncation and paused turns
 * still completed from the adapter's point of view.
 */
export function mapStopReason(stopReason: string | null): 'complete' | 'interrupted' | 'error' {
  return stopReason === 'refusal' ? 'error' : 'complete';
}

function parseToolArguments(json: string): {
  args: Record<string, unknown> | null;
  parseError: string | null;
} {
  if (json.length === 0) return { args: {}, parseError: null };
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, parseError: null };
    }
    return { args: null, parseError: 'tool arguments must be a JSON object' };
  } catch (error) {
    return { args: null, parseError: 'invalid tool arguments: ' + errorMessage(error) };
  }
}

interface CallPlan {
  args: Record<string, unknown> | null;
  parseError: string | null;
  /** Set when the call cannot run at all; the call is answered without executing. */
  result: ToolExecResult | null;
  decision: PermissionDecision | null;
}

/**
 * Decides what a call does before any of the step's calls start: answer with an error,
 * ask the user, or run. Kept separate from execution so a whole assistant step can be
 * judged before any of it is started, which is what makes the parallel decision safe.
 */
function planToolCall(
  name: string,
  args: Record<string, unknown> | null,
  parseError: string | null,
  ctx: TurnContext,
  toolOptions: TurnToolOptions,
): CallPlan {
  if (parseError !== null) {
    return { args, parseError, result: { output: parseError, isError: true }, decision: null };
  }
  if (!isServerToolOffered(name, toolOptions)) {
    return {
      args,
      parseError,
      result: { output: 'tool "' + name + '" is not available in this turn', isError: true },
      decision: null,
    };
  }
  // A child's profile is the outer boundary and its verdict is final: a profile-allowed
  // call must not become an approval, because nothing answers a child's approval.
  const profiled = ctx.toolProfile !== undefined;
  if (ctx.toolProfile !== undefined) {
    const verdict = profileAllows(name, args ?? {}, ctx.toolProfile, ctx.cwd);
    if (!verdict.allowed) {
      return {
        args,
        parseError,
        result: { output: verdict.reason, isError: true },
        decision: null,
      };
    }
  }
  let decision: PermissionDecision;
  if (name === SUBAGENT_TOOL_NAME) {
    decision = profiled ? 'allow' : classifySubagentTool(ctx.permissionMode, args ?? {});
  } else if (isExtraToolName(name)) {
    decision = profiled ? 'allow' : classifyExtraTool(name, args ?? {}, ctx.permissionMode);
  } else if (!isToolName(name)) {
    return {
      args,
      parseError,
      result: { output: 'unknown tool: ' + name, isError: true },
      decision: null,
    };
  } else if (isToolDisabled(name, ctx.toolAllowlist)) {
    return {
      args,
      parseError,
      result: { output: 'tool "' + name + '" is disabled in settings', isError: true },
      decision: null,
    };
  } else {
    decision = profiled ? 'allow' : classifyTool(name, args ?? {}, ctx.permissionMode);
  }
  if (decision === 'deny') {
    return {
      args,
      parseError,
      result: { output: 'tool is not allowed in ' + ctx.permissionMode + ' mode', isError: true },
      decision,
    };
  }
  return { args, parseError, result: null, decision };
}

export async function* runTurn(options: RunTurnOptions): AsyncIterable<AdapterEvent> {
  const { ctx, client, messages, state, deps, signal } = options;
  const turnId = ctx.turnId;
  const toolOptions = resolveToolOptions(ctx, deps);
  const repeatGuard = new RepeatedToolCallGuard();
  const system = systemPrompt(ctx);
  let reason: 'complete' | 'interrupted' | 'error' = 'complete';

  try {
    for (let iteration = 0; ; iteration += 1) {
      if (signal.aborted) {
        reason = 'interrupted';
        break;
      }

      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await client.stream(
          {
            model: ctx.model,
            messages,
            max_tokens: ctx.maxOutputTokens ?? options.maxTokens,
            ...(system.length > 0 ? { system } : {}),
            ...(ctx.systemPromptStatic === undefined
              ? {}
              : { systemStatic: ctx.systemPromptStatic }),
            ...(ctx.toolAllowlist !== undefined ? { toolAllowlist: ctx.toolAllowlist } : {}),
            toolOptions,
            ...(ctx.toolProfile !== undefined ? { toolProfile: ctx.toolProfile } : {}),
            ...(ctx.reasoningEffort !== undefined ? { reasoningEffort: ctx.reasoningEffort } : {}),
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          reason = 'interrupted';
          break;
        }
        const retryable = error instanceof AnthropicRequestError ? error.retryable : true;
        yield { type: 'error', message: 'anthropic: ' + errorMessage(error), retryable };
        reason = 'error';
        break;
      }

      const textParts: string[] = [];
      const calls = new Map<number, ToolUseAccumulator>();
      /** Thinking blocks by stream index; they precede tool_use in the echoed assistant turn. */
      const thinking = new Map<number, AnthropicThinkingBlock | AnthropicRedactedThinkingBlock>();
      let stopReason: string | null = null;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let streamError: { message: string; retryable: boolean } | null = null;

      try {
        for await (const event of streamAnthropicSse(stream, {
          signal,
          logger: deps.logger,
        })) {
          if (signal.aborted) break;
          const record = asRecord(event.data);
          if (record === null) continue;
          const type = typeof record.type === 'string' ? record.type : event.event;

          if (type === 'message_start') {
            const message = asRecord(record.message);
            const usage = message === null ? null : asRecord(message.usage);
            if (usage !== null) {
              if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
              if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
            }
            continue;
          }

          if (type === 'content_block_start') {
            const block = asRecord(record.content_block);
            if (block === null) continue;
            const index = typeof record.index === 'number' ? record.index : calls.size;
            if (block.type === 'thinking') {
              thinking.set(index, {
                type: 'thinking',
                thinking: typeof block.thinking === 'string' ? block.thinking : '',
                signature: typeof block.signature === 'string' ? block.signature : '',
              });
            } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
              thinking.set(index, { type: 'redacted_thinking', data: block.data });
            } else if (block.type === 'tool_use') {
              calls.set(index, {
                id: typeof block.id === 'string' ? block.id : '',
                name: typeof block.name === 'string' ? block.name : '',
                json: '',
              });
            } else if (
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.length > 0
            ) {
              textParts.push(block.text);
              yield { type: 'text.delta', turnId, text: block.text };
            }
            continue;
          }

          if (type === 'content_block_delta') {
            const delta = asRecord(record.delta);
            if (delta === null) continue;
            if (
              delta.type === 'text_delta' &&
              typeof delta.text === 'string' &&
              delta.text.length > 0
            ) {
              textParts.push(delta.text);
              yield { type: 'text.delta', turnId, text: delta.text };
            } else if (
              delta.type === 'thinking_delta' &&
              typeof delta.thinking === 'string' &&
              delta.thinking.length > 0
            ) {
              const index = typeof record.index === 'number' ? record.index : -1;
              const block = thinking.get(index);
              if (block?.type === 'thinking') block.thinking += delta.thinking;
              yield { type: 'reasoning.delta', turnId, text: delta.thinking };
            } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
              const index = typeof record.index === 'number' ? record.index : -1;
              const block = thinking.get(index);
              if (block?.type === 'thinking') block.signature += delta.signature;
            } else if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string'
            ) {
              const index = typeof record.index === 'number' ? record.index : 0;
              const call = calls.get(index);
              if (call !== undefined) call.json += delta.partial_json;
            }
            continue;
          }

          if (type === 'message_delta') {
            const delta = asRecord(record.delta);
            if (delta !== null && typeof delta.stop_reason === 'string') {
              stopReason = delta.stop_reason;
            }
            const usage = asRecord(record.usage);
            if (usage !== null && typeof usage.output_tokens === 'number') {
              outputTokens = usage.output_tokens;
            }
            continue;
          }

          if (type === 'error') {
            const error = asRecord(record.error);
            const errorType = error !== null && typeof error.type === 'string' ? error.type : '';
            const detail =
              error !== null && typeof error.message === 'string' ? error.message : 'stream error';
            streamError = {
              message: 'anthropic: ' + detail,
              retryable: errorType === 'overloaded_error' || errorType === 'rate_limit_error',
            };
            break;
          }
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          reason = 'interrupted';
          break;
        }
        yield { type: 'error', message: 'anthropic: ' + errorMessage(error), retryable: true };
        reason = 'error';
        break;
      }

      if (signal.aborted) {
        reason = 'interrupted';
        break;
      }

      if (streamError !== null) {
        yield { type: 'error', message: streamError.message, retryable: streamError.retryable };
        reason = 'error';
        break;
      }

      if (inputTokens !== undefined || outputTokens !== undefined) {
        yield {
          type: 'usage',
          turnId,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        };
      }
      if (stopReason !== null) {
        deps.logger.debug('anthropic stream finished', { turnId, stopReason });
      }

      const ordered = [...calls.entries()]
        .toSorted((left, right) => left[0] - right[0])
        .map(([, call]) => call);

      if (ordered.length === 0) {
        if (textParts.length > 0) {
          messages.push({ role: 'assistant', content: textParts.join('') });
        }
        if (mapStopReason(stopReason) === 'error') {
          yield {
            type: 'error',
            message:
              'anthropic: model refused the request (stop_reason ' + String(stopReason) + ')',
            retryable: false,
          };
          reason = 'error';
          break;
        }
        break;
      }

      const parsedArguments = ordered.map((call) => parseToolArguments(call.json));
      const repeated = repeatGuard.observe(
        textParts.join(''),
        ordered.map((call, index) => ({
          name: call.name,
          args: parsedArguments[index]?.args ?? call.json,
        })),
      );
      if (repeated) {
        yield {
          type: 'error',
          message: 'anthropic: repeated identical tool call',
          retryable: false,
        };
        reason = 'error';
        break;
      }

      const assistantBlocks: AnthropicContentBlock[] = [...thinking.entries()]
        .toSorted((left, right) => left[0] - right[0])
        .map(([, block]) => block);
      const text = textParts.join('');
      if (text.length > 0) assistantBlocks.push({ type: 'text', text });

      const toolUseBlocks: AnthropicToolUseBlock[] = ordered.map((call, index) => ({
        type: 'tool_use',
        id: call.id.length > 0 ? call.id : newId('call'),
        name: call.name,
        input: parsedArguments[index]?.args ?? {},
      }));
      assistantBlocks.push(...toolUseBlocks);
      messages.push({ role: 'assistant', content: assistantBlocks });

      const plans = toolUseBlocks.map((block, index) =>
        planToolCall(
          block.name,
          parsedArguments[index]?.args ?? null,
          parsedArguments[index]?.parseError ?? null,
          ctx,
          toolOptions,
        ),
      );
      // The step overlaps only when every call is a read the ladder allows in every
      // mode. One approval, one write, or one unknown tool keeps the whole step serial.
      const parallel =
        !signal.aborted &&
        toolUseBlocks.length > 1 &&
        plans.every(
          (plan, index) =>
            plan.result === null &&
            plan.decision === 'allow' &&
            isParallelSafeTool(toolUseBlocks[index]?.name ?? '', plan.args),
        );

      const toolResults: AnthropicToolResultBlock[] = [];
      if (parallel) {
        // Every call is announced in the model's order before any of them runs, so the
        // timeline never shows a later call starting before an earlier one.
        for (const [index, block] of toolUseBlocks.entries()) {
          yield {
            type: 'tool.started',
            turnId,
            toolCallId: block.id,
            name: block.name,
            input: redactToolInput(plans[index]?.args ?? ordered[index]?.json ?? ''),
          };
        }
        const batch = new Map<number, AnthropicToolResultBlock>();
        const inFlight = new Map<number, Promise<{ index: number; result: ToolExecResult }>>();
        const start = (position: number): void => {
          const block = toolUseBlocks[position];
          if (block === undefined) return;
          // A rejection stays inside its own call: siblings keep running and the error
          // is reported for this call only.
          inFlight.set(
            position,
            executeTool(
              block.name,
              plans[position]?.args ?? {},
              ctx,
              state,
              deps,
              deps.extraTool,
            ).then(
              (result) => ({ index: position, result }),
              (error: unknown) => ({
                index: position,
                result: { output: errorMessage(error), isError: true },
              }),
            ),
          );
        };
        let nextCall = 0;
        while (nextCall < toolUseBlocks.length && inFlight.size < PARALLEL_TOOL_LIMIT) {
          start(nextCall);
          nextCall += 1;
        }
        for (let completed = 0; completed < toolUseBlocks.length; completed += 1) {
          const done = await Promise.race(inFlight.values());
          inFlight.delete(done.index);
          const block = toolUseBlocks[done.index];
          batch.set(done.index, {
            type: 'tool_result',
            tool_use_id: block?.id ?? newId('call'),
            content: done.result.output,
            ...(done.result.isError ? { is_error: true } : {}),
          });
          yield {
            type: 'tool.finished',
            turnId,
            toolCallId: block?.id ?? '',
            output: done.result.output,
            isError: done.result.isError,
          };
          if (nextCall < toolUseBlocks.length) {
            start(nextCall);
            nextCall += 1;
          }
        }
        // The model reads results in the order it asked, not the order they finished.
        for (let index = 0; index < toolUseBlocks.length; index += 1) {
          const result = batch.get(index);
          if (result !== undefined) toolResults.push(result);
        }
      } else {
        for (const [index, call] of ordered.entries()) {
          const toolCallId = toolUseBlocks[index]?.id ?? newId('call');
          if (signal.aborted) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCallId,
              content: '[interrupted]',
              is_error: true,
            });
            continue;
          }

          const plan = plans[index];
          yield {
            type: 'tool.started',
            turnId,
            toolCallId,
            name: call.name,
            input: redactToolInput(plan?.args ?? call.json),
          };

          let result = plan?.result ?? null;
          if (result === null && plan?.decision === 'approve') {
            const approvalId = newId('apr');
            const pending = options.requestApproval(approvalId);
            yield {
              type: 'approval.requested',
              turnId,
              approvalId,
              toolCallId,
              name: call.name,
              input: redactToolInput(plan.args),
            };
            const choice = await pending;
            if (signal.aborted) {
              result = { output: '[interrupted]', isError: true };
            } else if (choice === 'deny') {
              result = { output: 'denied by user', isError: true };
            }
          }
          if (result === null) {
            result = await executeTool(
              call.name,
              plan?.args ?? {},
              ctx,
              state,
              deps,
              deps.extraTool,
            );
          }

          yield {
            type: 'tool.finished',
            turnId,
            toolCallId,
            output: result.output,
            isError: result.isError,
          };
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: result.output,
            ...(result.isError ? { is_error: true } : {}),
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }

      if (signal.aborted) {
        reason = 'interrupted';
        break;
      }
      deps.logger.debug('anthropic tool iteration', { turnId, iteration });
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      reason = 'interrupted';
    } else {
      deps.logger.warn('anthropic turn failed', { turnId });
      yield { type: 'error', message: 'anthropic: ' + errorMessage(error), retryable: false };
      reason = 'error';
    }
  }

  yield { type: 'turn.finished', turnId, reason };
}

/** Kept short: the summary is a fact sheet, not prose the model should imitate. */
export const COMPACTION_SYSTEM_PROMPT =
  'You compress conversation history for another model. Reply with a compact factual ' +
  'summary: decisions made, files and symbols touched, tool results that still matter, ' +
  'and any open questions. No preamble, no markdown headings.';

const MAX_TRANSCRIPT_CHARS = 60_000;

export interface CompactHistoryOptions {
  client: MessagesStreamer;
  messages: AnthropicMessage[];
  model: string;
  maxTokens: number;
  deps: AdapterDeps;
  signal: AbortSignal;
}

function renderAnthropicMessage(message: AnthropicMessage): string {
  if (typeof message.content === 'string') return `[${message.role}] ${message.content}`;
  const blocks = message.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') return '[image omitted from summary]';
    if (block.type === 'tool_use') {
      return `tool_use ${block.name}(${JSON.stringify(block.input)})`;
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return '';
    return `tool_result ${block.tool_use_id}: ${block.content}${block.is_error === true ? ' (error)' : ''}`;
  });
  return `[${message.role}] ${blocks.join(LF)}`;
}

function isToolResultMessage(message: AnthropicMessage | undefined): boolean {
  return (
    message !== undefined &&
    Array.isArray(message.content) &&
    message.content.every((block) => block.type === 'tool_result')
  );
}

/**
 * Folds every message except the last two into one system message using the same
 * client. A tool result cannot outlive its `tool_use` block, so the keep window
 * widens past leading tool-result rows instead of orphaning them.
 */
export async function compactHistory(options: CompactHistoryOptions): Promise<{ removed: number }> {
  const { messages, deps } = options;
  if (messages.length <= 2 || options.model.trim().length === 0) return { removed: 0 };
  let start = messages.length - 2;
  while (start > 0 && isToolResultMessage(messages[start])) start -= 1;
  if (start <= 0) return { removed: 0 };

  const older = messages.slice(0, start);
  const keep = messages.slice(start);
  let transcript = older.map(renderAnthropicMessage).join(LF + LF);
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = '[earlier history omitted]' + LF + transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }

  try {
    const stream = await options.client.stream(
      {
        model: options.model,
        max_tokens: options.maxTokens,
        messages: [{ role: 'user', content: transcript }],
        system: COMPACTION_SYSTEM_PROMPT,
        toolAllowlist: [],
      },
      options.signal,
    );
    const parts: string[] = [];
    for await (const event of streamAnthropicSse(stream, {
      signal: options.signal,
      logger: deps.logger,
    })) {
      const record = asRecord(event.data);
      if (record === null) continue;
      const type = typeof record.type === 'string' ? record.type : event.event;
      if (type !== 'content_block_delta') continue;
      const delta = asRecord(record.delta);
      if (delta === null || delta.type !== 'text_delta' || typeof delta.text !== 'string') {
        continue;
      }
      parts.push(delta.text);
    }
    const summary = parts.join('').trim();
    if (summary.length === 0) return { removed: 0 };
    messages.splice(
      0,
      messages.length,
      { role: 'system', content: `Summary of the earlier conversation:${LF}${summary}` },
      ...keep,
    );
    return { removed: older.length };
  } catch (error) {
    deps.logger.warn('anthropic compaction failed', { reason: errorMessage(error) });
    return { removed: 0 };
  }
}

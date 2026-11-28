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
  OpenAIRequestError,
  type ChatMessage,
  type ChatStreamer,
  type OpenAIToolCall,
} from './client.js';
import { streamSse } from './sse.js';
import {
  classifyExtraTool,
  classifySubagentTool,
  classifyTool,
  executeTool,
  type PermissionDecision,
  type ToolExecResult,
  type ToolSessionState,
} from './tools.js';
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
  client: ChatStreamer;
  messages: ChatMessage[];
  state: ToolSessionState;
  deps: AdapterDeps;
  signal: AbortSignal;
  requestApproval: (approvalId: string) => Promise<ApprovalChoice>;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface ToolCallDelta {
  index: number;
  id: string;
  name: string;
  arguments: string;
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

function parseToolArguments(json: string): {
  args: Record<string, unknown> | null;
  parseError: string | null;
} {
  try {
    const parsed: unknown = json.length === 0 ? {} : JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, parseError: null };
    }
    return { args: null, parseError: 'tool arguments must be a JSON object' };
  } catch (error) {
    return { args: null, parseError: 'invalid tool arguments: ' + errorMessage(error) };
  }
}

function parseToolCallDelta(value: unknown, fallbackIndex: number): ToolCallDelta {
  if (typeof value !== 'object' || value === null) {
    return { index: fallbackIndex, id: '', name: '', arguments: '' };
  }
  const record = value as Record<string, unknown>;
  const index = typeof record.index === 'number' ? record.index : fallbackIndex;
  const id = typeof record.id === 'string' ? record.id : '';
  let name = '';
  let args = '';
  const fn = record.function;
  if (typeof fn === 'object' && fn !== null) {
    const fnRecord = fn as Record<string, unknown>;
    if (typeof fnRecord.name === 'string') name = fnRecord.name;
    if (typeof fnRecord.arguments === 'string') args = fnRecord.arguments;
  }
  return { index, id, name, arguments: args };
}

function accumulateCall(calls: Map<number, ToolCallAccumulator>, delta: ToolCallDelta): void {
  const existing = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
  if (delta.id.length > 0) existing.id = delta.id;
  if (delta.name.length > 0) {
    if (existing.name.length === 0) existing.name = delta.name;
    else if (existing.name !== delta.name) existing.name += delta.name;
  }
  existing.arguments += delta.arguments;
  calls.set(delta.index, existing);
}

function requestMessages(ctx: TurnContext, messages: ChatMessage[]): ChatMessage[] {
  const system = [ctx.systemPrompt.trim(), ctx.brainSlice.trim()]
    .filter((part) => part.length > 0)
    .join(LF + LF);
  return system.length > 0 ? [{ role: 'system', content: system }, ...messages] : [...messages];
}

interface ChunkDelta {
  content: string;
  reasoning: string;
  toolCalls: unknown[];
  finishReason: string | null;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

function parseChunk(value: unknown): ChunkDelta | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const usage = record.usage;
  if (typeof usage === 'object' && usage !== null) {
    const usageRecord = usage as Record<string, unknown>;
    if (typeof usageRecord.prompt_tokens === 'number') inputTokens = usageRecord.prompt_tokens;
    if (typeof usageRecord.completion_tokens === 'number') {
      outputTokens = usageRecord.completion_tokens;
    }
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      content: '',
      reasoning: '',
      toolCalls: [],
      finishReason: null,
      inputTokens,
      outputTokens,
    };
  }
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null) return null;
  const choiceRecord = choice as Record<string, unknown>;
  const finishReason =
    typeof choiceRecord.finish_reason === 'string' ? choiceRecord.finish_reason : null;
  const delta = choiceRecord.delta;
  if (typeof delta !== 'object' || delta === null) {
    return { content: '', reasoning: '', toolCalls: [], finishReason, inputTokens, outputTokens };
  }
  const deltaRecord = delta as Record<string, unknown>;
  const content = typeof deltaRecord.content === 'string' ? deltaRecord.content : '';
  const reasoning =
    typeof deltaRecord.reasoning_content === 'string'
      ? deltaRecord.reasoning_content
      : typeof deltaRecord.reasoning === 'string'
        ? deltaRecord.reasoning
        : '';
  const toolCalls = Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls : [];
  return { content, reasoning, toolCalls, finishReason, inputTokens, outputTokens };
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
            messages: requestMessages(ctx, messages),
            ...(ctx.maxOutputTokens !== undefined ? { maxTokens: ctx.maxOutputTokens } : {}),
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
        const retryable = error instanceof OpenAIRequestError ? error.retryable : true;
        yield { type: 'error', message: 'openai: ' + errorMessage(error), retryable };
        reason = 'error';
        break;
      }
      const textParts: string[] = [];
      const calls = new Map<number, ToolCallAccumulator>();
      let finishReason: string | null = null;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      try {
        for await (const raw of streamSse(stream, { signal, logger: deps.logger })) {
          if (signal.aborted) break;
          const chunk = parseChunk(raw);
          if (chunk === null) continue;
          if (chunk.inputTokens !== undefined) inputTokens = chunk.inputTokens;
          if (chunk.outputTokens !== undefined) outputTokens = chunk.outputTokens;
          if (chunk.content.length > 0) {
            textParts.push(chunk.content);
            yield { type: 'text.delta', turnId, text: chunk.content };
          }
          if (chunk.reasoning.length > 0) {
            yield { type: 'reasoning.delta', turnId, text: chunk.reasoning };
          }
          for (const rawCall of chunk.toolCalls) {
            accumulateCall(calls, parseToolCallDelta(rawCall, calls.size));
          }
          if (chunk.finishReason !== null) finishReason = chunk.finishReason;
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          reason = 'interrupted';
          break;
        }
        yield { type: 'error', message: 'openai: ' + errorMessage(error), retryable: true };
        reason = 'error';
        break;
      }

      if (signal.aborted) {
        reason = 'interrupted';
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
      if (finishReason !== null) {
        deps.logger.debug('openai stream finished', { turnId, finishReason });
      }

      const ordered = [...calls.entries()]
        .toSorted((left, right) => left[0] - right[0])
        .map(([, call]) => call);

      if (ordered.length === 0) {
        messages.push({ role: 'assistant', content: textParts.join('') });
        break;
      }

      const parsedArguments = ordered.map((call) => parseToolArguments(call.arguments));
      const repeated = repeatGuard.observe(
        textParts.join(''),
        ordered.map((call, index) => ({
          name: call.name,
          args: parsedArguments[index]?.args ?? call.arguments,
        })),
      );
      if (repeated) {
        yield { type: 'error', message: 'openai: repeated identical tool call', retryable: false };
        reason = 'error';
        break;
      }

      const assistantCalls: OpenAIToolCall[] = ordered.map((call) => ({
        id: call.id.length > 0 ? call.id : newId('call'),
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
      messages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
        tool_calls: assistantCalls,
      });

      const plans = assistantCalls.map((call, index) => {
        const { args, parseError } = parsedArguments[index] ?? { args: null, parseError: null };
        return planToolCall(call.function.name, args, parseError, ctx, toolOptions);
      });
      // The step overlaps only when every call is a read the ladder allows in every
      // mode. One approval, one write, or one unknown tool keeps the whole step serial.
      const parallel =
        !signal.aborted &&
        assistantCalls.length > 1 &&
        plans.every(
          (plan, index) =>
            plan.result === null &&
            plan.decision === 'allow' &&
            isParallelSafeTool(assistantCalls[index]?.function.name ?? '', plan.args),
        );

      if (parallel) {
        // Every call is announced in the model's order before any of them runs, so the
        // timeline never shows a later call starting before an earlier one.
        for (const [index, call] of assistantCalls.entries()) {
          yield {
            type: 'tool.started',
            turnId,
            toolCallId: call.id,
            name: call.function.name,
            input: redactToolInput(plans[index]?.args ?? call.function.arguments),
          };
        }
        const results = new Map<number, ToolExecResult>();
        const inFlight = new Map<number, Promise<{ index: number; result: ToolExecResult }>>();
        const start = (position: number): void => {
          const call = assistantCalls[position];
          if (call === undefined) return;
          // A rejection stays inside its own call: siblings keep running and the error
          // is reported for this call only.
          inFlight.set(
            position,
            executeTool(
              call.function.name,
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
        while (nextCall < assistantCalls.length && inFlight.size < PARALLEL_TOOL_LIMIT) {
          start(nextCall);
          nextCall += 1;
        }
        for (let completed = 0; completed < assistantCalls.length; completed += 1) {
          const done = await Promise.race(inFlight.values());
          inFlight.delete(done.index);
          results.set(done.index, done.result);
          yield {
            type: 'tool.finished',
            turnId,
            toolCallId: assistantCalls[done.index]?.id ?? '',
            output: done.result.output,
            isError: done.result.isError,
          };
          if (nextCall < assistantCalls.length) {
            start(nextCall);
            nextCall += 1;
          }
        }
        // The model reads results in the order it asked, not the order they finished.
        for (const [index, call] of assistantCalls.entries()) {
          const result = results.get(index) ?? { output: '[interrupted]', isError: true };
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.output });
        }
      } else {
        for (const [index, call] of assistantCalls.entries()) {
          const toolCallId = call.id;
          if (signal.aborted) {
            messages.push({ role: 'tool', tool_call_id: toolCallId, content: '[interrupted]' });
            continue;
          }

          const plan = plans[index];
          const name = call.function.name;
          yield {
            type: 'tool.started',
            turnId,
            toolCallId,
            name,
            input: redactToolInput(plan?.args ?? call.function.arguments),
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
              name,
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
            result = await executeTool(name, plan?.args ?? {}, ctx, state, deps, deps.extraTool);
          }

          yield {
            type: 'tool.finished',
            turnId,
            toolCallId,
            output: result.output,
            isError: result.isError,
          };
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: result.output });
        }
      }

      if (signal.aborted) {
        reason = 'interrupted';
        break;
      }
      deps.logger.debug('openai tool iteration', { turnId, iteration });
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      reason = 'interrupted';
    } else {
      deps.logger.warn('openai turn failed', { turnId });
      yield { type: 'error', message: 'openai: ' + errorMessage(error), retryable: false };
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
  client: ChatStreamer;
  messages: ChatMessage[];
  model: string;
  deps: AdapterDeps;
  signal: AbortSignal;
}

/** Flattens a multimodal message to text, so a compaction summary never sees `[object Object]`. */
function contentText(content: ChatMessage['content']): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : '[image omitted from summary]'))
    .join(LF);
}

function renderTranscriptMessage(message: ChatMessage): string {
  const lines = [`[${message.role}] ${contentText(message.content)}`];
  if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
    const calls = message.tool_calls
      .map((call) => `${call.function.name}(${call.function.arguments})`)
      .join('; ');
    lines.push(`tool calls: ${calls}`);
  }
  if (message.tool_call_id !== undefined) lines.push(`tool_call_id: ${message.tool_call_id}`);
  return lines.join(LF);
}

/**
 * Folds every message except the last two into one system message using the same
 * client. A tool result can only follow the assistant message that requested it, so
 * the keep window widens past leading `tool` rows instead of slicing a pair apart.
 */
export async function compactHistory(options: CompactHistoryOptions): Promise<{ removed: number }> {
  const { messages, deps } = options;
  if (messages.length <= 2 || options.model.trim().length === 0) return { removed: 0 };
  let start = messages.length - 2;
  while (start > 0 && messages[start]?.role === 'tool') start -= 1;
  if (start <= 0) return { removed: 0 };

  const older = messages.slice(0, start);
  const keep = messages.slice(start);
  let transcript = older.map(renderTranscriptMessage).join(LF + LF);
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = '[earlier history omitted]' + LF + transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }

  try {
    const stream = await options.client.stream(
      {
        model: options.model,
        messages: [
          { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
        toolAllowlist: [],
      },
      options.signal,
    );
    const parts: string[] = [];
    for await (const raw of streamSse(stream, { signal: options.signal, logger: deps.logger })) {
      const chunk = parseChunk(raw);
      if (chunk === null || chunk.content.length === 0) continue;
      parts.push(chunk.content);
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
    deps.logger.warn('openai compaction failed', { reason: errorMessage(error) });
    return { removed: 0 };
  }
}

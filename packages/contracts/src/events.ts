import { z } from 'zod';
import {
  ApprovalSchema,
  EventRowSchema,
  GoalStateSchema,
  IdSchema,
  InstalledPluginSchema,
  IsoDateTimeSchema,
  McpServerSchema,
  ProviderViewSchema,
  SeqSchema,
  SubagentMessageSchema,
  SubagentStatusSchema,
  SubagentTypeSchema,
  TaskStateSchema,
  ThreadSchema,
  TodoPhaseSchema,
} from './entities.js';
import { SettingsSchema } from './settings.js';

export const AdapterEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.started'),
    sessionId: IdSchema,
    model: z.string(),
    capabilities: z.object({
      tools: z.boolean(),
      approvals: z.boolean(),
      resume: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('turn.started'),
    turnId: IdSchema,
  }),
  z.object({
    type: z.literal('text.delta'),
    turnId: IdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal('reasoning.delta'),
    turnId: IdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool.started'),
    turnId: IdSchema,
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool.delta'),
    turnId: IdSchema,
    toolCallId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool.finished'),
    turnId: IdSchema,
    toolCallId: z.string(),
    output: z.string(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal('approval.requested'),
    turnId: IdSchema,
    approvalId: IdSchema,
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('usage'),
    turnId: IdSchema,
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('turn.finished'),
    turnId: IdSchema,
    reason: z.enum(['complete', 'interrupted', 'error']),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({
    /** A user-facing note about the turn, not an adapter failure. */
    type: z.literal('notice'),
    message: z.string(),
    tone: z.enum(['info', 'warning']),
  }),
  z.object({
    type: z.literal('session.ended'),
    reason: z.string(),
  }),
]);
export type AdapterEvent = z.infer<typeof AdapterEventSchema>;
export type AdapterEventType = AdapterEvent['type'];

export const ThreadEventRowSchema = EventRowSchema.extend({
  payload: AdapterEventSchema,
});
export type ThreadEventRow = z.infer<typeof ThreadEventRowSchema>;

const serverEvent = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    kind: z.literal('event'),
    type: z.literal(type),
    threadId: IdSchema.optional(),
    seq: SeqSchema.optional(),
    payload,
  });

export const ServerEventSchema = z.discriminatedUnion('type', [
  serverEvent('thread.updated', ThreadSchema),
  z.object({
    kind: z.literal('event'),
    type: z.literal('thread.event'),
    threadId: IdSchema,
    seq: SeqSchema,
    // The persisted row's timestamp, so a live frame and the replayed row agree.
    createdAt: IsoDateTimeSchema,
    payload: AdapterEventSchema,
  }),
  serverEvent('approval.requested', ApprovalSchema),
  serverEvent(
    'terminal.data',
    z.object({
      terminalId: IdSchema,
      data: z.string(),
    }),
  ),
  serverEvent(
    'council.updated',
    z.object({
      goalId: IdSchema,
      state: GoalStateSchema,
      /** Set when the event reports a task change, so the UI can refresh without polling. */
      taskId: IdSchema.optional(),
      taskState: TaskStateSchema.optional(),
    }),
  ),
  serverEvent(
    'subagent.started',
    z.object({
      childId: IdSchema,
      threadId: IdSchema,
      type: SubagentTypeSchema,
      model: z.string(),
    }),
  ),
  serverEvent(
    'subagent.event',
    z.object({
      childId: IdSchema,
      threadId: IdSchema,
      event: AdapterEventSchema,
    }),
  ),
  serverEvent(
    'subagent.finished',
    z.object({
      childId: IdSchema,
      threadId: IdSchema,
      status: SubagentStatusSchema,
      summary: z.string().optional(),
    }),
  ),
  serverEvent(
    'subagent.telemetry',
    z.object({
      childId: IdSchema,
      threadId: IdSchema,
      toolCount: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      activity: z.string().nullable(),
    }),
  ),
  serverEvent(
    'subagent.message',
    z.object({
      childId: IdSchema,
      threadId: IdSchema,
      message: SubagentMessageSchema,
    }),
  ),
  /** A child is blocked on this question until the parent answers it. */
  serverEvent(
    'subagent.question',
    z.object({
      childId: IdSchema,
      threadId: IdSchema,
      questionId: IdSchema,
      text: z.string(),
    }),
  ),
  /** The parent or the user answered an open question; the child's turn resumes. */
  serverEvent(
    'subagent.answered',
    z.object({
      childId: IdSchema,
      threadId: IdSchema,
      questionId: IdSchema,
      text: z.string(),
      by: z.enum(['parent', 'user']),
    }),
  ),
  serverEvent(
    'todo.updated',
    z.object({
      threadId: IdSchema,
      phases: TodoPhaseSchema.array(),
    }),
  ),
  serverEvent('plugins.updated', InstalledPluginSchema.array()),
  /** Discovered commands changed; the palette drops its cache and refetches. */
  serverEvent('commands.updated', z.object({})),
  /** Discovered skills changed; the palette drops its cache and refetches. */
  serverEvent('skills.updated', z.object({})),
  /** One connector changed: saved, removed, or finished an OAuth sign-in. */
  serverEvent('mcp.updated', McpServerSchema),
  serverEvent('providers.updated', ProviderViewSchema.array()),
  serverEvent(
    'provider.login.output',
    z.object({
      loginId: IdSchema,
      providerId: IdSchema,
      chunk: z.string(),
    }),
  ),
  serverEvent(
    'provider.login.done',
    z.object({
      loginId: IdSchema,
      providerId: IdSchema,
      ok: z.boolean(),
      detail: z.string(),
    }),
  ),
  serverEvent(
    'context.updated',
    z.object({
      threadId: IdSchema,
      usedTokens: z.number().int().nonnegative(),
      maxTokens: z.number().int().positive(),
      percent: z.number().min(0).max(1),
      /**
       * Which precedence step supplied `maxTokens` (D46). Every emitter sends it, so the
       * inferred type is required; a frame from a server that predates the field still
       * parses and reads as the model's own window.
       */
      limitSource: z.enum(['model', 'config', 'settings', 'default']).default('model'),
      compacted: z.boolean(),
    }),
  ),
  serverEvent('settings.updated', SettingsSchema),
  serverEvent(
    'server.warning',
    z.object({
      message: z.string(),
      code: z.string().optional(),
    }),
  ),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];

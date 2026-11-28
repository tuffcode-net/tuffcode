import { z } from 'zod';
import {
  ApprovalChoiceSchema,
  AttachmentSchema,
  BrainEntrySchema,
  BrainKindSchema,
  BrainRelationSchema,
  BrainSliceSchema,
  CatalogEntrySchema,
  CheckpointSchema,
  CommandSchema,
  ConnectorEntrySchema,
  DashboardThreadSchema,
  DiffFileSchema,
  EscalationSchema,
  ExecutionModeSchema,
  GoalAutonomySchema,
  GoalSchema,
  IdSchema,
  InstalledPluginSchema,
  IsoDateTimeSchema,
  MarketplaceSchema,
  McpAuthModeSchema,
  McpServerSchema,
  McpTransportSchema,
  McpToolSchema,
  MessageSchema,
  ModelSchema,
  PermissionModeSchema,
  ProjectSchema,
  ProviderConfigSchema,
  ProviderKindSchema,
  ProviderViewSchema,
  ReasoningLevelSchema,
  ReviewCommentSchema,
  ReviewCommentSideSchema,
  ReviewSchema,
  SeqSchema,
  SkillSchema,
  SubagentMessageSchema,
  SubagentQuestionViewSchema,
  SubagentSpecSchema,
  SubagentViewSchema,
  TaskSchema,
  ThreadSchema,
  TodoListSchema,
} from './entities.js';
import { ServerEventSchema, ThreadEventRowSchema, type ServerEvent } from './events.js';
import { SettingsPatchSchema, SettingsSchema } from './settings.js';

export const PROTOCOL_VERSION = 1;

export const EmptyObjectSchema = z.object({});

export const RpcErrorCodeSchema = z.enum([
  'unauthorized',
  'bad-request',
  'not-found',
  'conflict',
  'provider-unavailable',
  'permission-denied',
  'internal',
]);
export type RpcErrorCode = z.infer<typeof RpcErrorCodeSchema>;

export const RpcErrorSchema = z.object({
  code: RpcErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const ClientRequestSchema = z.object({
  id: IdSchema,
  method: z.string().min(1),
  params: z.unknown(),
});
export type ClientRequest = z.infer<typeof ClientRequestSchema>;

export const ServerResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    id: IdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    id: IdSchema,
    ok: z.literal(false),
    error: RpcErrorSchema,
  }),
]);
export type ServerResponse = z.infer<typeof ServerResponseSchema>;

export const ServerEventFrameSchema = ServerEventSchema;
export type ServerEventFrame = ServerEvent;

/** The sections and token budget `prompt.preview` reports for one message. */
export const PromptPreviewSchema = z.object({
  sections: z
    .object({
      name: z.string(),
      text: z.string(),
      tokens: z.number().int().nonnegative(),
    })
    .array(),
  total: z.number().int().nonnegative(),
  /** Brain entry ids this message injects, in injection order; absent when not reported. */
  injectedIds: IdSchema.array().optional(),
  /** Why each injected id made the slice, keyed by id. */
  injectionReasons: z.record(z.string(), z.string()).optional(),
});
export type PromptPreview = z.infer<typeof PromptPreviewSchema>;

/** Settings sections a slash command may open directly. */
export const CommandSettingsSectionSchema = z.enum(['your-tuffcode', 'instructions', 'agents']);
export type CommandSettingsSection = z.infer<typeof CommandSettingsSectionSchema>;

/**
 * A command result that the composer must carry out rather than print: open the
 * model picker, switch the thread mode, open a settings section, show the prompt
 * budget, or reload the transcript after the server changed it.
 */
export const CommandUiActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open-model-picker') }),
  z.object({ type: z.literal('switch-mode'), mode: ExecutionModeSchema }),
  z.object({ type: z.literal('open-settings'), section: CommandSettingsSectionSchema }),
  z.object({ type: z.literal('show-context'), preview: PromptPreviewSchema }),
  z.object({ type: z.literal('reload-transcript'), text: z.string() }),
]);
export type CommandUiAction = z.infer<typeof CommandUiActionSchema>;

/**
 * What `commands.run` decided for one input. `turn` text is sent as a user turn,
 * `text` is shown without sending, `ui` is an action the composer performs, and
 * `error` is a command-level failure the composer reports.
 */
export const CommandRunResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ui'), action: CommandUiActionSchema }),
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('turn'), text: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type CommandRunResult = z.infer<typeof CommandRunResultSchema>;

type RpcMethodDefinition = {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
};

const idParam = z.object({ id: IdSchema });
const threadIdParam = z.object({ threadId: IdSchema });
const projectIdParam = z.object({ projectId: IdSchema });

/**
 * One task of the plan the council currently holds in memory. Task rows store the
 * brief but not the owned files, so a goal waiting for plan approval reads them here.
 */
const CouncilPlanTaskSchema = z.object({
  taskId: IdSchema,
  title: z.string(),
  files: z.string().array(),
  dependsOn: z.string().array(),
  critical: z.boolean(),
});

export const EscalationDecisionSchema = z.enum(['accept', 'revise', 'drop']);
export type EscalationDecision = z.infer<typeof EscalationDecisionSchema>;

export const methods = {
  'app.health': {
    params: EmptyObjectSchema,
    result: z.object({
      version: z.string(),
      pid: z.number().int().positive(),
      uptimeMs: z.number().nonnegative(),
      dbPath: z.string(),
    }),
  },
  'projects.list': {
    params: EmptyObjectSchema,
    result: ProjectSchema.array(),
  },
  'projects.add': {
    params: z.object({ path: z.string().min(1) }),
    result: ProjectSchema,
  },
  'projects.remove': {
    params: z.object({
      id: IdSchema,
      deleteWorktrees: z.boolean().optional(),
    }),
    result: EmptyObjectSchema,
  },
  'projects.refresh': {
    params: idParam,
    result: ProjectSchema,
  },
  'threads.list': {
    params: z.object({ projectId: IdSchema.optional() }),
    result: ThreadSchema.array(),
  },
  /** Every root thread across projects, for the Needs you view and its badge. */
  'threads.dashboard': {
    params: EmptyObjectSchema,
    result: z.object({ threads: DashboardThreadSchema.array() }),
  },
  'threads.create': {
    params: z.object({
      projectId: IdSchema,
      title: z.string().optional(),
      providerId: IdSchema,
      modelId: z.string(),
      executionMode: ExecutionModeSchema,
      permissionMode: PermissionModeSchema,
      /** Where the thread runs: the project folder (default) or an isolated worktree. */
      workspace: z.enum(['folder', 'worktree']).optional(),
      baseBranch: z.string().optional(),
    }),
    result: ThreadSchema,
  },
  'threads.get': {
    params: idParam,
    result: ThreadSchema,
  },
  'threads.update': {
    params: z.object({
      id: IdSchema,
      title: z.string().optional(),
      /** Moves the thread to another enabled provider; the next turn replays a bounded digest. */
      providerId: IdSchema.optional(),
      modelId: z.string().optional(),
      reasoningEffort: ReasoningLevelSchema.nullable().optional(),
      executionMode: ExecutionModeSchema.optional(),
      permissionMode: PermissionModeSchema.optional(),
    }),
    result: ThreadSchema,
  },
  /** Title and message search for the sidebar search dialog. */
  'threads.search': {
    params: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().positive().max(50).optional(),
    }),
    result: z
      .object({
        threadId: IdSchema,
        projectId: IdSchema,
        title: z.string(),
        snippet: z.string(),
        matchedIn: z.enum(['title', 'message']),
      })
      .array(),
  },
  'threads.delete': {
    params: z.object({
      id: IdSchema,
      removeWorktree: z.boolean().optional(),
    }),
    result: EmptyObjectSchema,
  },
  'threads.send': {
    params: z.object({
      id: IdSchema,
      text: z.string(),
      attachments: AttachmentSchema.array().optional(),
    }),
    // `queued` marks a send accepted while another turn was live; it runs on settle.
    result: z.object({ turnId: z.string(), queued: z.boolean().optional() }),
  },
  'threads.interrupt': {
    params: idParam,
    result: EmptyObjectSchema,
  },
  'threads.approve': {
    params: z.object({
      threadId: IdSchema,
      approvalId: IdSchema,
      decision: ApprovalChoiceSchema,
    }),
    result: EmptyObjectSchema,
  },
  'threads.events': {
    params: z.object({
      id: IdSchema,
      sinceSeq: SeqSchema.optional(),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({
      events: ThreadEventRowSchema.array(),
      hasMore: z.boolean(),
    }),
  },
  'threads.context': {
    params: threadIdParam,
    result: z.object({
      usedTokens: z.number().int().nonnegative(),
      maxTokens: z.number().int().positive(),
      percent: z.number().min(0).max(1),
      /** Which precedence step supplied `maxTokens`: the model row, its config, settings, or the default. */
      limitSource: z.enum(['model', 'config', 'settings', 'default']),
      compactedAt: IsoDateTimeSchema.optional(),
      segments: z
        .object({
          name: z.string(),
          tokens: z.number().int().nonnegative(),
        })
        .array(),
    }),
  },
  'todos.get': {
    params: threadIdParam,
    result: TodoListSchema,
  },
  'files.tree': {
    params: threadIdParam,
    result: z.object({ paths: z.string().array(), truncated: z.boolean() }),
  },
  'files.read': {
    params: z.object({ threadId: IdSchema, path: z.string().min(1) }),
    result: z.object({ text: z.string(), truncated: z.boolean(), binary: z.boolean() }),
  },
  'messages.list': {
    params: threadIdParam,
    result: MessageSchema.array(),
  },
  'checkpoints.create': {
    params: z.object({ threadId: IdSchema, label: z.string() }),
    result: CheckpointSchema,
  },
  'checkpoints.list': {
    params: threadIdParam,
    result: CheckpointSchema.array(),
  },
  'checkpoints.revert': {
    // The revert discards working-tree changes, so the caller must say so explicitly.
    params: z.object({ threadId: IdSchema, checkpointId: IdSchema, confirm: z.literal(true) }),
    result: EmptyObjectSchema,
  },
  'diff.get': {
    params: z.object({
      threadId: IdSchema,
      checkpointId: IdSchema.optional(),
    }),
    result: z.object({ files: DiffFileSchema.array() }),
  },
  'comments.list': {
    params: threadIdParam,
    result: ReviewCommentSchema.array(),
  },
  'comments.add': {
    params: z.object({
      threadId: IdSchema,
      filePath: z.string().min(1),
      line: z.number().int().positive(),
      side: ReviewCommentSideSchema,
      body: z.string().min(1),
    }),
    result: ReviewCommentSchema,
  },
  'comments.resolve': {
    params: z.object({
      id: IdSchema,
      resolved: z.boolean(),
    }),
    result: ReviewCommentSchema,
  },
  'git.commit': {
    params: z.object({ threadId: IdSchema, message: z.string() }),
    result: z.object({ sha: z.string() }),
  },
  'git.push': {
    params: threadIdParam,
    result: z.object({ branch: z.string(), remote: z.string() }),
  },
  'git.pr': {
    params: z.object({
      threadId: IdSchema,
      title: z.string(),
      body: z.string(),
      draft: z.boolean().optional(),
    }),
    result: z.object({ url: z.string(), number: z.number().int().positive() }),
  },
  'terminal.open': {
    params: z.object({
      threadId: IdSchema,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    result: z.object({ terminalId: IdSchema }),
  },
  'terminal.input': {
    params: z.object({ terminalId: IdSchema, data: z.string() }),
    result: EmptyObjectSchema,
  },
  'terminal.resize': {
    params: z.object({
      terminalId: IdSchema,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    result: EmptyObjectSchema,
  },
  'terminal.close': {
    params: z.object({ terminalId: IdSchema }),
    result: EmptyObjectSchema,
  },
  'providers.list': {
    params: EmptyObjectSchema,
    result: ProviderViewSchema.array(),
  },
  'providers.upsert': {
    params: z.object({
      id: IdSchema.optional(),
      kind: ProviderKindSchema,
      label: z.string(),
      config: ProviderConfigSchema,
      secret: z.string().optional(),
    }),
    result: ProviderViewSchema,
  },
  'providers.remove': {
    params: idParam,
    result: EmptyObjectSchema,
  },
  'providers.test': {
    params: idParam,
    result: z.object({
      ok: z.boolean(),
      detail: z.string(),
      signedIn: z.boolean().optional(),
      cliPath: z.string().optional(),
      models: z.string().array().optional(),
    }),
  },
  'providers.login': {
    params: idParam,
    result: z.object({ loginId: IdSchema }),
  },
  'providers.loginCancel': {
    params: z.object({ loginId: IdSchema }),
    result: EmptyObjectSchema,
  },
  'models.list': {
    params: z.object({ providerId: IdSchema }),
    result: ModelSchema.array(),
  },
  'providers.models': {
    params: z.object({
      providerId: IdSchema,
      refresh: z.boolean().optional(),
    }),
    result: z.object({
      models: ModelSchema.array(),
      source: z.enum(['sdk', 'api', 'manual', 'cache']),
      error: z.string().optional(),
    }),
  },
  'mcp.list': {
    params: EmptyObjectSchema,
    result: McpServerSchema.array(),
  },
  'mcp.upsert': {
    params: z
      .object({
        id: IdSchema.optional(),
        label: z.string().min(1),
        transport: McpTransportSchema.optional(),
        command: z.string().optional(),
        args: z.string().array().optional(),
        env: z.record(z.string(), z.string()).optional(),
        cwd: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        /** How the connector authenticates; defaults to bearer when a secret is sent. */
        authMode: McpAuthModeSchema.optional(),
        /** Request header that carries the credential; defaults to Authorization. */
        authHeader: z.string().min(1).max(120).optional(),
        /**
         * Bearer token or API key for an http server; sent once, stored in the secret
         * bridge. `secretPrefix` (for example "Bearer ") is prepended before storage.
         */
        secret: z.string().optional(),
        secretPrefix: z.string().max(40).optional(),
        enabled: z.boolean().optional(),
      })
      .refine(
        (value) =>
          (value.transport ?? 'stdio') === 'stdio'
            ? (value.command ?? '').trim().length > 0
            : (value.url ?? '').trim().length > 0,
        { message: 'a stdio server needs a command and an http server needs a url' },
      ),
    result: McpServerSchema,
  },
  'mcp.remove': {
    params: idParam,
    result: EmptyObjectSchema,
  },
  'mcp.test': {
    params: idParam,
    result: z.object({
      ok: z.boolean(),
      detail: z.string(),
      tools: McpToolSchema.array(),
      /** True when the connector needs an interactive OAuth sign-in. */
      needsAuth: z.boolean().optional(),
    }),
  },
  /**
   * Starts an OAuth 2.1 authorization code flow with PKCE. The server binds a loopback
   * listener and returns the authorize URL; the renderer opens it in the system browser.
   */
  'mcp.oauth.start': {
    params: z.object({
      id: IdSchema,
      /** Manual client id; omitted means dynamic client registration. */
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().optional(),
    }),
    result: z.object({
      flowId: IdSchema,
      authorizeUrl: z.url(),
    }),
  },
  'mcp.oauth.status': {
    params: idParam,
    result: z.object({
      connected: z.boolean(),
      needsAuth: z.boolean(),
      expiresAt: IsoDateTimeSchema.nullable(),
      authorizationServer: z.string().nullable(),
    }),
  },
  'mcp.oauth.disconnect': {
    params: idParam,
    result: EmptyObjectSchema,
  },
  'settings.get': {
    params: EmptyObjectSchema,
    result: SettingsSchema,
  },
  'settings.set': {
    params: z.object({ patch: SettingsPatchSchema }),
    result: SettingsSchema,
  },
  'prompt.preview': {
    params: z.object({
      threadId: IdSchema,
      message: z.string(),
    }),
    result: PromptPreviewSchema,
  },
  'brain.list': {
    params: z.object({
      kind: BrainKindSchema.optional(),
      projectId: IdSchema.optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().optional(),
      includeInactive: z.boolean().optional(),
    }),
    result: BrainEntrySchema.array(),
  },
  'brain.upsert': {
    params: z.object({
      id: IdSchema.optional(),
      kind: BrainKindSchema,
      scope: z.string().min(1),
      projectId: IdSchema.nullable().optional(),
      text: z.string().min(1),
      tags: z.string().optional(),
      appliesTo: z.string().optional(),
      importance: z.number().min(0).max(1).optional(),
      active: z.boolean().optional(),
    }),
    result: BrainEntrySchema,
  },
  'brain.delete': {
    params: idParam,
    result: EmptyObjectSchema,
  },
  /** Deletes every brain entry and edge, or only one project's. */
  'brain.reset': {
    params: z.object({ projectId: IdSchema.optional() }),
    result: z.object({ removed: z.number().int().nonnegative() }),
  },
  'brain.preview': {
    params: z.object({
      projectId: IdSchema,
      threadId: IdSchema.optional(),
      message: z.string(),
    }),
    result: BrainSliceSchema,
  },
  'brain.graph': {
    params: z.object({
      projectId: IdSchema.optional(),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({
      nodes: z
        .object({
          id: IdSchema,
          kind: BrainKindSchema,
          label: z.string(),
          importance: z.number().min(0).max(1),
          degree: z.number().int().nonnegative(),
        })
        .array(),
      edges: z
        .object({
          from: IdSchema,
          to: IdSchema,
          relation: z.string().min(1),
        })
        .array(),
    }),
  },
  'brain.link': {
    params: z.object({
      fromId: IdSchema,
      toId: IdSchema,
      relation: BrainRelationSchema,
    }),
    result: EmptyObjectSchema,
  },
  'memory.search': {
    params: z.object({
      projectId: IdSchema.optional(),
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
    result: z.object({
      entries: z
        .object({
          id: IdSchema,
          kind: BrainKindSchema,
          text: z.string(),
          score: z.number().nonnegative(),
          reason: z.string(),
        })
        .array(),
    }),
  },
  'council.start': {
    params: z.object({
      threadId: IdSchema,
      goal: z.string().min(1),
      autonomy: GoalAutonomySchema,
    }),
    result: z.object({ goalId: IdSchema }),
  },
  'council.cancel': {
    params: z.object({ goalId: IdSchema }),
    result: EmptyObjectSchema,
  },
  'council.status': {
    params: z.object({ goalId: IdSchema }),
    result: z.object({
      goal: GoalSchema,
      tasks: TaskSchema.array(),
      reviews: ReviewSchema.array(),
      /** Every escalation the goal raised, so a captain sees the open question. */
      escalations: EscalationSchema.array().optional(),
      /** The plan held in memory while the goal runs; empty after a restart. */
      plan: CouncilPlanTaskSchema.array().optional(),
    }),
  },
  'council.latest': {
    params: z.object({ threadId: IdSchema }),
    /** The thread's newest goal, so a reload reattaches to it; null before the first one. */
    result: z
      .object({
        goal: GoalSchema,
        tasks: TaskSchema.array(),
        reviews: ReviewSchema.array(),
        escalations: EscalationSchema.array().optional(),
        plan: CouncilPlanTaskSchema.array().optional(),
      })
      .nullable(),
  },
  /** A manual goal left planning: the captain accepts the plan as it stands. */
  'council.approvePlan': {
    params: z.object({ goalId: IdSchema }),
    result: EmptyObjectSchema,
  },
  /** A manual goal left planning: the planner runs again with the captain feedback. */
  'council.revisePlan': {
    params: z.object({ goalId: IdSchema, feedback: z.string().min(1).max(2000) }),
    result: EmptyObjectSchema,
  },
  /** The captain answers a task escalation: accept it, ask for a revision, or drop it. */
  'council.answerEscalation': {
    params: z.object({
      taskId: IdSchema,
      decision: EscalationDecisionSchema,
      feedback: z.string().max(4000).optional(),
    }),
    result: EmptyObjectSchema,
  },
  'subagents.spawn': {
    params: z.object({
      threadId: IdSchema,
      spec: SubagentSpecSchema,
    }),
    result: z.object({ childId: IdSchema }),
  },
  'subagents.cancel': {
    params: z.object({ childId: IdSchema }),
    result: EmptyObjectSchema,
  },
  'subagents.list': {
    params: z.object({ threadId: IdSchema }),
    result: SubagentViewSchema.array(),
  },
  'subagents.get': {
    params: z.object({ childId: IdSchema }),
    result: SubagentViewSchema,
  },
  /** Sends a follow-up to a child: queued while it runs, a new turn once it settled. */
  'subagents.message': {
    params: z.object({
      childId: IdSchema,
      text: z.string().min(1).max(8000),
      /** Reviewer findings sent back as a rework round; capped per child. */
      rework: z.boolean().optional(),
    }),
    result: z.object({ delivered: z.enum(['queued', 'started']) }),
  },
  'subagents.messages': {
    params: z.object({ childId: IdSchema }),
    result: SubagentMessageSchema.array(),
  },
  /**
   * The user answers a child's blocking question while the main agent is idle. The
   * child's turn resumes with this text, exactly as if the parent had answered.
   */
  'subagents.answer': {
    params: z.object({
      threadId: IdSchema,
      questionId: IdSchema,
      text: z.string().min(1).max(8000),
    }),
    result: EmptyObjectSchema,
  },
  /** Stops, archives and (when it holds no commits) disposes a child; the transcript stays. */
  'subagents.close': {
    params: z.object({ childId: IdSchema }),
    result: SubagentViewSchema,
  },
  /** Open questions of one parent thread, so a reload can still show the answer box. */
  'subagents.questions': {
    params: z.object({ threadId: IdSchema }),
    result: SubagentQuestionViewSchema.array(),
  },
  /** Every subagent across threads, so the sidebar can map child thread ids to child ids. */
  'subagents.listAll': {
    params: EmptyObjectSchema,
    result: SubagentViewSchema.array(),
  },
  'commands.list': {
    params: projectIdParam,
    result: CommandSchema.array(),
  },
  'commands.run': {
    params: z.object({
      threadId: IdSchema,
      input: z.string().min(1),
    }),
    result: CommandRunResultSchema,
  },
  'skills.list': {
    params: projectIdParam,
    result: SkillSchema.array(),
  },
  'skills.read': {
    params: z.object({ projectId: IdSchema, name: z.string().min(1) }),
    result: SkillSchema,
  },
  'plugins.marketplaces': {
    params: EmptyObjectSchema,
    result: MarketplaceSchema.array(),
  },
  'plugins.addMarketplace': {
    params: z.object({ url: z.string().min(3).max(500) }),
    result: MarketplaceSchema,
  },
  'plugins.removeMarketplace': {
    params: idParam,
    result: EmptyObjectSchema,
  },
  /** A user action: reads the cache, fetching only when it is stale or `refresh` is set. */
  'plugins.catalog': {
    params: z.object({
      marketplaceId: IdSchema.optional(),
      refresh: z.boolean().optional(),
    }),
    result: z.object({
      entries: CatalogEntrySchema.array(),
      marketplaces: MarketplaceSchema.array(),
    }),
  },
  'plugins.installed': {
    params: EmptyObjectSchema,
    result: InstalledPluginSchema.array(),
  },
  'plugins.install': {
    params: z.object({ entryId: z.string().min(1) }),
    result: InstalledPluginSchema,
  },
  /** Installs a local .zip, .skill or SKILL.md picked by the user. */
  'plugins.upload': {
    params: z.object({ path: z.string().min(1) }),
    result: InstalledPluginSchema,
  },
  'plugins.setEnabled': {
    params: z.object({ id: IdSchema, enabled: z.boolean() }),
    result: InstalledPluginSchema,
  },
  'plugins.remove': {
    params: idParam,
    result: EmptyObjectSchema,
  },
  'connectors.search': {
    params: z.object({ query: z.string().max(200) }),
    result: z.object({ entries: ConnectorEntrySchema.array(), error: z.string().nullable() }),
  },
  'connectors.install': {
    params: z.object({
      entry: ConnectorEntrySchema,
      env: z.record(z.string(), z.string()).optional(),
      secret: z.string().optional(),
    }),
    result: McpServerSchema,
  },
  'diagnostics.export': {
    params: EmptyObjectSchema,
    result: z.object({ path: z.string() }),
  },
} satisfies Record<string, RpcMethodDefinition>;

export type RpcMethod = keyof typeof methods;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof methods)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof methods)[M]['result']>;

export const RPC_METHODS = Object.keys(methods) as RpcMethod[];

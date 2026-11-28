import { z } from 'zod';

export const IdSchema = z.string().min(1);
export const IsoDateTimeSchema = z.iso.datetime();
export const SeqSchema = z.number().int().nonnegative();

export const ExecutionModeSchema = z.enum(['plan', 'work', 'council']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const PermissionModeSchema = z.enum(['read-only', 'ask', 'accept-edits', 'full-auto']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * What one agent may be offered and may do with it. A subagent child carries the
 * profile of its type, so the request omits what it cannot use instead of denying
 * the call after the model already tried it.
 */
export const ToolProfileSchema = z.object({
  /** Tool names this profile offers. An entry is `name` or `name:action` for extra tools. */
  offer: z.array(z.string()).min(1),
  /** Globs (cwd-relative, forward slashes) that write and edit may touch. Absent means no file writing. */
  writeGlobs: z.array(z.string()).optional(),
  /** read-only: only isReadOnlyCommand passes. worktree: anything except DESTRUCTIVE_COMMANDS. none: bash is not offered. */
  bash: z.enum(['read-only', 'worktree', 'none']),
});
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const ThreadStatusSchema = z.enum([
  'idle',
  'running',
  'needs-approval',
  'ready-to-review',
  'failed',
  'merged',
  'closed',
]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ProviderKindSchema = z.enum([
  'claude',
  'codex',
  'acp',
  'opencode',
  'openai-compatible',
  'anthropic',
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const BrainKindSchema = z.enum([
  'identity',
  'preference',
  'rule',
  'project',
  'memory',
  'working-note',
]);
export type BrainKind = z.infer<typeof BrainKindSchema>;

export const BrainRelationSchema = z.enum(['about', 'part-of', 'supersedes', 'caused']);
export type BrainRelation = z.infer<typeof BrainRelationSchema>;

export const GoalStateSchema = z.enum([
  'intake',
  'planning',
  'provisioning',
  'running',
  'reviewing',
  'reporting',
  'done',
  'failed',
  'cancelled',
]);
export type GoalState = z.infer<typeof GoalStateSchema>;

export const TaskStateSchema = z.enum([
  'queued',
  'provisioning',
  'running',
  'blocked',
  'pr-open',
  'reviewing',
  'changes-requested',
  'passed',
  'merged',
  'awaiting-captain',
  'failed',
  'cancelled',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const ReviewVerdictSchema = z.enum(['pass', 'changes-requested', 'escalate']);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ApprovalDecisionSchema = z.enum(['pending', 'allow', 'allow-thread', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalChoiceSchema = z.enum(['allow', 'allow-thread', 'deny']);
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

export const GoalAutonomySchema = z.enum(['manual', 'auto']);
export type GoalAutonomy = z.infer<typeof GoalAutonomySchema>;

export const DiffFileStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'conflicted',
]);
export type DiffFileStatus = z.infer<typeof DiffFileStatusSchema>;

export const ReviewCommentSideSchema = z.enum(['old', 'new']);
export type ReviewCommentSide = z.infer<typeof ReviewCommentSideSchema>;

export const SubagentTypeSchema = z.enum([
  'explorer',
  'reviewer',
  'notetaker',
  'worker',
  'planner',
]);
export type SubagentType = z.infer<typeof SubagentTypeSchema>;

export const SubagentStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/** A reasoning level name: the built-in ladder or a custom provider level such as `max`. */
export const ReasoningLevelSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/);

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string(),
  path: z.string(),
  defaultBranch: z.string(),
  createdAt: IsoDateTimeSchema,
  lastOpenedAt: IsoDateTimeSchema.nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ThreadSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  parentThreadId: IdSchema.nullable(),
  title: z.string(),
  providerId: IdSchema,
  modelId: z.string(),
  executionMode: ExecutionModeSchema,
  permissionMode: PermissionModeSchema,
  status: ThreadStatusSchema,
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  prUrl: z.string().nullable(),
  /** Per-thread reasoning level; null inherits the provider or model default. */
  reasoningEffort: ReasoningLevelSchema.nullable().default(null),
  lastSeq: SeqSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Thread = z.infer<typeof ThreadSchema>;

export const EventRowSchema = z.object({
  id: z.number().int().positive(),
  threadId: IdSchema,
  seq: SeqSchema,
  type: z.string(),
  payload: z.unknown(),
  createdAt: IsoDateTimeSchema,
});
export type EventRow = z.infer<typeof EventRowSchema>;

export const MessageSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const CheckpointSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  ref: z.string(),
  label: z.string(),
  commitSha: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const ApprovalSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  decision: ApprovalDecisionSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/** One approval waiting on the user, reduced to what a cross-project row shows. */
export const DashboardApprovalSchema = z.object({
  approvalId: IdSchema,
  toolName: z.string(),
  inputSummary: z.string(),
});
export type DashboardApproval = z.infer<typeof DashboardApprovalSchema>;

/**
 * One root thread as the Needs you view sees it: where it lives, what it is doing,
 * whether it went quiet, and which approvals are waiting. `stalled` is decided on
 * the server so every client agrees on the threshold.
 */
export const DashboardThreadSchema = z.object({
  threadId: IdSchema,
  projectId: IdSchema,
  projectName: z.string(),
  title: z.string(),
  status: ThreadStatusSchema,
  updatedAt: IsoDateTimeSchema,
  lastEventAt: IsoDateTimeSchema.nullable(),
  stalled: z.boolean(),
  pendingApprovals: DashboardApprovalSchema.array(),
});
export type DashboardThread = z.infer<typeof DashboardThreadSchema>;

/** What a model can do; every flag is known once a row carries the object. */
export const ModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  reasoningEfforts: z.string().array(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

/**
 * What a payload that declares nothing about capabilities is assumed to do. Discovery
 * leaves the stored object `NULL` instead of writing this, so a row carrying exactly
 * this shape came from a path that did not know whether it was a declaration.
 */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: false,
  reasoning: false,
  reasoningEfforts: [],
};

/** The built-in ladder. The UI labels `none` as "off"; `xhigh` reaches the providers that have it. */
export const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * Free-form provider config with the token limits presets seed and users override.
 * Unknown keys stay untouched so adapters can read their own settings.
 */
export const ProviderConfigSchema = z
  .object({
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    capabilities: ModelCapabilitiesSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
  })
  .catchall(z.unknown());

export const ProviderViewSchema = z.object({
  id: IdSchema,
  kind: ProviderKindSchema,
  label: z.string(),
  config: ProviderConfigSchema,
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;

export const ModelSchema = z.object({
  providerId: IdSchema,
  modelId: z.string(),
  label: z.string(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  capabilities: ModelCapabilitiesSchema.nullable().optional(),
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  isDefault: z.boolean(),
});
export type Model = z.infer<typeof ModelSchema>;

export const McpTransportSchema = z.enum(['stdio', 'http']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/**
 * How a connector proves who it is: nothing, a stored header value (bearer token or
 * API key), or an OAuth 2.1 authorization code flow with PKCE.
 */
export const McpAuthModeSchema = z.enum(['none', 'bearer', 'oauth']);
export type McpAuthMode = z.infer<typeof McpAuthModeSchema>;

export const McpServerSchema = z.object({
  id: IdSchema,
  label: z.string().min(1),
  /** stdio servers need a command; http servers leave it empty and set `url`. */
  transport: McpTransportSchema.default('stdio'),
  command: z.string(),
  args: z.string().array(),
  env: z.record(z.string(), z.string()),
  cwd: z.string().nullable(),
  /** Streamable HTTP endpoint for an http server. */
  url: z.string().nullable().default(null),
  /** How the connector authenticates. Stdio servers default to `none`. */
  authMode: McpAuthModeSchema.default('none'),
  /** Request header that carries the credential. OAuth always uses Authorization. */
  authHeader: z.string().min(1).max(120).default('Authorization'),
  /**
   * True when a credential is stored in the secret bridge: the header value for
   * `bearer`, the token bundle for `oauth`. The value never leaves the bridge.
   */
  hasSecret: z.boolean().default(false),
  /** The installed plugin that owns this server, or null for one the user added. */
  pluginId: IdSchema.nullable().default(null),
  enabled: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}).refine(
  (server) =>
    server.transport === 'stdio'
      ? server.command.trim().length > 0
      : (server.url ?? '').trim().length > 0,
  { message: 'a stdio server needs a command and an http server needs a url' },
);
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type McpTool = z.infer<typeof McpToolSchema>;

export const SubagentSpecSchema = z.object({
  type: SubagentTypeSchema,
  task: z.string().min(1),
  model: z.string().optional(),
  providerId: IdSchema.optional(),
  worktree: z.boolean().optional(),
  budgetTokens: z.number().int().positive().optional(),
});
export type SubagentSpec = z.infer<typeof SubagentSpecSchema>;

export const SubagentViewSchema = z.object({
  childId: IdSchema,
  threadId: IdSchema,
  childThreadId: IdSchema.nullable(),
  type: SubagentTypeSchema,
  model: z.string(),
  providerId: IdSchema,
  status: SubagentStatusSchema,
  task: z.string(),
  summary: z.string().optional(),
  /**
   * Live telemetry. Absent means not measured (a row from before telemetry existed), which
   * the UI shows as "usage -" instead of a guessed zero.
   */
  toolCount: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  /** The current or most recent tool call, one line. */
  activity: z.string().nullable().optional(),
  startedAt: IsoDateTimeSchema.nullable().optional(),
  finishedAt: IsoDateTimeSchema.nullable().optional(),
  /** Messages from the child the parent has not read yet. */
  unread: z.number().int().nonnegative().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SubagentView = z.infer<typeof SubagentViewSchema>;

export const SubagentMessageDirectionSchema = z.enum(['to-child', 'to-parent']);
export type SubagentMessageDirection = z.infer<typeof SubagentMessageDirectionSchema>;

export const SubagentMessageSchema = z.object({
  id: IdSchema,
  childId: IdSchema,
  direction: SubagentMessageDirectionSchema,
  text: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type SubagentMessage = z.infer<typeof SubagentMessageSchema>;

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'abandoned']);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoItemSchema = z.object({
  content: z.string().min(1).max(500),
  status: TodoStatusSchema,
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoPhaseSchema = z.object({
  name: z.string().min(1).max(80),
  tasks: TodoItemSchema.array(),
});
export type TodoPhase = z.infer<typeof TodoPhaseSchema>;

export const TodoListSchema = z.object({
  threadId: IdSchema,
  phases: TodoPhaseSchema.array(),
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type TodoList = z.infer<typeof TodoListSchema>;

export const BrainEntrySchema = z.object({
  id: IdSchema,
  kind: BrainKindSchema,
  scope: z.string(),
  projectId: IdSchema.nullable(),
  text: z.string(),
  tags: z.string(),
  appliesTo: z.string().nullable(),
  importance: z.number().min(0).max(1),
  useCount: z.number().int().nonnegative(),
  active: z.boolean(),
  sourceQuote: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema.nullable(),
});
export type BrainEntry = z.infer<typeof BrainEntrySchema>;

export const BrainSliceSchema = z.object({
  always: BrainEntrySchema.array(),
  retrieved: BrainEntrySchema.array(),
  tokens: z.number().int().nonnegative(),
});
export type BrainSlice = z.infer<typeof BrainSliceSchema>;

export const GoalSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  text: z.string(),
  autonomy: GoalAutonomySchema,
  state: GoalStateSchema,
  createdAt: IsoDateTimeSchema,
  reportedAt: IsoDateTimeSchema.nullable(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  goalId: IdSchema,
  threadId: IdSchema.nullable(),
  title: z.string(),
  brief: z.string(),
  /** Titles of the tasks that must pass before this one starts; the plan's edges. */
  dependsOn: z.string().array(),
  state: TaskStateSchema,
  authorProvider: z.string(),
  authorModel: z.string(),
  reviewerProvider: z.string().nullable(),
  reviewerModel: z.string().nullable(),
  critical: z.boolean(),
  round: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const ReviewSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  providerId: IdSchema,
  modelId: z.string(),
  verdict: ReviewVerdictSchema,
  body: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type Review = z.infer<typeof ReviewSchema>;

export const EscalationSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  question: z.string(),
  answer: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export const ReviewCommentSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  filePath: z.string(),
  line: z.number().int().positive(),
  side: ReviewCommentSideSchema,
  body: z.string(),
  resolved: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const CommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  path: z.string().nullable(),
  /** Usage hint from frontmatter, or null when the command takes no arguments. */
  argumentHint: z.string().nullable(),
});
export type Command = z.infer<typeof CommandSchema>;

export const SkillSourceSchema = z.enum([
  'system',
  'project',
  'user',
  'plugin',
  'claude-project',
]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  path: z.string(),
  /** Where the skill was discovered; project skills shadow user and plugin skills. */
  source: SkillSourceSchema.default('project'),
  pluginId: IdSchema.nullable().default(null),
});
export type Skill = z.infer<typeof SkillSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: DiffFileStatusSchema,
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().nullable(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const TerminalSessionSchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  cwd: z.string(),
  shell: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;

export const PluginKindSchema = z.enum(['plugin', 'skill', 'connector']);
export type PluginKind = z.infer<typeof PluginKindSchema>;

/** What an installed plugin contributes. Agents and hooks are listed but never executed. */
export const PluginComponentsSchema = z.object({
  skills: z.string().array(),
  commands: z.string().array(),
  mcpServers: z.string().array(),
  agents: z.string().array(),
  hooks: z.boolean(),
});
export type PluginComponents = z.infer<typeof PluginComponentsSchema>;

export const MarketplaceSchema = z.object({
  id: IdSchema,
  label: z.string(),
  /** A GitHub `owner/repo` slug or an https URL to a marketplace.json file. */
  url: z.string(),
  verified: z.boolean(),
  builtIn: z.boolean(),
  fetchedAt: IsoDateTimeSchema.nullable(),
  error: z.string().nullable(),
  /** Entries the last fetch skipped because they did not parse. */
  skipped: z.number().int().nonnegative(),
});
export type Marketplace = z.infer<typeof MarketplaceSchema>;

export const CatalogEntrySchema = z.object({
  /** `<marketplaceId>/<name>`, stable across refreshes. */
  id: z.string().min(1),
  marketplaceId: IdSchema,
  name: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  category: z.string(),
  author: z.string().nullable(),
  homepage: z.string().nullable(),
  /** `owner/repo` of the source, for the card's repo label. */
  repo: z.string().nullable(),
  kind: PluginKindSchema,
  verified: z.boolean(),
  /** Component names the catalog declares; null when the catalog does not say. */
  components: PluginComponentsSchema.partial().nullable(),
  installed: z.boolean(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const InstalledPluginSourceSchema = z.enum(['marketplace', 'upload', 'custom']);
export type InstalledPluginSource = z.infer<typeof InstalledPluginSourceSchema>;

export const InstalledPluginSchema = z.object({
  id: IdSchema,
  marketplaceId: IdSchema.nullable(),
  name: z.string().min(1),
  displayName: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  kind: PluginKindSchema,
  enabled: z.boolean(),
  installPath: z.string(),
  components: PluginComponentsSchema,
  source: InstalledPluginSourceSchema,
  installedAt: IsoDateTimeSchema,
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

/** One MCP registry server, reduced to what the connectors tab shows and installs. */
export const ConnectorEntrySchema = z.object({
  name: z.string().min(1),
  title: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  /** Streamable HTTP endpoint when the server is hosted. */
  remoteUrl: z.string().nullable(),
  /** npm package for a local stdio server. */
  npmPackage: z.string().nullable(),
  /** Environment variables the server declares as required. */
  requiredEnv: z.string().array(),
  repository: z.string().nullable(),
});
export type ConnectorEntry = z.infer<typeof ConnectorEntrySchema>;

/**
 * One user attachment. Exactly one source is present: `path` for a file inside the
 * thread worktree, `data` for bytes the renderer already encoded (a pasted or
 * downscaled image, which has no filesystem home the server may read).
 */
export const AttachmentSchema = z
  .object({
    name: z.string(),
    path: z.string().optional(),
    /** Base64 payload without the `data:` prefix; `mimeType` names the format. */
    data: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .refine((attachment) => (attachment.path === undefined) !== (attachment.data === undefined), {
    message: 'an attachment carries either a path or inline data, never both',
  });
export type Attachment = z.infer<typeof AttachmentSchema>;

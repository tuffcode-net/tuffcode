import type {
  ApprovalChoice,
  PermissionMode,
  ProviderKind,
  SubagentDepth,
  SubagentType,
  ToolProfile,
} from './entities.js';
import type { AdapterEvent } from './events.js';

export interface TurnContext {
  turnId: string;
  cwd: string;
  systemPrompt: string;
  /**
   * The cacheable head of `systemPrompt`: base, custom instructions, project rules and
   * skills, with none of the per-turn blocks. Providers that support prompt caching
   * mark it as a breakpoint so a changing memory block does not invalidate it.
   */
  systemPromptStatic?: string;
  permissionMode: PermissionMode;
  model: string;
  brainSlice: string;
  /**
   * One entry per user attachment. `path` is a resolved file inside the worktree;
   * `data` is base64 the renderer already encoded, with `mimeType` naming the format.
   */
  attachments: TurnAttachment[];
  /** True when the turn's model can read images; adapters inline them only then. */
  vision: boolean;
  signal: AbortSignal;
  /** Tool names the user enabled in settings; unset means every harness tool. */
  toolAllowlist?: string[];
  /** Output token cap for this turn; unset leaves the adapter's configured default. */
  maxOutputTokens?: number;
  /** The thread the turn belongs to, so server tools attribute work without guessing. */
  threadId?: string;
  /** Reasoning level for this turn (`none` disables thinking); unset keeps the adapter default. */
  reasoningEffort?: string;
  /** Which server tools this turn offers; unset keeps the adapter's construction-time choice. */
  toolOptions?: TurnToolOptions;
  /** Set only for subagent child threads: the tools their type may be offered and use. */
  toolProfile?: ToolProfile;
}

/** One attachment as an adapter receives it, with the source already resolved. */
export interface TurnAttachment {
  /** The display name the user saw, kept so an inline image still has a filename. */
  name?: string;
  /** Absolute path inside the worktree, for attachments that arrived as a path. */
  path?: string;
  /** Base64 payload for attachments that arrived as bytes. */
  data?: string;
  /** MIME type of `data`, and the hint that marks an attachment as an image. */
  mimeType?: string;
  /** Pixel size of an inline image, used for the context estimate. */
  width?: number;
  height?: number;
  kind: 'file' | 'image';
}

/** Server tools a turn may offer, decided per turn from capabilities and the thread kind. */
export interface TurnToolOptions {
  subagent: boolean;
  /** mcp, memory and config. */
  extra: boolean;
  todo: boolean;
  skill: boolean;
  webFetch: boolean;
  /** mcp tool and Claude's MCP servers; false when the connectors capability is off. */
  mcp: boolean;
}

export interface AdapterCapabilities {
  tools: boolean;
  approvals: boolean;
  resume: boolean;
  models: boolean;
}

export interface AdapterSession {
  readonly id: string;
  readonly providerId: string;
  readonly capabilities: AdapterCapabilities;
  send(text: string, ctx: TurnContext): AsyncIterable<AdapterEvent>;
  approve(approvalId: string, decision: ApprovalChoice): void;
  interrupt(): Promise<void>;
  /**
   * Trims the adapter's in-memory history to a summary plus the last two messages.
   * Only the harness adapters implement this; vendor CLIs report their own usage and
   * leave history to the vendor. A failed summary leaves history untouched and
   * reports zero removed.
   */
  compact?(): Promise<CompactResult>;
  dispose(): Promise<void>;
}

export interface CompactResult {
  /** Messages folded into the summary; zero when nothing was trimmed. */
  removed: number;
}

export interface AdapterLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** One enabled MCP server as a vendor CLI must reach it: a stdio command or an http endpoint. */
export type McpServerLaunch =
  | { type?: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

export interface AdapterDeps {
  logger: AdapterLogger;
  resolveCommand(name: string): Promise<string | null>;
  env: Record<string, string | undefined>;
  /**
   * Spawns a typed subagent for the parent turn that owns `cwd`. The harness passes
   * the turn cwd because the adapter never sees the thread id; the server resolves
   * the parent thread from the worktree and rejects nested or read-only turns.
   */
  spawnSubagent?(request: SubagentToolRequest): Promise<SubagentToolResult>;
  /**
   * Every subagent action other than spawn (status, wait, message, stop, inbox, report,
   * ask, answer, close, read). Returns the text the model reads.
   */
  subagentControl?(request: SubagentControlRequest): Promise<string>;
  /**
   * Runs one of the server-owned tools (`mcp`, `memory`, `config`) for a turn. The
   * harness passes the turn cwd because the server resolves the thread from it. When
   * unset the harness offers no extra tools and a stray call is answered as unavailable.
   */
  extraTool?: ExtraToolRunner;
  /**
   * Enabled stdio MCP servers keyed by unique display name. Vendor CLIs that launch
   * servers themselves read this; harness adapters reach MCP through `extraTool`.
   */
  mcpServers?: () => Record<string, McpServerLaunch>;
}

/** Server-owned harness tools: the adapter only shapes the schema and permission. */
export type ExtraToolName = 'mcp' | 'memory' | 'config' | 'todo' | 'skill' | 'web_fetch';

export type ExtraToolRunner = (
  name: ExtraToolName,
  args: Record<string, unknown>,
  ctx: { cwd: string; threadId?: string },
) => Promise<string>;

export interface SubagentToolRequest {
  /** Absolute worktree of the parent turn. */
  cwd: string;
  /** The parent thread when the harness knows it; preferred over the worktree lookup. */
  threadId?: string;
  type: SubagentType;
  task: string;
  model?: string;
  /** quick, normal or thorough; the prompt states it and the row keeps it. */
  depth?: SubagentDepth;
}

export type SubagentControlAction =
  | 'status'
  | 'wait'
  | 'message'
  | 'stop'
  | 'inbox'
  | 'report'
  | 'ask'
  | 'answer'
  | 'close'
  | 'read';

export interface SubagentControlRequest {
  action: SubagentControlAction;
  cwd: string;
  threadId?: string;
  /** Child id for message, stop, close and read; optional filter for status and wait. */
  id?: string;
  text?: string;
  /** True when this message sends reviewer findings back as a rework round. */
  rework?: boolean;
  timeoutSeconds?: number;
  /** The open question `answer` replies to. */
  questionId?: string;
  /** The last message id `read` returned; the next page starts after it. */
  cursor?: string;
  /** The parent turn's signal, so an interrupted parent stops waiting at once. */
  signal?: AbortSignal;
}

export interface SubagentToolResult {
  childId: string;
  status: string;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  config: Record<string, unknown>;
  secret: string | null;
}

export interface ModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  isDefault?: boolean;
}

export class AdapterUnavailableError extends Error {
  readonly code = 'provider-unavailable';
  readonly providerId: string;
  readonly hint: string;

  constructor(providerId: string, hint: string, options?: ErrorOptions) {
    super(`provider ${providerId} is unavailable`, options);
    this.name = 'AdapterUnavailableError';
    this.providerId = providerId;
    this.hint = hint;
  }
}

import type {
  AdapterDeps,
  ExtraToolName,
  PermissionMode,
  ToolProfile,
  TurnContext,
  TurnToolOptions,
} from '@tuffcode/contracts';
import {
  EXTRA_TOOL_SCHEMAS,
  SUBAGENT_TOOL,
  SUBAGENT_TOOL_NAME,
  TOOL_SCHEMAS,
  type ToolName,
  type ToolSchema,
} from '@tuffcode/prompt';
import { classifyTool } from './openai/tools.js';

/** A file tool, the delegation tool, or a server-owned extra tool. */
export type HarnessToolSchema =
  | ToolSchema
  | { name: string; description: string; parameters: ToolSchema['parameters'] };

/** Which server tools a request offers; every flag defaults to off. */
export type ToolListOptions = Partial<TurnToolOptions>;

const NO_SERVER_TOOLS: TurnToolOptions = {
  subagent: false,
  extra: false,
  todo: false,
  skill: false,
  webFetch: false,
  mcp: false,
};

/**
 * The server tools this turn offers: what the harness can run (deps) narrowed by what
 * the server enabled for this turn (capabilities, thread kind). A context built without
 * `toolOptions` keeps the construction-time behaviour: every injected tool is offered.
 */
export function resolveToolOptions(ctx: TurnContext, deps: AdapterDeps): TurnToolOptions {
  const extra = deps.extraTool !== undefined;
  // Read-only turns still see the tool: status, wait, inbox and report are safe there,
  // and classifySubagentTool denies spawn, message and stop.
  const subagent = deps.spawnSubagent !== undefined;
  const available: TurnToolOptions = {
    subagent,
    extra,
    todo: extra,
    skill: extra,
    webFetch: extra,
    mcp: extra,
  };
  const wanted = ctx.toolOptions;
  if (wanted === undefined) return available;
  return {
    subagent: available.subagent && wanted.subagent,
    extra: available.extra && wanted.extra,
    todo: available.todo && wanted.todo,
    skill: available.skill && wanted.skill,
    webFetch: available.webFetch && wanted.webFetch,
    mcp: available.mcp && wanted.mcp,
  };
}

/** Whether a server tool name was offered this turn; file tools are gated by the allowlist. */
export function isServerToolOffered(name: string, options: TurnToolOptions): boolean {
  switch (name) {
    case SUBAGENT_TOOL_NAME:
      return options.subagent;
    case 'mcp':
      return options.extra && options.mcp;
    case 'memory':
    case 'config':
      return options.extra;
    case 'todo':
      return options.todo;
    case 'skill':
      return options.skill;
    case 'web_fetch':
      return options.webFetch;
    default:
      return true;
  }
}

export { NO_SERVER_TOOLS };

/** Whether a profile offers a tool at all: by bare name, or by one of its named actions. */
export function profileOffers(profile: ToolProfile, name: string): boolean {
  return profile.offer.some((entry) => entry === name || entry.startsWith(name + ':'));
}

/** The schema with the profile's limits spelled out; never mutates the shared TOOL_SCHEMAS. */
function shapeForProfile(
  schema: HarnessToolSchema,
  profile: ToolProfile | undefined,
): HarnessToolSchema {
  if (profile === undefined) return schema;
  if (schema.name === 'bash' && profile.bash === 'read-only') {
    return {
      ...schema,
      description:
        schema.description + ' Read-only commands only; anything that writes is refused.',
    };
  }
  if (schema.name === 'write' || schema.name === 'edit') {
    const globs = profile.writeGlobs ?? [];
    if (globs.length === 0) return schema;
    return {
      ...schema,
      description:
        schema.description + ' You may write only these paths: ' + globs.join(', ') + '.',
    };
  }
  return schema;
}

/**
 * The harness tools a turn may offer. An unset allowlist means every file tool, which
 * keeps a context built without settings on the pre-settings behaviour. The subagent
 * and extra tools are separate from the allowlist on purpose: `enabledTools` lists file
 * tools, and delegation or server tools must not disappear because the user narrowed
 * that list. A profile narrows what is left: a tool it does not offer is never shown,
 * so a child never spends a turn on a call that would be refused.
 */
export function allowedToolSchemas(
  allowlist?: readonly string[],
  options: ToolListOptions = {},
  profile?: ToolProfile,
): readonly HarnessToolSchema[] {
  const listed: HarnessToolSchema[] =
    allowlist === undefined
      ? [...TOOL_SCHEMAS]
      : TOOL_SCHEMAS.filter((schema) => allowlist.includes(schema.name));
  const tools =
    profile === undefined
      ? listed
      : listed.filter((schema) => profileOffers(profile, schema.name));
  // Callers that only say `extra` mean the original three tools, mcp included.
  const offered = { ...NO_SERVER_TOOLS, ...options, mcp: options.mcp ?? options.extra === true };
  const shaped = tools.map((schema) => shapeForProfile(schema, profile));
  if (offered.subagent && (profile === undefined || profileOffers(profile, SUBAGENT_TOOL_NAME))) {
    shaped.push(SUBAGENT_TOOL);
  }
  for (const schema of EXTRA_TOOL_SCHEMAS) {
    if (!isServerToolOffered(schema.name, offered)) continue;
    if (profile !== undefined && !profileOffers(profile, schema.name)) continue;
    shaped.push(schema);
  }
  return shaped;
}

/** True when settings disabled this tool, so a call must be answered with an error. */
export function isToolDisabled(name: string, allowlist: readonly string[] | undefined): boolean {
  return allowlist !== undefined && !allowlist.includes(name);
}

const ALL_PERMISSION_MODES: readonly PermissionMode[] = [
  'read-only',
  'ask',
  'accept-edits',
  'full-auto',
];

/** Tools that only read the worktree. Everything else can write, spawn, or reach the network. */
const READ_ONLY_TOOLS: Record<string, true> = {
  read: true,
  glob: true,
  grep: true,
  memory: true,
  todo: true,
};

/** How many read-only calls of one assistant step may be in flight at the same time. */
export const PARALLEL_TOOL_LIMIT = 4;

/**
 * Whether a call may run concurrently with its siblings from the same assistant step.
 *
 * Two conditions, both required: the shared permission ladder allows the call in every
 * mode, so no mode can ever gate it after it started, and the tool is on the read-only
 * list, so it cannot write, spawn, or reach the network. `mcp list` is deliberately
 * absent even though it looks like a read: it spawns the configured binaries, and a
 * read-only turn denies it. `memory` and `todo` allow their mutating actions in every
 * mode, so their action decides.
 */
export function isParallelSafeTool(
  name: string,
  args: Record<string, unknown> | null | undefined,
): boolean {
  if (READ_ONLY_TOOLS[name] !== true) return false;
  const input = args ?? {};
  const allowed = ALL_PERMISSION_MODES.every(
    (mode) => classifyTool(name as ToolName | ExtraToolName, input, mode) === 'allow',
  );
  if (!allowed) return false;
  if (name === 'memory') return input.action === 'search';
  if (name === 'todo') return input.op === 'view';
  return true;
}

/** How many identical repeats in a row, with no new assistant text, mean the model is stuck. */
export const REPEATED_TOOL_CALL_LIMIT = 3;

/** Sorted-key JSON, so a re-serialised but identical argument object compares equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).toSorted();
    const entries = keys.map((key) => JSON.stringify(key) + ':' + stableJson(record[key]));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Stops a turn whose model is stuck repeating itself. A turn may run any number of
 * distinct tool calls; the same call issued `REPEATED_TOOL_CALL_LIMIT` times in a
 * row with no new assistant text in between is a loop, not progress.
 */
export class RepeatedToolCallGuard {
  private signature: string | null = null;
  private count = 0;

  /** Records one assistant step; true when this step is the stuck repeat. */
  observe(text: string, calls: readonly { name: string; args: unknown }[]): boolean {
    if (text.length > 0 || calls.length === 0) {
      this.signature = null;
      this.count = 0;
      return false;
    }
    const signature = calls
      .map((call) => call.name + '\u0000' + stableJson(call.args))
      .join('\u0001');
    if (signature === this.signature) this.count += 1;
    else {
      this.signature = signature;
      this.count = 1;
    }
    return this.count >= REPEATED_TOOL_CALL_LIMIT;
  }
}

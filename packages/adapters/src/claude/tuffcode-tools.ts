import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { AdapterDeps, PermissionMode, TurnContext } from '@tuffcode/contracts';
import {
  SUBAGENT_TOOL_NAME,
  TOOL_NAMES,
  isSubagentAction,
  isSubagentType,
} from '@tuffcode/prompt';
import { z } from 'zod';
import {
  classifyExtraTool,
  classifySubagentTool,
  type PermissionDecision,
} from '../openai/tools.js';
import { profileOffers, resolveToolOptions } from '../tool-policy.js';

/**
 * Tuffcode's own tools for Claude sessions. The Claude CLI runs its own tool loop, so
 * the harness tools reach it as an in-process SDK MCP server named `tuffcode`: the
 * task list, subagent control, memory, config, MCP, skills and web_fetch share one
 * implementation with the harness adapters and land in the same thread state.
 */
export const TUFFCODE_SERVER_NAME = 'tuffcode';
const PREFIX = `mcp__${TUFFCODE_SERVER_NAME}__`;

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** One registered tool before the SDK wraps it, so tests can inspect names and handlers. */
export interface TuffcodeToolSpec {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  run(args: Record<string, unknown>): Promise<ToolText>;
}

function text(value: string, isError = false): ToolText {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): ToolText {
  return text(error instanceof Error ? error.message : String(error), true);
}

/** Drops undefined fields so the server-side runner sees the same shape the harness sends. */
function defined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

/** Every name a profile can speak about: the harness tools and this server's tools. */
const PROFILE_TOOL_NAMES = new Set<string>([
  ...TOOL_NAMES,
  SUBAGENT_TOOL_NAME,
  'mcp',
  'memory',
  'config',
  'todo',
  'skill',
  'web_fetch',
]);

/** The built-in Claude tools whose harness counterpart the profile governs. */
const VENDOR_TOOL_NAMES: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
};

/**
 * The harness name behind a Claude tool call, or null when the profile has no say.
 * The built-in file tools and this server's own `mcp__tuffcode__*` tools map; vendor
 * MCP tools and tools Tuffcode does not run keep the approval path.
 */
export function claudeHarnessToolName(toolName: string): string | null {
  if (toolName.startsWith(PREFIX)) {
    const name = toolName.slice(PREFIX.length);
    return PROFILE_TOOL_NAMES.has(name) ? name : null;
  }
  return VENDOR_TOOL_NAMES[toolName] ?? null;
}

/**
 * The permission decision for a `mcp__tuffcode__*` call, or null for any other tool.
 * Mirrors the harness: status reads, todo and skill never ask; spawning, messaging,
 * stopping, config and MCP calls follow the permission ladder.
 */
export function classifyTuffcodeTool(
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
): PermissionDecision | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const name = toolName.slice(PREFIX.length);
  if (name === SUBAGENT_TOOL_NAME) return classifySubagentTool(mode, input);
  if (
    name === 'todo' ||
    name === 'skill' ||
    name === 'web_fetch' ||
    name === 'memory' ||
    name === 'config' ||
    name === 'mcp'
  ) {
    return classifyExtraTool(name, input, mode);
  }
  return 'deny';
}

/** The `config` schema mirrors the prompt tool, plus the secret fields this round adds. */
const CONFIG_SCHEMA = {
  action: z.string(),
  providerId: z.string().optional(),
  kind: z.string().optional(),
  label: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  modelId: z.string().optional(),
  contextWindow: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  capabilities: z.string().optional(),
  reasoning: z.string().optional(),
  command: z.string().optional(),
  args: z.string().optional(),
  env: z.string().optional(),
  cwd: z.string().optional(),
  transport: z.enum(['stdio', 'http']).optional(),
  url: z.string().optional(),
  token: z.string().optional(),
  secretEnv: z.string().optional(),
  secret: z.string().optional(),
  apiKey: z.string().optional(),
  key: z.string().optional(),
  value: z.string().optional(),
};

const MCP_SCHEMA = {
  action: z.string(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.string().optional(),
};

/**
 * The tools this turn offers, in registration order. Gated exactly like the harness:
 * config and memory need `extra`, mcp needs `mcp`, every spec needs a runner, and a
 * child's profile drops what its type may not use.
 */
export function tuffcodeToolSpecs(deps: AdapterDeps, ctx: TurnContext): TuffcodeToolSpec[] {
  const options = resolveToolOptions(ctx, deps);
  const runner = deps.extraTool;
  const scope = { cwd: ctx.cwd, ...(ctx.threadId === undefined ? {} : { threadId: ctx.threadId }) };
  const specs: TuffcodeToolSpec[] = [];
  const wanted = (name: string): boolean =>
    ctx.toolProfile === undefined || profileOffers(ctx.toolProfile, name);

  if (options.todo && runner !== undefined && wanted('todo')) {
    specs.push({
      name: 'todo',
      description:
        'Track multi-step work as a phased task list the user sees live. op: init (list or items), start (task), done, drop, rm (task, phase, or all), append (items, phase), view. Keep one task in progress; mark it done right after verifying.',
      schema: {
        op: z.enum(['init', 'start', 'done', 'drop', 'rm', 'append', 'view']),
        list: z
          .array(z.object({ phase: z.string().optional(), items: z.array(z.string()) }))
          .optional(),
        items: z.array(z.string()).optional(),
        task: z.string().optional(),
        phase: z.string().optional(),
      },
      run: async (args) => {
        try {
          return text(await runner('todo', defined(args), scope));
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  if (options.subagent && deps.spawnSubagent !== undefined && wanted(SUBAGENT_TOOL_NAME)) {
    const spawn = deps.spawnSubagent;
    const control = deps.subagentControl;
    specs.push({
      name: SUBAGENT_TOOL_NAME,
      description:
        'Run and control Tuffcode subagents. action spawn (default) starts explorer, reviewer, notetaker, worker or planner with a self-contained task and returns its id; status lists children with tool count, tokens and activity; wait blocks until children settle or one asks a question (timeout_s), and returns open questions first; message steers a child; stop cancels one; inbox reads unread reports; ask posts one blocking question to the parent; answer replies to a question id; close stops and archives a child, keeping its transcript; read pages a child reports with cursor.',
      schema: {
        action: z.string().optional(),
        id: z.string().optional(),
        text: z.string().optional(),
        question_id: z.string().optional(),
        cursor: z.string().optional(),
        timeout_s: z.number().int().min(1).max(600).optional(),
        type: z.string().optional(),
        task: z.string().optional(),
        model: z.string().optional(),
      },
      run: async (args) => {
        const action = typeof args.action === 'string' ? args.action : 'spawn';
        const task = typeof args.task === 'string' ? args.task : '';
        const model = typeof args.model === 'string' ? args.model : undefined;
        try {
          if (!isSubagentAction(action)) return text(`unknown action: ${action}`, true);
          if (action === 'spawn') {
            if (!isSubagentType(args.type)) {
              return text(
                'type must be one of explorer, reviewer, notetaker, worker, planner',
                true,
              );
            }
            if (task.trim().length === 0) {
              return text('task is required', true);
            }
            const spawned = await spawn({
              ...scope,
              type: args.type,
              task,
              ...(model === undefined ? {} : { model }),
            });
            return text(
              `subagent ${spawned.childId} (${args.type}) ${spawned.status}. Use action wait to collect its summary.`,
            );
          }
          if (control === undefined) return text(`subagent ${action} is unavailable`, true);
          return text(
            await control({
              action,
              ...scope,
              ...(typeof args.id === 'string' ? { id: args.id } : {}),
              ...(typeof args.text === 'string' ? { text: args.text } : {}),
              ...(typeof args.question_id === 'string' ? { questionId: args.question_id } : {}),
              ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
              ...(typeof args.timeout_s === 'number' ? { timeoutSeconds: args.timeout_s } : {}),
              signal: ctx.signal,
            }),
          );
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  if (options.extra && runner !== undefined && wanted('memory')) {
    specs.push({
      name: 'memory',
      description:
        'Search Tuffcode brain memory or record one durable entry. action: search (query) or add (kind, text, tags, importance).',
      schema: {
        action: z.enum(['search', 'add']),
        query: z.string().optional(),
        kind: z.string().optional(),
        text: z.string().optional(),
        tags: z.string().optional(),
        importance: z.string().optional(),
      },
      run: async (args) => {
        try {
          return text(await runner('memory', defined(args), scope));
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  if (options.extra && runner !== undefined && wanted('config')) {
    specs.push({
      name: 'config',
      description:
        'Change Tuffcode configuration through validated services: add a provider, add a provider model, add an MCP server, or set one allowlisted setting. Pass a user-supplied credential in secret (alias apiKey) for provider.add, token for an http MCP server, or secretEnv as a JSON object for a stdio server; it goes to the OS keychain and is never echoed. Pass capabilities, args, env and secretEnv as JSON strings.',
      schema: CONFIG_SCHEMA,
      run: async (args) => {
        try {
          return text(await runner('config', defined(args), scope));
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  if (options.mcp && runner !== undefined && wanted('mcp')) {
    specs.push({
      name: 'mcp',
      description:
        'List enabled MCP servers and their tools, or call one tool on one server. Pass arguments as a JSON object string.',
      schema: MCP_SCHEMA,
      run: async (args) => {
        try {
          return text(await runner('mcp', defined(args), scope));
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  if (options.skill && runner !== undefined && wanted('skill')) {
    specs.push({
      name: 'skill',
      description: 'Load the full instructions of one skill listed under Available skills.',
      schema: { name: z.string() },
      run: async (args) => {
        try {
          return text(await runner('skill', defined(args), scope));
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  if (options.webFetch && runner !== undefined && wanted('web_fetch')) {
    specs.push({
      name: 'web_fetch',
      description: 'Fetch one public http or https URL and return its readable text.',
      schema: { url: z.string(), max_chars: z.number().int().min(500).max(64000).optional() },
      run: async (args) => {
        try {
          return text(await runner('web_fetch', defined(args), scope));
        } catch (error) {
          return failure(error);
        }
      },
    });
  }

  return specs;
}

/** The in-process server for one turn, or undefined when the turn offers none of the tools. */
export function tuffcodeServer(
  deps: AdapterDeps,
  ctx: TurnContext,
): Record<string, unknown> | undefined {
  const specs = tuffcodeToolSpecs(deps, ctx);
  if (specs.length === 0) return undefined;
  const tools = specs.map((spec) =>
    tool(spec.name, spec.description, spec.schema, (args) =>
      spec.run(args as Record<string, unknown>),
    ),
  );
  return {
    [TUFFCODE_SERVER_NAME]: createSdkMcpServer({
      name: TUFFCODE_SERVER_NAME,
      version: '1.0.0',
      tools,
    }),
  };
}

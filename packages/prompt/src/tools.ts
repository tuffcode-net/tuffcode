/**
 * JSON Schema definitions for the six core harness tools and the three extra
 * tools the server runs itself.
 *
 * These are plain data, not zod schemas, so they serialize directly into a
 * model request and stay under the token budget. The server validates calls
 * against the same shapes.
 */

export const TOOL_NAMES = ['bash', 'read', 'edit', 'write', 'glob', 'grep'] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolParameterType = 'string' | 'integer' | 'boolean';

export interface ToolParameterSchema {
  type: ToolParameterType;
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ToolParameterSchema>;
  required: string[];
  additionalProperties: false;
}

export interface ToolSchema {
  name: ToolName;
  description: string;
  parameters: ToolParameters;
}

export const TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: 'bash',
    description:
      'Run a shell command in the worktree. Use for builds, tests, git, and process control. Output is capped and a timeout kills the process tree.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to execute.' },
        timeout_ms: {
          type: 'integer',
          description: 'Timeout in milliseconds. Default 120000.',
          minimum: 1000,
          maximum: 600000,
        },
        cwd: { type: 'string', description: 'Working directory, relative to the worktree root.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      'Read a UTF-8 text file and return numbered lines. Required before editing. Use offset and limit to page through large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the worktree root.' },
        offset: { type: 'integer', description: 'First line to return, 1-based.', minimum: 1 },
        limit: {
          type: 'integer',
          description: 'Maximum lines to return.',
          minimum: 1,
          maximum: 2000,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    description:
      'Replace an exact string in a file. Fails when old_string is missing or matches more than once; add surrounding context to disambiguate. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the worktree root.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every match instead of requiring exactly one.',
          default: false,
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'write',
    description:
      'Create a file or replace its entire contents. Parent directories are created. Refuses paths outside the worktree root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the worktree root.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description:
      'List files matching a glob pattern, newest first. Use to locate files by name or extension. Results are capped at 200.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as src/**/*.ts.' },
        path: {
          type: 'string',
          description: 'Directory to search. Defaults to the worktree root.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Respects .gitignore. Returns matching lines, one path per file with a match, or a per-file count. Results are capped at 200.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        mode: {
          type: 'string',
          description:
            'content (default) returns path:line: text, files returns one path per file with a match, count returns path:count.',
          default: 'content',
        },
        path: { type: 'string', description: 'File or directory to search.' },
        glob: { type: 'string', description: 'Restrict files by glob, such as **/*.ts.' },
        case_sensitive: {
          type: 'boolean',
          description: 'Match case when true. Default true.',
          default: true,
        },
        max_results: {
          type: 'integer',
          description: 'Maximum matches to return.',
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
];

export const EXTRA_TOOL_NAMES = ['mcp', 'memory', 'config', 'todo', 'skill', 'web_fetch'] as const;

export type ExtraToolName = (typeof EXTRA_TOOL_NAMES)[number];

export interface ExtraToolSchema {
  name: ExtraToolName;
  description: string;
  parameters: ToolParameters;
}

/**
 * The extra tools are served by the server, not the file tools. Object and array
 * parameters are encoded as JSON strings because `ToolParameterSchema` has no
 * object or array type.
 */
export const MCP_TOOL: ExtraToolSchema = {
  name: 'mcp',
  description:
    'List enabled MCP servers and their tools, or call one tool on one server. Pass arguments as a JSON object string.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: list enabled servers and their tools, or call one tool on one server.',
      },
      server: {
        type: 'string',
        description: 'Server id from the list action. Required for call.',
      },
      tool: {
        type: 'string',
        description: 'Tool name on that server. Required for call.',
      },
      arguments: {
        type: 'string',
        description:
          'JSON object string of arguments for the MCP tool, for example {"path":"src"}. Omit when the tool takes none.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export const MEMORY_TOOL: ExtraToolSchema = {
  name: 'memory',
  description:
    'Search brain memory or record one durable entry. Search before asking the user to repeat context.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: search brain memory, or add one durable entry.',
      },
      query: {
        type: 'string',
        description: 'Text to search for. Required for search.',
      },
      kind: {
        type: 'string',
        description:
          'Entry kind for add: identity, preference, rule, project, memory, or working-note.',
      },
      text: {
        type: 'string',
        description: 'The durable fact to store, one sentence. Required for add.',
      },
      tags: {
        type: 'string',
        description: 'Comma separated lowercase tags for add, for example build,windows.',
      },
      importance: {
        type: 'string',
        description: 'Importance from 0 to 1 as a decimal string, for example 0.5.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export const CONFIG_TOOL: ExtraToolSchema = {
  name: 'config',
  description:
    'Change Tuffcode configuration through validated services: add a provider, add a provider model, add an MCP server, or set one allowlisted setting. provider.add creates the row; the key is set in Settings > Providers and never passed through a tool. Pass capabilities, args, and env as JSON strings.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'Action: provider.add, provider.model.add, mcp.add, or settings.set.',
      },
      providerId: {
        type: 'string',
        description: 'Provider id for provider.add and provider.model.add.',
      },
      kind: {
        type: 'string',
        description:
          'Provider kind for provider.add: claude, codex, anthropic, openai-compatible, acp, or opencode.',
      },
      label: {
        type: 'string',
        description: 'Human readable provider label.',
      },
      baseUrl: {
        type: 'string',
        description: 'Base URL for an openai-compatible provider.',
      },
      modelId: {
        type: 'string',
        description: 'Model id for provider.model.add.',
      },
      contextWindow: {
        type: 'integer',
        description: 'Context window in tokens for the model.',
        minimum: 1,
      },
      maxOutputTokens: {
        type: 'integer',
        description: 'Maximum output tokens for the model.',
        minimum: 1,
      },
      capabilities: {
        type: 'string',
        description:
          'JSON object string with tools, vision, reasoning, and reasoningEfforts, for example {"tools":true}.',
      },
      reasoning: {
        type: 'string',
        description: 'Reasoning effort for the model: none, minimal, low, medium, or high.',
      },
      command: {
        type: 'string',
        description: 'Executable for mcp.add.',
      },
      args: {
        type: 'string',
        description: 'JSON array of strings of command arguments for mcp.add, for example ["--stdio"].',
      },
      env: {
        type: 'string',
        description:
          'JSON object string of environment variables for mcp.add. Secret-like keys are rejected; set those in Settings > MCP env.',
      },
      key: {
        type: 'string',
        description: 'Settings key for settings.set. Only the documented allowlist is accepted.',
      },
      value: {
        type: 'string',
        description: 'Settings value as text for settings.set.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

/**
 * OMP-style task list. One op per call; `list` and `items` are JSON strings because
 * the parameter schema has no array type.
 */
export const TODO_TOOL: ExtraToolSchema = {
  name: 'todo',
  description:
    'Track multi-step work as a phased task list the user sees live. One op per call: init replaces the list, start marks one task in progress (others go back to pending), done or drop closes a task, a phase, or everything, rm removes, append adds tasks, view shows the list. Use it for work with three or more steps; keep exactly one task in progress and mark it done right after you verify it.',
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        description: 'One of init, start, done, drop, rm, append, view.',
      },
      list: {
        type: 'string',
        description:
          'For init: JSON array of phases, for example [{"phase":"Build","items":["add schema","wire tool"]}].',
      },
      items: {
        type: 'string',
        description:
          'For append, or a flat init: JSON array of task strings, for example ["write tests"].',
      },
      task: {
        type: 'string',
        description: 'Exact task text for start, or to target one task with done, drop, rm.',
      },
      phase: {
        type: 'string',
        description: 'Phase name: targets a phase for done, drop, rm, or chooses one for append and init.',
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
};

export const SKILL_TOOL: ExtraToolSchema = {
  name: 'skill',
  description:
    'Load the full instructions of one skill listed under Available skills. Load a skill only when its description matches the task; the body is returned as text.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name exactly as listed.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export const WEB_FETCH_TOOL: ExtraToolSchema = {
  name: 'web_fetch',
  description:
    'Fetch one http or https URL and return its readable text (HTML is stripped). Use it for documentation and issue pages the task needs; never for secrets or private hosts.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http or https URL.' },
      max_chars: {
        type: 'integer',
        description: 'Maximum characters of text to return. Default 20000.',
        minimum: 500,
        maximum: 64000,
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export const EXTRA_TOOL_SCHEMAS: readonly ExtraToolSchema[] = [
  MCP_TOOL,
  MEMORY_TOOL,
  CONFIG_TOOL,
  TODO_TOOL,
  SKILL_TOOL,
  WEB_FETCH_TOOL,
];

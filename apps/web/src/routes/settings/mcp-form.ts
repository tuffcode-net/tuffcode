import type { McpAuthMode, McpServer, McpTransport } from '@tuffcode/contracts';

/** The add/edit form state for one MCP server: a stdio command or an http endpoint. */
export interface McpDraft {
  id?: string;
  label: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  authMode: McpAuthMode;
  authHeader: string;
  /** Prepended to `secret` before storage, for example "Bearer ". */
  secretPrefix: string;
  /** Only ever written by the user; a stored credential is never rendered back. */
  secret: string;
  /** The row already holds a credential; only its presence is shown. */
  hasSecret: boolean;
  enabled: boolean;
}

export interface McpFieldErrors {
  label?: string;
  command?: string;
  env?: string;
  cwd?: string;
  url?: string;
  authHeader?: string;
  secret?: string;
}

export interface McpUpsertParams {
  id?: string;
  label: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  url?: string | null;
  authMode?: McpAuthMode;
  authHeader?: string;
  secret?: string;
  secretPrefix?: string;
  enabled: boolean;
}

export interface ParsedEnv {
  env?: Record<string, string>;
  error?: string;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_URL = /^https:\/\/\S+$/;
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

export function emptyMcpDraft(): McpDraft {
  return {
    label: '',
    transport: 'stdio',
    command: '',
    args: '',
    env: '',
    cwd: '',
    url: '',
    authMode: 'none',
    authHeader: 'Authorization',
    secretPrefix: 'Bearer ',
    secret: '',
    hasSecret: false,
    enabled: true,
  };
}

/** One argument as text that `parseMcpArgs` reads back as the same single argument. */
export function formatMcpArg(arg: string): string {
  if (!/[\s"']/.test(arg)) return arg;
  return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
}

/** Never copies a credential into the draft: only `hasSecret` describes it. */
export function mcpDraftFromServer(server: McpServer): McpDraft {
  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    command: server.command,
    args: server.args.map(formatMcpArg).join('\n'),
    env: Object.keys(server.env).length > 0 ? JSON.stringify(server.env, null, 2) : '',
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    authMode: server.authMode,
    authHeader: server.authHeader,
    secretPrefix: 'Bearer ',
    secret: '',
    hasSecret: server.hasSecret,
    enabled: server.enabled,
  };
}

/**
 * Arguments are separated by whitespace, and one argument per line also works. A
 * quoted segment stays one argument, so a Windows path with a space survives:
 * `"C:/Users/me/the code/fixture.mjs"`.
 */
export function parseMcpArgs(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/** Parses the env field as a JSON object of strings; blank means no variables. */
export function parseMcpEnv(text: string): ParsedEnv {
  const trimmed = text.trim();
  if (!trimmed) return { env: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: 'Environment must be valid JSON.' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Environment must be a JSON object.' };
  }

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      return { error: `Environment value for ${name} must be a string.` };
    }
    env[name] = value;
  }

  return { env };
}

/** True when the URL is https, or plain http on the loopback interface. */
export function isMcpHttpUrl(raw: string): boolean {
  const value = raw.trim();
  return HTTP_URL.test(value) || LOCAL_URL.test(value);
}

export function validateMcpDraft(draft: McpDraft): McpFieldErrors {
  const errors: McpFieldErrors = {};

  if (!draft.label.trim()) errors.label = 'Label is required.';

  if (draft.transport === 'stdio') {
    if (!draft.command.trim()) errors.command = 'Command is required.';
  } else if (!isMcpHttpUrl(draft.url)) {
    errors.url = 'Enter an https URL, or http on localhost.';
  }

  const parsedEnv = parseMcpEnv(draft.env);
  if (parsedEnv.error) errors.env = parsedEnv.error;

  const cwd = draft.cwd.trim();
  if (cwd && !/^[A-Za-z]:[\\/]|^\/|^~[\\/]/.test(cwd)) {
    errors.cwd = 'Enter an absolute path.';
  }

  if (draft.transport === 'http' && draft.authMode === 'bearer') {
    if (!HEADER_NAME.test(draft.authHeader.trim())) {
      errors.authHeader = 'Enter a valid header name.';
    }
    if (!draft.hasSecret && draft.secret.trim().length === 0) {
      errors.secret = 'Enter the token or API key.';
    }
  }

  return errors;
}

/** Builds the `mcp.upsert` params; invalid env JSON throws instead of dropping it. */
export function buildMcpUpsertParams(draft: McpDraft): McpUpsertParams {
  const parsedEnv = parseMcpEnv(draft.env);
  if (parsedEnv.error) throw new Error(parsedEnv.error);

  const cwd = draft.cwd.trim();
  const base = {
    ...(draft.id ? { id: draft.id } : {}),
    label: draft.label.trim(),
    transport: draft.transport,
    enabled: draft.enabled,
  };
  if (draft.transport === 'stdio') {
    return {
      ...base,
      command: draft.command.trim(),
      args: parseMcpArgs(draft.args),
      env: parsedEnv.env ?? {},
      cwd: cwd ? cwd : null,
    };
  }

  const secret = draft.secret.trim();
  return {
    ...base,
    url: draft.url.trim(),
    authMode: draft.authMode,
    ...(draft.authMode === 'bearer'
      ? {
          authHeader: draft.authHeader.trim(),
          ...(secret.length === 0 ? {} : { secret, secretPrefix: draft.secretPrefix }),
        }
      : {}),
  };
}

/** One-line description of how a saved connector authenticates. */
export function mcpAuthSummary(server: McpServer): string {
  if (server.authMode === 'oauth') return 'Browser OAuth';
  if (server.authMode === 'bearer') return `Header ${server.authHeader}`;
  return 'No auth';
}

import {
  AdapterEventSchema,
  methods,
  type AdapterEvent,
  type ClientRequest,
  type EventRow,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerResponse,
  type Thread,
  type ThreadEventRow,
} from '@tuffcode/contracts';
import type { z } from 'zod';
import { buildBrainGraph } from './brain/graph.js';
import { createBrainRpcHandlers, type BrainHandlerDeps } from './brain/handlers.js';
import { searchMemory } from './brain/search.js';
import { createBrainStore } from './brain/store.js';
import { createCommentHandlers } from './comments/rpc.js';
import { createContextHandlers } from './context/rpc.js';
import { createCouncilHandlers } from './council/rpc.js';
import type { Council } from './council/types.js';
import { dashboardThreads } from './dashboard.js';
import type { Repos } from './db/repos/index.js';
import type { DiagnosticsInput } from './diagnostics.js';
import { createDiagnosticsHandlers } from './diagnostics.js';
import { RpcError } from './errors.js';
import type { EventBus } from './events.js';
import {
  assertGitHubCli,
  commitThread,
  createCheckpoint,
  getDiff,
  listCheckpoints,
  openPullRequest,
  preparePullRequest,
  pushThread,
  revertCheckpoint,
} from './git/index.js';
import { registerMcpRpc } from './mcp/rpc.js';
import type { McpService } from './mcp/service.js';
import { addProject, listProjects, refreshProject, removeProject } from './projects.js';
import { createPromptHandlers } from './prompt/rpc.js';
import { createProviderHandlers } from './providers/rpc.js';
import type { ProvidersService } from './providers/service.js';
import { createRunnerHandlers } from './runner/rpc.js';
import type { Runner } from './runner/runner.js';
import { createSubagentHandlers } from './subagents/rpc.js';
import type { Subagents } from './subagents/types.js';
import {
  createThread,
  deleteThread,
  getThread,
  listThreads,
  searchThreads,
  updateThread,
} from './threads.js';

export interface RpcDeps {
  repos: Repos;
  bus: EventBus;
  version: string;
  startedAt: number;
  dbPath: string;
  runner: Runner;
  providers: ProvidersService;
  brain: BrainHandlerDeps;
  commands: RpcHandlers;
  diagnostics: DiagnosticsInput;
  /** Present once the council slice is wired; absent leaves its methods unregistered. */
  council?: Council;
  /** Present once the subagent slice is wired; absent leaves its methods unregistered. */
  subagents?: Subagents;
  /** Present once the MCP slice is wired; absent leaves its methods unregistered. */
  mcp?: McpService;
  featureHandlers: readonly RpcHandlers[];
}

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;
export type RpcHandlers = ReadonlyMap<string, RpcHandler>;

type HandlerFor<M extends RpcMethod> = (
  params: RpcParams<M>,
) => RpcResult<M> | Promise<RpcResult<M>>;

interface MethodDefinition {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
}

const definitions: Record<string, MethodDefinition> = methods;

function parseAdapterEvent(row: EventRow): AdapterEvent {
  const parsed = AdapterEventSchema.safeParse(row.payload);
  if (!parsed.success) throw new RpcError('internal', 'stored event payload is invalid');
  return parsed.data;
}

/**
 * The exact method set this slice implements. Later slices add their methods by
 * extending this function; anything not registered is rejected by `dispatch`, never
 * answered by a stub.
 */
export function createRpcHandlers(deps: RpcDeps): RpcHandlers {
  const handlers = new Map<string, RpcHandler>();

  function define<M extends RpcMethod>(method: M, handler: HandlerFor<M>): void {
    // dispatch already parsed params with the contract schema for this method.
    handlers.set(method, (params) => handler(params as RpcParams<M>));
  }

  /** Feature maps merge here; a duplicate is a startup bug, never last-wins. */
  function register(map: RpcHandlers): void {
    for (const [method, handler] of map) {
      if (handlers.has(method)) {
        throw new Error(`duplicate RPC method registration: ${method}`);
      }
      handlers.set(method, handler);
    }
  }

  function emitThread(thread: Thread): void {
    deps.bus.emit({ kind: 'event', type: 'thread.updated', threadId: thread.id, payload: thread });
  }

  define('app.health', () => ({
    version: deps.version,
    pid: process.pid,
    uptimeMs: Date.now() - deps.startedAt,
    dbPath: deps.dbPath,
  }));

  define('projects.list', () => listProjects(deps.repos));
  define('projects.add', ({ path }) => addProject(deps.repos, path));
  define('projects.remove', async ({ id, deleteWorktrees }) => {
    await removeProject(deps.repos, id, deleteWorktrees ?? false);
    return {};
  });
  define('projects.refresh', ({ id }) => refreshProject(deps.repos, id));

  define('threads.list', ({ projectId }) => listThreads(deps.repos, projectId));
  define('threads.dashboard', () => ({ threads: dashboardThreads(deps.repos) }));
  define('threads.create', async (params) => {
    const thread = await createThread(deps.repos, params);
    emitThread(thread);
    return thread;
  });
  define('threads.get', ({ id }) => getThread(deps.repos, id));
  define('threads.update', (params) => {
    const thread = updateThread(deps.repos, params);
    emitThread(thread);
    return thread;
  });
  define('threads.search', ({ query, limit }) => searchThreads(deps.repos, query, limit));
  define('threads.delete', async ({ id, removeWorktree }) => {
    // A deleted parent must not leave a live child: stop every queued or running child
    // first, then remove the child thread rows, which the parent's ON DELETE SET NULL
    // would otherwise turn into top-level conversations with live worktrees.
    await deps.subagents?.cancelAll(id);
    for (const child of deps.repos.subagents.listByThread(id)) {
      if (child.childThreadId !== null) deps.repos.threads.remove(child.childThreadId);
    }
    await deps.runner.disposeThread(id);
    await deleteThread(deps.repos, id, removeWorktree ?? false);
    return {};
  });
  define('threads.events', ({ id, sinceSeq, limit }) => {
    const thread = getThread(deps.repos, id);
    const max = Math.min(limit ?? 200, 1000);
    const rows = deps.repos.events.since(thread.id, sinceSeq ?? 0, max + 1);
    const events: ThreadEventRow[] = rows
      .slice(0, max)
      .map((row) => ({ ...row, payload: parseAdapterEvent(row) }));
    return { events, hasMore: rows.length > max };
  });

  // getThread is the ownership check: an unknown thread is not-found, never an
  // empty list that hides a bad id.
  define('messages.list', ({ threadId }) =>
    deps.repos.messages.list(getThread(deps.repos, threadId).id),
  );

  define('settings.get', () => deps.repos.settings.get());
  define('settings.set', ({ patch }) => {
    const settings = deps.repos.settings.patch(patch);
    deps.bus.emit({ kind: 'event', type: 'settings.updated', payload: settings });
    return settings;
  });

  define('checkpoints.create', ({ threadId, label }) =>
    createCheckpoint(deps.repos, threadId, label),
  );
  define('checkpoints.list', ({ threadId }) => listCheckpoints(deps.repos, threadId));
  define('checkpoints.revert', async ({ threadId, checkpointId, confirm }) => {
    // The contract already pins confirm to true; passing it through keeps the
    // destructive git calls behind the domain-level gate instead of a literal.
    await revertCheckpoint(deps.repos, threadId, checkpointId, confirm);
    return {};
  });

  define('diff.get', async ({ threadId, checkpointId }) => ({
    files: await getDiff(deps.repos, threadId, checkpointId),
  }));

  define('git.commit', ({ threadId, message }) => commitThread(deps.repos, threadId, message));
  define('git.push', ({ threadId }) => pushThread(deps.repos, threadId));
  define('git.pr', async ({ threadId, title, body, draft }) => {
    // gh is checked before preparePullRequest, so a missing or signed-out CLI fails
    // without first committing and pushing work the user did not expect to leave.
    await assertGitHubCli(deps.repos, threadId);
    await preparePullRequest(deps.repos, threadId, title);
    const result = await openPullRequest(deps.repos, threadId, { title, body, draft });
    deps.repos.threads.setPrUrl(threadId, result.url);
    emitThread(getThread(deps.repos, threadId));
    return result;
  });

  register(createRunnerHandlers({ runner: deps.runner }));
  register(createPromptHandlers({ repos: deps.repos }));
  register(createContextHandlers({ repos: deps.repos }));
  register(createProviderHandlers({ providers: deps.providers }));
  register(createCommentHandlers({ repos: deps.repos }));
  register(createBrainRpcHandlers(deps.brain));
  define('brain.graph', (params) => buildBrainGraph(deps.repos.brain, params));
  define('memory.search', (params) => searchMemory(createBrainStore(deps.repos.brain), params));
  register(deps.commands);
  register(createDiagnosticsHandlers(deps.diagnostics));
  if (deps.council !== undefined) register(createCouncilHandlers({ council: deps.council }));
  if (deps.subagents !== undefined) {
    register(createSubagentHandlers({ subagents: deps.subagents }));
  }
  if (deps.mcp !== undefined) registerMcpRpc(register, deps.mcp);
  for (const feature of deps.featureHandlers) register(feature);

  return handlers;
}

/** Maps a thrown value to a contract error without ever exposing a stack trace. */
export function errorResponse(id: string, error: unknown): ServerResponse {
  if (error instanceof RpcError) {
    return {
      id,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  return { id, ok: false, error: { code: 'internal', message: 'internal error' } };
}

/**
 * Validates params, runs the handler, validates the result. Unknown methods and bad
 * params are `bad-request`; a handler that returns something off-contract is
 * `internal`, which surfaces a server bug instead of shipping malformed data.
 */
export async function dispatch(
  handlers: RpcHandlers,
  request: ClientRequest,
): Promise<ServerResponse> {
  const handler = handlers.get(request.method);
  const definition = definitions[request.method];
  if (handler === undefined || definition === undefined) {
    return {
      id: request.id,
      ok: false,
      error: { code: 'bad-request', message: `unknown method: ${request.method}` },
    };
  }
  const params = definition.params.safeParse(request.params);
  if (!params.success) {
    return {
      id: request.id,
      ok: false,
      error: {
        code: 'bad-request',
        message: 'invalid params',
        details: params.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    };
  }
  try {
    const result = await handler(params.data);
    const parsed = definition.result.safeParse(result);
    if (!parsed.success) {
      return {
        id: request.id,
        ok: false,
        error: { code: 'internal', message: 'handler returned an invalid result' },
      };
    }
    return { id: request.id, ok: true, result: parsed.data };
  } catch (error) {
    return errorResponse(request.id, error);
  }
}

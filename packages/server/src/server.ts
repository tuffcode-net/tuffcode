import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  cacheRoot,
  createLogger,
  dbPath as defaultDbPath,
  logsDir,
  pluginsRoot,
  serverJsonPath,
  type Logger,
} from '@tuffcode/shared';
import {
  createAdapterDeps,
  createAdapterForProvider,
  type AdapterFactoryOverrides,
} from './adapters/factory.js';
import { createResolveCommand } from './adapters/resolveCommand.js';
import { ensureToken, verifyToken } from './auth.js';
import { searchMemory } from './brain/search.js';
import { createBrainStore } from './brain/store.js';
import { createRunningBudget } from './budget.js';
import { createCommandHandlers } from './commands/handlers.js';
import { recoverOrphanedGoals } from './council/recover.js';
import { createCouncil } from './council/service.js';
import { closeDb, migrate, openDb } from './db/index.js';
import { createRepos, type Repos } from './db/repos/index.js';
import { createWarningLog, type DiagnosticsInput } from './diagnostics.js';
import { createEventBus, type EventBus } from './events.js';
import { createHttpServer as createHttpSurface } from './http.js';
import { createMcpService, type McpService } from './mcp/service.js';
import { createProvidersService, type ProvidersService } from './providers/service.js';
import { createTerminalHandlers } from './pty/handlers.js';
import { TerminalService } from './pty/service.js';
import { createRpcHandlers, type RpcHandlers } from './rpc.js';
import { createRunner, type Runner } from './runner/runner.js';
import { createSecretBridge, type SecretPort, type Secrets } from './secrets/bridge.js';
import { createSkillHandlers } from './skills/handlers.js';
import { createSubagents } from './subagents/service.js';
import { backfillTitles } from './titles.js';
import { createFileHandlers } from './files/service.js';
import { loadSkill } from './skills/discover.js';
import { pluginSkillRoots } from './skills/roots.js';
import { createPluginHandlers } from './plugins/rpc.js';
import { createPluginsService } from './plugins/service.js';
import { createTodoHandlers } from './todos/rpc.js';
import { createTodoService } from './todos/service.js';
import { createWebFetch } from './tools/web-fetch.js';
import type { Subagents } from './subagents/types.js';
import { createExtraTools } from './tools/extra.js';
import { attachWebSocket, type AttachedWebSocket } from './ws.js';

export interface ServerJson {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export interface StartServerOptions {
  version?: string;
  dbFile?: string;
  port?: number;
  writeServerJson?: boolean;
  /** Electron's utilityProcess message port for the safeStorage bridge. */
  parentPort?: SecretPort;
  /** Handler maps owned by other slices, merged into the registry. */
  featureHandlers?: readonly RpcHandlers[];
  adapterOverrides?: AdapterFactoryOverrides;
  logger?: Logger;
}

export interface RunningServer {
  port: number;
  token: string;
  dbPath: string;
  db: DatabaseSync;
  repos: Repos;
  bus: EventBus;
  handlers: RpcHandlers;
  httpServer: Server;
  runner: Runner;
  providers: ProvidersService;
  secrets: Secrets;
  mcp: McpService;
  close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    server.off('error', reject);
    resolve();
  });
  return promise;
}

function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => {
    resolve();
  });
  return promise;
}

/** Writes `~/.tuffcode/server.json` with mode 0600 for the Electron main process. */
export function writeServerJson(info: ServerJson): void {
  const file = serverJsonPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Boots the Node-side core: database plus migrations, token, HTTP surface, WS
 * transport, provider registry, secret bridge, thread runner, and the RPC registry.
 * Binds 127.0.0.1 on an OS-assigned port unless one is supplied.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const version = options.version ?? process.env.TUFFCODE_APP_VERSION ?? '0.0.0';
  const file = options.dbFile ?? defaultDbPath();
  const db = openDb(file);
  migrate(db);
  const repos = createRepos(db);
  // Discovery used to write its fallback shape as if the endpoint had declared it, which
  // made the provider Vision toggle unreachable for those rows. Null them once per boot.
  repos.providers.repairDefaultCapabilities();
  const bus = createEventBus();
  const token = ensureToken();
  const startedAt = Date.now();

  const logger = options.logger ?? createLogger({ dir: logsDir(), channel: 'server' });
  const adapterLogger = createLogger({ dir: logsDir(), channel: 'adapter' });
  const secrets = createSecretBridge(options.parentPort);
  const resolveCommand = createResolveCommand();
  const warnings = createWarningLog();
  bus.subscribe((event) => {
    if (event.type === 'server.warning') warnings.push(event.payload.message);
  });

  const providers = createProvidersService({
    repos,
    bus,
    secrets,
    resolveCommand,
    cacheDir: cacheRoot(),
  });
  const mcp = createMcpService(repos, { secrets, bus });
  // Connector tokens load once so Claude's synchronous launch map can attach them.
  void mcp.warmSecrets().catch(() => undefined);
  const todos = createTodoService({ repos, bus });
  const plugins = createPluginsService({
    repos,
    bus,
    mcp,
    pluginsDir: pluginsRoot(),
    cacheDir: cacheRoot(),
  });
  const brainStore = createBrainStore(repos.brain);
  const extraTools = createExtraTools({
    repos,
    settings: () => repos.settings.get(),
    providers,
    mcp,
    brain: {
      search: (input) => searchMemory(brainStore, input),
      add: (input) => brainStore.upsert(input),
    },
    todos,
    skills: {
      read: (projectId, name) => {
        const project = repos.projects.get(projectId);
        if (project === undefined) throw new Error('project not found');
        return loadSkill(project.path, name, {
          pluginRoots: pluginSkillRoots(repos),
          onWarning: () => undefined,
        });
      },
    },
    webFetch: createWebFetch(),
    emit: (event) => bus.emit(event),
  });
  // The runner needs adapter deps and the subagent service needs the runner, so the
  // harness hook resolves the service through a holder assigned right after creation.
  let subagentsRef: Subagents | undefined;
  // Claude launches MCP servers itself; the map is read per session, so a connector
  // added or toggled in Plugins reaches the next Claude session without a restart.
  const adapterDeps = createAdapterDeps({
    logger: adapterLogger,
    resolveCommand,
    extraTool: extraTools.run,
    mcpServers: () => mcp.launchMap(),
    subagentControl: async (request) => {
      if (subagentsRef === undefined) throw new Error('subagent service is not ready');
      return subagentsRef.control(request);
    },
    spawnSubagent: async (request) => {
      if (subagentsRef === undefined) throw new Error('subagent service is not ready');
      return subagentsRef.spawnFromTool(request);
    },
  });
  const runner = createRunner({
    repos,
    bus,
    logger,
    secrets,
    settings: () => repos.settings.get(),
    createAdapter: (provider, secret) =>
      createAdapterForProvider(provider, adapterDeps, secret, options.adapterOverrides ?? {}),
  });
  runner.recoverOrphanedRuns();
  const recovered = await recoverOrphanedGoals({ repos, logger });
  logger.info('council recovery finished', {
    goals: recovered.goals,
    tasksFailed: recovered.tasksFailed,
    worktreesKept: recovered.worktreesKept,
    worktreesRemoved: recovered.worktreesRemoved,
  });
  // One child budget for the whole process: every parent and every resume draws on it.
  const budget = createRunningBudget(() => repos.settings.get().subagentConcurrency);
  const council = createCouncil({
    repos,
    bus,
    runner,
    logger,
    // Council runs unattended, so its runner answers child approvals through the runner.
    ports: {
      approve: (threadId, approvalId, decision) => runner.approve(threadId, approvalId, decision),
    },
  });
  const subagents = createSubagents({
    repos,
    bus,
    runner,
    logger,
    settings: () => repos.settings.get(),
    budget,
  });
  subagentsRef = subagents;
  subagents.recoverOrphaned();
  try {
    const renamed = backfillTitles(repos);
    if (renamed > 0) logger.info('legacy thread titles backfilled', { count: renamed });
  } catch (error) {
    logger.warn('thread title backfill failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const diagnostics: DiagnosticsInput = {
    version,
    startedAt,
    dbPath: file,
    repos,
    runner,
    warnings: () => warnings.list(),
    secretBridgeAvailable: secrets.available,
  };

  const commands: RpcHandlers = new Map([
    ...createCommandHandlers({ repos, bus, council, subagents, runner, mcp }),
    ...createSkillHandlers({ repos, bus }),
  ]);
  const terminals = new TerminalService({
    repos,
    onData: ({ threadId, terminalId, data }) => {
      bus.emit({ kind: 'event', type: 'terminal.data', threadId, payload: { terminalId, data } });
    },
  });

  const httpServer = createHttpSurface({ version, startedAt });
  const handlers = createRpcHandlers({
    repos,
    bus,
    version,
    startedAt,
    dbPath: file,
    runner,
    providers,
    brain: { repos },
    commands,
    diagnostics,
    council,
    subagents,
    mcp,
    featureHandlers: [
      createTerminalHandlers(terminals),
      createTodoHandlers({ todos }),
      createFileHandlers({ repos }),
      createPluginHandlers({ plugins }),
      ...(options.featureHandlers ?? []),
    ],
  });
  const ws: AttachedWebSocket = attachWebSocket(httpServer, { handlers, bus, verifyToken });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await council.dispose();
    await subagents.dispose();
    await runner.disposeAll();
    mcp.dispose();
    secrets.dispose();
    await terminals.disposeAll();
    await ws.close();
    httpServer.closeIdleConnections();
    httpServer.closeAllConnections();
    await closeHttp(httpServer);
    closeDb(db);
    await adapterLogger.close().catch(() => undefined);
    if (options.logger === undefined) await logger.close().catch(() => undefined);
  };

  try {
    await listen(httpServer, options.port ?? 0);
  } catch (error) {
    await close();
    throw error;
  }
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    await close();
    throw new Error('server did not bind a TCP port');
  }
  const port = (address as AddressInfo).port;

  if (options.writeServerJson !== false) {
    try {
      writeServerJson({ port, token, pid: process.pid, startedAt });
    } catch (error) {
      await close();
      throw error;
    }
  }

  return {
    port,
    token,
    dbPath: file,
    db,
    repos,
    bus,
    handlers,
    httpServer,
    runner,
    providers,
    secrets,
    mcp,
    close,
  };
}

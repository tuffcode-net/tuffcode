import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_REMOTE_SETTINGS, type RemoteSettings, type Settings } from '@tuffcode/contracts';
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
import { createSessionAuth, createPairingStore, ensureToken, hashSecret, verifyToken } from './auth.js';
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
import { createRemoteSockets } from './remote-sockets.js';
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
  /** Overrides for the persisted remote settings, used by tests and the packaged app. */
  remoteOverrides?: Partial<RemoteSettings>;
  /** Built renderer directory; defaults to `TUFFCODE_WEB_ROOT` or `apps/web/dist`. */
  webRoot?: string;
}

export interface RunningServer {
  port: number;
  host: string;
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
  /** Effective remote access settings right now; replaced when the user saves. */
  readonly remote: RemoteSettings;
  /** The remote listener's port while remote access is on, otherwise undefined. */
  readonly remotePort: number | undefined;
  webRoot: string | undefined;
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  const { promise, resolve: resolveListen, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolveListen();
  });
  return promise;
}

/** Where the built renderer lives: explicit option, Electron's env var, then the workspace path. */
function resolveWebRoot(explicit: string | undefined): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const fromEnv = process.env['TUFFCODE_WEB_ROOT'];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  const candidate = resolve(process.cwd(), 'apps', 'web', 'dist');
  return existsSync(candidate) ? candidate : undefined;
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
 * Binds 127.0.0.1 on an OS-assigned port unless remote access is enabled.
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
  const storedRemote = repos.settings.get().remote ?? DEFAULT_REMOTE_SETTINGS;
  // Overrides are a test and packaged-app seam for the boot value. A settings save
  // replaces them, which is what lets a test disable remote access at runtime.
  let remote: RemoteSettings = { ...storedRemote, ...options.remoteOverrides };
  const getRemote = (): RemoteSettings => remote;
  const getSettings = (): Settings => repos.settings.get();
  const webRoot = resolveWebRoot(options.webRoot);
  // The fingerprint of the file token decides whether paired devices survive a boot.
  repos.remoteSessions.syncTokenFingerprint(hashSecret(token), new Date().toISOString());
  const pairing = createPairingStore();
  const sessions = createSessionAuth(repos.remoteSessions);

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

  const sockets = createRemoteSockets();
  const httpServer = createHttpSurface({
    version,
    startedAt,
    webRoot,
    getRemote,
    sessions: repos.remoteSessions,
    pairing,
    verifyToken,
    verifySession: sessions.verify,
    sockets,
    allowSessionAuth: false,
  });
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
  const ws: AttachedWebSocket = attachWebSocket(httpServer, {
    handlers,
    bus,
    verifyToken,
    verifySession: sessions.verify,
    getRemote,
    getSettings,
    sockets,
    allowSessionAuth: false,
  });

  // The desktop listener stays on loopback at a stable OS assigned port. Remote access
  // is a second listener, so switching it off closes that socket instead of leaving the
  // LAN reachable until the app restarts.
  let remoteServer: Server | undefined;
  let remoteWs: AttachedWebSocket | undefined;
  let remotePort: number | undefined;

  const openRemoteListener = async (): Promise<void> => {
    if (!remote.enabled || remoteServer !== undefined) return;
    const server = createHttpSurface({
      version,
      startedAt,
      webRoot,
      getRemote,
      sessions: repos.remoteSessions,
      pairing,
      verifyToken,
      verifySession: sessions.verify,
      sockets,
      allowSessionAuth: true,
    });
    const attached = attachWebSocket(server, {
      handlers,
      bus,
      verifyToken,
      verifySession: sessions.verify,
      getRemote,
      getSettings,
      sockets,
      allowSessionAuth: true,
    });
    try {
      await listen(server, remote.bindHost, remote.port);
    } catch (error) {
      await attached.close();
      server.closeAllConnections();
      const reason = error instanceof Error ? error.message : String(error);
      bus.emit({
        kind: 'event',
        type: 'server.warning',
        payload: {
          message: `Remote access could not listen on ${remote.bindHost}:${remote.port} (${reason}). The desktop stays on loopback.`,
          code: 'remote-bind-failed',
        },
      });
      return;
    }
    const address = server.address();
    remoteServer = server;
    remoteWs = attached;
    remotePort = address !== null && typeof address !== 'string' ? address.port : undefined;
  };

  const closeRemoteListener = async (): Promise<void> => {
    const server = remoteServer;
    const attached = remoteWs;
    remoteServer = undefined;
    remoteWs = undefined;
    remotePort = undefined;
    sockets.disconnectAllRemote();
    if (attached !== undefined) await attached.close();
    if (server !== undefined) {
      server.closeIdleConnections();
      server.closeAllConnections();
      await closeHttp(server);
    }
  };

  const reconfigureRemote = async (next: RemoteSettings): Promise<void> => {
    const previous = remote;
    remote = next;
    const listenerChanged =
      previous.enabled !== next.enabled ||
      previous.bindHost !== next.bindHost ||
      previous.port !== next.port;
    if (!listenerChanged) return;
    await closeRemoteListener();
    await openRemoteListener();
  };

  bus.subscribe((event) => {
    if (event.type !== 'settings.updated') return;
    const next = event.payload.remote;
    if (JSON.stringify(next) === JSON.stringify(remote)) return;
    void reconfigureRemote(next).catch((error: unknown) => {
      bus.emit({
        kind: 'event',
        type: 'server.warning',
        payload: {
          message: `Remote access could not be reconfigured: ${error instanceof Error ? error.message : String(error)}`,
          code: 'remote-reconfigure-failed',
        },
      });
    });
  });

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
    await closeRemoteListener();
    await ws.close();
    httpServer.closeIdleConnections();
    httpServer.closeAllConnections();
    await closeHttp(httpServer);
    closeDb(db);
    await adapterLogger.close().catch(() => undefined);
    if (options.logger === undefined) await logger.close().catch(() => undefined);
  };

  const host = '127.0.0.1';
  try {
    await listen(httpServer, host, options.port ?? 0);
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
  await openRemoteListener();

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
    host,
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
    get remote() {
      return remote;
    },
    get remotePort() {
      return remotePort;
    },
    webRoot,
    close,
  };
}

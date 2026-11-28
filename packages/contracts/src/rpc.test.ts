import { describe, expect, it } from 'vitest';
import {
  AdapterEventSchema,
  BrainEntrySchema,
  BrainRelationSchema,
  ClientRequestSchema,
  CommandSchema,
  DEFAULT_SETTINGS,
  DiffFileSchema,
  McpServerSchema,
  MessageSchema,
  ModelCapabilitiesSchema,
  ModelSchema,
  PROTOCOL_VERSION,
  ProjectSchema,
  ProviderViewSchema,
  RPC_METHODS,
  ReasoningEffortSchema,
  ReviewCommentSchema,
  RpcErrorCodeSchema,
  ServerEventFrameSchema,
  ServerEventSchema,
  ServerResponseSchema,
  SettingsPatchSchema,
  SettingsSchema,
  SubagentViewSchema,
  ThreadSchema,
  methods,
  type AdapterEvent,
  type Approval,
  type BrainEntry,
  type Checkpoint,
  type Command,
  type DiffFile,
  type Goal,
  type McpServer,
  type McpTool,
  type Message,
  type Model,
  type Project,
  type ProviderView,
  type Review,
  type ReviewComment,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type Skill,
  type SubagentView,
  type Task,
  type Thread,
  type ThreadEventRow,
} from './index.js';

const at = '2026-11-24T10:00:00.000Z';

const project: Project = {
  id: 'p1',
  name: 'tuffcode',
  path: 'C:/work/tuffcode',
  defaultBranch: 'main',
  createdAt: at,
  lastOpenedAt: null,
};

const thread: Thread = {
  id: 't1',
  projectId: 'p1',
  parentThreadId: null,
  title: 'Contracts',
  providerId: 'prov-claude',
  modelId: 'claude-opus-4-5',
  executionMode: 'work',
  permissionMode: 'ask',
  status: 'idle',
  worktreePath: 'C:/work/tuffcode-wt/contracts',
  branch: 'feat/contracts',
  baseBranch: 'main',
  prUrl: null,
  reasoningEffort: null,
  lastSeq: 12,
  createdAt: at,
  updatedAt: at,
};

const checkpoint: Checkpoint = {
  id: 'c1',
  threadId: 't1',
  ref: 'refs/tuffcode/checkpoints/c1',
  label: 'before review fixes',
  commitSha: 'abc123',
  createdAt: at,
};

const diffFile: DiffFile = {
  path: 'packages/contracts/src/rpc.ts',
  oldPath: null,
  status: 'modified',
  binary: false,
  additions: 10,
  deletions: 2,
  patch: '@@ -1,3 +1,4 @@',
};

const provider: ProviderView = {
  id: 'prov-claude',
  kind: 'claude',
  label: 'Claude subscription',
  config: { family: 'anthropic' },
  enabled: true,
  hasSecret: false,
  createdAt: at,
  updatedAt: at,
};

const model: Model = {
  providerId: 'prov-claude',
  modelId: 'claude-opus-4-5',
  label: 'Opus 4.5',
  contextWindow: 200000,
  maxOutputTokens: 8192,
  capabilities: {
    tools: true,
    vision: true,
    reasoning: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  reasoningEffort: 'high',
  isDefault: true,
};

const mcpServer: McpServer = {
  id: 'mcp-1',
  label: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work'],
  env: { DEBUG: '1' },
  cwd: null,
  url: null,
  authMode: 'none',
  authHeader: 'Authorization',
  hasSecret: false,
  pluginId: null,
  enabled: true,
  createdAt: at,
  updatedAt: at,
};

const mcpTool: McpTool = {
  name: 'read_file',
  description: 'Read one file from the allowed roots',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

const subagentView: SubagentView = {
  childId: 'child-1',
  threadId: 't1',
  childThreadId: 't2',
  type: 'explorer',
  model: 'claude-opus-4-5',
  providerId: 'prov-claude',
  status: 'running',
  task: 'Map the contracts package',
  summary: 'Found the RPC registry',
  createdAt: at,
  updatedAt: at,
};

const brainEntry: BrainEntry = {
  id: 'b1',
  kind: 'rule',
  scope: 'global',
  projectId: null,
  text: 'Never use emdash characters',
  tags: 'style',
  appliesTo: 'all',
  importance: 0.9,
  useCount: 3,
  active: true,
  sourceQuote: 'never use emdash',
  createdAt: at,
  updatedAt: at,
  lastUsedAt: null,
};

const goal: Goal = {
  id: 'g1',
  threadId: 't1',
  text: 'Ship the contracts package',
  autonomy: 'auto',
  state: 'running',
  createdAt: at,
  reportedAt: null,
};

const task: Task = {
  id: 'k1',
  goalId: 'g1',
  threadId: 't1',
  title: 'Write entities',
  brief: 'TASK: write entities',
  dependsOn: [],
  state: 'running',
  authorProvider: 'claude',
  authorModel: 'claude-opus-4-5',
  reviewerProvider: 'codex',
  reviewerModel: 'gpt-5',
  critical: true,
  round: 1,
  error: null,
  createdAt: at,
  updatedAt: at,
};

const review: Review = {
  id: 'r1',
  taskId: 'k1',
  providerId: 'prov-codex',
  modelId: 'gpt-5',
  verdict: 'pass',
  body: 'Looks correct',
  createdAt: at,
};

const reviewComment: ReviewComment = {
  id: 'rc1',
  threadId: 't1',
  filePath: 'packages/contracts/src/rpc.ts',
  line: 12,
  side: 'new',
  body: 'This branch needs a test.',
  resolved: false,
  deliveredAt: null,
  createdAt: at,
};

const command: Command = {
  name: 'review',
  description: 'Review the current diff',
  body: 'Review the diff and report findings',
  path: null,
  argumentHint: '[path]',
};

const skill: Skill = {
  name: 'deploy',
  description: 'Deploy the app',
  body: 'Run the deploy script',
  path: 'C:/work/tuffcode/.claude/skills/deploy/SKILL.md',
  source: 'claude-project',
  pluginId: null,
};

const marketplace = {
  id: 'official',
  label: 'Anthropic official',
  url: 'anthropics/claude-plugins-official',
  verified: true,
  builtIn: true,
  fetchedAt: at,
  error: null,
  skipped: 0,
};

const components = {
  skills: ['deploy'],
  commands: ['ship'],
  mcpServers: ['github'],
  agents: [],
  hooks: false,
};

const catalogEntry = {
  id: 'official/github',
  marketplaceId: 'official',
  name: 'github',
  displayName: 'GitHub',
  description: 'Work with issues and pull requests',
  category: 'development',
  author: 'GitHub',
  homepage: 'https://github.com',
  repo: 'github/github-mcp-server',
  kind: 'connector' as const,
  verified: true,
  components: { mcpServers: ['github'] },
  installed: false,
};

const installedPlugin = {
  id: 'plg-1',
  marketplaceId: 'official',
  name: 'github',
  displayName: 'GitHub',
  description: 'Work with issues and pull requests',
  version: '1.0.0',
  kind: 'plugin' as const,
  enabled: true,
  installPath: 'C:/Users/Hp/.tuffcode/plugins/official/github',
  components,
  source: 'marketplace' as const,
  installedAt: at,
};

const connectorEntry = {
  name: 'io.github.example/weather',
  title: 'Weather',
  description: 'Forecasts',
  version: '1.0.0',
  remoteUrl: 'https://mcp.example.com/mcp',
  npmPackage: null,
  requiredEnv: [],
  repository: null,
};

const approval: Approval = {
  id: 'ap1',
  threadId: 't1',
  toolCallId: 'call-1',
  toolName: 'bash',
  input: { command: 'rm -rf build' },
  decision: 'pending',
  createdAt: at,
  resolvedAt: null,
};

const threadEventRow: ThreadEventRow = {
  id: 1,
  threadId: 't1',
  seq: 1,
  type: 'text.delta',
  payload: { type: 'text.delta', turnId: 'turn-1', text: 'hello' },
  createdAt: at,
};

const message: Message = {
  id: 'm1',
  threadId: 't1',
  role: 'user',
  content: 'hello',
  createdAt: at,
};

const adapterEvents: AdapterEvent[] = [
  {
    type: 'session.started',
    sessionId: 'session-1',
    model: 'claude-opus-4-5',
    capabilities: { tools: true, approvals: true, resume: true },
  },
  { type: 'turn.started', turnId: 'turn-1' },
  { type: 'text.delta', turnId: 'turn-1', text: 'hello' },
  { type: 'reasoning.delta', turnId: 'turn-1', text: 'thinking' },
  {
    type: 'tool.started',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    name: 'bash',
    input: { command: 'pnpm test' },
  },
  { type: 'tool.delta', turnId: 'turn-1', toolCallId: 'call-1', text: 'stdout' },
  {
    type: 'tool.finished',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    output: 'ok',
    isError: false,
  },
  {
    type: 'approval.requested',
    turnId: 'turn-1',
    approvalId: 'ap1',
    toolCallId: 'call-1',
    name: 'write',
    input: { path: 'a.txt' },
  },
  { type: 'usage', turnId: 'turn-1', inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
  { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' },
  { type: 'error', message: 'rate limited', retryable: true },
  { type: 'session.ended', reason: 'disposed' },
];

type MethodFixture = {
  params: unknown;
  result: unknown;
};

const fixtures: Record<RpcMethod, MethodFixture> = {
  'app.health': {
    params: {},
    result: {
      version: '0.0.0',
      pid: 4321,
      uptimeMs: 1200,
      dbPath: 'C:/Users/Hp/AppData/Roaming/Tuffcode/tuffcode.db',
    },
  },
  'projects.list': { params: {}, result: [project] },
  'projects.add': { params: { path: 'C:/work/tuffcode' }, result: project },
  'projects.remove': { params: { id: 'p1', deleteWorktrees: true }, result: {} },
  'projects.refresh': { params: { id: 'p1' }, result: project },
  'threads.list': { params: { projectId: 'p1' }, result: [thread] },
  'threads.create': {
    params: {
      projectId: 'p1',
      title: 'Contracts',
      providerId: 'prov-claude',
      modelId: 'claude-opus-4-5',
      executionMode: 'work',
      permissionMode: 'ask',
      baseBranch: 'main',
    },
    result: thread,
  },
  'threads.get': { params: { id: 't1' }, result: thread },
  'threads.dashboard': {
    params: {},
    result: {
      threads: [
        {
          threadId: 't1',
          projectId: 'p1',
          projectName: 'tuffcode',
          title: 'Contracts',
          status: 'needs-approval',
          updatedAt: at,
          lastEventAt: at,
          stalled: false,
          pendingApprovals: [
            { approvalId: 'ap1', toolName: 'write', inputSummary: 'write: a.txt' },
          ],
        },
      ],
    },
  },
  'threads.update': {
    params: { id: 't1', title: 'Renamed', permissionMode: 'accept-edits' },
    result: thread,
  },
  'threads.delete': { params: { id: 't1', removeWorktree: true }, result: {} },
  'threads.search': {
    params: { query: 'login', limit: 10 },
    result: [
      { threadId: 't1', projectId: 'p1', title: 'Contracts', snippet: 'fix login', matchedIn: 'message' },
    ],
  },
  'todos.get': {
    params: { threadId: 't1' },
    result: {
      threadId: 't1',
      phases: [{ name: 'Tasks', tasks: [{ content: 'write tests', status: 'in_progress' }] }],
      updatedAt: at,
    },
  },
  'files.tree': { params: { threadId: 't1' }, result: { paths: ['src/a.ts'], truncated: false } },
  'files.read': {
    params: { threadId: 't1', path: 'src/a.ts' },
    result: { text: 'export {}', truncated: false, binary: false },
  },
  'threads.send': {
    params: {
      id: 't1',
      text: 'hello',
      attachments: [{ name: 'a.txt', path: 'C:/work/a.txt' }],
    },
    result: { turnId: 'turn-1' },
  },
  'threads.interrupt': { params: { id: 't1' }, result: {} },
  'threads.approve': {
    params: { threadId: 't1', approvalId: 'ap1', decision: 'allow-thread' },
    result: {},
  },
  'threads.events': {
    params: { id: 't1', sinceSeq: 0, limit: 100 },
    result: { events: [threadEventRow], hasMore: false },
  },
  'threads.context': {
    params: { threadId: 't1' },
    result: {
      usedTokens: 42000,
      maxTokens: 200000,
      percent: 0.21,
      limitSource: 'model',
      compactedAt: at,
      segments: [
        { name: 'system', tokens: 640 },
        { name: 'messages', tokens: 41360 },
      ],
    },
  },
  'messages.list': { params: { threadId: 't1' }, result: [message] },
  'checkpoints.create': {
    params: { threadId: 't1', label: 'before review fixes' },
    result: checkpoint,
  },
  'checkpoints.list': { params: { threadId: 't1' }, result: [checkpoint] },
  'checkpoints.revert': {
    params: { threadId: 't1', checkpointId: 'c1', confirm: true },
    result: {},
  },
  'diff.get': { params: { threadId: 't1', checkpointId: 'c1' }, result: { files: [diffFile] } },
  'comments.list': { params: { threadId: 't1' }, result: [reviewComment] },
  'comments.add': {
    params: {
      threadId: 't1',
      filePath: 'packages/contracts/src/rpc.ts',
      line: 12,
      side: 'new',
      body: 'This branch needs a test.',
    },
    result: reviewComment,
  },
  'comments.resolve': { params: { id: 'rc1', resolved: true }, result: reviewComment },
  'git.commit': {
    params: { threadId: 't1', message: 'feat: contracts' },
    result: { sha: 'abc123' },
  },
  'git.push': {
    params: { threadId: 't1' },
    result: { branch: 'feat/contracts', remote: 'origin' },
  },
  'git.pr': {
    params: { threadId: 't1', title: 'Contracts', body: 'Adds contracts', draft: true },
    result: { url: 'https://github.com/tuffcode-net/tuffcode/pull/1', number: 1 },
  },
  'terminal.open': {
    params: { threadId: 't1', cols: 120, rows: 30 },
    result: { terminalId: 'term1' },
  },
  'terminal.input': { params: { terminalId: 'term1', data: 'ls\r' }, result: {} },
  'terminal.resize': { params: { terminalId: 'term1', cols: 100, rows: 40 }, result: {} },
  'terminal.close': { params: { terminalId: 'term1' }, result: {} },
  'providers.list': { params: {}, result: [provider] },
  'providers.upsert': {
    params: {
      kind: 'openai-compatible',
      label: 'Local model',
      config: { baseUrl: 'http://127.0.0.1:1234/v1', family: 'openai' },
      secret: 'sk-local',
    },
    result: provider,
  },
  'providers.remove': { params: { id: 'prov-claude' }, result: {} },
  'providers.test': {
    params: { id: 'prov-claude' },
    result: {
      ok: true,
      detail: 'signed in as user@example.com',
      signedIn: true,
      cliPath: 'C:/Users/Hp/AppData/Roaming/npm/claude.cmd',
      models: ['claude-opus-4-5', 'claude-sonnet-4-5'],
    },
  },
  'providers.login': {
    params: { id: 'prov-claude' },
    result: { loginId: 'login-1' },
  },
  'providers.loginCancel': {
    params: { loginId: 'login-1' },
    result: {},
  },
  'models.list': { params: { providerId: 'prov-claude' }, result: [model] },
  'mcp.list': { params: {}, result: [mcpServer] },
  'mcp.upsert': {
    params: {
      label: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work'],
      env: { DEBUG: '1' },
      cwd: null,
      enabled: true,
    },
    result: mcpServer,
  },
  'mcp.remove': { params: { id: 'mcp-1' }, result: {} },
  'mcp.test': {
    params: { id: 'mcp-1' },
    result: { ok: true, detail: 'listed 1 tool', tools: [mcpTool] },
  },
  'mcp.oauth.start': {
    params: { id: 'mcp-1' },
    result: {
      flowId: 'flow-1',
      authorizeUrl: 'https://auth.example.com/authorize?response_type=code',
    },
  },
  'mcp.oauth.status': {
    params: { id: 'mcp-1' },
    result: {
      connected: true,
      needsAuth: false,
      expiresAt: at,
      authorizationServer: 'https://auth.example.com',
    },
  },
  'mcp.oauth.disconnect': { params: { id: 'mcp-1' }, result: {} },
  'providers.models': {
    params: { providerId: 'prov-claude', refresh: true },
    result: { models: [model], source: 'sdk' },
  },
  'settings.get': { params: {}, result: DEFAULT_SETTINGS },
  'settings.set': {
    params: { patch: { theme: 'light', brainEnabled: false } },
    result: DEFAULT_SETTINGS,
  },
  'prompt.preview': {
    params: { threadId: 't1', message: 'how do I run tests' },
    result: {
      sections: [
        { name: 'base', text: 'You are Tuffcode.', tokens: 640 },
        { name: 'custom', text: 'Prefer pnpm.', tokens: 12 },
        { name: 'user', text: 'how do I run tests', tokens: 8 },
      ],
      total: 660,
      injectedIds: ['b1'],
      injectionReasons: { b1: 'standing rule for every turn' },
    },
  },
  'brain.list': {
    params: { kind: 'rule', projectId: 'p1', query: 'emdash', limit: 8, includeInactive: true },
    result: [brainEntry],
  },
  'brain.upsert': {
    params: {
      kind: 'preference',
      scope: 'global',
      projectId: 'p1',
      text: 'Prefer pnpm',
      tags: 'tooling',
      appliesTo: 'all',
      importance: 0.8,
      active: false,
    },
    result: brainEntry,
  },
  'brain.delete': { params: { id: 'b1' }, result: {} },
  'brain.reset': { params: { projectId: 'p1' }, result: { removed: 3 } },
  'brain.preview': {
    params: { projectId: 'p1', threadId: 't1', message: 'how do I run tests' },
    result: { always: [brainEntry], retrieved: [brainEntry], tokens: 120 },
  },
  'brain.graph': {
    params: { projectId: 'p1', limit: 300 },
    result: {
      nodes: [
        { id: 'b1', kind: 'rule', label: 'Never use emdash', importance: 0.9, degree: 2 },
        { id: 'b2', kind: 'preference', label: 'Prefer pnpm', importance: 0.8, degree: 1 },
      ],
      edges: [{ from: 'b1', to: 'b2', relation: 'about' }],
    },
  },
  'brain.link': {
    params: { fromId: 'b1', toId: 'b2', relation: 'about' },
    result: {},
  },
  'memory.search': {
    params: { projectId: 'p1', query: 'emdash', limit: 8 },
    result: {
      entries: [
        {
          id: 'b1',
          kind: 'rule',
          text: 'Never use emdash characters',
          score: 0.87,
          reason: 'keyword match on "emdash"',
        },
      ],
    },
  },
  'council.start': {
    params: { threadId: 't1', goal: 'Ship the contracts package', autonomy: 'auto' },
    result: { goalId: 'g1' },
  },
  'council.cancel': { params: { goalId: 'g1' }, result: {} },
  'council.status': {
    params: { goalId: 'g1' },
    result: { goal, tasks: [task], reviews: [review], escalations: [], plan: [] },
  },
  'council.latest': {
    params: { threadId: 't1' },
    result: { goal, tasks: [task], reviews: [review], escalations: [], plan: [] },
  },
  'council.approvePlan': { params: { goalId: 'g1' }, result: {} },
  'council.revisePlan': { params: { goalId: 'g1', feedback: 'Split the parser task' }, result: {} },
  'council.answerEscalation': {
    params: { taskId: 'tsk1', decision: 'revise', feedback: 'Cover the null case' },
    result: {},
  },
  'subagents.spawn': {
    params: {
      threadId: 't1',
      spec: {
        type: 'worker',
        task: 'Implement the subagent RPC',
        model: 'claude-opus-4-5',
        providerId: 'prov-claude',
        worktree: true,
        budgetTokens: 20000,
      },
    },
    result: { childId: 'child-1' },
  },
  'subagents.cancel': { params: { childId: 'child-1' }, result: {} },
  'subagents.list': { params: { threadId: 't1' }, result: [subagentView] },
  'subagents.get': {
    params: { childId: 'sub-1' },
    result: { ...subagentView, toolCount: 3, inputTokens: 120, outputTokens: 40, unread: 1 },
  },
  'subagents.message': {
    params: { childId: 'sub-1', text: 'also check the tests' },
    result: { delivered: 'queued' },
  },
  'subagents.messages': {
    params: { childId: 'sub-1' },
    result: [
      {
        id: 'sm-1',
        childId: 'sub-1',
        direction: 'to-parent',
        kind: 'message',
        text: 'done',
        createdAt: at,
      },
    ],
  },
  'subagents.answer': {
    params: { threadId: 't1', questionId: 'sq-1', text: 'src/a.ts' },
    result: {},
  },
  'subagents.close': {
    params: { childId: 'sub-1' },
    result: { ...subagentView, status: 'done', closedAt: at },
  },
  'subagents.questions': {
    params: { threadId: 't1' },
    result: [
      {
        questionId: 'sq-1',
        childId: 'sub-1',
        threadId: 't1',
        text: 'Which file should I change?',
        createdAt: at,
      },
    ],
  },
  'subagents.listAll': { params: {}, result: [subagentView] },
  'commands.list': { params: { projectId: 'p1' }, result: [command] },
  'commands.run': {
    params: { threadId: 't1', input: '/context' },
    result: {
      kind: 'ui',
      action: {
        type: 'show-context',
        preview: {
          sections: [{ name: 'base', text: 'You are Tuffcode.', tokens: 6 }],
          total: 6,
        },
      },
    },
  },
  'skills.list': { params: { projectId: 'p1' }, result: [skill] },
  'skills.read': { params: { projectId: 'p1', name: 'deploy' }, result: skill },
  'plugins.marketplaces': { params: {}, result: [marketplace] },
  'plugins.addMarketplace': { params: { url: 'acme/plugins' }, result: marketplace },
  'plugins.removeMarketplace': { params: { id: 'official' }, result: {} },
  'plugins.catalog': {
    params: { marketplaceId: 'official', refresh: true },
    result: { entries: [catalogEntry], marketplaces: [marketplace] },
  },
  'plugins.installed': { params: {}, result: [installedPlugin] },
  'plugins.install': { params: { entryId: 'official/github' }, result: installedPlugin },
  'plugins.upload': { params: { path: 'C:/Downloads/deploy.skill' }, result: installedPlugin },
  'plugins.setEnabled': { params: { id: 'plg-1', enabled: false }, result: installedPlugin },
  'plugins.remove': { params: { id: 'plg-1' }, result: {} },
  'connectors.search': { params: { query: 'weather' }, result: { entries: [connectorEntry], error: null } },
  'connectors.install': {
    params: { entry: connectorEntry },
    result: { ...mcpServer, transport: 'http', command: '', url: 'https://mcp.example.com/mcp' },
  },
  'diagnostics.export': {
    params: {},
    result: { path: 'C:/Users/Hp/AppData/Local/Tuffcode/logs/diagnostics.zip' },
  },
};

const expectedMethods: RpcMethod[] = [
  'app.health',
  'brain.delete',
  'brain.graph',
  'brain.link',
  'brain.list',
  'brain.preview',
  'brain.reset',
  'brain.upsert',
  'checkpoints.create',
  'checkpoints.list',
  'checkpoints.revert',
  'commands.list',
  'commands.run',
  'comments.add',
  'comments.list',
  'comments.resolve',
  'connectors.install',
  'connectors.search',
  'council.answerEscalation',
  'council.approvePlan',
  'council.cancel',
  'council.latest',
  'council.revisePlan',
  'council.start',
  'council.status',
  'diagnostics.export',
  'diff.get',
  'files.read',
  'files.tree',
  'git.commit',
  'git.pr',
  'git.push',
  'mcp.list',
  'mcp.oauth.disconnect',
  'mcp.oauth.start',
  'mcp.oauth.status',
  'mcp.remove',
  'mcp.test',
  'mcp.upsert',
  'memory.search',
  'messages.list',
  'models.list',
  'plugins.addMarketplace',
  'plugins.catalog',
  'plugins.install',
  'plugins.installed',
  'plugins.marketplaces',
  'plugins.remove',
  'plugins.removeMarketplace',
  'plugins.setEnabled',
  'plugins.upload',
  'projects.add',
  'projects.list',
  'projects.refresh',
  'projects.remove',
  'prompt.preview',
  'providers.list',
  'providers.login',
  'providers.loginCancel',
  'providers.models',
  'providers.remove',
  'providers.test',
  'providers.upsert',
  'settings.get',
  'settings.set',
  'skills.list',
  'skills.read',
  'subagents.answer',
  'subagents.cancel',
  'subagents.close',
  'subagents.get',
  'subagents.list',
  'subagents.listAll',
  'subagents.message',
  'subagents.messages',
  'subagents.questions',
  'subagents.spawn',
  'terminal.close',
  'terminal.input',
  'terminal.open',
  'terminal.resize',
  'threads.approve',
  'threads.context',
  'threads.create',
  'threads.dashboard',
  'threads.delete',
  'threads.events',
  'threads.get',
  'threads.interrupt',
  'threads.list',
  'threads.search',
  'threads.send',
  'threads.update',
  'todos.get',
];

describe('protocol envelope', () => {
  it('pins protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('round-trips a client request', () => {
    const request = { id: 'req-1', method: 'app.health', params: {} };
    expect(ClientRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects malformed client requests', () => {
    expect(
      ClientRequestSchema.safeParse({ id: '', method: 'app.health', params: {} }).success,
    ).toBe(false);
    expect(ClientRequestSchema.safeParse({ method: 'app.health', params: {} }).success).toBe(false);
    expect(ClientRequestSchema.safeParse({ id: 'req-1', method: '', params: {} }).success).toBe(
      false,
    );
  });

  it('round-trips an ok response and narrows on ok', () => {
    const response = { id: 'req-1', ok: true, result: { version: '0.0.0' } };
    const parsed = ServerResponseSchema.parse(response);
    expect(parsed).toEqual(response);
    if (parsed.ok) {
      expect(parsed.result).toEqual({ version: '0.0.0' });
    } else {
      throw new Error('expected ok response');
    }
  });

  it('round-trips an error response with details', () => {
    const response = {
      id: 'req-2',
      ok: false,
      error: { code: 'conflict', message: 'thread is running', details: { retryAfterMs: 500 } },
    };
    const parsed = ServerResponseSchema.parse(response);
    expect(parsed).toEqual(response);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('conflict');
    }
  });

  it('rejects invalid responses', () => {
    expect(ServerResponseSchema.safeParse({ id: 'req-1', ok: true }).success).toBe(false);
    expect(
      ServerResponseSchema.safeParse({
        id: 'req-1',
        ok: false,
        error: { code: 'teapot', message: 'nope' },
      }).success,
    ).toBe(false);
    expect(ServerResponseSchema.safeParse({ id: 'req-1', ok: 'yes', result: {} }).success).toBe(
      false,
    );
  });

  it('exposes exactly the seven error codes', () => {
    expect(RpcErrorCodeSchema.options).toEqual([
      'unauthorized',
      'bad-request',
      'not-found',
      'conflict',
      'provider-unavailable',
      'permission-denied',
      'internal',
    ]);
  });
});

function parseCommandRunResult(result: unknown) {
  return methods['commands.run'].result.safeParse(result);
}

describe('rpc methods', () => {
  it('exposes exactly 94 methods with the documented names', () => {
    expect(RPC_METHODS).toHaveLength(94);
    expect(RPC_METHODS.toSorted()).toEqual(expectedMethods);
    expect(Object.keys(fixtures).toSorted()).toEqual(expectedMethods);
    expect(Object.keys(methods).toSorted()).toEqual(expectedMethods);
  });

  it('parses valid params and results for every method', () => {
    for (const [method, fixture] of Object.entries(fixtures) as Array<[RpcMethod, MethodFixture]>) {
      expect(methods[method].params.parse(fixture.params), `${method} params`).toEqual(
        fixture.params,
      );
      expect(methods[method].result.parse(fixture.result), `${method} result`).toEqual(
        fixture.result,
      );
    }
  });

  it('accepts the round 2 methods with optional fields omitted', () => {
    expect(
      methods['providers.models'].params.safeParse({ providerId: 'prov-claude' }).success,
    ).toBe(true);
    expect(
      methods['providers.models'].result.safeParse({ models: [], source: 'manual' }).success,
    ).toBe(true);
    expect(
      methods['providers.models'].result.safeParse({
        models: [],
        source: 'cache',
        error: 'claude CLI not found',
      }).success,
    ).toBe(true);
    expect(methods['prompt.preview'].result.safeParse({ sections: [], total: 0 }).success).toBe(
      true,
    );
    expect(
      methods['prompt.preview'].result.safeParse({
        sections: [],
        total: 0,
        injectedIds: ['b1', 'b2'],
        injectionReasons: { b1: 'standing rule for every turn' },
      }).success,
    ).toBe(true);
    expect(
      methods['subagents.spawn'].params.safeParse({
        threadId: 't1',
        spec: { type: 'notetaker', task: 'Distill the thread' },
      }).success,
    ).toBe(true);
    expect(methods['subagents.list'].result.safeParse([]).success).toBe(true);
    expect(
      methods['subagents.list'].result.safeParse([{ ...subagentView, summary: undefined }]).success,
    ).toBe(true);
    expect(methods['brain.graph'].params.safeParse({}).success).toBe(true);
    expect(methods['brain.graph'].result.safeParse({ nodes: [], edges: [] }).success).toBe(true);
    expect(methods['memory.search'].params.safeParse({ query: 'emdash' }).success).toBe(true);
    expect(methods['memory.search'].result.safeParse({ entries: [] }).success).toBe(true);
    expect(
      methods['threads.context'].result.safeParse({
        usedTokens: 0,
        maxTokens: 200000,
        percent: 0,
        limitSource: 'default',
        segments: [],
      }).success,
    ).toBe(true);
    expect(
      methods['providers.models'].result.safeParse({
        models: [{ providerId: 'prov-claude', modelId: 'm', label: 'M', isDefault: false }],
        source: 'manual',
      }).success,
    ).toBe(true);
    expect(
      methods['providers.upsert'].params.safeParse({
        kind: 'openai-compatible',
        label: 'Local',
        config: { contextWindow: 200000, maxOutputTokens: 8192, baseUrl: 'http://127.0.0.1:1/v1' },
      }).success,
    ).toBe(true);
  });

  it('accepts the round 3 methods with optional fields omitted', () => {
    expect(methods['mcp.list'].params.safeParse({}).success).toBe(true);
    expect(methods['mcp.list'].result.safeParse([]).success).toBe(true);
    expect(methods['mcp.upsert'].params.safeParse({ label: 'fs', command: 'npx' }).success).toBe(
      true,
    );
    expect(
      methods['mcp.upsert'].params.safeParse({ id: 'mcp-1', label: 'fs', command: 'npx' }).success,
    ).toBe(true);
    expect(
      methods['mcp.test'].result.safeParse({ ok: false, detail: 'spawn failed', tools: [] }).success,
    ).toBe(true);
    expect(methods['subagents.listAll'].result.safeParse([]).success).toBe(true);
    expect(
      methods['brain.link'].params.safeParse({ fromId: 'b1', toId: 'b2', relation: 'caused' })
        .success,
    ).toBe(true);
    expect(
      methods['providers.upsert'].params.safeParse({
        kind: 'openai-compatible',
        label: 'Local',
        config: {
          contextWindow: 200000,
          capabilities: {
            tools: true,
            vision: false,
            reasoning: true,
            reasoningEfforts: ['low', 'high'],
          },
          reasoningEffort: 'medium',
        },
      }).success,
    ).toBe(true);
  });

  it('parses every commands.run result kind', () => {
    expect(parseCommandRunResult({ kind: 'text', text: '/model opens the picker.' }).success).toBe(
      true,
    );
    expect(parseCommandRunResult({ kind: 'turn', text: '/review src/app.ts' }).success).toBe(true);
    expect(parseCommandRunResult({ kind: 'error', message: 'Unknown subagent type' }).success).toBe(
      true,
    );
    expect(
      parseCommandRunResult({ kind: 'ui', action: { type: 'open-model-picker' } }).success,
    ).toBe(true);
    expect(
      parseCommandRunResult({ kind: 'ui', action: { type: 'switch-mode', mode: 'council' } })
        .success,
    ).toBe(true);
    expect(
      parseCommandRunResult({
        kind: 'ui',
        action: { type: 'open-settings', section: 'instructions' },
      }).success,
    ).toBe(true);
    expect(
      parseCommandRunResult({
        kind: 'ui',
        action: { type: 'reload-transcript', text: 'Cleared 3 messages.' },
      }).success,
    ).toBe(true);
    expect(
      parseCommandRunResult({ kind: 'ui', action: { type: 'switch-mode', mode: 'turbo' } }).success,
    ).toBe(false);
    expect(
      parseCommandRunResult({ kind: 'ui', action: { type: 'open-settings', section: 'billing' } })
        .success,
    ).toBe(false);
    expect(parseCommandRunResult({ kind: 'ui', action: { type: 'show-context' } }).success).toBe(
      false,
    );
    expect(parseCommandRunResult({ kind: 'text' }).success).toBe(false);
  });

  it('rejects null params and results for every method', () => {
    for (const method of RPC_METHODS) {
      expect(methods[method].params.safeParse(null).success, `${method} params`).toBe(false);
      // council.latest answers null when the thread never ran a goal.
      if (method === 'council.latest') continue;
      expect(methods[method].result.safeParse(null).success, `${method} result`).toBe(false);
    }
  });

  it('accepts a null result for council.latest', () => {
    expect(methods['council.latest'].result.safeParse(null).success).toBe(true);
    expect(methods['council.latest'].params.safeParse({ threadId: 't1' }).success).toBe(true);
    expect(methods['council.latest'].params.safeParse({}).success).toBe(false);
  });

  it('rejects wrong field values', () => {
    const cases: Array<[RpcMethod, 'params' | 'result', unknown]> = [
      [
        'threads.create',
        'params',
        { ...(fixtures['threads.create'].params as object), executionMode: 'yolo' },
      ],
      [
        'threads.create',
        'params',
        { projectId: 'p1', modelId: 'm', executionMode: 'work', permissionMode: 'ask' },
      ],
      ['threads.approve', 'params', { threadId: 't1', approvalId: 'ap1', decision: 'pending' }],
      ['threads.events', 'params', { id: 't1', sinceSeq: -1 }],
      ['terminal.open', 'params', { threadId: 't1', cols: 0, rows: 30 }],
      ['providers.upsert', 'params', { kind: 'gemini', label: 'x', config: {} }],
      [
        'brain.upsert',
        'params',
        { kind: 'preference', scope: 'global', text: 'x', importance: 1.5 },
      ],
      ['brain.upsert', 'params', { kind: 'preference', scope: 'global', text: 'x', active: 'yes' }],
      ['brain.upsert', 'params', { kind: 'preference', scope: 'global', text: 'x', projectId: 7 }],
      ['brain.list', 'params', { includeInactive: 1 }],
      ['settings.set', 'params', { patch: { theme: 'blue' } }],
      ['projects.add', 'params', { path: '' }],
      ['git.pr', 'result', { url: 'https://example.test/pr/1', number: 0 }],
      ['app.health', 'result', { version: '1', pid: 1, uptimeMs: 1 }],
      ['council.status', 'result', { goal, tasks: 'none', reviews: [] }],
      ['council.latest', 'result', { goal, tasks: [], reviews: 'none' }],
      ['providers.test', 'result', { ok: true }],
      ['brain.list', 'result', [brainEntry, { ...brainEntry, importance: 2 }]],
      [
        'comments.add',
        'params',
        { threadId: 't1', filePath: 'a.ts', line: 1, side: 'both', body: 'x' },
      ],
      [
        'comments.add',
        'params',
        { threadId: 't1', filePath: 'a.ts', line: 0, side: 'new', body: 'x' },
      ],
      ['comments.resolve', 'params', { id: 'rc1' }],
      ['checkpoints.revert', 'params', { threadId: 't1', checkpointId: 'c1' }],
      [
        'checkpoints.revert',
        'params',
        { threadId: 't1', checkpointId: 'c1', confirm: false },
      ],
      ['comments.list', 'result', [{ ...reviewComment, line: -1 }]],
      ['providers.test', 'result', { ok: true, detail: 'x', signedIn: 'yes' }],
      ['providers.test', 'result', { ok: true, detail: 'x', models: 'claude-opus-4-5' }],
      ['providers.login', 'params', { id: '' }],
      ['providers.loginCancel', 'params', { loginId: '' }],
      ['messages.list', 'params', { threadId: '' }],
      ['messages.list', 'result', [{ ...message, role: 'bot' }]],
      ['providers.models', 'params', { providerId: '' }],
      ['providers.models', 'result', { models: [], source: 'guess' }],
      ['providers.models', 'result', { models: [{ ...model, contextWindow: 0 }], source: 'cache' }],
      [
        'providers.models',
        'result',
        { models: [{ ...model, maxOutputTokens: 0 }], source: 'cache' },
      ],
      [
        'providers.models',
        'result',
        { models: [{ ...model, maxOutputTokens: 1.5 }], source: 'cache' },
      ],
      ['threads.context', 'params', { threadId: '' }],
      [
        'threads.context',
        'result',
        { usedTokens: -1, maxTokens: 200000, percent: 0, segments: [] },
      ],
      ['threads.context', 'result', { usedTokens: 1, maxTokens: 0, percent: 0, segments: [] }],
      [
        'threads.context',
        'result',
        { usedTokens: 1, maxTokens: 200000, percent: 1.5, segments: [] },
      ],
      [
        'threads.context',
        'result',
        { usedTokens: 1, maxTokens: 200000, percent: 0.5, segments: [{ name: 'x', tokens: -1 }] },
      ],
      ['threads.context', 'result', { usedTokens: 1, maxTokens: 200000, percent: 0.5 }],
      [
        'threads.context',
        'result',
        {
          usedTokens: 1,
          maxTokens: 200000,
          percent: 0.5,
          compactedAt: 'yesterday',
          segments: [],
        },
      ],
      [
        'providers.upsert',
        'params',
        { kind: 'openai-compatible', label: 'x', config: { contextWindow: 0 } },
      ],
      [
        'providers.upsert',
        'params',
        { kind: 'openai-compatible', label: 'x', config: { maxOutputTokens: -1 } },
      ],
      ['prompt.preview', 'params', { threadId: 't1' }],
      [
        'prompt.preview',
        'result',
        { sections: [{ name: 'base', text: 'x', tokens: -1 }], total: 0 },
      ],
      ['prompt.preview', 'result', { sections: [], total: 1.5 }],
      ['prompt.preview', 'result', { sections: [], total: 0, injectedIds: [''] }],
      [
        'prompt.preview',
        'result',
        { sections: [], total: 0, injectionReasons: { b1: 2 } },
      ],
      ['subagents.spawn', 'params', { threadId: 't1', spec: { type: 'janitor', task: 'x' } }],
      ['subagents.spawn', 'params', { threadId: 't1', spec: { type: 'worker', task: '' } }],
      [
        'subagents.spawn',
        'params',
        { threadId: 't1', spec: { type: 'worker', task: 'x', budgetTokens: 0 } },
      ],
      ['subagents.spawn', 'result', { childId: '' }],
      ['subagents.cancel', 'params', { childId: '' }],
      ['subagents.list', 'params', { threadId: '' }],
      ['subagents.list', 'result', [{ ...subagentView, status: 'paused' }]],
      ['brain.graph', 'params', { limit: 0 }],
      [
        'brain.graph',
        'result',
        {
          nodes: [{ id: 'b1', kind: 'rule', label: 'x', importance: 2, degree: 0 }],
          edges: [],
        },
      ],
      ['brain.graph', 'result', { nodes: [], edges: [{ from: 'b1', to: 'b2', relation: '' }] }],
      ['commands.run', 'params', { threadId: 't1', input: '' }],
      ['commands.run', 'params', { threadId: '', input: '/help' }],
      ['commands.run', 'result', { kind: 'turn' }],
      ['commands.run', 'result', { kind: 'ui', action: { type: 'open-settings' } }],
      ['commands.run', 'result', { kind: 'nope', text: 'x' }],
      ['memory.search', 'params', { query: '' }],
      ['memory.search', 'params', { projectId: 'p1', query: 'emdash', limit: -1 }],
      [
        'memory.search',
        'result',
        { entries: [{ id: 'b1', kind: 'rule', text: 'x', score: -1, reason: 'r' }] },
      ],
      [
        'memory.search',
        'result',
        { entries: [{ id: 'b1', kind: 'idea', text: 'x', score: 1, reason: 'r' }] },
      ],
      ['mcp.upsert', 'params', { label: '', command: 'npx' }],
      ['mcp.upsert', 'params', { label: 'fs', command: '' }],
      ['mcp.upsert', 'params', { label: 'fs', command: 'npx', env: { TOKEN: 7 } }],
      ['mcp.upsert', 'params', { label: 'fs', command: 'npx', args: 'C:/work' }],
      ['mcp.test', 'result', { ok: true, detail: 'x', tools: [{ name: '', inputSchema: {} }] }],
      ['brain.link', 'params', { fromId: 'b1', toId: 'b2', relation: 'related-to' }],
      ['brain.link', 'params', { fromId: '', toId: 'b2', relation: 'about' }],
      [
        'threads.context',
        'result',
        { usedTokens: 1, maxTokens: 200000, percent: 0.5, limitSource: 'guess', segments: [] },
      ],
    ];

    for (const [method, side, value] of cases) {
      expect(methods[method][side].safeParse(value).success, `${method} ${side}`).toBe(false);
    }
  });

  it('keeps params and results typed for callers', () => {
    const sendParams: RpcParams<'threads.send'> = { id: 't1', text: 'hello' };
    const health: RpcResult<'app.health'> = {
      version: '0.0.0',
      pid: 1,
      uptimeMs: 0,
      dbPath: 'db.sqlite',
    };
    const method: RpcMethod = 'app.health';
    expect(sendParams.text).toBe('hello');
    expect(health.pid).toBe(1);
    expect(method).toBe('app.health');

    const invalidApproval: RpcParams<'threads.approve'> = {
      threadId: 't1',
      approvalId: 'ap1',
      // @ts-expect-error pending is a stored approval state, not a resolvable decision
      decision: 'pending',
    };
    expect(invalidApproval.decision).toBe('pending');

    // @ts-expect-error thread results require every thread field
    const invalidThread: RpcResult<'threads.get'> = { id: 't1' };
    expect(invalidThread.id).toBe('t1');
  });
});

describe('adapter events', () => {
  it('parses every adapter event variant', () => {
    for (const event of adapterEvents) {
      const parsed = AdapterEventSchema.parse(event);
      expect(parsed.type).toBe(event.type);
    }
  });

  it('rejects unknown event types and invalid variants', () => {
    expect(AdapterEventSchema.safeParse({ type: 'thread.removed' }).success).toBe(false);
    expect(
      AdapterEventSchema.safeParse({ type: 'turn.finished', turnId: 'turn-1', reason: 'done' })
        .success,
    ).toBe(false);
    expect(
      AdapterEventSchema.safeParse({ type: 'usage', turnId: 'turn-1', inputTokens: -1 }).success,
    ).toBe(false);
    expect(AdapterEventSchema.safeParse({ type: 'text.delta', turnId: 'turn-1' }).success).toBe(
      false,
    );
  });

  it('carries adapter events in replay rows', () => {
    expect(threadEventRow.payload.type).toBe('text.delta');
    expect(
      methods['threads.events'].result.safeParse({ events: [threadEventRow], hasMore: false })
        .success,
    ).toBe(true);
    expect(
      methods['threads.events'].result.safeParse({
        events: [{ ...threadEventRow, payload: { type: 'nope' } }],
        hasMore: false,
      }).success,
    ).toBe(false);
  });
});

describe('server events', () => {
  it('discriminates thread.event and keeps the adapter payload typed', () => {
    const frame = {
      kind: 'event',
      type: 'thread.event',
      threadId: 't1',
      seq: 7,
      createdAt: '2026-01-01T00:00:00.000Z',
      payload: { type: 'text.delta', turnId: 'turn-1', text: 'hello' },
    };
    const parsed = ServerEventSchema.parse(frame);
    expect(parsed.type).toBe('thread.event');
    if (parsed.type === 'thread.event') {
      expect(parsed.seq).toBe(7);
      if (parsed.payload.type === 'text.delta') {
        expect(parsed.payload.text).toBe('hello');
      }
    }
    expect(ServerEventFrameSchema.parse(frame)).toEqual(frame);
  });

  it('parses every server event variant', () => {
    const frames = [
      { kind: 'event', type: 'thread.updated', payload: thread },
      {
        kind: 'event',
        type: 'thread.event',
        threadId: 't1',
        seq: 8,
        createdAt: '2026-01-01T00:00:00.000Z',
        payload: { type: 'turn.started', turnId: 'turn-2' },
      },
      { kind: 'event', type: 'approval.requested', payload: approval },
      { kind: 'event', type: 'terminal.data', payload: { terminalId: 'term1', data: 'ok' } },
      {
        kind: 'event',
        type: 'council.updated',
        payload: { goalId: 'g1', state: 'reviewing', taskId: 'tsk1', taskState: 'reviewing' },
      },
      {
        kind: 'event',
        type: 'subagent.started',
        payload: {
          childId: 'child-1',
          threadId: 't1',
          type: 'explorer',
          model: 'claude-opus-4-5',
        },
      },
      {
        kind: 'event',
        type: 'subagent.event',
        payload: {
          childId: 'child-1',
          threadId: 't1',
          event: { type: 'text.delta', turnId: 'turn-1', text: 'mapping files' },
        },
      },
      {
        kind: 'event',
        type: 'subagent.finished',
        payload: {
          childId: 'child-1',
          threadId: 't1',
          status: 'done',
          summary: 'Mapped 5 files',
        },
      },
      { kind: 'event', type: 'providers.updated', payload: [provider] },
      {
        kind: 'event',
        type: 'provider.login.output',
        payload: { loginId: 'login-1', providerId: 'prov-claude', chunk: 'Visit the URL' },
      },
      {
        kind: 'event',
        type: 'provider.login.done',
        payload: { loginId: 'login-1', providerId: 'prov-claude', ok: true, detail: 'signed in' },
      },
      { kind: 'event', type: 'settings.updated', payload: DEFAULT_SETTINGS },
      { kind: 'event', type: 'commands.updated', payload: {} },
      { kind: 'event', type: 'skills.updated', payload: {} },
      {
        kind: 'event',
        type: 'context.updated',
        payload: {
          threadId: 't1',
          usedTokens: 42000,
          maxTokens: 200000,
          percent: 0.21,
          limitSource: 'default',
          compacted: false,
        },
      },
      { kind: 'event', type: 'server.warning', payload: { message: 'disk low', code: 'disk' } },
    ];

    expect(frames).toHaveLength(16);
    for (const frame of frames) {
      expect(ServerEventSchema.safeParse(frame).success, frame.type).toBe(true);
    }
  });

  it('reads a context.updated frame without a limit source as the model window', () => {
    const parsed = ServerEventSchema.parse({
      kind: 'event',
      type: 'context.updated',
      payload: {
        threadId: 't1',
        usedTokens: 42000,
        maxTokens: 200000,
        percent: 0.21,
        compacted: false,
      },
    });
    expect(parsed.type).toBe('context.updated');
    if (parsed.type !== 'context.updated') return;
    expect(parsed.payload.limitSource).toBe('model');
  });

  it('rejects a context.updated frame with an unknown limit source', () => {
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'context.updated',
        payload: {
          threadId: 't1',
          usedTokens: 42000,
          maxTokens: 200000,
          percent: 0.21,
          limitSource: 'guess',
          compacted: false,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown event types and missing thread context', () => {
    expect(
      ServerEventSchema.safeParse({ kind: 'event', type: 'thread.removed', payload: {} }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'thread.event',
        threadId: 't1',
        payload: { type: 'text.delta', turnId: 'turn-1', text: 'x' },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({ kind: 'response', type: 'thread.updated', payload: thread })
        .success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'provider.login.output',
        payload: { loginId: 'login-1', providerId: 'prov-claude' },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'provider.login.done',
        payload: { loginId: 'login-1', providerId: 'prov-claude', ok: 'yes', detail: 'signed in' },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'subagent.started',
        payload: { childId: 'child-1', threadId: 't1', type: 'janitor', model: 'm' },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'subagent.started',
        payload: { childId: 'child-1', threadId: 't1', type: 'explorer' },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'subagent.event',
        payload: { childId: 'child-1', threadId: 't1', event: { type: 'nope' } },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'subagent.finished',
        payload: { childId: 'child-1', threadId: 't1', status: 'paused' },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'subagent.finished',
        payload: { childId: 'child-1', status: 'done' },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'context.updated',
        payload: {
          threadId: 't1',
          usedTokens: 42000,
          maxTokens: 200000,
          percent: 1.2,
          compacted: false,
        },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'context.updated',
        payload: { usedTokens: 42000, maxTokens: 200000, percent: 0.2, compacted: false },
      }).success,
    ).toBe(false);
    expect(
      ServerEventSchema.safeParse({
        kind: 'event',
        type: 'context.updated',
        payload: {
          threadId: 't1',
          usedTokens: 42000,
          maxTokens: 200000,
          percent: 0.2,
          compacted: 'yes',
        },
      }).success,
    ).toBe(false);
  });
});

describe('settings', () => {
  it('exposes the documented defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'dark',
      shell: null,
      defaultPermissionMode: 'ask',
      defaultProviderId: null,
      defaultModelId: null,
      worktreeRoot: null,
      logLevel: 'info',
      brainEnabled: true,
      updateChannel: 'stable',
      keybindings: {},
      interfaceSize: 'default',
      fontSize: 14,
      sidebarWidth: 256,
      panelAnimation: false,
      enabledTools: ['bash', 'read', 'edit', 'write', 'glob', 'grep'],
      terminalScrollback: 5000,
      terminalFontSize: 13,
      cursorStyle: 'bar',
      checkUpdatesOnStart: true,
      customInstructions: '',
      subagentModels: {
        explorer: {},
        reviewer: {},
        notetaker: {},
        worker: {},
        planner: {},
      },
      subagentConcurrency: 4,
      contextWarningThreshold: 0.8,
      autoCompact: true,
      maxOutputTokens: 8192,
      showContextMeter: true,
      profile: { name: '', role: '', about: '' },
      responseStyle: 'default',
      brainCapture: true,
      capabilities: {
        skills: true,
        connectors: true,
        subagents: true,
        todo: true,
        worktrees: true,
        webFetch: true,
        browser: true,
      },
      notifications: {
        turnFinished: true,
        approvalNeeded: true,
        subagentFinished: true,
        councilEscalation: true,
        sound: true,
        onlyWhenUnfocused: true,
      },
      keepAwake: false,
      remote: {
        enabled: false,
        bindHost: '127.0.0.1',
        port: 4310,
        publicUrl: '',
        allowedOrigins: [],
        allowInsecureLan: false,
      },
    });
    expect(SettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS);
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(SettingsSchema.parse({}).keybindings).not.toBe(DEFAULT_SETTINGS.keybindings);
    expect(SettingsSchema.parse({}).enabledTools).not.toBe(DEFAULT_SETTINGS.enabledTools);
    expect(SettingsSchema.parse({}).subagentModels).not.toBe(DEFAULT_SETTINGS.subagentModels);
    expect(SettingsSchema.parse({})).not.toHaveProperty('paneLayout');
  });

  it('parses partial patches without filling defaults', () => {
    expect(SettingsPatchSchema.parse({})).toEqual({});
    expect(SettingsPatchSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
    expect(SettingsPatchSchema.parse({ theme: 'nord' })).toEqual({ theme: 'nord' });
    expect(SettingsPatchSchema.parse({ fontSize: 16, cursorStyle: 'block' })).toEqual({
      fontSize: 16,
      cursorStyle: 'block',
    });
    expect(SettingsPatchSchema.parse({ enabledTools: ['read', 'grep'] })).toEqual({
      enabledTools: ['read', 'grep'],
    });
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: 'blue' }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, logLevel: 'verbose' }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontSize: 30 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontSize: 13.5 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, sidebarWidth: 400 }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, terminalFontSize: 10 }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, interfaceSize: 'huge' }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, cursorStyle: 'beam' }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, enabledTools: 'bash' }).success).toBe(
      false,
    );
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, contextWarningThreshold: 0.4 }).success,
    ).toBe(false);
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, contextWarningThreshold: 0.96 }).success,
    ).toBe(false);
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, autoCompact: 'yes' }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxOutputTokens: 255 }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxOutputTokens: 65537 }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxOutputTokens: 8192.5 }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, showContextMeter: 1 }).success).toBe(
      false,
    );
  });

  it('ignores the legacy maxToolIterations key in a stored settings row', () => {
    const stored = { ...DEFAULT_SETTINGS, maxToolIterations: 40 };
    const parsed = SettingsSchema.parse(stored);
    expect(parsed).not.toHaveProperty('maxToolIterations');
    expect(parsed).toEqual(DEFAULT_SETTINGS);
  });

  it('parses context limit settings and patches', () => {
    const parsed = SettingsSchema.parse({
      contextWarningThreshold: 0.95,
      autoCompact: false,
      maxOutputTokens: 256,
      showContextMeter: false,
    });
    expect(parsed.contextWarningThreshold).toBe(0.95);
    expect(parsed.autoCompact).toBe(false);
    expect(parsed.maxOutputTokens).toBe(256);
    expect(parsed.showContextMeter).toBe(false);

    expect(SettingsSchema.parse({ contextWarningThreshold: 0.5 }).contextWarningThreshold).toBe(
      0.5,
    );
    expect(SettingsSchema.parse({ maxOutputTokens: 65536 }).maxOutputTokens).toBe(65536);
    expect(SettingsPatchSchema.parse({ autoCompact: false })).toEqual({ autoCompact: false });
    expect(SettingsPatchSchema.safeParse({ contextWarningThreshold: 0.99 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ maxOutputTokens: 100 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ showContextMeter: 'on' }).success).toBe(false);
  });

  it('parses custom instructions, subagent models and concurrency', () => {
    const parsed = SettingsSchema.parse({
      customInstructions: 'Prefer pnpm and never use emdash.',
      subagentModels: { worker: { model: 'claude-opus-4-5', fallbackModel: 'gpt-5' } },
      subagentConcurrency: 6,
    });
    expect(parsed.customInstructions).toBe('Prefer pnpm and never use emdash.');
    expect(parsed.subagentModels).toEqual({
      explorer: {},
      reviewer: {},
      notetaker: {},
      worker: { model: 'claude-opus-4-5', fallbackModel: 'gpt-5' },
      planner: {},
    });
    expect(parsed.subagentConcurrency).toBe(6);

    expect(
      SettingsSchema.parse({ customInstructions: 'x'.repeat(16000) }).customInstructions,
    ).toHaveLength(16000);
    expect(SettingsSchema.parse({ subagentConcurrency: 1 }).subagentConcurrency).toBe(1);
    expect(SettingsSchema.parse({ subagentConcurrency: 8 }).subagentConcurrency).toBe(8);
    expect(SettingsSchema.safeParse({ customInstructions: 'x'.repeat(16001) }).success).toBe(
      false,
    );
    expect(SettingsSchema.safeParse({ customInstructions: 12 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ subagentConcurrency: 0 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ subagentConcurrency: 9 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ subagentConcurrency: 4.5 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ subagentModels: { explorer: { model: 7 } } }).success).toBe(
      false,
    );
    expect(
      SettingsSchema.safeParse({ subagentModels: { explorer: { providerId: 'p1' } } }).success,
    ).toBe(true);
    expect(SettingsPatchSchema.parse({ customInstructions: 'be brief' })).toEqual({
      customInstructions: 'be brief',
    });
    expect(SettingsPatchSchema.safeParse({ subagentConcurrency: 9 }).success).toBe(false);
  });

  it('keeps paneLayout optional and opaque', () => {
    const layout = { panes: [{ id: 'pane-1', kind: 'thread', threadId: 't1', width: 0.5 }] };
    expect(SettingsSchema.parse({ paneLayout: layout }).paneLayout).toEqual(layout);
    expect(SettingsPatchSchema.parse({ paneLayout: layout })).toEqual({ paneLayout: layout });
  });
});

describe('entity schemas', () => {
  it('round-trips every entity fixture', () => {
    expect(ProjectSchema.parse(project)).toEqual(project);
    expect(ThreadSchema.parse(thread)).toEqual(thread);
    expect(MessageSchema.parse(message)).toEqual(message);
    expect(ProviderViewSchema.parse(provider)).toEqual(provider);
    expect(ModelSchema.parse(model)).toEqual(model);
    expect(SubagentViewSchema.parse(subagentView)).toEqual(subagentView);
    expect(BrainEntrySchema.parse(brainEntry)).toEqual(brainEntry);
    expect(DiffFileSchema.parse(diffFile)).toEqual(diffFile);
    expect(ReviewCommentSchema.parse(reviewComment)).toEqual(reviewComment);
    expect(CommandSchema.parse(command)).toEqual(command);
  });

  it('keeps model token limits optional and positive', () => {
    const withoutLimits = {
      providerId: 'prov-claude',
      modelId: 'claude-opus-4-5',
      label: 'Opus 4.5',
      isDefault: false,
    };
    expect(ModelSchema.parse(withoutLimits)).toEqual(withoutLimits);
    expect(ModelSchema.parse({ ...model, contextWindow: null })).toEqual({
      ...model,
      contextWindow: null,
    });
    expect(ModelSchema.parse({ ...model, maxOutputTokens: null })).toEqual({
      ...model,
      maxOutputTokens: null,
    });
    expect(ModelSchema.safeParse({ ...model, contextWindow: 0 }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...model, contextWindow: -1 }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...model, contextWindow: 1.5 }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...model, maxOutputTokens: 0 }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...model, maxOutputTokens: 255.5 }).success).toBe(false);
  });

  it('carries model capabilities and a reasoning effort when the row knows them', () => {
    expect(ModelSchema.parse({ ...model, capabilities: null })).toEqual({
      ...model,
      capabilities: null,
    });
    expect(ModelSchema.parse({ ...model, reasoningEffort: null })).toEqual({
      ...model,
      reasoningEffort: null,
    });
    expect(
      ModelCapabilitiesSchema.parse({
        tools: true,
        vision: false,
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
      }),
    ).toEqual({ tools: true, vision: false, reasoning: true, reasoningEfforts: ['low', 'high'] });
    expect(ReasoningEffortSchema.options).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(ModelSchema.safeParse({ ...model, reasoningEffort: 'turbo' }).success).toBe(false);
    expect(
      ModelSchema.safeParse({
        ...model,
        capabilities: { tools: true, vision: false, reasoning: true },
      }).success,
    ).toBe(false);
    expect(
      ModelSchema.safeParse({
        ...model,
        capabilities: { tools: true, vision: false, reasoning: true, reasoningEfforts: [1] },
      }).success,
    ).toBe(false);
  });

  it('round-trips an MCP server and rejects empty labels or commands', () => {
    expect(McpServerSchema.parse(mcpServer)).toEqual(mcpServer);
    expect(McpServerSchema.parse({ ...mcpServer, cwd: 'C:/work', enabled: false })).toEqual({
      ...mcpServer,
      cwd: 'C:/work',
      enabled: false,
    });
    expect(McpServerSchema.safeParse({ ...mcpServer, label: '' }).success).toBe(false);
    expect(McpServerSchema.safeParse({ ...mcpServer, command: '' }).success).toBe(false);
    expect(McpServerSchema.safeParse({ ...mcpServer, args: 'C:/work' }).success).toBe(false);
    expect(McpServerSchema.safeParse({ ...mcpServer, env: { TOKEN: 7 } }).success).toBe(false);
    expect(McpServerSchema.safeParse({ ...mcpServer, updatedAt: 'yesterday' }).success).toBe(false);
  });

  it('accepts an http MCP server only with a url', () => {
    const http = { ...mcpServer, transport: 'http', command: '', url: 'https://mcp.example.com/mcp' };
    expect(McpServerSchema.parse(http)).toEqual(http);
    expect(McpServerSchema.safeParse({ ...http, url: null }).success).toBe(false);
    expect(McpServerSchema.safeParse({ ...http, transport: 'ws' }).success).toBe(false);
    expect(
      methods['mcp.upsert'].params.safeParse({ label: 'remote', transport: 'http', url: '' })
        .success,
    ).toBe(false);
    expect(
      methods['mcp.upsert'].params.safeParse({
        label: 'remote',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        secret: 'kept out of logs',
      }).success,
    ).toBe(true);
  });

  it('round-trips a todo list and rejects unknown statuses', () => {
    const list = methods['todos.get'].result.parse({
      threadId: 't1',
      phases: [
        {
          name: 'Build',
          tasks: [
            { content: 'write schema', status: 'completed' },
            { content: 'wire tool', status: 'in_progress' },
            { content: 'skip docs', status: 'abandoned' },
          ],
        },
      ],
      updatedAt: null,
    });
    expect(list.phases[0]?.tasks).toHaveLength(3);
    expect(
      methods['todos.get'].result.safeParse({
        threadId: 't1',
        phases: [{ name: 'Build', tasks: [{ content: 'x', status: 'blocked' }] }],
        updatedAt: null,
      }).success,
    ).toBe(false);
    expect(
      methods['todos.get'].result.safeParse({
        threadId: 't1',
        phases: [{ name: 'Build', tasks: [{ content: '', status: 'pending' }] }],
        updatedAt: null,
      }).success,
    ).toBe(false);
  });

  it('carries subagent telemetry and keeps it optional for old rows', () => {
    const view = methods['subagents.get'].result.parse({
      ...subagentView,
      toolCount: 7,
      inputTokens: 1200,
      outputTokens: 300,
      activity: 'bash: pnpm test',
      startedAt: at,
      finishedAt: null,
      unread: 2,
    });
    expect(view.toolCount).toBe(7);
    expect(methods['subagents.get'].result.parse(subagentView).toolCount).toBeUndefined();
    expect(
      methods['subagents.get'].result.safeParse({ ...subagentView, toolCount: -1 }).success,
    ).toBe(false);
  });

  it('lets threads.update move providers and set a reasoning level', () => {
    const params = methods['threads.update'].params;
    expect(
      params.safeParse({ id: 't1', providerId: 'prov-openai', modelId: 'gpt-5' }).success,
    ).toBe(true);
    expect(params.safeParse({ id: 't1', reasoningEffort: 'xhigh' }).success).toBe(true);
    expect(params.safeParse({ id: 't1', reasoningEffort: null }).success).toBe(true);
    expect(params.safeParse({ id: 't1', reasoningEffort: 'Extra High' }).success).toBe(false);
    expect(ThreadSchema.parse({ ...thread, reasoningEffort: undefined }).reasoningEffort).toBe(
      null,
    );
  });

  it('accepts only the four brain relations', () => {
    expect(BrainRelationSchema.options).toEqual(['about', 'part-of', 'supersedes', 'caused']);
    for (const relation of ['about', 'part-of', 'supersedes', 'caused']) {
      expect(BrainRelationSchema.safeParse(relation).success, relation).toBe(true);
    }
    expect(BrainRelationSchema.safeParse('related-to').success).toBe(false);
  });

  it('rejects entities with invalid enum values', () => {
    expect(ThreadSchema.safeParse({ ...thread, status: 'paused' }).success).toBe(false);
    expect(ThreadSchema.safeParse({ ...thread, executionMode: 'chat' }).success).toBe(false);
    expect(ThreadSchema.safeParse({ ...thread, permissionMode: 'yolo' }).success).toBe(false);
    expect(ProviderViewSchema.safeParse({ ...provider, kind: 'gemini' }).success).toBe(false);
    expect(BrainEntrySchema.safeParse({ ...brainEntry, kind: 'idea' }).success).toBe(false);
    expect(DiffFileSchema.safeParse({ ...diffFile, status: 'unknown' }).success).toBe(false);
    expect(ReviewCommentSchema.safeParse({ ...reviewComment, side: 'both' }).success).toBe(false);
    expect(MessageSchema.safeParse({ ...message, role: 'bot' }).success).toBe(false);
  });

  it('accepts every provider kind including anthropic', () => {
    const kinds = ['claude', 'codex', 'acp', 'opencode', 'openai-compatible', 'anthropic'];
    for (const kind of kinds) {
      expect(ProviderViewSchema.safeParse({ ...provider, kind }).success, kind).toBe(true);
    }
  });
});

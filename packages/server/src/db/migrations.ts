/**
 * Embedded migrations. The schema lives in TypeScript strings so the bundled server
 * never reads `.sql` files at runtime (D5). Versions are append-only and applied in
 * ascending order inside a transaction by `migrate`.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INIT_SQL = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('plan','work','council')),
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('read-only','ask','accept-edits','full-auto')),
  status TEXT NOT NULL CHECK (status IN ('idle','running','needs-approval','ready-to-review','failed','merged','closed')),
  worktree_path TEXT,
  branch TEXT,
  base_branch TEXT,
  pr_url TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_threads_project ON threads(project_id, updated_at DESC);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE INDEX idx_events_thread ON events(thread_id, seq);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  label TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','allow','allow-thread','deny')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claude','codex','acp','opencode','openai-compatible')),
  label TEXT NOT NULL,
  config TEXT NOT NULL,
  secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_models (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  context_window INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('old','new')),
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  autonomy TEXT NOT NULL CHECK (autonomy IN ('manual','auto')),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reported_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  state TEXT NOT NULL,
  author_provider TEXT NOT NULL,
  author_model TEXT NOT NULL,
  reviewer_provider TEXT,
  reviewer_model TEXT,
  critical INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','changes-requested','escalate')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE escalations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE brain_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('identity','preference','rule','project','memory','working-note')),
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  applies_to TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  use_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  source_quote TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_brain_scope ON brain_entries(scope, kind, active);
CREATE VIRTUAL TABLE brain_fts USING fts5(text, tags, content='brain_entries', content_rowid='rowid');

CREATE TRIGGER brain_entries_ai AFTER INSERT ON brain_entries BEGIN
  INSERT INTO brain_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
CREATE TRIGGER brain_entries_ad AFTER DELETE ON brain_entries BEGIN
  INSERT INTO brain_fts(brain_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
END;
CREATE TRIGGER brain_entries_au AFTER UPDATE ON brain_entries BEGIN
  INSERT INTO brain_fts(brain_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO brain_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  shell TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const TURNS_SQL = `
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','needs-approval','complete','interrupted','failed')),
  injected_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_turns_thread ON turns(thread_id, created_at);
CREATE INDEX idx_turns_status ON turns(status);
`;

/**
 * Typed relations between brain entries. The graph RPC reads this table; entries
 * remain the only node source, so an edge whose endpoint is deleted cascades away.
 */
const BRAIN_EDGES_SQL = `
CREATE TABLE brain_edges (
  from_id TEXT NOT NULL REFERENCES brain_entries(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES brain_entries(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (length(trim(relation)) > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX idx_brain_edges_to ON brain_edges(to_id);
`;

/**
 * `anthropic` is an API-key provider kind, but the original providers CHECK constraint
 * only listed the CLI kinds. SQLite cannot alter a CHECK, so both tables are rebuilt:
 * the copy keeps every row, and renaming `providers_new` rewrites the model FK back to
 * `providers` so the cascade still holds.
 */
const ANTHROPIC_KIND_SQL = `
CREATE TABLE providers_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claude','codex','acp','opencode','openai-compatible','anthropic')),
  label TEXT NOT NULL,
  config TEXT NOT NULL,
  secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO providers_new (id, kind, label, config, secret_ref, enabled, created_at, updated_at)
  SELECT id, kind, label, config, secret_ref, enabled, created_at, updated_at FROM providers;
CREATE TABLE provider_models_new (
  provider_id TEXT NOT NULL REFERENCES providers_new(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  context_window INTEGER,
  is_default INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, model_id)
);
INSERT INTO provider_models_new (provider_id, model_id, label, context_window, is_default)
  SELECT provider_id, model_id, label, context_window, is_default FROM provider_models;
DROP TABLE provider_models;
DROP TABLE providers;
ALTER TABLE providers_new RENAME TO providers;
ALTER TABLE provider_models_new RENAME TO provider_models;
`;

const SUBAGENTS_SQL = `
CREATE TABLE subagents (
  child_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  child_thread_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('explorer','reviewer','notetaker','worker','planner')),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  task TEXT NOT NULL,
  summary TEXT,
  budget_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_subagents_thread ON subagents(thread_id, created_at);
CREATE INDEX idx_subagents_status ON subagents(status);
`;

/**
 * Discovery results are cached per provider, so every model row carries the moment the
 * set was refreshed. Rows seeded from provider config keep `NULL`, which reads as stale
 * and lets the first `providers.models` call discover for real.
 */
const MODEL_REFRESH_SQL = `
ALTER TABLE provider_models ADD COLUMN refreshed_at TEXT;
`;

/**
 * The plan's dependency edges, kept as a JSON array of task titles. Existing rows
 * read as no dependencies, which is what they were planned with.
 */
const TASK_DEPENDS_ON_SQL = `
ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
`;

/**
 * Model metadata beyond the token window. `capabilities` holds the JSON object the
 * contracts describe, `reasoning_effort` the selected level, and `source` records which
 * discovery path wrote the row. Every column is nullable, so rows seeded before this
 * migration keep reading as unknown metadata.
 */
const PROVIDER_MODEL_METADATA_SQL = `
ALTER TABLE provider_models ADD COLUMN max_output_tokens INTEGER;
ALTER TABLE provider_models ADD COLUMN capabilities TEXT;
ALTER TABLE provider_models ADD COLUMN reasoning_effort TEXT;
ALTER TABLE provider_models ADD COLUMN source TEXT;
`;

/**
 * MCP servers are machine-wide configuration, not project state: there is no foreign
 * key here, so removing a project or thread never takes a server with it.
 */
const MCP_SERVERS_SQL = `
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  cwd TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Round 4: per-thread reasoning level, the todo list, subagent telemetry and mailbox,
 * http MCP servers owned by plugins, and the plugin tables. Every new column is
 * nullable or defaulted, so rows written before this migration read as unmeasured
 * telemetry, stdio servers and no reasoning override.
 */
const R4_SQL = `
ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;

CREATE TABLE todos (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  phases TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

ALTER TABLE subagents ADD COLUMN tool_count INTEGER;
ALTER TABLE subagents ADD COLUMN input_tokens INTEGER;
ALTER TABLE subagents ADD COLUMN output_tokens INTEGER;
ALTER TABLE subagents ADD COLUMN activity TEXT;
ALTER TABLE subagents ADD COLUMN started_at TEXT;
ALTER TABLE subagents ADD COLUMN finished_at TEXT;

CREATE TABLE subagent_messages (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES subagents(child_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('to-child','to-parent')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX idx_subagent_messages_child ON subagent_messages(child_id, created_at);

ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio';
ALTER TABLE mcp_servers ADD COLUMN url TEXT;
ALTER TABLE mcp_servers ADD COLUMN secret_ref TEXT;
ALTER TABLE mcp_servers ADD COLUMN plugin_id TEXT;

CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  marketplace_id TEXT,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('plugin','skill','connector')),
  enabled INTEGER NOT NULL DEFAULT 1,
  install_path TEXT NOT NULL,
  components TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('marketplace','upload','custom')),
  installed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_plugins_name ON plugins(COALESCE(marketplace_id, ''), name);

CREATE TABLE plugin_marketplaces (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

/**
 * Round 5: connector auth modes. `auth_mode` records how a server authenticates and
 * `auth_header` names the header that carries the credential. Rows that already had a
 * secret read as bearer connectors, which is exactly what they were. Credentials
 * themselves stay in the OS keychain; only the reference and the mode live here.
 */
const MCP_AUTH_SQL = `
ALTER TABLE mcp_servers ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE mcp_servers ADD COLUMN auth_header TEXT;
UPDATE mcp_servers SET auth_mode = 'bearer' WHERE secret_ref IS NOT NULL;
`;

/**
 * Round 5: how thoroughly a child worked. Rows from before the column read as null,
 * which the prompt and the UI treat as the default `normal`.
 */
const SUBAGENT_DEPTH_SQL = `
ALTER TABLE subagents ADD COLUMN depth TEXT;
`;

/**
 * Round 6: two-way control. `kind` marks a mailbox row as a plain message, a child's
 * blocking question or the parent's answer; rows written before this migration read
 * as `message`. `closed_at` marks a child the parent closed: the status keeps one of
 * the five existing values, because widening that CHECK would rebuild the table, and
 * the transcript stays readable after the child is archived.
 */
const SUBAGENT_MAILBOX_SQL = `
ALTER TABLE subagent_messages ADD COLUMN kind TEXT;
ALTER TABLE subagents ADD COLUMN closed_at TEXT;
`;

/**
 * Round 6, PR 7: a child's full final answer lives in its own row, so the bounded
 * `subagents.summary` never becomes the only copy. `footer_status` keeps the status
 * the child declared in its footer (`done`, `partial`, `blocked`), which is narrower
 * than the five-value row status and reads as null for a child that declared none.
 */
const SUBAGENT_REPORTS_SQL = `
CREATE TABLE subagent_reports (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL REFERENCES subagents(child_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_subagent_reports_child ON subagent_reports(child_id, created_at);
ALTER TABLE subagents ADD COLUMN footer_status TEXT;
`;

/**
 * Attachments the user sent with a message, as a JSON array of wire attachments.
 * Inline image bytes are stored under the app data directory and referenced by id, so
 * a transcript row stays small and a reload can still show what was attached.
 */
const MESSAGE_ATTACHMENTS_SQL = `
ALTER TABLE messages ADD COLUMN attachments TEXT;
`;

/**
 * How many reviewer-driven rework rounds a child has taken. The parent can steer a
 * child freely, but findings sent back as rework stop at SUBAGENT_REWORK_LIMIT.
 */
const SUBAGENT_REWORK_SQL = `
ALTER TABLE subagents ADD COLUMN rework_round INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Remote access: a paired device is one row keyed by the SHA-256 of its cookie token,
 * never the token itself. `remote_state` keeps the fingerprint of the current
 * `~/.tuffcode/token` value, so rewriting that file revokes every device.
 */
const REMOTE_ACCESS_SQL = `
CREATE TABLE remote_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_remote_sessions_expiry ON remote_sessions(expires_at);
CREATE TABLE remote_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: INIT_SQL,
  },
  {
    version: 2,
    name: 'turns',
    sql: TURNS_SQL,
  },
  {
    version: 3,
    name: 'provider-anthropic-kind',
    sql: ANTHROPIC_KIND_SQL,
  },
  {
    version: 4,
    name: 'brain-edges',
    sql: BRAIN_EDGES_SQL,
  },
  {
    version: 5,
    name: 'subagents',
    sql: SUBAGENTS_SQL,
  },
  {
    version: 6,
    name: 'provider-model-refresh',
    sql: MODEL_REFRESH_SQL,
  },
  {
    version: 7,
    name: 'task-depends-on',
    sql: TASK_DEPENDS_ON_SQL,
  },
  {
    version: 8,
    name: 'provider-model-metadata',
    sql: PROVIDER_MODEL_METADATA_SQL,
  },
  {
    version: 9,
    name: 'mcp-servers',
    sql: MCP_SERVERS_SQL,
  },
  {
    version: 10,
    name: 'r4-todos-subagent-telemetry-plugins',
    sql: R4_SQL,
  },
  {
    version: 11,
    name: 'mcp-connector-auth',
    sql: MCP_AUTH_SQL,
  },
  {
    version: 12,
    name: 'subagent-depth',
    sql: SUBAGENT_DEPTH_SQL,
  },
  {
    version: 13,
    name: 'subagent-mailbox',
    sql: SUBAGENT_MAILBOX_SQL,
  },
  {
    version: 14,
    name: 'subagent-reports',
    sql: SUBAGENT_REPORTS_SQL,
  },
  {
    version: 15,
    name: 'message-attachments',
    sql: MESSAGE_ATTACHMENTS_SQL,
  },
  {
    version: 16,
    name: 'subagent-rework-round',
    sql: SUBAGENT_REWORK_SQL,
  },
  {
    version: 18,
    name: 'remote-access',
    sql: REMOTE_ACCESS_SQL,
  },
];

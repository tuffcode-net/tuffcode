import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempEnv, type TempEnv } from '../test-support.js';
import { createRepos } from './repos/index.js';
import { MIGRATIONS, migrate, openDb, transaction } from './index.js';

describe('db migrations', () => {
  let env: TempEnv | undefined;

  afterEach(() => {
    env?.dispose();
    env = undefined;
  });

  it('applies the schema once and is idempotent', () => {
    env = createTempEnv();
    const db = openDb(join(env.root, 'tuffcode.db'));
    try {
      const expected = MIGRATIONS.map((entry) => entry.version);
      expect(migrate(db)).toEqual(expected);
      expect(migrate(db)).toEqual([]);

      const versions = db.prepare('SELECT version FROM schema_migrations').all();
      expect(versions).toHaveLength(expected.length);
      expect(versions.map((row) => row['version'])).toEqual(expected);
      expect(expected.at(-1)).toBe(18);

      expect(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
      expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
      expect(db.prepare('PRAGMA busy_timeout').get()?.['timeout']).toBe(5000);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row['name']);
      for (const table of [
        'projects',
        'threads',
        'events',
        'messages',
        'checkpoints',
        'approvals',
        'providers',
        'provider_models',
        'settings',
        'review_comments',
        'goals',
        'tasks',
        'reviews',
        'escalations',
        'brain_entries',
        'brain_edges',
        'brain_fts',
        'terminal_sessions',
        'turns',
        'subagents',
        'subagent_reports',
        'mcp_servers',
      ]) {
        expect(tables).toContain(table);
      }

      const modelColumns = db
        .prepare('PRAGMA table_info(provider_models)')
        .all()
        .map((row) => row['name']);
      for (const column of [
        'context_window',
        'max_output_tokens',
        'capabilities',
        'reasoning_effort',
        'source',
      ]) {
        expect(modelColumns).toContain(column);
      }

      const commentColumns = db
        .prepare('PRAGMA table_info(review_comments)')
        .all()
        .map((row) => row['name']);
      expect(commentColumns).toContain('delivered_at');
    } finally {
      db.close();
    }
  });

  it('accepts the anthropic provider kind and keeps the model cascade', () => {
    env = createTempEnv();
    const db = openDb(join(env.root, 'tuffcode.db'));
    migrate(db);
    try {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO providers (id, kind, label, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('prv_anthropic', 'anthropic', 'Anthropic', '{}', now, now);
      db.prepare('INSERT INTO provider_models (provider_id, model_id, label) VALUES (?, ?, ?)').run(
        'prv_anthropic',
        'claude-opus-4-5',
        'Opus',
      );
      db.prepare('DELETE FROM providers WHERE id = ?').run('prv_anthropic');
      expect(db.prepare('SELECT COUNT(*) AS total FROM provider_models').get()?.['total']).toBe(0);

      expect(() =>
        db
          .prepare(
            'INSERT INTO providers (id, kind, label, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('prv_bad', 'gemini', 'Gemini', '{}', now, now),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('keeps mcp servers independent of projects and threads', () => {
    env = createTempEnv();
    const db = openDb(join(env.root, 'tuffcode.db'));
    migrate(db);
    try {
      const now = new Date().toISOString();
      const insert = db.prepare(
        'INSERT INTO mcp_servers (id, label, command, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('mcp_one', 'filesystem', 'npx', now, now);
      insert.run('mcp_two', 'github', 'npx', now, now);

      expect(db.prepare('PRAGMA foreign_key_list(mcp_servers)').all()).toEqual([]);

      db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        'prj_mcp',
        'MCP',
        join(env.root, 'mcp-project'),
        now,
      );
      db.prepare('DELETE FROM projects WHERE id = ?').run('prj_mcp');

      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run('mcp_one');
      const remaining = db
        .prepare('SELECT id, args, env, enabled FROM mcp_servers ORDER BY id')
        .all();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toEqual({ id: 'mcp_two', args: '[]', env: '{}', enabled: 1 });
    } finally {
      db.close();
    }
  });

  it('upgrades a populated version 11 database without losing a row', () => {
    env = createTempEnv();
    const db = openDb(join(env.root, 'tuffcode.db'));
    const now = new Date().toISOString();
    try {
      // Build the schema the previous release shipped, row by row, the way a user's
      // database looks when the five new migrations arrive.
      const older = MIGRATIONS.filter((migration) => migration.version <= 11);
      expect(older).toHaveLength(11);
      for (const migration of older) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          now,
        );
      }
      const insert = (sql: string, ...values: (string | null)[]) =>
        db.prepare(sql).run(...values);
      insert(
        'INSERT INTO projects (id, name, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
        'prj_old',
        'Old project',
        env.root,
        'main',
        now,
      );
      insert(
        'INSERT INTO threads (id, project_id, parent_thread_id, title, provider_id, model_id, execution_mode, permission_mode, status, worktree_path, branch, base_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'thr_old',
        'prj_old',
        null,
        'Old thread',
        'prv_old',
        'model-old',
        'work',
        'full-auto',
        'ready-to-review',
        env.root,
        'tuffcode/thr_old',
        'main',
        now,
        now,
      );
      insert(
        'INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
        'msg_old',
        'thr_old',
        'user',
        'old prompt',
        now,
      );
      insert(
        'INSERT INTO subagents (child_id, thread_id, child_thread_id, type, provider_id, model, status, task, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'sub_old',
        'thr_old',
        null,
        'explorer',
        'prv_old',
        'model-old',
        'done',
        'explore it',
        'found it',
        now,
        now,
      );
      insert(
        'INSERT INTO subagent_messages (id, child_id, direction, text, created_at) VALUES (?, ?, ?, ?, ?)',
        'smsg_old',
        'sub_old',
        'to-parent',
        'report',
        now,
      );
      insert(
        'INSERT INTO turns (id, thread_id, status, injected_ids, created_at) VALUES (?, ?, ?, ?, ?)',
        'turn_old',
        'thr_old',
        'complete',
        '[]',
        now,
      );
      insert(
        'INSERT INTO terminal_sessions (id, thread_id, cwd, shell, created_at) VALUES (?, ?, ?, ?, ?)',
        'term_old',
        'thr_old',
        env.root,
        'bash',
        now,
      );
      insert(
        'INSERT INTO mcp_servers (id, label, command, args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        'mcp_old',
        'Old server',
        'node',
        '[]',
        now,
        now,
      );
      insert(
        'INSERT INTO brain_entries (id, kind, scope, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        'brain_old',
        'rule',
        'global',
        'always test',
        now,
        now,
      );
      insert(
        'INSERT INTO review_comments (id, thread_id, file_path, line, side, body, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        'rc_old',
        'thr_old',
        'src/a.ts',
        '1',
        'new',
        'old comment',
        now,
      );

      expect(migrate(db)).toEqual([12, 13, 14, 15, 16, 17, 18]);
      // A second start must be a no-op, not a re-run that fails on an existing column.
      expect(migrate(db)).toEqual([]);

      // The old rows survive, and every new column carries its documented default.
      expect(db.prepare('SELECT id, title FROM threads').get()).toEqual({
        id: 'thr_old',
        title: 'Old thread',
      });
      expect(db.prepare('SELECT content, attachments FROM messages').get()).toEqual({
        content: 'old prompt',
        attachments: null,
      });
      expect(db.prepare('SELECT delivered_at FROM review_comments').get()).toEqual({
        delivered_at: null,
      });
      expect(
        db
          .prepare(
            'SELECT child_id, type, status, summary, depth, closed_at, footer_status, rework_round FROM subagents',
          )
          .get(),
      ).toEqual({
        child_id: 'sub_old',
        type: 'explorer',
        status: 'done',
        summary: 'found it',
        depth: null,
        closed_at: null,
        footer_status: null,
        rework_round: 0,
      });
      expect(db.prepare('SELECT text, kind FROM subagent_messages').get()).toEqual({
        text: 'report',
        kind: null,
      });
      expect(db.prepare('SELECT status, finished_at FROM turns').get()).toEqual({
        status: 'complete',
        finished_at: null,
      });
      expect(db.prepare('SELECT COUNT(*) AS total FROM projects').get()?.['total']).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS total FROM terminal_sessions').get()?.['total']).toBe(
        1,
      );
      expect(db.prepare('SELECT COUNT(*) AS total FROM mcp_servers').get()?.['total']).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS total FROM brain_entries').get()?.['total']).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS total FROM subagent_reports').get()?.['total']).toBe(0);
    } finally {
      db.close();
    }
  });

  it('adds the remote session tables to a database that already holds data', () => {
    env = createTempEnv();
    const db = openDb(join(env.root, 'upgrade-remote.db'));
    try {
      const now = new Date().toISOString();
      const remoteMigration = MIGRATIONS.find((entry) => entry.name === 'remote-access');
      if (remoteMigration === undefined) throw new Error('the remote migration is missing');
      for (const migration of MIGRATIONS.filter((entry) => entry.name !== 'remote-access')) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          now,
        );
      }
      db.prepare(
        'INSERT INTO projects (id, name, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('prj_keep', 'Keep me', 'C:/work/keep', 'main', now);
      db.prepare(
        `INSERT INTO threads (id, project_id, title, provider_id, model_id, execution_mode, permission_mode, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('thr_keep', 'prj_keep', 'Existing chat', 'prv_keep', 'model', 'work', 'ask', 'idle', now, now);
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        'theme',
        JSON.stringify('light'),
        now,
      );

      expect(migrate(db)).toEqual([remoteMigration.version]);
      expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('prj_keep')?.['name']).toBe(
        'Keep me',
      );
      expect(db.prepare('SELECT title FROM threads WHERE id = ?').get('thr_keep')?.['title']).toBe(
        'Existing chat',
      );
      expect(
        JSON.parse(
          String(db.prepare('SELECT value FROM settings WHERE key = ?').get('theme')?.['value']),
        ),
      ).toBe('light');
      expect(db.prepare('SELECT COUNT(*) AS n FROM remote_sessions').get()?.['n']).toBe(0);
      const repos = createRepos(db);
      expect(repos.remoteSessions.list()).toEqual([]);
      expect(repos.remoteSessions.tokenFingerprint()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rolls back a throwing transaction', () => {
    env = createTempEnv();
    const db = openDb(join(env.root, 'tuffcode.db'));
    migrate(db);
    try {
      const now = new Date().toISOString();
      expect(() =>
        transaction(db, () => {
          db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
            'prj_rollback',
            'Rollback',
            env?.root ?? '',
            now,
          );
          throw new Error('boom');
        }),
      ).toThrow('boom');
      const count = db.prepare('SELECT COUNT(*) AS total FROM projects').get()?.['total'];
      expect(count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects nested transactions', () => {
    env = createTempEnv();
    const db = openDb(join(env.root, 'tuffcode.db'));
    migrate(db);
    try {
      expect(() =>
        transaction(db, () => {
          transaction(db, () => undefined);
        }),
      ).toThrow('nested transaction');
    } finally {
      db.close();
    }
  });
});

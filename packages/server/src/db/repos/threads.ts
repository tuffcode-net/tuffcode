import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionMode, PermissionMode, Thread, ThreadStatus } from '@tuffcode/contracts';
import { asRow, integer, nullableText, text, type SqlRow } from '../rows.js';

export interface CreateThreadInput {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  title: string;
  providerId: string;
  modelId: string;
  executionMode: ExecutionMode;
  permissionMode: PermissionMode;
  /** Per-thread override; null inherits the provider default. */
  reasoningEffort?: string | null;
  status: ThreadStatus;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateThreadInput {
  title?: string;
  providerId?: string;
  modelId?: string;
  /** `null` clears the override; `undefined` leaves it as it is. */
  reasoningEffort?: string | null;
  executionMode?: ExecutionMode;
  permissionMode?: PermissionMode;
  status?: ThreadStatus;
  updatedAt: string;
}

export interface ThreadsRepo {
  list(projectId?: string): Thread[];
  listByProject(projectId: string): Thread[];
  get(id: string): Thread | undefined;
  create(input: CreateThreadInput): Thread;
  update(id: string, input: UpdateThreadInput): Thread | undefined;
  remove(id: string): void;
  setWorktree(id: string, worktree: { path: string; branch: string; baseBranch: string }): void;
  setPrUrl(id: string, url: string): void;
}

const THREAD_COLUMNS =
  'id, project_id, parent_thread_id, title, provider_id, model_id, execution_mode, permission_mode, status, worktree_path, branch, base_branch, pr_url, reasoning_effort, last_seq, created_at, updated_at';

export function mapThread(row: SqlRow): Thread {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    parentThreadId: nullableText(row, 'parent_thread_id'),
    title: text(row, 'title'),
    providerId: text(row, 'provider_id'),
    modelId: text(row, 'model_id'),
    executionMode: text(row, 'execution_mode') as ExecutionMode,
    permissionMode: text(row, 'permission_mode') as PermissionMode,
    status: text(row, 'status') as ThreadStatus,
    worktreePath: nullableText(row, 'worktree_path'),
    branch: nullableText(row, 'branch'),
    baseBranch: nullableText(row, 'base_branch'),
    prUrl: nullableText(row, 'pr_url'),
    reasoningEffort: nullableText(row, 'reasoning_effort'),
    lastSeq: integer(row, 'last_seq'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function createThreadsRepo(db: DatabaseSync): ThreadsRepo {
  const selectAll = db.prepare(`SELECT ${THREAD_COLUMNS} FROM threads ORDER BY updated_at DESC`);
  const selectByProject = db.prepare(
    `SELECT ${THREAD_COLUMNS} FROM threads WHERE project_id = ? ORDER BY updated_at DESC`,
  );
  const selectOne = db.prepare(`SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`);
  const insert = db.prepare(
    'INSERT INTO threads (id, project_id, parent_thread_id, title, provider_id, model_id, execution_mode, permission_mode, reasoning_effort, status, worktree_path, branch, base_branch, pr_url, last_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)',
  );
  const updateRow = db.prepare(
    'UPDATE threads SET title = COALESCE(?, title), provider_id = COALESCE(?, provider_id), model_id = COALESCE(?, model_id), reasoning_effort = CASE WHEN ? = 1 THEN ? ELSE reasoning_effort END, execution_mode = COALESCE(?, execution_mode), permission_mode = COALESCE(?, permission_mode), status = COALESCE(?, status), updated_at = ? WHERE id = ?',
  );
  const removeRow = db.prepare('DELETE FROM threads WHERE id = ?');
  const updateWorktree = db.prepare(
    'UPDATE threads SET worktree_path = ?, branch = ?, base_branch = ?, updated_at = ? WHERE id = ?',
  );
  const updatePrUrl = db.prepare('UPDATE threads SET pr_url = ? WHERE id = ?');

  function get(id: string): Thread | undefined {
    const row = selectOne.get(id);
    return row === undefined ? undefined : mapThread(asRow(row));
  }

  return {
    list: (projectId) =>
      (projectId === undefined ? selectAll.all() : selectByProject.all(projectId)).map((row) =>
        mapThread(asRow(row)),
      ),
    listByProject: (projectId) =>
      selectByProject.all(projectId).map((row) => mapThread(asRow(row))),
    get,
    create: (input) => {
      insert.run(
        input.id,
        input.projectId,
        input.parentThreadId,
        input.title,
        input.providerId,
        input.modelId,
        input.executionMode,
        input.permissionMode,
        input.reasoningEffort ?? null,
        input.status,
        input.worktreePath,
        input.branch,
        input.baseBranch,
        input.createdAt,
        input.updatedAt,
      );
      const created = get(input.id);
      if (created === undefined) throw new Error('thread insert did not persist');
      return created;
    },
    update: (id, input) => {
      updateRow.run(
        input.title ?? null,
        input.providerId ?? null,
        input.modelId ?? null,
        input.reasoningEffort === undefined ? 0 : 1,
        input.reasoningEffort ?? null,
        input.executionMode ?? null,
        input.permissionMode ?? null,
        input.status ?? null,
        input.updatedAt,
        id,
      );
      return get(id);
    },
    remove: (id) => {
      removeRow.run(id);
    },
    setWorktree: (id, worktree) => {
      updateWorktree.run(
        worktree.path,
        worktree.branch,
        worktree.baseBranch,
        new Date().toISOString(),
        id,
      );
    },
    setPrUrl: (id, url) => {
      updatePrUrl.run(url, id);
    },
  };
}

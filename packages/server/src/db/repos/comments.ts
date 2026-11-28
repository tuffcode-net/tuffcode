import type { DatabaseSync } from 'node:sqlite';
import type { ReviewComment, ReviewCommentSide } from '@tuffcode/contracts';
import { asRow, boolean, integer, nullableText, text, type SqlRow } from '../rows.js';

export interface CreateReviewCommentInput {
  id: string;
  threadId: string;
  filePath: string;
  line: number;
  side: ReviewCommentSide;
  body: string;
  createdAt: string;
}

export interface ReviewCommentsRepo {
  get(id: string): ReviewComment | undefined;
  list(threadId: string): ReviewComment[];
  create(input: CreateReviewCommentInput): ReviewComment;
  setResolved(id: string, resolved: boolean): ReviewComment | undefined;
  /** Stamps the first turn that carried each comment; already delivered rows keep theirs. */
  markDelivered(ids: readonly string[], at: string): void;
  /** Clears delivery so a reopened comment goes out with the next turn again. */
  clearDelivered(id: string): void;
}

const COMMENT_COLUMNS =
  'id, thread_id, file_path, line, side, body, resolved, delivered_at, created_at';

function mapComment(row: SqlRow): ReviewComment {
  return {
    id: text(row, 'id'),
    threadId: text(row, 'thread_id'),
    filePath: text(row, 'file_path'),
    line: integer(row, 'line'),
    side: text(row, 'side') as ReviewCommentSide,
    body: text(row, 'body'),
    resolved: boolean(row, 'resolved'),
    deliveredAt: nullableText(row, 'delivered_at'),
    createdAt: text(row, 'created_at'),
  };
}

export function createReviewCommentsRepo(db: DatabaseSync): ReviewCommentsRepo {
  const insert = db.prepare(
    'INSERT INTO review_comments (id, thread_id, file_path, line, side, body, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
  );
  const selectOne = db.prepare(`SELECT ${COMMENT_COLUMNS} FROM review_comments WHERE id = ?`);
  const selectByThread = db.prepare(
    `SELECT ${COMMENT_COLUMNS} FROM review_comments WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
  );
  const updateResolved = db.prepare('UPDATE review_comments SET resolved = ? WHERE id = ?');
  const stampDelivered = db.prepare(
    'UPDATE review_comments SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
  );
  const clearDelivered = db.prepare('UPDATE review_comments SET delivered_at = NULL WHERE id = ?');

  function get(id: string): ReviewComment | undefined {
    const row = selectOne.get(id);
    return row === undefined ? undefined : mapComment(asRow(row));
  }

  return {
    get,
    list: (threadId) => selectByThread.all(threadId).map((row) => mapComment(asRow(row))),
    create: (input) => {
      insert.run(
        input.id,
        input.threadId,
        input.filePath,
        input.line,
        input.side,
        input.body,
        input.createdAt,
      );
      const created = get(input.id);
      if (created === undefined) throw new Error('review comment insert did not persist');
      return created;
    },
    setResolved: (id, resolved) => {
      updateResolved.run(resolved ? 1 : 0, id);
      return get(id);
    },
    markDelivered: (ids, at) => {
      for (const id of ids) stampDelivered.run(at, id);
    },
    clearDelivered: (id) => {
      clearDelivered.run(id);
    },
  };
}

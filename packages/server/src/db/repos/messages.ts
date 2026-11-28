import type { DatabaseSync } from 'node:sqlite';
import type { Attachment, Message, MessageRole } from '@tuffcode/contracts';
import { asRow, text, type SqlRow } from '../rows.js';

export interface AddMessageInput {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  /** What the user attached; omitted for assistant and tool rows. */
  attachments?: readonly Attachment[];
  createdAt: string;
}

export interface MessagesRepo {
  add(input: AddMessageInput): Message;
  /**
   * Inserts unless a row with the same id already exists. Turn-derived message ids
   * make a replayed insert a no-op instead of a duplicate.
   */
  addIfAbsent(input: AddMessageInput): Message;
  list(threadId: string, limit?: number): Message[];
  /** Deletes every message of one thread; returns the number of rows removed. */
  removeByThread(threadId: string): number;
  /** Deletes the given message ids; returns the number of rows removed. */
  removeMany(ids: readonly string[]): number;
  /** Stored attachment ids referenced by one thread's messages. */
  attachmentIdsOfThread(threadId: string): string[];
  /** Stored attachment ids referenced by any remaining message. */
  attachmentIds(): string[];
  /** Newest user and assistant messages containing `query`, case-insensitive, one per thread. */
  search(query: string, limit: number): Message[];
}

/** Escapes LIKE wildcards so the query matches literally; paired with `ESCAPE '\\'`. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const MESSAGE_COLUMNS = 'id, thread_id, role, content, attachments, created_at';

/** Parses the stored JSON array; a malformed value never fails a transcript read. */
function parseAttachments(value: unknown): Attachment[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return parsed as Attachment[];
  } catch {
    return undefined;
  }
}

function mapMessage(row: SqlRow): Message {
  const attachments = parseAttachments(row['attachments']);
  return {
    id: text(row, 'id'),
    threadId: text(row, 'thread_id'),
    role: text(row, 'role') as MessageRole,
    content: text(row, 'content'),
    ...(attachments === undefined ? {} : { attachments }),
    createdAt: text(row, 'created_at'),
  };
}

/** The stored ids carried by a set of rows, deduplicated. */
function idsOf(rows: readonly SqlRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const attachment of parseAttachments(row['attachments']) ?? []) {
      if (attachment.id !== undefined) ids.add(attachment.id);
    }
  }
  return [...ids];
}

/** The stored JSON for an attachment list, or null when the row carries none. */
function serializeAttachments(attachments: readonly Attachment[] | undefined): string | null {
  return attachments === undefined || attachments.length === 0
    ? null
    : JSON.stringify(attachments);
}

export function createMessagesRepo(db: DatabaseSync): MessagesRepo {
  const insert = db.prepare(
    'INSERT INTO messages (id, thread_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertIgnore = db.prepare(
    'INSERT OR IGNORE INTO messages (id, thread_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`);
  const selectByThread = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
  );
  const deleteByThread = db.prepare('DELETE FROM messages WHERE thread_id = ?');
  const deleteOne = db.prepare('DELETE FROM messages WHERE id = ?');
  const selectAttachmentIdsByThread = db.prepare(
    'SELECT attachments FROM messages WHERE thread_id = ? AND attachments IS NOT NULL',
  );
  const selectAttachmentIds = db.prepare(
    'SELECT attachments FROM messages WHERE attachments IS NOT NULL',
  );
  const searchRows = db.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE role IN ('user','assistant') AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  );

  function readBack(id: string): Message {
    const row = selectOne.get(id);
    if (row === undefined) throw new Error('message insert did not persist');
    return mapMessage(asRow(row));
  }

  return {
    add: (input) => {
      insert.run(
        input.id,
        input.threadId,
        input.role,
        input.content,
        serializeAttachments(input.attachments),
        input.createdAt,
      );
      return readBack(input.id);
    },
    addIfAbsent: (input) => {
      insertIgnore.run(
        input.id,
        input.threadId,
        input.role,
        input.content,
        serializeAttachments(input.attachments),
        input.createdAt,
      );
      return readBack(input.id);
    },
    list: (threadId, limit = 500) =>
      selectByThread
        .all(threadId, Math.max(1, Math.floor(limit)))
        .map((row) => mapMessage(asRow(row))),
    removeByThread: (threadId) => Number(deleteByThread.run(threadId).changes),
    removeMany: (ids) => {
      let removed = 0;
      for (const id of ids) removed += Number(deleteOne.run(id).changes);
      return removed;
    },
    attachmentIdsOfThread: (threadId) => idsOf(selectAttachmentIdsByThread.all(threadId)),
    attachmentIds: () => idsOf(selectAttachmentIds.all()),
    search: (query, limit) => {
      const cap = Math.max(1, Math.min(50, Math.floor(limit)));
      const seen = new Set<string>();
      const out: Message[] = [];
      // Over-fetch so one chatty thread cannot crowd every other thread out of the result.
      for (const row of searchRows.all(likePattern(query), cap * 8)) {
        const message = mapMessage(asRow(row));
        if (seen.has(message.threadId)) continue;
        seen.add(message.threadId);
        out.push(message);
        if (out.length >= cap) break;
      }
      return out;
    },
  };
}

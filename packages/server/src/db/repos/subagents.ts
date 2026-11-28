import type { DatabaseSync } from 'node:sqlite';
import type {
  SubagentDepth,
  SubagentFooterStatus,
  SubagentMessage,
  SubagentMessageDirection,
  SubagentMessageKind,
  SubagentStatus,
  SubagentType,
  SubagentView,
} from '@tuffcode/contracts';
import { asRow, integer, nullableInteger, nullableText, text, type SqlRow } from '../rows.js';

export interface CreateSubagentInput {
  childId: string;
  threadId: string;
  type: SubagentType;
  providerId: string;
  model: string;
  status: SubagentStatus;
  task: string;
  budgetTokens?: number | null;
  /** quick, normal or thorough; null on rows from before the column existed. */
  depth?: SubagentDepth | null;
  createdAt: string;
}

export interface SubagentRecord extends SubagentView {
  budgetTokens: number | null;
  depth: SubagentDepth | null;
  /** Reviewer-driven rework rounds already sent to this child. */
  reworkRound: number;
  /** Null until the parent closes the child; a closed child keeps its final status. */
  closedAt: string | null;
  /** The status the child declared in its footer, when it declared one. */
  footerStatus: SubagentFooterStatus | null;
  /** The latest stored full report, so a bounded summary always names its artifact. */
  reportId: string | null;
  reportChars: number | null;
}

export interface FinishSubagentInput {
  status: SubagentStatus;
  summary?: string | null;
  updatedAt: string;
  /** The footer status the child declared; null when it stated none it recognised. */
  footerStatus?: SubagentFooterStatus | null;
}

/** One child's full final answer, kept apart from the bounded row summary. */
export interface SubagentReport {
  id: string;
  childId: string;
  text: string;
  createdAt: string;
}

export interface AddSubagentReportInput {
  id: string;
  childId: string;
  text: string;
  createdAt: string;
}

export interface SubagentsRepo {
  create(input: CreateSubagentInput): SubagentRecord;
  get(childId: string): SubagentRecord | undefined;
  listByThread(threadId: string): SubagentRecord[];
  listAll(): SubagentRecord[];
  setRunning(
    childId: string,
    childThreadId: string | null,
    updatedAt: string,
  ): SubagentRecord | undefined;
  finish(childId: string, input: FinishSubagentInput): SubagentRecord | undefined;
  /** Startup recovery: queued and running rows can never resume after a restart. */
  failUnfinished(updatedAt: string, summary: string): number;
  /** Writes the live counters; called throttled while a child runs and once on settle. */
  recordTelemetry(childId: string, telemetry: SubagentTelemetry): void;
  /** A settled done or failed child goes back to running for a follow-up turn. */
  reopen(childId: string, updatedAt: string): SubagentRecord | undefined;
  /** Records that one reviewer-driven rework round was sent. */
  setReworkRound(childId: string, round: number): void;
  /** Marks a child closed; every message row survives. */
  close(childId: string, closedAt: string): SubagentRecord | undefined;
  addMessage(input: AddSubagentMessageInput): SubagentMessage;
  /** One mailbox row by id; an answer uses it to tell a closed child from an unknown id. */
  message(id: string): SubagentMessage | undefined;
  listMessages(childId: string): SubagentMessage[];
  /** To-parent messages the parent has not read, oldest first. */
  unreadMessages(childId: string): SubagentMessage[];
  markRead(childId: string, readAt: string): number;
  /** Stores a child's full final answer; the row summary stays bounded. */
  addReport(input: AddSubagentReportInput): SubagentReport;
  getReport(id: string): SubagentReport | undefined;
  /** The newest report of one child, which is what `read` returns first. */
  latestReport(childId: string): SubagentReport | undefined;
}

export interface SubagentTelemetry {
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  activity: string | null;
}

export interface AddSubagentMessageInput {
  id: string;
  childId: string;
  direction: SubagentMessageDirection;
  /** Plain message, a child's question or the parent's answer; null reads as message. */
  kind?: SubagentMessageKind;
  text: string;
  createdAt: string;
}

const COLUMNS =
  'child_id, thread_id, child_thread_id, type, provider_id, model, status, task, summary, budget_tokens, depth, created_at, updated_at, tool_count, input_tokens, output_tokens, activity, started_at, finished_at, closed_at, footer_status, rework_round';

const SELECT_COLUMNS = `${COLUMNS}, (SELECT COUNT(*) FROM subagent_messages m WHERE m.child_id = subagents.child_id AND m.direction = 'to-parent' AND m.read_at IS NULL) AS unread, (SELECT r.id FROM subagent_reports r WHERE r.child_id = subagents.child_id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS report_id, (SELECT length(r.text) FROM subagent_reports r WHERE r.child_id = subagents.child_id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS report_chars`;

const INSERT_COLUMNS =
  'child_id, thread_id, child_thread_id, type, provider_id, model, status, task, summary, budget_tokens, depth, created_at, updated_at';

function mapRecord(row: SqlRow): SubagentRecord {
  return {
    childId: text(row, 'child_id'),
    threadId: text(row, 'thread_id'),
    type: text(row, 'type') as SubagentType,
    providerId: text(row, 'provider_id'),
    model: text(row, 'model'),
    status: text(row, 'status') as SubagentStatus,
    task: text(row, 'task'),
    summary: nullableText(row, 'summary') ?? undefined,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    childThreadId: nullableText(row, 'child_thread_id'),
    budgetTokens: row['budget_tokens'] === null ? null : integer(row, 'budget_tokens'),
    depth: nullableText(row, 'depth') as SubagentDepth | null,
    reworkRound: integer(row, 'rework_round'),
    closedAt: nullableText(row, 'closed_at'),
    footerStatus: nullableText(row, 'footer_status') as SubagentFooterStatus | null,
    reportId: nullableText(row, 'report_id'),
    reportChars: nullableInteger(row, 'report_chars'),
    ...telemetryOf(row),
  };
}

/** Telemetry columns are null on rows from before round 4; those stay unmeasured. */
function telemetryOf(row: SqlRow): Partial<SubagentView> {
  const out: Partial<SubagentView> = {};
  const toolCount = nullableInteger(row, 'tool_count');
  if (toolCount !== null) {
    out.toolCount = toolCount;
    out.inputTokens = nullableInteger(row, 'input_tokens') ?? 0;
    out.outputTokens = nullableInteger(row, 'output_tokens') ?? 0;
    out.activity = nullableText(row, 'activity');
  }
  out.startedAt = nullableText(row, 'started_at');
  out.finishedAt = nullableText(row, 'finished_at');
  if (row['unread'] !== undefined) out.unread = integer(row, 'unread');
  return out;
}

function mapMessage(row: SqlRow): SubagentMessage {
  return {
    id: text(row, 'id'),
    childId: text(row, 'child_id'),
    direction: text(row, 'direction') as SubagentMessageDirection,
    // Rows written before the kind column existed are plain messages.
    kind: (nullableText(row, 'kind') ?? 'message') as SubagentMessageKind,
    text: text(row, 'text'),
    createdAt: text(row, 'created_at'),
  };
}

/** The contract view hides the internal budget column. */
export function toSubagentView(record: SubagentRecord): SubagentView {
  return {
    childId: record.childId,
    threadId: record.threadId,
    childThreadId: record.childThreadId,
    type: record.type,
    model: record.model,
    providerId: record.providerId,
    status: record.status,
    task: record.task,
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.toolCount === undefined
      ? {}
      : {
          toolCount: record.toolCount,
          inputTokens: record.inputTokens ?? 0,
          outputTokens: record.outputTokens ?? 0,
          activity: record.activity ?? null,
        }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.unread === undefined ? {} : { unread: record.unread }),
    ...(record.reportId === null
      ? {}
      : { reportId: record.reportId, reportChars: record.reportChars ?? 0 }),
    ...(record.footerStatus === null ? {} : { footerStatus: record.footerStatus }),
    closedAt: record.closedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createSubagentsRepo(db: DatabaseSync): SubagentsRepo {
  const insert = db.prepare(
    `INSERT INTO subagents (${INSERT_COLUMNS}) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare(`SELECT ${SELECT_COLUMNS} FROM subagents WHERE child_id = ?`);
  const selectByThread = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM subagents WHERE thread_id = ? ORDER BY created_at ASC`,
  );
  const selectAll = db.prepare(`SELECT ${SELECT_COLUMNS} FROM subagents ORDER BY created_at ASC`);
  const updateRunning = db.prepare(
    'UPDATE subagents SET status = ?, child_thread_id = COALESCE(?, child_thread_id), started_at = COALESCE(started_at, ?), tool_count = COALESCE(tool_count, 0), input_tokens = COALESCE(input_tokens, 0), output_tokens = COALESCE(output_tokens, 0), updated_at = ? WHERE child_id = ?',
  );
  const updateFinished = db.prepare(
    'UPDATE subagents SET status = ?, summary = COALESCE(?, summary), footer_status = ?, finished_at = ?, updated_at = ? WHERE child_id = ?',
  );
  const updateTelemetry = db.prepare(
    'UPDATE subagents SET tool_count = ?, input_tokens = ?, output_tokens = ?, activity = ? WHERE child_id = ?',
  );
  const updateReopen = db.prepare(
    "UPDATE subagents SET status = 'running', finished_at = NULL, footer_status = NULL, updated_at = ? WHERE child_id = ? AND status IN ('done','failed')",
  );
  const updateReworkRound = db.prepare('UPDATE subagents SET rework_round = ? WHERE child_id = ?');
  const updateClosed = db.prepare(
    'UPDATE subagents SET closed_at = ?, updated_at = ? WHERE child_id = ?',
  );
  const insertMessage = db.prepare(
    'INSERT INTO subagent_messages (id, child_id, direction, kind, text, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  );
  const selectMessage = db.prepare(
    'SELECT id, child_id, direction, kind, text, created_at FROM subagent_messages WHERE id = ?',
  );
  const selectMessages = db.prepare(
    'SELECT id, child_id, direction, kind, text, created_at FROM subagent_messages WHERE child_id = ? ORDER BY created_at ASC, rowid ASC',
  );
  const selectUnread = db.prepare(
    "SELECT id, child_id, direction, kind, text, created_at FROM subagent_messages WHERE child_id = ? AND direction = 'to-parent' AND read_at IS NULL ORDER BY created_at ASC, rowid ASC",
  );
  const updateRead = db.prepare(
    "UPDATE subagent_messages SET read_at = ? WHERE child_id = ? AND direction = 'to-parent' AND read_at IS NULL",
  );
  const failUnfinished = db.prepare(
    "UPDATE subagents SET status = 'failed', summary = COALESCE(summary, ?), updated_at = ? WHERE status IN ('queued','running')",
  );
  const insertReport = db.prepare(
    'INSERT INTO subagent_reports (id, child_id, text, created_at) VALUES (?, ?, ?, ?)',
  );
  const selectReport = db.prepare(
    'SELECT id, child_id, text, created_at FROM subagent_reports WHERE id = ?',
  );
  const selectLatestReport = db.prepare(
    'SELECT id, child_id, text, created_at FROM subagent_reports WHERE child_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );

  function get(childId: string): SubagentRecord | undefined {
    const row = selectOne.get(childId);
    return row === undefined ? undefined : mapRecord(asRow(row));
  }

  function mapReport(row: SqlRow): SubagentReport {
    return {
      id: text(row, 'id'),
      childId: text(row, 'child_id'),
      text: text(row, 'text'),
      createdAt: text(row, 'created_at'),
    };
  }

  return {
    create: (input) => {
      insert.run(
        input.childId,
        input.threadId,
        input.type,
        input.providerId,
        input.model,
        input.status,
        input.task,
        input.budgetTokens ?? null,
        input.depth ?? null,
        input.createdAt,
        input.createdAt,
      );
      const created = get(input.childId);
      if (created === undefined) throw new Error('subagent insert did not persist');
      return created;
    },
    get,
    listByThread: (threadId) => selectByThread.all(threadId).map((row) => mapRecord(asRow(row))),
    listAll: () => selectAll.all().map((row) => mapRecord(asRow(row))),
    setRunning: (childId, childThreadId, updatedAt) => {
      updateRunning.run('running', childThreadId, updatedAt, updatedAt, childId);
      return get(childId);
    },
    finish: (childId, input) => {
      updateFinished.run(
        input.status,
        input.summary ?? null,
        input.footerStatus ?? null,
        input.updatedAt,
        input.updatedAt,
        childId,
      );
      return get(childId);
    },
    failUnfinished: (updatedAt, summary) =>
      Number(failUnfinished.run(summary, updatedAt).changes ?? 0),
    recordTelemetry: (childId, telemetry) => {
      updateTelemetry.run(
        telemetry.toolCount,
        telemetry.inputTokens,
        telemetry.outputTokens,
        telemetry.activity,
        childId,
      );
    },
    reopen: (childId, updatedAt) => {
      updateReopen.run(updatedAt, childId);
      return get(childId);
    },
    setReworkRound: (childId, round) => {
      updateReworkRound.run(Math.max(0, Math.floor(round)), childId);
    },
    close: (childId, closedAt) => {
      updateClosed.run(closedAt, closedAt, childId);
      return get(childId);
    },
    addMessage: (input) => {
      insertMessage.run(
        input.id,
        input.childId,
        input.direction,
        input.kind ?? 'message',
        input.text,
        input.createdAt,
      );
      const row = selectMessage.get(input.id);
      if (row === undefined) throw new Error('subagent message insert did not persist');
      return mapMessage(asRow(row));
    },
    listMessages: (childId) => selectMessages.all(childId).map((row) => mapMessage(asRow(row))),
    message: (id) => {
      const row = selectMessage.get(id);
      return row === undefined ? undefined : mapMessage(asRow(row));
    },
    unreadMessages: (childId) => selectUnread.all(childId).map((row) => mapMessage(asRow(row))),
    markRead: (childId, readAt) => Number(updateRead.run(readAt, childId).changes ?? 0),
    addReport: (input) => {
      insertReport.run(input.id, input.childId, input.text, input.createdAt);
      const row = selectReport.get(input.id);
      if (row === undefined) throw new Error('subagent report insert did not persist');
      return mapReport(asRow(row));
    },
    getReport: (id) => {
      const row = selectReport.get(id);
      return row === undefined ? undefined : mapReport(asRow(row));
    },
    latestReport: (childId) => {
      const row = selectLatestReport.get(childId);
      return row === undefined ? undefined : mapReport(asRow(row));
    },
  };
}

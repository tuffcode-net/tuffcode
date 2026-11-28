import type { StatusKey } from '@tuffcode/ui';
import type {
  SubagentMessage,
  SubagentMessageKind,
  SubagentStatus,
  SubagentType,
  ThreadEventRow,
} from '@tuffcode/contracts';
import { Compass, Hammer, ListTree, NotebookPen, ShieldCheck, type LucideIcon } from 'lucide-react';
import { isTerminalSubagentStatus, type SubagentChild } from '../../store/app-store';

/** Spec 7.5: the child pane takes 42 percent of the timeline row by default. */
export const SUBAGENT_PANE_WIDTH_PERCENT = 42;

export const SUBAGENT_TYPES: readonly SubagentType[] = [
  'explorer',
  'reviewer',
  'notetaker',
  'worker',
  'planner',
];

export const SUBAGENT_TYPE_LABEL: Record<SubagentType, string> = {
  explorer: 'Explorer',
  reviewer: 'Reviewer',
  notetaker: 'Notetaker',
  worker: 'Worker',
  planner: 'Planner',
};

export const SUBAGENT_TYPE_ICON: Record<SubagentType, LucideIcon> = {
  explorer: Compass,
  reviewer: ShieldCheck,
  notetaker: NotebookPen,
  worker: Hammer,
  planner: ListTree,
};

export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Status hues reuse the thread palette: running is sky, done is emerald, failed is
 * red, a queued child reads neutral, and a cancelled child reads closed.
 */
export const SUBAGENT_STATUS_TONE: Record<SubagentStatus, StatusKey> = {
  queued: 'idle',
  running: 'running',
  done: 'ready-to-review',
  failed: 'failed',
  cancelled: 'closed',
};

/** Children of one parent thread in spawn order; object key order is insertion order. */
export function subagentsOfThread(
  subagents: Readonly<Record<string, SubagentChild>>,
  threadId: string,
): SubagentChild[] {
  return Object.values(subagents).filter((child) => child.threadId === threadId);
}

/**
 * The live child that runs in `threadId`. A child row's thread id is the child
 * thread, while `threadId` on the child is its parent, so this matches
 * `childThreadId` only. Returns undefined until a list row has supplied it.
 */
export function childForThread(
  subagents: Readonly<Record<string, SubagentChild>>,
  threadId: string,
): SubagentChild | undefined {
  return Object.values(subagents).find((child) => child.childThreadId === threadId);
}

export function isRunningSubagent(child: SubagentChild): boolean {
  return !isTerminalSubagentStatus(child.status);
}

export function runningSubagentCount(children: readonly SubagentChild[]): number {
  return children.filter(isRunningSubagent).length;
}

/** The dock draws one chip per child while the row still fits four of them. */
export const SUBAGENT_CHIP_LIMIT = 4;

/** Beyond the limit the dock keeps this many running children plus a count. */
export const SUBAGENT_CHIP_RUNNING_LIMIT = 3;

/**
 * One dock chip. `child` opens the pane on that child, `more` opens the first
 * running child, and `finished` opens the last child that finished cleanly.
 */
export type SubagentChip =
  | { kind: 'child'; child: SubagentChild }
  | { kind: 'more'; count: number; childId: string }
  | { kind: 'finished'; count: number; label: string; childId: string };

/** Finished dock copy: "3 subagents finished". */
export function subagentFinishedLabel(count: number): string {
  return count === 1 ? '1 subagent finished' : `${count} subagents finished`;
}

/**
 * The dock's chips, decision D40: a chip per running child while four fit,
 * otherwise the first three running children and a `+N more` chip. A child that
 * failed or was cancelled keeps its own chip, because it needs attention and a
 * check icon would report it as finished. Only children that finished cleanly fold
 * into one finished chip, pushed last so the running chips keep spawn order.
 */
export function subagentStripChips(children: readonly SubagentChild[]): SubagentChip[] {
  if (children.length === 0) return [];

  const running = children.filter(isRunningSubagent);
  const attention = children.filter(
    (child) => !isRunningSubagent(child) && child.status !== 'done',
  );
  const done = children.filter((child) => child.status === 'done');

  const chips: SubagentChip[] = [];
  const shown =
    running.length <= SUBAGENT_CHIP_LIMIT
      ? running
      : running.slice(0, SUBAGENT_CHIP_RUNNING_LIMIT);
  chips.push(...shown.map((child): SubagentChip => ({ kind: 'child', child })));
  const target = running[0];
  if (running.length > SUBAGENT_CHIP_LIMIT && target !== undefined) {
    chips.push({ kind: 'more', count: running.length - shown.length, childId: target.childId });
  }
  chips.push(...attention.map((child): SubagentChip => ({ kind: 'child', child })));

  const lastDone = done[done.length - 1];
  if (lastDone !== undefined) {
    chips.push({
      kind: 'finished',
      count: done.length,
      label: subagentFinishedLabel(done.length),
      childId: lastDone.childId,
    });
  }
  return chips;
}

/** Elapsed time from start to finish, or to `nowMs` while the child runs. */
export function subagentElapsedMs(child: SubagentChild, nowMs: number): number | null {
  if (child.startedAt === null) return null;
  const start = Date.parse(child.startedAt);
  const end = child.finishedAt === null ? nowMs : Date.parse(child.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/**
 * The pane's visible tab. A requested child wins; otherwise the first running child
 * keeps the pane on live work, and a settled-only set falls back to the first child.
 */
export function selectActiveSubagent(
  children: readonly SubagentChild[],
  activeChildId: string | null,
): SubagentChild | null {
  if (activeChildId !== null) {
    const requested = children.find((child) => child.childId === activeChildId);
    if (requested !== undefined) return requested;
  }
  return children.find(isRunningSubagent) ?? children[0] ?? null;
}

/** One label per mailbox kind, so the pane never shows a bare enum value. */
export const SUBAGENT_MESSAGE_KIND_LABEL: Record<SubagentMessageKind, string> = {
  message: 'Message',
  report: 'Report',
  question: 'Question',
  answer: 'Answer',
};

/** Which way a mailbox row travelled, in words the parent can read. */
export function subagentMessageDirectionLabel(message: SubagentMessage): string {
  return message.direction === 'to-child' ? 'parent to child' : 'child to parent';
}

/**
 * A child's persisted event rows plus the live frames the store holds. The seq is the
 * cursor for both, so a live frame wins when it covers the same row, and a reload
 * rebuilds the pane instead of showing an empty timeline.
 */
export function mergeChildEvents(
  persisted: readonly ThreadEventRow[],
  live: readonly ThreadEventRow[],
): ThreadEventRow[] {
  const bySeq = new Map<number, ThreadEventRow>();
  for (const row of persisted) bySeq.set(row.seq, row);
  for (const row of live) bySeq.set(row.seq, row);
  return [...bySeq.values()].toSorted((left, right) => left.seq - right.seq);
}

/**
 * Persisted rows plus the live frames of the same child, oldest first and deduped by
 * id. The server is the source of truth for what was said; a live frame only fills the
 * gap between a load and the next one.
 */
export function mergeSubagentMessages(
  persisted: readonly SubagentMessage[],
  live: readonly SubagentMessage[],
): SubagentMessage[] {
  const seen = new Set<string>();
  const merged: SubagentMessage[] = [];
  for (const message of [...persisted, ...live]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

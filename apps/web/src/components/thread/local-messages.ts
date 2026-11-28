import type { ApprovalChoice } from '@tuffcode/contracts';
import { useSyncExternalStore } from 'react';
import type { ApprovalDecisionMap, LocalUserMessage } from './grouping';

const EMPTY_MESSAGES: readonly LocalUserMessage[] = [];
const EMPTY_TURNS: ReadonlySet<string> = new Set();

const messagesByThread = new Map<string, LocalUserMessage[]>();
const supersededTurnsByThread = new Map<string, ReadonlySet<string>>();
const approvals = new Map<string, ApprovalChoice>();
const listeners = new Set<() => void>();

let localMessageSeq = 0;

let approvalSnapshot: ApprovalDecisionMap = {};
let approvalVersion = 0;
let approvalSnapshotVersion = -1;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function updateMessage(
  messageId: string,
  patch: (message: LocalUserMessage) => LocalUserMessage,
): boolean {
  for (const [threadId, list] of messagesByThread) {
    const index = list.findIndex((message) => message.id === messageId);
    if (index === -1) continue;
    const current = list[index];
    if (!current) return false;
    const next = list.slice();
    next[index] = patch(current);
    messagesByThread.set(threadId, next);
    emit();
    return true;
  }
  return false;
}

/** A fresh echo id; the server only assigns ids once a turn is persisted. */
export function nextLocalUserMessageId(threadId: string): string {
  localMessageSeq += 1;
  return `${threadId}-${Date.now().toString(36)}-${localMessageSeq.toString(36)}`;
}

/** Session-local echo of a sent message; the event log has no user message row. */
export function addLocalUserMessage(message: LocalUserMessage): void {
  const list = messagesByThread.get(message.threadId) ?? [];
  messagesByThread.set(message.threadId, [...list, message]);
  emit();
}

/** Drops an echo, for a message the user deleted before it reached the log. */
export function removeLocalUserMessage(messageId: string): void {
  for (const [threadId, list] of messagesByThread) {
    const next = list.filter((message) => message.id !== messageId);
    if (next.length === list.length) continue;
    messagesByThread.set(threadId, next);
    emit();
    return;
  }
}

/**
 * The server accepted the send: the echo now carries the turn it started. A queued
 * send already has its turn id, but that turn only runs once the live one settles.
 */
export function resolveLocalUserMessage(messageId: string, turnId: string, queued = false): void {
  updateMessage(messageId, (message) => ({
    ...message,
    turnId,
    status: queued ? 'queued' : 'sent',
  }));
}

/** The send RPC rejected: keep the text so the bubble can offer a retry. */
export function failLocalUserMessage(messageId: string): void {
  updateMessage(messageId, (message) => ({ ...message, status: 'failed' }));
}

/** A retry is in flight again. */
export function retryLocalUserMessage(messageId: string): void {
  updateMessage(messageId, (message) => ({ ...message, status: 'pending' }));
}

/** Rewrites an echo in place; returns false when the id belongs to a persisted row. */
export function updateLocalUserMessageText(messageId: string, text: string): boolean {
  return updateMessage(messageId, (message) => ({ ...message, text }));
}

/**
 * Hides a turn whose prompt was edited and resent. The event log cannot be
 * rewritten, so the replaced turn is filtered out of the render for this session.
 */
export function supersedeTurn(threadId: string, turnId: string): void {
  const current = supersededTurnsByThread.get(threadId) ?? EMPTY_TURNS;
  if (current.has(turnId)) return;
  const next = new Set(current);
  next.add(turnId);
  supersededTurnsByThread.set(threadId, next);
  emit();
}

export function supersededTurns(threadId: string): ReadonlySet<string> {
  return supersededTurnsByThread.get(threadId) ?? EMPTY_TURNS;
}

export function useSupersededTurns(threadId: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => supersededTurns(threadId));
}

/**
 * Drops echoes whose turn now has a persisted row. Pending echoes are kept
 * because a new send can share text with an older row.
 */
export function pruneResolvedLocalUserMessages(
  threadId: string,
  turnIds: ReadonlySet<string>,
): void {
  if (turnIds.size === 0) return;
  const list = messagesByThread.get(threadId);
  if (list === undefined) return;
  const kept = list.filter((message) => message.turnId === null || !turnIds.has(message.turnId));
  if (kept.length === list.length) return;
  messagesByThread.set(threadId, kept);
  emit();
}

/** Drops every echo of a thread; /clear replaced the transcript the echoes stood in for. */
export function clearLocalUserMessages(threadId: string): void {
  if (!messagesByThread.delete(threadId)) return;
  supersededTurnsByThread.delete(threadId);
  emit();
}

export function localUserMessages(threadId: string): readonly LocalUserMessage[] {
  return messagesByThread.get(threadId) ?? EMPTY_MESSAGES;
}

export function setApprovalDecision(approvalId: string, decision: ApprovalChoice): void {
  if (approvals.get(approvalId) === decision) return;
  approvals.set(approvalId, decision);
  approvalVersion += 1;
  emit();
}

export function useLocalUserMessages(threadId: string): readonly LocalUserMessage[] {
  return useSyncExternalStore(subscribe, () => localUserMessages(threadId));
}

function getApprovalSnapshot(): ApprovalDecisionMap {
  if (approvalSnapshotVersion !== approvalVersion) {
    approvalSnapshot = Object.fromEntries(approvals);
    approvalSnapshotVersion = approvalVersion;
  }
  return approvalSnapshot;
}

export function useApprovalDecisions(): ApprovalDecisionMap {
  return useSyncExternalStore(subscribe, getApprovalSnapshot);
}

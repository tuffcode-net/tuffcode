/**
 * Text another surface wants in a thread's composer the next time it mounts, such as
 * the skill-authoring request "Create with AI" opens a new chat with. Consumed once.
 */
const pending = new Map<string, string>();

/** Unsent text per thread, kept while the user switches threads in one pane. */
const drafts = new Map<string, string>();

export function setPendingDraft(threadId: string, text: string): void {
  pending.set(threadId, text);
}

export function takePendingDraft(threadId: string | undefined): string | null {
  if (threadId === undefined) return null;
  const text = pending.get(threadId) ?? null;
  pending.delete(threadId);
  return text;
}

/** Remembers the text a thread's composer held when the pane moved to another thread. */
export function rememberDraft(threadId: string, text: string): void {
  if (text.trim().length === 0) drafts.delete(threadId);
  else drafts.set(threadId, text);
}

/** The text this thread's composer held last time, or null when it held none. */
export function draftFor(threadId: string | undefined): string | null {
  if (threadId === undefined) return null;
  return drafts.get(threadId) ?? null;
}


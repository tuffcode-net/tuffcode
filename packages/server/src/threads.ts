import type { ExecutionMode, PermissionMode, Thread } from '@tuffcode/contracts';
import { newId, worktreesRoot } from '@tuffcode/shared';
import { removeStoredAttachments } from './attachments/store.js';
import type { Repos } from './db/repos/index.js';
import { badRequest, conflict, notFound, RpcError } from './errors.js';
import { provisionWorktree, removeWorktree, samePath } from './git/worktree.js';
import { DEFAULT_THREAD_TITLE } from './titles.js';

/** Where a thread runs: the project folder itself, or an isolated worktree. */
export type ThreadWorkspace = 'folder' | 'worktree';

export interface CreateThreadRequest {
  projectId: string;
  title?: string;
  providerId: string;
  modelId: string;
  executionMode: ExecutionMode;
  permissionMode: PermissionMode;
  /** Defaults to `folder`, so callers that omit it keep the project checkout. */
  workspace?: ThreadWorkspace;
  baseBranch?: string;
}

export interface UpdateThreadRequest {
  id: string;
  title?: string;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: string | null;
  executionMode?: ExecutionMode;
  permissionMode?: PermissionMode;
}

/**
 * Serializes worktree provisioning. Two threads created at the same moment would
 * otherwise run `git worktree add` concurrently, and git locks the repository's
 * worktree metadata, so one of them would fail with a spurious lock error.
 */
let worktreeQueue: Promise<unknown> = Promise.resolve();

function withWorktreeLock<T>(task: () => Promise<T>): Promise<T> {
  const result = worktreeQueue.then(task, task);
  worktreeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Creates the thread row. `folder` (the default) runs in the project checkout with a
 * null branch; `worktree` provisions a fresh `tuffcode/<threadId>` branch first. The
 * worktree is provisioned before the insert, and if the insert fails the worktree is
 * removed so the repository is never left with an orphan checkout. With the Worktrees
 * capability off a requested worktree is forced back to folder rather than failing.
 */
export async function createThread(repos: Repos, request: CreateThreadRequest): Promise<Thread> {
  const project = repos.projects.get(request.projectId);
  if (project === undefined) throw notFound('project not found');
  const provider = repos.providers.get(request.providerId);
  if (provider === undefined) throw notFound('provider not found');
  if (!provider.enabled) {
    throw new RpcError('provider-unavailable', 'provider is disabled');
  }
  if (request.modelId.trim().length === 0) throw badRequest('model id is required');

  const id = newId('thr');
  const baseBranch = request.baseBranch ?? project.defaultBranch;
  const settings = repos.settings.get();
  const requestedWorkspace = request.workspace ?? 'folder';
  const workspace: ThreadWorkspace =
    requestedWorkspace === 'worktree' && settings.capabilities.worktrees ? 'worktree' : 'folder';
  const now = new Date().toISOString();
  const row = {
    id,
    projectId: project.id,
    parentThreadId: null,
    // The first message replaces the placeholder with a derived one-line title.
    title: request.title?.trim() || DEFAULT_THREAD_TITLE,
    providerId: provider.id,
    modelId: request.modelId,
    executionMode: request.executionMode,
    permissionMode: request.permissionMode,
    status: 'idle' as const,
    createdAt: now,
    updatedAt: now,
  };
  // A folder-backed thread owns no worktree: it runs in the project checkout itself.
  if (workspace === 'folder') {
    return repos.threads.create({
      ...row,
      worktreePath: project.path,
      branch: null,
      baseBranch,
    });
  }
  const root = settings.worktreeRoot ?? worktreesRoot();
  const worktree = await withWorktreeLock(() =>
    provisionWorktree({
      repoPath: project.path,
      baseBranch,
      projectId: project.id,
      threadId: id,
      worktreesRoot: root,
    }),
  );
  try {
    return repos.threads.create({
      ...row,
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    await removeWorktree(project.path, worktree.path, { worktreesRoot: root }).catch(
      () => undefined,
    );
    throw error;
  }
}

export interface ThreadSearchHit {
  threadId: string;
  projectId: string;
  title: string;
  snippet: string;
  matchedIn: 'title' | 'message';
}

function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + needle.length + 80);
  return `${start > 0 ? '...' : ''}${flat.slice(start, end)}${end < flat.length ? '...' : ''}`;
}

/** Title matches first, then the newest message match per other thread. */
export function searchThreads(repos: Repos, query: string, limit = 20): ThreadSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const cap = Math.max(1, Math.min(50, limit));
  const threads = repos.threads.list();
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const hits: ThreadSearchHit[] = threads
    .filter((thread) => thread.title.toLowerCase().includes(needle))
    .slice(0, cap)
    .map((thread) => ({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      snippet: thread.title,
      matchedIn: 'title',
    }));
  const seen = new Set(hits.map((hit) => hit.threadId));
  for (const message of repos.messages.search(query.trim(), cap)) {
    if (hits.length >= cap) break;
    const thread = byId.get(message.threadId);
    if (thread === undefined || seen.has(thread.id)) continue;
    seen.add(thread.id);
    hits.push({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      snippet: snippetAround(message.content, needle),
      matchedIn: 'message',
    });
  }
  return hits;
}

export function getThread(repos: Repos, id: string): Thread {
  const thread = repos.threads.get(id);
  if (thread === undefined) throw notFound('thread not found');
  return thread;
}

export function listThreads(repos: Repos, projectId?: string): Thread[] {
  return repos.threads.list(projectId);
}

export function updateThread(repos: Repos, request: UpdateThreadRequest): Thread {
  const existing = getThread(repos, request.id);
  const title = request.title === undefined ? undefined : request.title.trim();
  if (title !== undefined && title.length === 0) throw badRequest('title is required');
  if (request.providerId !== undefined && request.providerId !== existing.providerId) {
    const provider = repos.providers.get(request.providerId);
    if (provider === undefined) throw notFound('provider not found');
    if (!provider.enabled) throw new RpcError('provider-unavailable', 'provider is disabled');
    if (existing.status === 'running' || existing.status === 'needs-approval') {
      throw conflict('stop the running turn before switching providers');
    }
    // A model id belongs to its provider, so a move must name the model on the new one.
    if (request.modelId === undefined || request.modelId.trim().length === 0) {
      throw badRequest('a model id is required when switching providers');
    }
  }
  if (request.modelId !== undefined && request.modelId.trim().length === 0) {
    throw badRequest('model id is required');
  }
  const updated = repos.threads.update(existing.id, {
    title,
    ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    modelId: request.modelId,
    executionMode: request.executionMode,
    permissionMode: request.permissionMode,
    updatedAt: new Date().toISOString(),
  });
  if (updated === undefined) throw notFound('thread not found');
  return updated;
}

/**
 * Deletes the stored bytes behind the given ids unless another message still references
 * them. The store is content-addressed, so one image sent twice is one file.
 */
async function pruneAttachmentBytes(repos: Repos, candidates: readonly string[]): Promise<void> {
  if (candidates.length === 0) return;
  const kept = new Set(repos.messages.attachmentIds());
  await removeStoredAttachments(candidates.filter((id) => !kept.has(id)));
}

/**
 * Deletes the thread row. With `removeWorktree` the checkout is removed from git and
 * disk first; without it the directory is left in place for manual recovery. A
 * folder-backed thread (null branch, project path) owns no worktree, so its delete
 * never touches the project checkout.
 */
export async function deleteThread(
  repos: Repos,
  id: string,
  removeWorktreeFlag: boolean,
): Promise<void> {
  const thread = getThread(repos, id);
  if (removeWorktreeFlag && thread.branch !== null && thread.worktreePath !== null) {
    const project = repos.projects.get(thread.projectId);
    if (project !== undefined && !samePath(project.path, thread.worktreePath)) {
      await removeWorktree(project.path, thread.worktreePath, {
        worktreesRoot: repos.settings.get().worktreeRoot ?? worktreesRoot(),
      });
    }
  }
  // The thread's rows cascade on delete, so the ids have to be read first. Bytes that
  // another message still references stay, because the store is content-addressed.
  const candidates = repos.messages.attachmentIdsOfThread(thread.id);
  repos.threads.remove(id);
  await pruneAttachmentBytes(repos, candidates);
}

/** Messages kept verbatim when a thread is compacted; the rest fold into a digest. */
export const COMPACT_KEEP_MESSAGES = 8;

/** The digest is stored as one system row, so it stays bounded. */
const COMPACT_DIGEST_LIMIT = 2000;

export interface ClearThreadResult {
  messages: number;
  events: number;
}

/**
 * Empties a thread's transcript and event log. The caller drops the cached adapter
 * session first, so the model starts without the earlier conversation either.
 */
export async function clearThread(repos: Repos, threadId: string): Promise<ClearThreadResult> {
  const thread = getThread(repos, threadId);
  if (thread.status === 'running') throw conflict('stop the running turn before clearing');
  const candidates = repos.messages.attachmentIdsOfThread(thread.id);
  const result = repos.transaction(() => ({
    messages: repos.messages.removeByThread(thread.id),
    events: repos.events.removeByThread(thread.id),
  }));
  await pruneAttachmentBytes(repos, candidates);
  return result;
}

export interface CompactThreadResult {
  removed: number;
  kept: number;
}

function digestLine(role: string, content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  return `- ${role}: ${text.length <= 100 ? text : `${text.slice(0, 97)}...`}`;
}

/**
 * Folds all but the newest `COMPACT_KEEP_MESSAGES` rows into one system digest.
 * The transcript the UI renders keeps only the recent rows; the digest preserves a
 * short record of what was removed.
 */
export async function compactThread(
  repos: Repos,
  threadId: string,
  instructions = '',
): Promise<CompactThreadResult> {
  const thread = getThread(repos, threadId);
  if (thread.status === 'running') throw conflict('stop the running turn before compacting');
  const messages = repos.messages.list(thread.id, 1000);
  if (messages.length <= COMPACT_KEEP_MESSAGES) {
    return { removed: 0, kept: messages.length };
  }
  const removed = messages.slice(0, messages.length - COMPACT_KEEP_MESSAGES);
  const note = instructions.trim();
  let digest = `Compacted ${removed.length} earlier messages.`;
  if (note.length > 0) digest += ` Instructions: ${note}`;
  const lines: string[] = [];
  for (const message of removed) {
    const line = digestLine(message.role, message.content);
    if (digest.length + line.length + 1 > COMPACT_DIGEST_LIMIT) break;
    lines.push(line);
  }
  if (lines.length > 0) digest += `\n${lines.join('\n')}`;
  const createdAt = new Date().toISOString();
  const candidates: string[] = [];
  for (const message of removed) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.id !== undefined) candidates.push(attachment.id);
    }
  }
  repos.transaction(() => {
    repos.messages.removeMany(removed.map((message) => message.id));
    repos.messages.add({
      id: newId('msg'),
      threadId: thread.id,
      role: 'system',
      content: digest,
      createdAt,
    });
  });
  await pruneAttachmentBytes(repos, candidates);
  return { removed: removed.length, kept: messages.length - removed.length };
}

import type { Thread } from '@tuffcode/contracts';
import { newId, worktreesRoot } from '@tuffcode/shared';
import type { Repos } from '../db/repos/index.js';
import { badRequest, notFound, RpcError } from '../errors.js';
import { provisionWorktree, removeWorktree, tryRunGit } from '../git/index.js';
import { deleteThread } from '../threads.js';
import { isIntegrationBranch } from './integration.js';
import type { ChildThreadRequest } from './types.js';

/**
 * The base a thread row records. The review diff and every later diff resolve against
 * it, so it must outlive provisioning: a temporary council integration branch is
 * deleted as soon as the worktree exists, so its row records the commit it pointed at.
 */
async function recordedBase(
  repoPath: string,
  startPoint: string,
  fallback: string,
): Promise<string> {
  if (!isIntegrationBranch(startPoint)) return fallback;
  const commit = await tryRunGit(
    ['rev-parse', '--verify', '--quiet', `${startPoint}^{commit}`],
    repoPath,
  );
  const sha = commit.ok ? commit.stdout.trim() : '';
  return sha.length > 0 ? sha : fallback;
}

/**
 * Creates a council child thread with its own `tuffcode/<threadId>` worktree and a
 * `parent_thread_id` pointing at the thread that owns the goal. The shared
 * `createThread` helper does not take a parent, and council must not edit that slice,
 * so the same validation and cleanup rules live here.
 */
export async function provisionChildThread(
  repos: Repos,
  request: ChildThreadRequest,
): Promise<Thread> {
  const project = repos.projects.get(request.projectId);
  if (project === undefined) throw notFound('project not found');
  const provider = repos.providers.get(request.providerId);
  if (provider === undefined) throw notFound('provider not found');
  if (!provider.enabled) {
    throw new RpcError('provider-unavailable', 'provider is disabled');
  }
  if (request.modelId.trim().length === 0) throw badRequest('model id is required');

  const id = newId('thr');
  const startPoint = (request.startRef ?? request.baseBranch).trim() || project.defaultBranch;
  const root = repos.settings.get().worktreeRoot ?? worktreesRoot();
  const worktree = await provisionWorktree({
    repoPath: project.path,
    baseBranch: startPoint,
    projectId: project.id,
    threadId: id,
    worktreesRoot: root,
  });
  const baseBranch = await recordedBase(project.path, startPoint, worktree.baseBranch);
  const now = new Date().toISOString();
  try {
    return repos.threads.create({
      id,
      projectId: project.id,
      parentThreadId: request.parentThreadId,
      title: request.title.trim() || `Council ${id.slice(4, 12)}`,
      providerId: provider.id,
      modelId: request.modelId,
      executionMode: request.executionMode,
      permissionMode: request.permissionMode,
      reasoningEffort: request.effort ?? null,
      status: 'idle',
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseBranch,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    await removeWorktree(project.path, worktree.path).catch(() => undefined);
    throw error;
  }
}

/** Removes a child thread row and its worktree. Missing rows are already disposed. */
export async function deleteChildThread(repos: Repos, threadId: string): Promise<void> {
  if (repos.threads.get(threadId) === undefined) return;
  await deleteThread(repos, threadId, true);
}

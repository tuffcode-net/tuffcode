import type { Repos } from '../db/repos/index.js';
import { badRequest, conflict, RpcError } from '../errors.js';
import { requireWorktree } from './context.js';
import { currentBranch } from './worktree.js';
import { runGit } from './runGit.js';

const PROTECTED_BRANCHES: Readonly<Record<string, true>> = { main: true, master: true };

/**
 * Stages everything and commits it. Refuses on main/master (the protected branches)
 * and when there is nothing staged.
 */
export async function commitThread(
  repos: Repos,
  threadId: string,
  message: string,
): Promise<{ sha: string }> {
  const trimmed = message.trim();
  if (trimmed.length === 0) throw badRequest('commit message is required');
  const { thread, worktreePath } = requireWorktree(repos, threadId);
  const branch = (await currentBranch(worktreePath)) ?? thread.branch;
  if (branch === null) throw conflict('thread is not on a branch');
  if (PROTECTED_BRANCHES[branch] === true) {
    throw new RpcError('permission-denied', `commits are not allowed on ${branch}`);
  }
  const status = await runGit(['status', '--porcelain'], worktreePath);
  if (status.trim().length === 0) throw conflict('nothing to commit');
  await runGit(['add', '-A'], worktreePath);
  await runGit(['commit', '-m', trimmed], worktreePath);
  const sha = (await runGit(['rev-parse', 'HEAD'], worktreePath)).trim();
  return { sha };
}

/** Pushes the thread branch to `origin` and sets its upstream. */
export async function pushThread(
  repos: Repos,
  threadId: string,
): Promise<{ branch: string; remote: string }> {
  const { thread, worktreePath } = requireWorktree(repos, threadId);
  const branch = (await currentBranch(worktreePath)) ?? thread.branch;
  if (branch === null) throw conflict('thread is not on a branch');
  await runGit(['push', '-u', 'origin', branch], worktreePath);
  return { branch, remote: 'origin' };
}

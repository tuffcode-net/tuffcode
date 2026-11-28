import type { Repos } from '../db/repos/index.js';
import { requireWorktree, resolveBaseRef, tryRunGit } from '../git/index.js';
import type { TaskChanges } from './types.js';

const MAX_PATCH_CHARS = 120_000;

/**
 * Everything the task branch changed since its base branch, including uncommitted
 * work. The worker commits per its brief, so the committed range is the normal case;
 * the working-tree diff is included so a dirty checkout is never mistaken for an
 * empty task.
 *
 * A council task that started from a temporary integration branch records the merge
 * commit as its base, so the base may be a commit id rather than a branch name. The
 * fallback below then diffs against that commit directly.
 */
export async function changesForThread(repos: Repos, threadId: string): Promise<TaskChanges> {
  const { thread, worktreePath } = requireWorktree(repos, threadId);
  const base = thread.baseBranch ?? 'main';
  const ref = await resolveBaseRef(worktreePath, base).catch(() => base);

  const status = await tryRunGit(['status', '--porcelain'], worktreePath);
  const dirty = status.ok && status.stdout.trim().length > 0;
  const count = await tryRunGit(['rev-list', '--count', `${ref}..HEAD`], worktreePath);
  const commits = count.ok ? Number.parseInt(count.stdout.trim(), 10) : 0;
  if (!dirty && !(Number.isFinite(commits) && commits > 0)) {
    return { changed: false, files: [], patch: '' };
  }

  const files = await tryRunGit(['diff', '--name-only', '--no-color', ref], worktreePath);
  const patch = await tryRunGit(['diff', '--no-color', ref], worktreePath);
  return {
    changed: true,
    files: files.ok
      ? files.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [],
    patch: patch.ok ? patch.stdout.slice(0, MAX_PATCH_CHARS) : '',
  };
}

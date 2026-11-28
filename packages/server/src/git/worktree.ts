import { existsSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isInside, normalizePath, worktreesRoot } from '@tuffcode/shared';
import { badRequest, conflict } from '../errors.js';
import { runGit, tryRunGit } from './runGit.js';

export interface ProvisionWorktreeInput {
  repoPath: string;
  baseBranch: string;
  projectId: string;
  threadId: string;
  worktreesRoot: string;
}

export interface ProvisionedWorktree {
  path: string;
  branch: string;
  baseBranch: string;
}

/**
 * Resolves a path that may not exist yet to its canonical long form. Windows can hand
 * out 8.3 aliases (`RUNNER~1`) for the same directory, and comparing an alias against
 * the real path breaks containment checks, so the nearest existing ancestor is
 * resolved with `realpath` and the missing tail is re-appended.
 */
function canonicalPath(path: string): string {
  const resolved = resolve(normalizePath(path));
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return normalizePath(join(real, ...missing.toReversed()));
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolved;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Compares two canonical paths. Windows path comparison is case-insensitive, so a
 * checkout reached through different casing must still count as the same directory.
 */
export function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await tryRunGit(['rev-parse', '--is-inside-work-tree'], dir);
  return result.ok && result.stdout.trim() === 'true';
}

/** Canonical absolute repository root for `dir`, or null when it is not a work tree. */
export async function repoRoot(dir: string): Promise<string | null> {
  const result = await tryRunGit(['rev-parse', '--show-toplevel'], dir);
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root.length === 0 ? null : canonicalPath(root);
}

/** Current branch name, or null for a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await tryRunGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (!result.ok) return null;
  const branch = result.stdout.trim();
  return branch.length === 0 ? null : branch;
}

/**
 * Resolves a base branch to something `git worktree add` accepts: the local branch
 * when it exists, otherwise `origin/<branch>`.
 */
export async function resolveBaseRef(cwd: string, branch: string): Promise<string> {
  const local = await tryRunGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  if (local.ok) return branch;
  const remote = await tryRunGit(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    cwd,
  );
  if (remote.ok) return `origin/${branch}`;
  throw badRequest(`base branch not found: ${branch}`);
}

/**
 * The branch a project treats as its default: `origin/HEAD` when the remote is set,
 * otherwise the first of main/master that exists, otherwise the checked-out branch.
 */
export async function detectDefaultBranch(cwd: string): Promise<string> {
  const remoteHead = await tryRunGit(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    cwd,
  );
  if (remoteHead.ok) {
    const value = remoteHead.stdout.trim();
    const slash = value.indexOf('/');
    if (slash >= 0 && slash < value.length - 1) return value.slice(slash + 1);
  }
  for (const candidate of ['main', 'master']) {
    const exists = await tryRunGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`],
      cwd,
    );
    if (exists.ok) return candidate;
  }
  return (await currentBranch(cwd)) ?? 'main';
}

/**
 * Creates `git worktree add -b tuffcode/<threadId> <worktreesRoot>/<projectId>/<threadId>
 * <base>` after validating the project is a git repository, the base branch exists and
 * the worktree root sits outside the project (worktrees never land inside the repo).
 */
export async function provisionWorktree(
  input: ProvisionWorktreeInput,
): Promise<ProvisionedWorktree> {
  if (!(await isGitRepo(input.repoPath))) {
    throw badRequest('project is not a git repository');
  }
  const repo = canonicalPath(input.repoPath);
  const root = canonicalPath(input.worktreesRoot);
  if (isInside(repo, root)) {
    throw badRequest('worktree root must be outside the project');
  }
  const target = join(root, input.projectId, input.threadId);
  if (isInside(repo, target)) {
    throw badRequest('worktree path must be outside the project');
  }
  if (existsSync(target)) {
    throw conflict('worktree path already exists');
  }
  const branch = `tuffcode/${input.threadId}`;
  const startPoint = await resolveBaseRef(repo, input.baseBranch);
  await runGit(['worktree', 'add', '-b', branch, target, startPoint], repo);
  return { path: target, branch, baseBranch: input.baseBranch };
}

export interface RemoveWorktreeOptions {
  /** Root the checkout must live under; defaults to the configured worktrees root. */
  worktreesRoot?: string;
}

/**
 * Whether a checkout holds work that exists in no commit: a tracked edit, a staged
 * change, or an untracked file. A git failure counts as work, because a checkout that
 * cannot be inspected must never be removed.
 */
export async function hasUncommittedWork(worktreePath: string): Promise<boolean> {
  const status = await tryRunGit(['status', '--porcelain'], worktreePath);
  if (!status.ok) return true;
  return status.stdout.trim().length > 0;
}

/**
 * Removes a worktree: `git worktree remove --force`, a filesystem fallback when git
 * refuses (for example after the directory was already partly deleted), then
 * `git worktree prune` so the repository stops listing it.
 *
 * The checkout is refused unless it sits strictly inside the worktrees root. A
 * folder-backed thread stores the project checkout itself as its worktree path, so
 * without this guard deleting the thread would delete the user's repository. The
 * containment check runs before any git or filesystem call, and a path that fails it
 * never falls back to a filesystem delete.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options: RemoveWorktreeOptions = {},
): Promise<void> {
  const target = canonicalPath(worktreePath);
  const repo = canonicalPath(repoPath);
  const root = canonicalPath(options.worktreesRoot ?? worktreesRoot());
  if (samePath(target, repo)) {
    throw badRequest('refusing to remove the project checkout');
  }
  if (samePath(target, root) || !isInside(root, target)) {
    throw badRequest('refusing to remove a path outside the worktrees root');
  }
  const removed = await tryRunGit(['worktree', 'remove', '--force', target], repo);
  if (!removed.ok && existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  await tryRunGit(['worktree', 'prune'], repo);
}

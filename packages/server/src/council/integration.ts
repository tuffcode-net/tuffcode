import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isInside, normalizePath } from '@tuffcode/shared';
import { badRequest, conflict } from '../errors.js';
import { repoRoot, resolveBaseRef, runGit, tryRunGit } from '../git/index.js';

/** Prefix of the temporary branches council merges a task's dependencies into. */
const INTEGRATION_PREFIX = 'council/';

/** Name of the temporary base branch for one task. */
function integrationBranchName(taskId: string): string {
  return `${INTEGRATION_PREFIX}${taskId}/base`;
}

/**
 * True when a ref names a temporary council integration branch. Such a branch is
 * deleted as soon as the task worktree exists, so a thread row records the commit it
 * pointed at instead of the name.
 */
export function isIntegrationBranch(ref: string): boolean {
  return ref.startsWith(INTEGRATION_PREFIX) && ref.endsWith('/base');
}

export interface IntegrationBranch {
  /** Local branch the task worktree starts from. Temporary: `cleanup` deletes it. */
  branch: string;
  /** Removes the temporary worktree and branch; safe to call more than once. */
  cleanup: () => Promise<void>;
}

export interface CreateIntegrationBranchInput {
  repoPath: string;
  worktreesRoot: string;
  projectId: string;
  taskId: string;
  /** Dependency branches in plan order; the first one seeds the base branch. */
  branches: readonly string[];
}

/**
 * Resolves a path that may not exist yet to its canonical long form. Windows can hand
 * out 8.3 aliases for the same directory, and comparing an alias against the real path
 * breaks the containment checks below.
 */
function canonicalRoot(path: string): string {
  const resolved = resolve(normalizePath(path));
  try {
    return normalizePath(realpathSync.native(resolved));
  } catch {
    return resolved;
  }
}

/** Files git reports as unmerged after a failed merge, in path order. */
async function unmergedFiles(cwd: string): Promise<string[]> {
  const result = await tryRunGit(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Last few non-empty lines of git's own output, for a failure git did not name. */
function outputTail(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-3).join('; ');
  return tail.length > 0 ? tail : 'merge failed';
}

/**
 * Merges several task branches into one temporary branch so a dependent task starts
 * from all of its dependencies at once. `--no-ff` keeps every dependency a distinct
 * commit, so the history says which task contributed what.
 *
 * The temporary worktree lives beside the task worktrees. A conflict removes it and the
 * branch before throwing: a half merged base would silently drop a dependency, so a
 * conflict always fails the task instead.
 */
export async function createIntegrationBranch(
  input: CreateIntegrationBranchInput,
): Promise<IntegrationBranch> {
  const names = input.branches
    .map((branch) => branch.trim())
    .filter((branch) => branch.length > 0);
  if (names.length < 2) throw badRequest('an integration branch needs at least two branches');

  const repo = await repoRoot(input.repoPath);
  if (repo === null) throw badRequest('project is not a git repository');
  const root = canonicalRoot(input.worktreesRoot);
  if (isInside(repo, root)) throw badRequest('worktree root must be outside the project');
  const target = join(root, input.projectId, `${input.taskId}-base`);
  if (isInside(repo, target)) throw badRequest('worktree path must be outside the project');
  if (existsSync(target)) throw conflict('worktree path already exists');

  const refs: { name: string; ref: string }[] = [];
  for (const name of names) refs.push({ name, ref: await resolveBaseRef(repo, name) });
  const [first, ...rest] = refs;
  if (first === undefined) throw badRequest('an integration branch needs at least two branches');
  const branch = integrationBranchName(input.taskId);

  const cleanup = async (): Promise<void> => {
    await tryRunGit(['worktree', 'remove', '--force', target], repo);
    await tryRunGit(['worktree', 'prune'], repo);
    await tryRunGit(['branch', '-D', branch], repo);
    if (existsSync(target)) {
      throw conflict(`could not remove the integration worktree at ${target}`);
    }
    const left = await tryRunGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo);
    if (left.ok) throw conflict(`could not delete the integration branch ${branch}`);
  };

  try {
    await runGit(['worktree', 'add', '-b', branch, target, first.ref], repo);
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }

  for (const other of rest) {
    const merge = await tryRunGit(
      ['merge', '--no-ff', '-m', `council: integrate ${other.name}`, other.ref],
      target,
    );
    if (merge.ok) continue;
    const files = await unmergedFiles(target);
    await cleanup().catch(() => undefined);
    const detail =
      files.length > 0 ? `conflicting files: ${files.join(', ')}` : outputTail(merge.stderr);
    throw conflict(
      `cannot integrate ${other.name} into ${branch} from ${first.name}: ${detail}`,
    );
  }

  return { branch, cleanup };
}

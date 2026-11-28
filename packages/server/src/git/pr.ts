import type { Repos } from '../db/repos/index.js';
import { badRequest, conflict, RpcError } from '../errors.js';
import { requireWorktree } from './context.js';
import { runExecutable, tryRunGit, GitError } from './runGit.js';
import { currentBranch } from './worktree.js';

export interface PullRequestInput {
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestResult {
  url: string;
  number: number;
}

/**
 * Finds the pull request URL in `gh pr create` output. gh prints the URL on its own
 * line (plus human-readable text around it), so the last matching line wins.
 */
export function parsePullRequestUrl(output: string): PullRequestResult | null {
  const matches = [...output.matchAll(/https?:\/\/[^\s]+\/pull\/(\d+)/g)];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const url = last[0].replace(/[.,)]+$/, '');
  const number = Number(last[1]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { url, number };
}

/**
 * `gh pr create --base` takes a branch, never a commit. Council records a temporary
 * integration branch as the merge commit it started from, so a recorded value that is
 * not a local or remote branch falls back to the project's default branch.
 */
async function branchBase(cwd: string, recorded: string, fallback: string): Promise<string> {
  const local = await tryRunGit(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${recorded}`],
    cwd,
  );
  if (local.ok) return recorded;
  const remote = await tryRunGit(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${recorded}`],
    cwd,
  );
  return remote.ok ? recorded : fallback;
}

/**
 * Runs `gh pr create` in the thread worktree. Drafts are the default; pass
 * `draft: false` to open a ready-for-review PR. gh's own failures are surfaced as
 * bad-request with its last stderr line, never as a stack trace.
 */
export async function openPullRequest(
  repos: Repos,
  threadId: string,
  input: PullRequestInput,
): Promise<PullRequestResult> {
  const title = input.title.trim();
  if (title.length === 0) throw badRequest('pull request title is required');
  const { thread, worktreePath } = requireWorktree(repos, threadId);
  const branch = (await currentBranch(worktreePath)) ?? thread.branch;
  if (branch === null) throw conflict('thread is not on a branch');
  const project = repos.projects.get(thread.projectId);
  const fallbackBase = project?.defaultBranch ?? 'main';
  const base = await branchBase(worktreePath, thread.baseBranch ?? fallbackBase, fallbackBase);
  const args = [
    'pr',
    'create',
    '--title',
    title,
    '--body',
    input.body,
    '--base',
    base,
    '--head',
    branch,
  ];
  if (input.draft !== false) args.push('--draft');

  let stdout: string;
  try {
    const result = await runExecutable('gh', args, worktreePath);
    stdout = result.stdout;
  } catch (error) {
    if (error instanceof GitError) {
      if (error.spawnCode === 'ENOENT') {
        throw new RpcError('provider-unavailable', 'GitHub CLI (gh) not found');
      }
      const detail = error.stderr
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .pop();
      throw badRequest(
        detail === undefined ? 'gh pr create failed' : `gh pr create failed: ${detail}`,
      );
    }
    throw error;
  }

  const parsed = parsePullRequestUrl(stdout);
  if (parsed === null) throw new RpcError('internal', 'gh did not report a pull request URL');
  return parsed;
}

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffFile, DiffFileStatus } from '@tuffcode/contracts';
import type { Repos } from '../db/repos/index.js';
import { notFound } from '../errors.js';
import { requireWorktree } from './context.js';
import { runGit, scrubbedEnv } from './runGit.js';

const MAX_FILES = 200;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
}

function statusFromCode(code: string): DiffFileStatus {
  switch (code.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

/** Parses `git diff --name-status -z` output, where every field is NUL separated. */
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split('\0');
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index];
    if (code === undefined || code.length === 0) break;
    index += 1;
    const status = statusFromCode(code);
    if (status === 'renamed' || status === 'copied') {
      const oldPath = fields[index] ?? '';
      const path = fields[index + 1] ?? '';
      index += 2;
      files.push({ path, oldPath, status });
      continue;
    }
    const path = fields[index] ?? '';
    index += 1;
    files.push({ path, oldPath: null, status });
  }
  return files;
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

async function trackedFile(
  cwd: string,
  base: string | undefined,
  entry: ChangedFile,
  env?: NodeJS.ProcessEnv,
): Promise<DiffFile> {
  const pathspec = entry.oldPath === null ? [entry.path] : [entry.oldPath, entry.path];
  const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3'];
  if (base !== undefined) args.push(base);
  args.push('--', ...pathspec);
  const patch = await runGit(args, cwd, env === undefined ? {} : { env });
  const binary = patch.startsWith('Binary files ') || patch.includes('GIT binary patch');
  const counts = countPatchLines(patch);
  const tooLarge = Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES;
  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    binary,
    additions: counts.additions,
    deletions: counts.deletions,
    patch: binary || tooLarge ? null : patch,
  };
}

/**
 * Untracked files have no git object to diff against, so the new text is read from
 * disk (capped at 2 MB) and rendered as a new-file patch.
 */
function untrackedFile(cwd: string, path: string): DiffFile {
  const base: DiffFile = {
    path,
    oldPath: null,
    status: 'untracked',
    binary: false,
    additions: 0,
    deletions: 0,
    patch: null,
  };
  const absolute = join(cwd, path);
  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    return base;
  }
  if (size > MAX_PATCH_BYTES) return base;
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) return { ...base, binary: true };
  const lines = buffer.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const additions = lines.length;
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  const patch =
    additions === 0
      ? header
      : `${header}@@ -0,0 +1,${additions} @@\n${lines.map((line) => `+${line.replace(/\r$/, '')}`).join('\n')}\n`;
  return { ...base, additions, patch };
}

/**
 * Collects changed files against `base` (a commit) or, when `base` is undefined, against
 * the index in `env`. With a temporary index the checkpoint tree is the comparison point,
 * so a file the checkpoint captured as untracked is compared instead of being reported
 * as deleted.
 */
async function collectFiles(
  worktreePath: string,
  base: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<DiffFile[]> {
  const nameStatusArgs = ['diff', '--name-status', '-z', '--no-color', '--no-ext-diff'];
  if (base !== undefined) nameStatusArgs.push(base);
  const nameStatus = await runGit(nameStatusArgs, worktreePath, env === undefined ? {} : { env });
  const changed = parseNameStatus(nameStatus);
  const seen = new Set(changed.map((entry) => entry.path));
  const untracked = await runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    worktreePath,
    env === undefined ? {} : { env },
  );
  for (const path of untracked.split('\0')) {
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    changed.push({ path, oldPath: null, status: 'untracked' });
  }

  const files: DiffFile[] = [];
  for (const entry of changed.slice(0, MAX_FILES)) {
    files.push(
      entry.status === 'untracked'
        ? untrackedFile(worktreePath, entry.path)
        : await trackedFile(worktreePath, base, entry, env),
    );
  }
  return files;
}

/**
 * Working-tree diff for a thread against HEAD, or against a checkpoint commit when
 * `checkpointId` is given. Tracked files come from `git diff --name-status -z`;
 * untracked files are appended. Capped at 200 files and 2 MB of patch per file.
 */
export async function getDiff(
  repos: Repos,
  threadId: string,
  checkpointId?: string,
): Promise<DiffFile[]> {
  const { worktreePath } = requireWorktree(repos, threadId);
  if (checkpointId === undefined) {
    const base = (await runGit(['rev-parse', 'HEAD'], worktreePath)).trim();
    return collectFiles(worktreePath, base);
  }

  const checkpoint = repos.checkpoints.get(checkpointId);
  if (checkpoint === undefined || checkpoint.threadId !== threadId) {
    throw notFound('checkpoint not found');
  }
  // A snapshot tree can hold files the real index never saw (untracked at checkpoint
  // time). Comparing the snapshot against the real index calls those deleted, so the
  // comparison runs through a throwaway index seeded from the checkpoint tree.
  const indexDir = mkdtempSync(join(tmpdir(), 'tuffcode-diff-'));
  try {
    const env: NodeJS.ProcessEnv = { ...scrubbedEnv(), GIT_INDEX_FILE: join(indexDir, 'index') };
    await runGit(['read-tree', checkpoint.commitSha], worktreePath, { env });
    return await collectFiles(worktreePath, undefined, env);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

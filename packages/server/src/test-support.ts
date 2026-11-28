import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Project, ProviderView, Thread } from '@tuffcode/contracts';
import type { Logger } from '@tuffcode/shared';
import { migrate, openDb } from './db/index.js';
import { createRepos, type Repos } from './db/repos/index.js';
import { addProject } from './projects.js';
import { createThread } from './threads.js';

export interface TempEnv {
  root: string;
  home: string;
  localAppData: string;
  dispose(): void;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Isolated `TUFFCODE_HOME`, `LOCALAPPDATA` and `XDG_DATA_HOME` under a fresh temp
 * directory, so the database, token, server.json, worktrees and attachment store never
 * touch the developer's real state on any platform.
 */
export function createTempEnv(): TempEnv {
  const root = mkdtempSync(join(tmpdir(), 'tuffcode-server-'));
  const home = join(root, 'home');
  const localAppData = join(root, 'local');
  const xdgData = join(root, 'xdg');
  mkdirSync(home, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(xdgData, { recursive: true });
  const previousHome = process.env.TUFFCODE_HOME;
  const previousLocal = process.env.LOCALAPPDATA;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.TUFFCODE_HOME = home;
  process.env.LOCALAPPDATA = localAppData;
  process.env.XDG_DATA_HOME = xdgData;
  return {
    root,
    home,
    localAppData,
    dispose: () => {
      restoreEnv('TUFFCODE_HOME', previousHome);
      restoreEnv('LOCALAPPDATA', previousLocal);
      restoreEnv('XDG_DATA_HOME', previousXdg);
      removeTempRoot(root);
    },
  };
}

/**
 * Removes a temp root, retrying briefly. Windows releases a git child's handles just
 * after it exits, so a removal that follows real `git worktree` calls can see EPERM
 * for a moment even though every process was awaited.
 */
function removeTempRoot(root: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** A logger that writes nowhere; runner and service tests use it by default. */
export function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return logger;
}

export interface TestContext {
  env: TempEnv;
  db: DatabaseSync;
  repos: Repos;
  dispose(): void;
}

export function createTestContext(): TestContext {
  const env = createTempEnv();
  const db = openDb(join(env.root, 'tuffcode.db'));
  migrate(db);
  return {
    env,
    db,
    repos: createRepos(db),
    dispose: () => {
      db.close();
      env.dispose();
    },
  };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface TemplateFile {
  /** Path relative to the repository root. */
  path: string;
  content: Buffer;
}

const templateCache = new Map<string, TemplateFile[]>();

/**
 * The files of one repository per branch, built on first use and written out by every
 * `initRepo` call.
 *
 * `initRepo` used to spawn seven `git` processes per test: init, four config writes, add
 * and commit. Those spawns were the whole hook: measured 207 ms of a 240 ms hook on an
 * idle machine and about 1.2 s per test on a loaded Windows CI runner. Process creation is
 * the part that stalls when several test files spawn git at once, which is how a hook that
 * normally costs a quarter of a second can time out at 20 s. Building the repository once
 * per worker process and writing its eleven files for each call (measured 7 ms) keeps every
 * test isolated while leaving no spawn in the hook.
 *
 * The template uses an empty git template directory: the default one copies sixteen sample
 * hooks per repository, which made a copy as slow as the spawns it replaces.
 */
function templateFiles(branch: string): TemplateFile[] {
  const cached = templateCache.get(branch);
  if (cached !== undefined) return cached;
  const root = mkdtempSync(join(tmpdir(), 'tuffcode-git-template-'));
  try {
    const emptyTemplate = join(root, 'empty');
    mkdirSync(emptyTemplate, { recursive: true });
    const path = join(root, 'repo');
    mkdirSync(path, { recursive: true });
    git(path, ['init', '-b', branch, `--template=${emptyTemplate}`]);
    // Written as text instead of four `git config` spawns; the values are constants and
    // the file format is stable.
    appendFileSync(
      join(path, '.git', 'config'),
      '[user]\n\temail = tuffcode@example.com\n\tname = Tuffcode Test\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
    );
    writeFileSync(join(path, 'README.md'), '# demo\n');
    git(path, ['add', '-A']);
    git(path, ['commit', '-m', 'init']);
    const files = readTree(path);
    templateCache.set(branch, files);
    return files;
  } finally {
    try {
      removeTempRoot(root);
    } catch {
      // The fixture is in memory now; a leftover temp directory is harmless.
    }
  }
}

function readTree(root: string): TemplateFile[] {
  const files: TemplateFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ path: relative(root, full), content: readFileSync(full) });
    }
  };
  walk(root);
  return files;
}

/** Real repository with one commit on `main` and local identity configured. */
export function initRepo(path: string, branch = 'main'): string {
  const files = templateFiles(branch);
  mkdirSync(path, { recursive: true });
  for (const file of files) {
    const target = join(path, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  return path;
}

export function initBareRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '--bare', '--initial-branch=main']);
  return path;
}

export function addTestProvider(repos: Repos, id = 'prv_test'): ProviderView {
  return repos.providers.upsert({ id, kind: 'claude', label: 'Test provider', config: {} });
}

export interface ProjectThread {
  project: Project;
  thread: Thread;
}

/** Project plus a provisioned worktree thread, the setup every git test needs. */
export async function createProjectThread(repos: Repos, repoPath: string): Promise<ProjectThread> {
  addTestProvider(repos);
  const project = await addProject(repos, repoPath);
  const thread = await createThread(repos, {
    projectId: project.id,
    providerId: 'prv_test',
    modelId: 'model-x',
    executionMode: 'work',
    permissionMode: 'ask',
    workspace: 'worktree',
  });
  return { project, thread };
}

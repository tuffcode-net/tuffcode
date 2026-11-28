import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Real repository with one commit on `main` and local identity configured. */
export function initRepo(path: string, branch = 'main'): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-b', branch]);
  git(path, ['config', 'user.email', 'tuffcode@example.com']);
  git(path, ['config', 'user.name', 'Tuffcode Test']);
  git(path, ['config', 'commit.gpgsign', 'false']);
  git(path, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(path, 'README.md'), '# demo\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-m', 'init']);
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

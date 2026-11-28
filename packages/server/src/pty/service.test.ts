import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Thread } from '@tuffcode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '../errors.js';
import { createTestContext, type TestContext } from '../test-support.js';
import { commandExists } from './shell.js';
import { TerminalService, terminalEnv, type TerminalDataEvent } from './service.js';

const NOW = '2026-11-24T00:00:00.000Z';
/**
 * Budget for one pty round trip. `node-pty` spawns the shell synchronously, and an
 * interactive `powershell.exe` loads its profile before it echoes input: measured 11.4 s
 * with a developer profile and 4.7 s with an empty one. At 20 s this test was one loaded
 * run away from a false failure, and it was seen failing at 20.8 s. The assertions below
 * check the round trip, not how long it takes.
 */
const ROUND_TRIP_TIMEOUT_MS = 60_000;

interface ThreadOptions {
  /** Folder threads have no branch; a worktree thread defaults to a tuffcode branch. */
  branch?: string | null;
  projectPath?: string;
}

function addThread(
  ctx: TestContext,
  id: string,
  worktreePath: string | null,
  options: ThreadOptions = {},
): Thread {
  ctx.repos.projects.add({
    id: `prj_${id}`,
    name: id,
    path: options.projectPath ?? join(ctx.env.root, `project-${id}`),
    defaultBranch: 'main',
    createdAt: NOW,
  });
  return ctx.repos.threads.create({
    id,
    projectId: `prj_${id}`,
    parentThreadId: null,
    title: id,
    providerId: 'prv_test',
    modelId: 'model-x',
    executionMode: 'work',
    permissionMode: 'ask',
    status: 'idle',
    worktreePath,
    branch: options.branch === undefined ? 'tuffcode/test' : options.branch,
    baseBranch: 'main',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof RpcError ? error.code : 'not-an-rpc-error';
  }
  return 'no-error';
}

const hasPwsh = process.platform === 'win32' && commandExists('pwsh.exe');
const hasPowershell = process.platform === 'win32' && commandExists('powershell.exe');
const hasCmd = process.platform === 'win32' && commandExists('cmd.exe');

if (process.platform === 'win32' && !hasPwsh && !hasCmd) {
  throw new Error('no shell available for the terminal tests; install pwsh.exe or cmd.exe');
}

describe('TerminalService', () => {
  let ctx: TestContext;
  let service: TerminalService;
  let events: TerminalDataEvent[];
  const waiters = new Set<() => void>();

  beforeEach(() => {
    ctx = createTestContext();
    events = [];
    waiters.clear();
    service = new TerminalService({
      repos: ctx.repos,
      onData: (event) => {
        events.push(event);
        for (const waiter of waiters) waiter();
      },
    });
  });

  afterEach(async () => {
    await service.disposeAll();
    ctx.dispose();
  });

  function waitForToken(token: string): Promise<void> {
    const found = (): boolean => events.some((event) => event.data.includes(token));
    if (found()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = (): void => {
        if (!found()) return;
        waiters.delete(waiter);
        resolve();
      };
      waiters.add(waiter);
    });
  }

  it('rejects an unknown thread', () => {
    expect(errorCode(() => service.open('thr_missing', 80, 24))).toBe('not-found');
  });

  it('rejects a thread without a worktree', () => {
    addThread(ctx, 'thr_none', null);
    expect(errorCode(() => service.open('thr_none', 80, 24))).toBe('conflict');
  });

  it('rejects a worktree that is missing from disk', () => {
    addThread(ctx, 'thr_gone', join(ctx.env.root, 'gone'));
    expect(errorCode(() => service.open('thr_gone', 80, 24))).toBe('conflict');
  });

  it('rejects a worktree path that is not a directory', () => {
    const file = join(ctx.env.root, 'not-a-dir');
    writeFileSync(file, 'x');
    addThread(ctx, 'thr_file', file);
    expect(errorCode(() => service.open('thr_file', 80, 24))).toBe('conflict');
  });

  it('opens a folder thread at the project path when the stored path is gone', async () => {
    const projectPath = join(ctx.env.root, 'project-folder-gone');
    mkdirSync(projectPath, { recursive: true });
    addThread(ctx, 'thr_folder_gone', join(ctx.env.root, 'gone'), {
      branch: null,
      projectPath,
    });

    const { terminalId } = service.open('thr_folder_gone', 80, 24);
    expect(service.get(terminalId)?.cwd.toLowerCase()).toBe(projectPath.toLowerCase());
    await service.close(terminalId);
  });

  it('rejects a folder thread when the project path is missing too', () => {
    addThread(ctx, 'thr_folder_lost', join(ctx.env.root, 'gone'), { branch: null });
    expect(errorCode(() => service.open('thr_folder_lost', 80, 24))).toBe('conflict');
  });

  it('never drops a worktree thread into the project checkout', () => {
    const projectPath = join(ctx.env.root, 'project-wt-gone');
    mkdirSync(projectPath, { recursive: true });
    addThread(ctx, 'thr_wt_gone', join(ctx.env.root, 'gone-wt'), { projectPath });
    expect(errorCode(() => service.open('thr_wt_gone', 80, 24))).toBe('conflict');
  });

  it('pins TERM and strips the bearer token from the child environment', () => {
    const env = terminalEnv({
      PATH: 'C:\\bin',
      KEEP: 'yes',
      TUFFCODE_TOKEN: 'secret',
      Tuffcode_Token: 'also-secret',
    });
    expect(env.TERM).toBe('xterm-256color');
    expect(env.PATH).toBe('C:\\bin');
    expect(env.KEEP).toBe('yes');
    expect(env.TUFFCODE_TOKEN).toBeUndefined();
    expect(env.Tuffcode_Token).toBeUndefined();
  });

  it('rejects input, resize, and close for an unknown terminal', async () => {
    expect(errorCode(() => service.input('term_missing', 'ls\r'))).toBe('not-found');
    expect(errorCode(() => service.resize('term_missing', 100, 40))).toBe('not-found');
    await expect(service.close('term_missing')).rejects.toMatchObject({ code: 'not-found' });
    expect(service.get('term_missing')).toBeUndefined();
  });

  it.runIf(hasCmd)('honors settings.shell over the fallback order', async () => {
    const worktree = join(ctx.env.root, 'wt-settings');
    mkdirSync(worktree, { recursive: true });
    addThread(ctx, 'thr_settings', worktree);
    ctx.repos.settings.patch({ shell: 'cmd.exe' });

    const { terminalId } = service.open('thr_settings', 80, 24);
    expect(service.get(terminalId)?.shell).toBe('cmd.exe');
    await service.close(terminalId);
    expect(service.get(terminalId)).toBeUndefined();
    expect(service.size).toBe(0);
  });

  it.runIf(process.platform === 'win32')(
    'surfaces an asynchronous spawn failure as a terminal notice',
    async () => {
      const worktree = join(ctx.env.root, 'wt-bad-shell');
      mkdirSync(worktree, { recursive: true });
      addThread(ctx, 'thr_bad_shell', worktree);
      const fake = join(ctx.env.root, 'not-a-shell.txt');
      writeFileSync(fake, 'not executable');
      ctx.repos.settings.patch({ shell: fake });

      const { terminalId } = service.open('thr_bad_shell', 80, 24);
      await waitForToken('shell exited before producing output');
      const notice = events.find((event) => event.data.includes('shell exited'));
      expect(notice?.terminalId).toBe(terminalId);
      expect(notice?.threadId).toBe('thr_bad_shell');
      expect(service.get(terminalId)).toBeUndefined();
    },
    ROUND_TRIP_TIMEOUT_MS,
  );

  async function roundTrip(threadId: string, expectedShell: string): Promise<void> {
    const worktree = join(ctx.env.root, `wt-${threadId}`);
    mkdirSync(worktree, { recursive: true });
    const thread = addThread(ctx, threadId, worktree);

    const { terminalId } = service.open(thread.id, 100, 30);
    const info = service.get(terminalId);
    expect(info?.threadId).toBe(thread.id);
    expect(info?.shell).toBe(expectedShell);
    expect(info?.cwd.toLowerCase()).toBe(worktree.toLowerCase());
    expect(service.size).toBe(1);

    const token = `tuffcode-pty-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    service.input(terminalId, `echo ${token}\r`);
    await waitForToken(token);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.terminalId === terminalId)).toBe(true);
    expect(events.every((event) => event.threadId === thread.id)).toBe(true);

    service.resize(terminalId, 120, 40);
    await service.close(terminalId);
    expect(service.get(terminalId)).toBeUndefined();
    expect(service.size).toBe(0);
  }

  it.skipIf(!hasPwsh)(
    'round-trips a token through pwsh',
    async () => {
      await roundTrip('thr_pwsh', 'pwsh.exe');
    },
    ROUND_TRIP_TIMEOUT_MS,
  );

  it.runIf(!hasPwsh && hasPowershell)(
    'round-trips a token through the resolved fallback shell',
    async () => {
      await roundTrip('thr_fallback', 'powershell.exe');
    },
    ROUND_TRIP_TIMEOUT_MS,
  );
});

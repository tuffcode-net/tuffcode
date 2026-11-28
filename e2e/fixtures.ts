import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockOpenAI, type MockOpenAI } from './mock-openai';
import { connectRpc, type HarnessRpc } from './rpc';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export interface E2EWorkspace {
  root: string;
  home: string;
  localAppData: string;
  appData: string;
  userData: string;
  projectPath: string;
}

function stringEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * A temp home, a temp app-data tree, and a real git repository. The app never sees
 * the developer's profile: TUFFCODE_HOME, LOCALAPPDATA, and TUFFCODE_USER_DATA are
 * redirected. `APPDATA` is redirected too, but Chromium ignores it for `userData`
 * (it uses the shell known-folder API), which is why `TUFFCODE_USER_DATA` exists.
 * USERPROFILE and HOME stay untouched because Electron aborts when they move.
 */
export function createWorkspace(): E2EWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'tuffcode-e2e-'));
  const home = join(root, 'home');
  const localAppData = join(root, 'localappdata');
  const appData = join(root, 'appdata');
  const userData = join(root, 'userdata');
  const projectPath = join(root, 'project');
  for (const dir of [home, localAppData, appData, userData, projectPath]) {
    mkdirSync(dir, { recursive: true });
  }

  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: projectPath, stdio: 'ignore' });
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@example.test']);
  git(['config', 'user.name', 'Tuffcode E2E']);
  writeFileSync(join(projectPath, 'README.md'), '# e2e project\n');
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeFileSync(join(projectPath, 'src', 'index.ts'), 'export const answer = 42;\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit']);

  return { root, home, localAppData, appData, userData, projectPath };
}

export interface AppSession {
  app: ElectronApplication;
  page: Page;
  consoleErrors: string[];
  pageErrors: string[];
  close(): Promise<void>;
  relaunch(): Promise<void>;
}

/**
 * A force-killed Electron can leave its crashpad handler behind. A stale handler
 * makes the next launch abort with 0x80000003, so clear only the handlers that
 * point at this workspace's temp tree. Scoped to one workspace on purpose: a broad
 * `tuffcode-e2e-*` match would kill the handlers of a concurrent suite.
 */
function killOrphanCrashpad(root: string): void {
  if (process.platform !== 'win32') return;
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'crashpad_handler.exe\'" | ' +
    `Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('${root}') -ge 0 } | ` +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {
    // Best effort: a missing handler is the normal case.
  }
}

/**
 * Deletes a workspace root, tolerating the short-lived locks Windows keeps after exit.
 * A pty or crashpad handle can outlive the app by a few hundred milliseconds, so
 * cleanup retries and then leaves the temp tree behind rather than failing a test
 * that already passed. Launch and assertion failures still propagate as before.
 */
async function removeWorkspace(root: string): Promise<void> {
  killOrphanCrashpad(root);
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === attempts) {
        console.warn(`[e2e] leaving temp workspace in place, cleanup failed: ${root}`);
        console.warn(error);
        return;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
  }
}

async function launchOnce(workspace: E2EWorkspace): Promise<{
  app: ElectronApplication;
  page: Page;
  consoleErrors: string[];
  pageErrors: string[];
}> {
  killOrphanCrashpad(workspace.root);
  const app = await electron.launch({
    // Software rendering only: GPU init is flaky on Windows builders and no test
    // asserts pixels. The renderer sandbox stays enabled.
    args: ['--disable-gpu', 'apps/desktop'],
    cwd: repoRoot,
    env: {
      ...stringEnv(process.env),
      TUFFCODE_HOME: workspace.home,
      LOCALAPPDATA: workspace.localAppData,
      APPDATA: workspace.appData,
      TUFFCODE_USER_DATA: workspace.userData,
    },
    timeout: 60_000,
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.waitForLoadState('domcontentloaded');
  // Set a roomy window so the inspector column and pane assertions have space.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) window.setSize(1440, 900);
  });
  await expect(page.getByTestId('app-shell')).toBeVisible();
  return { app, page, consoleErrors, pageErrors };
}

export async function launchApp(workspace: E2EWorkspace): Promise<AppSession> {
  const first = await launchOnce(workspace);
  const session: AppSession = {
    app: first.app,
    page: first.page,
    consoleErrors: first.consoleErrors,
    pageErrors: first.pageErrors,
    close: async () => {
      await session.app.close();
    },
    relaunch: async () => {
      await session.app.close();
      const next = await launchOnce(workspace);
      session.app = next.app;
      session.page = next.page;
      session.consoleErrors.length = 0;
      session.pageErrors.length = 0;
      session.consoleErrors.push(...next.consoleErrors);
      session.pageErrors.push(...next.pageErrors);
    },
  };
  return session;
}

/**
 * Replaces the native folder picker with a fixed answer. The Add project flow calls
 * the real IPC handler and dialog module, only the OS dialog itself is stubbed.
 */
export async function stubFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(async ({ dialog }, target) => {
    Object.assign(dialog, {
      showOpenDialog: async () => ({ canceled: false, filePaths: [target] }),
    });
  }, folder);
}

export interface Fixtures {
  workspace: E2EWorkspace;
  mock: MockOpenAI;
  session: AppSession;
  rpc: HarnessRpc;
}

export const test = base.extend<Fixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixtures require destructuring.
  workspace: async ({}, use) => {
    const workspace = createWorkspace();
    await use(workspace);
    await removeWorkspace(workspace.root);
  },
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixtures require destructuring.
  mock: async ({}, use) => {
    const mock = await startMockOpenAI();
    await use(mock);
    await mock.close();
  },
  session: async ({ workspace }, use) => {
    const session = await launchApp(workspace);
    await use(session);
    await session.close().catch(() => undefined);
  },
  rpc: async ({ workspace }, use) => {
    const rpc = await connectRpc(workspace.home);
    await use(rpc);
    rpc.close();
  },
});

export { expect };

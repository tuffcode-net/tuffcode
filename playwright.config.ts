import { execFileSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

/**
 * Electron E2E: one worker because every test owns a real app instance, a temp
 * home/userData, and a local mock provider. The suite never reaches the network.
 * Each workspace is deleted on teardown, and TUFFCODE_USER_DATA gives every run its
 * own Electron single-instance lock, so two suites can run concurrently in separate
 * worktrees without either app instance quitting.
 *
 * The mobile projects drive a served browser build instead: the mobile server serves
 * `apps/web/dist` on `remote.port` (4310 by default) and a phone opens
 * `http://<bindHost>:4310`. TUFFCODE_MOBILE_URL overrides that address for a LAN or
 * Tailscale run.
 */
/** A free port, so two runs and a running desktop never collide on 4310. */
function freePort(): number {
  const script =
    'const s=require("node:net").createServer();' +
    's.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})';
  return Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
}

const mobilePort = Number(process.env['TUFFCODE_MOBILE_PORT'] ?? freePort());
const mobileBaseUrl = process.env['TUFFCODE_MOBILE_URL'] ?? 'http://127.0.0.1:' + mobilePort;

/**
 * A run that names only mobile.spec.ts drives a served build, so it must not pay for the
 * Electron build in global setup. Every other invocation (the full suite, a single
 * Electron spec, a --project filter) still builds first, because those tests launch the
 * packaged app.
 */
const specArguments = process.argv.slice(2).filter((argument) => argument.endsWith('.spec.ts'));
const mobileOnlyRun =
  specArguments.length > 0 && specArguments.every((argument) => argument.includes('mobile.spec'));

export default defineConfig({
  testDir: './e2e',
  ...(mobileOnlyRun ? {} : { globalSetup: './e2e/global-setup.ts' }),
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  timeout: 120_000,
  // Every test drives a real Electron app on a shared machine, so a hover transition
  // or a pane remount can miss a 15s window while another build saturates the CPU.
  // The budget is global on purpose: no per-assertion weakening and no retries.
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/mobile-test-server.mjs',
    url: 'http://127.0.0.1:' + mobilePort + '/health',
    env: { ...process.env, TUFFCODE_MOBILE_PORT: String(mobilePort) },
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'electron',
      testIgnore: /mobile\.spec\.ts$/,
    },
    {
      name: 'pixel-7',
      testMatch: /mobile\.spec\.ts$/,
      use: { ...devices['Pixel 7'], baseURL: mobileBaseUrl },
    },
    {
      name: 'iphone-13',
      testMatch: /mobile\.spec\.ts$/,
      use: { ...devices['iPhone 13'], baseURL: mobileBaseUrl },
    },
  ],
});

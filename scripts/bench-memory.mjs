#!/usr/bin/env node
/**
 * Memory, bundle and startup benchmark for issue #30.
 *
 * Samples the working set of every running Tuffcode process (main, server utility,
 * renderer, GPU, crashpad), the renderer chunks that load on boot, the server bundle
 * size, and, when a packaged executable is passed, the time from process start to
 * `/health` returning ok.
 *
 * Usage:
 *   node scripts/bench-memory.mjs                     sample the running app and dist chunks
 *   node scripts/bench-memory.mjs --idle 60           wait 60 s before sampling (default 60)
 *   node scripts/bench-memory.mjs --json              machine-readable output
 *   node scripts/bench-memory.mjs --exe <Tuffcode.exe>
 *                                                     launch a packaged build four times in a
 *                                                     fresh temp profile: one first launch,
 *                                                     three warm starts, then idle sampling
 *   node scripts/bench-memory.mjs --exe <exe> --runs 4 --idle 60
 *   node scripts/bench-memory.mjs --exe <exe> --keep-profile   keep the temp profile
 *
 * A dev build can be sampled too, but only a packaged install has a meaningful first
 * launch number. Without `--exe` the app has to be running already; start it with a
 * fresh TUFFCODE_HOME, TUFFCODE_USER_DATA, LOCALAPPDATA and APPDATA so the numbers are
 * not inflated by a profile with years of history. With `--exe` the script creates that
 * profile itself under the system temp directory and only ever stops the processes it
 * launched from that executable's directory.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const idleSeconds = Number(option('--idle', '60'));
const exe = option('--exe', null);
const exePath = exe === null ? null : resolve(exe);
const installDir = exePath === null ? null : dirname(exePath);
const runs = Number(option('--runs', exePath === null ? '0' : '4'));
const keepProfile = args.includes('--keep-profile');

/** Processes whose name is the packaged app, the dev app or the bundled server. */
const NAME_PATTERN = /tuffcode/i;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Splits an Electron command line into the role it plays in the tree. */
function roleOf(command) {
  if (command.includes('--type=renderer')) return 'renderer';
  if (command.includes('--type=gpu-process')) return 'gpu';
  if (command.includes('network.mojom.NetworkService')) return 'network';
  if (command.includes('--type=utility')) return 'server';
  if (command.includes('--type=crashpad-handler')) return 'crashpad';
  return 'main';
}

function sampleWindows() {
  // A packaged tree is every process whose image lives in the install directory, which
  // includes crashpad_handler.exe; a dev tree has no single directory, so it is matched
  // by name plus the crashpad handler that points at a Tuffcode path.
  const script =
    exePath === null
      ? [
          "$ErrorActionPreference = 'SilentlyContinue'",
          'Get-CimInstance Win32_Process |',
          "  Where-Object { ($_.Name -match 'tuffcode') -or ($_.Name -eq 'crashpad_handler.exe' -and $_.ExecutablePath -match 'tuffcode') } |",
          '  Select-Object ProcessId, Name, WorkingSetSize, CommandLine | ConvertTo-Json -Compress',
        ].join('\n')
      : [
          "$ErrorActionPreference = 'SilentlyContinue'",
          `$dir = '${installDir.replaceAll("'", "''")}'`,
          'Get-CimInstance Win32_Process |',
          '  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir) } |',
          '  Select-Object ProcessId, Name, WorkingSetSize, CommandLine | ConvertTo-Json -Compress',
        ].join('\n');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }).trim();
  if (output === '') return [];
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: row.ProcessId,
    name: row.Name,
    role: roleOf(row.CommandLine ?? ''),
    workingSetMb: Math.round((row.WorkingSetSize / (1024 * 1024)) * 10) / 10,
  }));
}

function samplePosix() {
  const output = execFileSync('ps', ['-axo', 'pid=,rss=,comm='], { encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/, 3))
    .filter(([pid, rss, command]) => {
      if (!pid || !rss || !command) return false;
      return exePath === null ? NAME_PATTERN.test(command) : command.startsWith(installDir);
    })
    .map(([pid, rss, command]) => ({
      pid: Number(pid),
      name: command.split('/').pop() ?? command,
      role: roleOf(command),
      workingSetMb: Math.round((Number(rss) / 1024) * 10) / 10,
    }));
}

const sample = process.platform === 'win32' ? sampleWindows : samplePosix;

/** Chunks that the browser fetches before the first paint: the entry script plus modulepreload. */
function initialChunks() {
  const dist = join(root, 'apps', 'web', 'dist');
  const htmlPath = join(dist, 'index.html');
  if (!existsSync(htmlPath)) return [];
  const html = readFileSync(htmlPath, 'utf8');
  const files = new Set();
  for (const match of html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g)) {
    files.add(match[1]);
  }
  return [...files]
    .map((file) => {
      const path = join(dist, 'assets', file);
      return {
        file,
        kb: existsSync(path) ? Math.round((statSync(path).size / 1024) * 10) / 10 : 0,
      };
    })
    .toSorted((a, b) => b.kb - a.kb);
}

function chunkSizes() {
  const assets = join(root, 'apps', 'web', 'dist', 'assets');
  if (!existsSync(assets)) return [];
  return readdirSync(assets)
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({
      file,
      kb: Math.round((statSync(join(assets, file)).size / 1024) * 10) / 10,
    }))
    .toSorted((a, b) => b.kb - a.kb);
}

function serverBundleSize() {
  const bundle = join(root, 'packages', 'server', 'dist', 'server.js');
  if (!existsSync(bundle)) return null;
  return Math.round((statSync(bundle).size / (1024 * 1024)) * 100) / 100;
}

/** Waits until the server the app spawned answers /health, and returns the elapsed ms. */
async function waitForHealth(home, deadlineMs, since) {
  const serverJson = join(home, 'server.json');
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (existsSync(serverJson)) {
      try {
        const info = JSON.parse(readFileSync(serverJson, 'utf8'));
        // A server.json left by an earlier launch must not answer for this one.
        if (typeof info.startedAt === 'number' && info.startedAt >= since - 5000) {
          const response = await fetch(`http://127.0.0.1:${String(info.port)}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) return Date.now() - started;
        }
      } catch {
        // server.json is written before the socket accepts connections: keep polling
      }
    }
    await sleep(10);
  }
  throw new Error('bench-memory: the server did not answer /health within 120 s');
}

/**
 * Waits until the app's main process is gone, so the next launch takes the single
 * instance lock instead of quitting. A crashpad handler can outlive the app by a
 * moment and does not hold the lock, so only the main process is waited for.
 */
async function waitForExit(pid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await sleep(250);
  }
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // already gone
  }
}

/** Creates the redirected profile a launch uses, so no number depends on an old home. */
function createProfile() {
  const base = mkdtempSync(join(tmpdir(), 'tuffcode-bench-'));
  const profile = {
    root: base,
    home: join(base, 'home'),
    localAppData: join(base, 'localappdata'),
    appData: join(base, 'appdata'),
    userData: join(base, 'userdata'),
  };
  for (const dir of [profile.home, profile.localAppData, profile.appData, profile.userData]) {
    mkdirSync(dir, { recursive: true });
  }
  return profile;
}

async function launchAndTime(profile) {
  const child = spawn(exePath, [], {
    env: {
      ...process.env,
      TUFFCODE_HOME: profile.home,
      TUFFCODE_USER_DATA: profile.userData,
      LOCALAPPDATA: profile.localAppData,
      APPDATA: profile.appData,
    },
    stdio: 'ignore',
  });
  try {
    const ms = await waitForHealth(profile.home, 120_000, Date.now());
    return { child, ms };
  } catch (error) {
    stop(child);
    throw error;
  }
}

const startRuns = [];
let idleProcesses = [];
let keptChild = null;
let profile = null;

if (exePath !== null) {
  if (!existsSync(exePath)) {
    console.error(`bench-memory: no executable at ${exePath}`);
    process.exit(1);
  }
  profile = createProfile();
  for (let run = 1; run <= runs; run += 1) {
    const launched = await launchAndTime(profile);
    startRuns.push(launched.ms);
    // Let the window finish its first paint before the process set is sampled.
    await sleep(4000);
    if (run === runs) {
      keptChild = launched.child;
      await sleep(idleSeconds * 1000);
      idleProcesses = sample();
    } else {
      stop(launched.child);
      await waitForExit(launched.child.pid);
    }
  }
}

if (keptChild === null) {
  const before = sample();
  if (before.length === 0) {
    console.error('bench-memory: no Tuffcode process is running. Start the app first.');
    process.exit(1);
  }
  await sleep(idleSeconds * 1000);
  idleProcesses = sample();
}

const totalMb =
  Math.round(idleProcesses.reduce((sum, row) => sum + row.workingSetMb, 0) * 10) / 10;
const chunks = chunkSizes();
const initial = initialChunks();
const largest = initial[0] ?? chunks[0];
const firstLaunchMs = startRuns[0] ?? null;
const warmRunsMs = startRuns.slice(1);
const warmSorted = warmRunsMs.toSorted((a, b) => a - b);
const warmMedianMs =
  warmSorted.length === 0 ? null : warmSorted[Math.floor(warmSorted.length / 2)];

const report = {
  idleSeconds,
  processCount: idleProcesses.length,
  totalWorkingSetMb: totalMb,
  processes: idleProcesses,
  firstLaunchMs,
  warmRunsMs,
  warmMedianMs,
  profileRoot: profile !== null && keepProfile ? profile.root : null,
  largestChunkKb: largest?.kb ?? 0,
  largestChunk: largest?.file ?? '',
  initialPayloadKb: Math.round(initial.reduce((sum, chunk) => sum + chunk.kb, 0) * 10) / 10,
  initialChunks: initial,
  chunkCount: chunks.length,
  serverBundleMb: serverBundleSize(),
  chunks: chunks.slice(0, 15),
};

if (keptChild !== null) stop(keptChild);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Idle after ${String(idleSeconds)}s, ${String(idleProcesses.length)} processes`);
  for (const row of report.processes) {
    console.log(
      `  ${String(row.pid).padStart(7)}  ${String(row.workingSetMb).padStart(8)} MB  ${row.role.padEnd(9)} ${row.name}`,
    );
  }
  console.log(
    `  total${' '.repeat(12)}${String(totalMb).padStart(8)} MB  budget 450 MB (stretch 400)`,
  );
  if (firstLaunchMs !== null) {
    console.log('');
    console.log(`First launch: ${String(firstLaunchMs)} ms (budget 2800 ms)`);
    console.log(
      `Warm starts: ${warmRunsMs.map(String).join(', ')} ms, median ${String(warmMedianMs)} ms (budget 400 ms)`,
    );
    if (profile !== null && keepProfile) console.log(`Profile: ${profile.root}`);
  }
  console.log('');
  console.log(
    `Renderer chunks: ${String(report.chunkCount)}, largest initial ${String(report.largestChunkKb)} kB (${report.largestChunk})`,
  );
  console.log(
    `  initial payload ${String(report.initialPayloadKb)} kB across ${String(initial.length)} chunks, budget 1500 kB for the largest`,
  );
  for (const chunk of initial) {
    console.log(`  ${String(chunk.kb).padStart(8)} kB  ${chunk.file}`);
  }
  console.log('');
  for (const chunk of chunks.slice(0, 8)) {
    if (initial.some((entry) => entry.file === chunk.file)) continue;
    console.log(`  ${String(chunk.kb).padStart(8)} kB  ${chunk.file} (lazy)`);
  }
  if (report.serverBundleMb !== null) {
    console.log('');
    console.log(`Server bundle: ${String(report.serverBundleMb)} MB`);
  }
}

// The temp profile is throwaway; keep it only when the caller asked to inspect it.
// Windows can hold a Chromium cache file for a moment after exit, so a failed
// cleanup is reported and left behind rather than failing a measurement that ran.
if (profile !== null && !keepProfile) {
  // Chromium releases its cache handles a moment after the process list empties.
  await sleep(2000);
  try {
    rmSync(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(
      `bench-memory: left the temp profile at ${profile.root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

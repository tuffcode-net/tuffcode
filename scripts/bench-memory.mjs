#!/usr/bin/env node
/**
 * Memory and bundle benchmark for issue #30.
 *
 * Sums the working set of every running Tuffcode process (main, server utility, renderer,
 * GPU, crashpad) and lists the renderer chunks by size, so a release can be compared with
 * the previous one instead of arguing from a single Activity Monitor screenshot.
 *
 * Usage:
 *   node scripts/bench-memory.mjs                 measure running processes and dist chunks
 *   node scripts/bench-memory.mjs --idle 60       wait 60 seconds before sampling (default 60)
 *   node scripts/bench-memory.mjs --json          machine-readable output
 *
 * A packaged or dev app has to be running already. Start it with a fresh TUFFCODE_HOME,
 * TUFFCODE_USER_DATA, LOCALAPPDATA and APPDATA so the numbers are not inflated by a
 * profile with years of history.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const json = args.includes('--json');
const idleIndex = args.indexOf('--idle');
const idleSeconds = idleIndex === -1 ? 60 : Number(args[idleIndex + 1] ?? 60);

/** Processes whose name is the packaged app, the dev app or the bundled server. */
const NAME_PATTERN = /tuffcode/i;

function sampleWindows() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Get-Process | Where-Object { $_.ProcessName -match "tuffcode" } |',
    '  Select-Object Id, ProcessName, WorkingSet64, @{n="MainModule";e={$_.MainModule.FileName}} |',
    '  ConvertTo-Json -Compress',
  ].join(' ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }).trim();
  if (output === '') return [];
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: row.Id,
    name: row.ProcessName,
    workingSetMb: Math.round((row.WorkingSet64 / (1024 * 1024)) * 10) / 10,
    path: row.MainModule ?? '',
  }));
}

function samplePosix() {
  const output = execFileSync('ps', ['-axo', 'pid=,rss=,comm='], { encoding: 'utf8' });
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/, 3))
    .filter(([pid, rss, command]) => pid && rss && command && NAME_PATTERN.test(command))
    .map(([pid, rss, command]) => ({
      pid: Number(pid),
      name: command.split('/').pop() ?? command,
      workingSetMb: Math.round((Number(rss) / 1024) * 10) / 10,
      path: command,
    }));
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
  const bundle = join(root, 'apps', 'desktop', 'out', 'server', 'server.js');
  if (!existsSync(bundle)) return null;
  return Math.round((statSync(bundle).size / (1024 * 1024)) * 100) / 100;
}

function sleep(seconds) {
  return new Promise((done) => setTimeout(done, seconds * 1000));
}

const processes = process.platform === 'win32' ? sampleWindows : samplePosix;
const before = processes();
if (before.length === 0) {
  console.error('bench-memory: no Tuffcode process is running. Start the app first.');
  process.exit(1);
}

await sleep(idleSeconds);

const after = processes();
const totalMb = Math.round(after.reduce((sum, row) => sum + row.workingSetMb, 0) * 10) / 10;
const chunks = chunkSizes();
const initial = chunks.filter((chunk) => /^index-/.test(chunk.file)).slice(0, 1);
const largest = initial[0] ?? chunks[0];

const report = {
  idleSeconds,
  processCount: after.length,
  totalWorkingSetMb: totalMb,
  processes: after,
  largestChunkKb: largest?.kb ?? 0,
  largestChunk: largest?.file ?? '',
  chunkCount: chunks.length,
  serverBundleMb: serverBundleSize(),
  chunks: chunks.slice(0, 15),
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Idle after ${String(idleSeconds)}s, ${String(after.length)} processes`);
  for (const row of report.processes) {
    console.log(`  ${String(row.pid).padStart(7)}  ${String(row.workingSetMb).padStart(8)} MB  ${row.name}`);
  }
  console.log(`  total${' '.repeat(12)}${String(totalMb).padStart(8)} MB  budget 450 MB (stretch 400)`);
  console.log('');
  console.log(`Renderer chunks: ${String(report.chunkCount)}, largest ${String(report.largestChunkKb)} kB (${report.largestChunk})`);
  console.log('  budget 1500 kB for the largest initial chunk');
  for (const chunk of report.chunks.slice(0, 8)) {
    console.log(`  ${String(chunk.kb).padStart(8)} kB  ${chunk.file}`);
  }
  if (report.serverBundleMb !== null) {
    console.log('');
    console.log(`Server bundle: ${String(report.serverBundleMb)} MB`);
  }
}

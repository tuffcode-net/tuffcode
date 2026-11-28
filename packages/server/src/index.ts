import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isShutdownMessage } from './ipc.js';
import { installProcessGuards } from './process-guards.js';
import { startServer } from './server.js';
import type { SecretPort } from './secrets/bridge.js';

export * from './db/index.js';
export * from './db/repos/index.js';
export * from './errors.js';
export * from './auth.js';
export * from './events.js';
export * from './http.js';
export * from './ws.js';
export * from './rpc.js';
export * from './projects.js';
export * from './threads.js';
export * from './git/index.js';
export * from './adapters/factory.js';
export * from './adapters/resolveCommand.js';
export * from './brain/service.js';
export * from './diagnostics.js';
export * from './providers/config.js';
export * from './providers/service.js';
export * from './providers/rpc.js';
export * from './runner/runner.js';
export * from './runner/rpc.js';
export * from './subagents/service.js';
export * from './subagents/rpc.js';
export * from './subagents/types.js';
export * from './secrets/bridge.js';
export * from './server.js';

/**
 * Electron's utilityProcess adds `parentPort` to the child process; Node's own types
 * do not declare it, so the value is checked at the boundary before use.
 */
function getParentPort(): SecretPort | undefined {
  const electronProcess = process as unknown as { parentPort?: unknown };
  const candidate = electronProcess.parentPort;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  if (!('postMessage' in candidate) || typeof candidate.postMessage !== 'function') {
    return undefined;
  }
  if (!('on' in candidate) || typeof candidate.on !== 'function') return undefined;
  return candidate as SecretPort;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  installProcessGuards();
  const parentPort = getParentPort();
  const running = await startServer(parentPort === undefined ? {} : { parentPort });
  // Electron's MessagePort has no targetOrigin; the lint rule targets window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort?.postMessage({ type: 'ready', port: running.port });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };

  parentPort?.on('message', (message) => {
    if (isShutdownMessage(message)) void shutdown();
  });
  process.on('message', (message) => {
    if (isShutdownMessage(message)) void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

if (isEntryPoint()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tuffcode server failed: ${message}\n`);
    process.exit(1);
  });
}

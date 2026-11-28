import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Playwright webServer for the mobile projects. It serves the built web app from a
 * real server with remote access on, seeds a project, a mock provider and a thread,
 * and writes the bearer token and ports to a state file so the spec can pair.
 */
const root = resolve(import.meta.dirname, '..');
const webRoot = join(root, 'apps', 'web', 'dist');
const serverEntry = join(root, 'packages', 'server', 'dist', 'server.js');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const port = Number(process.env.TUFFCODE_MOBILE_PORT ?? '4310');
const bindHost = process.env.TUFFCODE_MOBILE_BIND ?? '127.0.0.1';
const publicUrl = process.env.TUFFCODE_MOBILE_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const allowInsecureLan = process.env.TUFFCODE_MOBILE_INSECURE === '1';
const statePath = join(tmpdir(), 'tuffcode-mobile-e2e.json');

const MOCK_MODEL = 'mock-model';
const FAST_TEXT = 'Hello from the mock provider.';
const SLOW_WORD = 'SLOW';

if (!existsSync(serverEntry)) {
  execFileSync(pnpm, ['build:server'], { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(webRoot, 'index.html'))) {
  execFileSync(pnpm, ['--filter', '@tuffcode/web', 'build'], { cwd: root, stdio: 'inherit' });
}

/** Streams one chat completion. Slow spreads the text so a stop can land mid-turn. */
function streamCompletion(res, slow) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const text = slow
    ? 'Counting: ' + Array.from({ length: 40 }, (_, i) => String(i)).join(' ')
    : FAST_TEXT;
  const chunks = [];
  for (let at = 0; at < text.length; at += 6) chunks.push(text.slice(at, at + 6));
  let index = 0;
  const timer = setInterval(() => {
    if (index === chunks.length) {
      res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
      res.end();
      clearInterval(timer);
      return;
    }
    const delta = { choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }] };
    res.write("data: " + JSON.stringify(delta) + "\n\n");
    index += 1;
  }, slow ? 120 : 10);
  res.on("close", () => clearInterval(timer));
}
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => streamCompletion(res, body.includes(SLOW_WORD)));
});
await new Promise((ready) => mock.listen(0, "127.0.0.1", ready));
const mockPort = mock.address().port;
const home = mkdtempSync(join(tmpdir(), "tuffcode-mobile-e2e-"));
process.env.TUFFCODE_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
const projectPath = join(home, "project");
mkdirSync(projectPath, { recursive: true });
writeFileSync(join(projectPath, "README.md"), "# e2e project\n");
const git = (args) => execFileSync("git", args, { cwd: projectPath, stdio: "ignore" });
git(["init"]);
git(["add", "."]);
git(["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-m", "init"]);
const { startServer } = await import(pathToFileURL(serverEntry).href);
const running = await startServer({
  version: "0.0.0-e2e",
  dbFile: join(home, "tuffcode.db"),
  writeServerJson: false,
  webRoot,
  remoteOverrides: { enabled: true, bindHost, port, publicUrl, allowedOrigins: [], allowInsecureLan },
});
const call = async (method, params) => {
  const handler = running.handlers.get(method);
  if (handler === undefined) throw new Error("missing handler " + method);
  return handler(params);
};
const provider = await call("providers.upsert", {
  kind: "openai-compatible",
  label: "Mock provider",
  config: { baseUrl: "http://127.0.0.1:" + mockPort + "/v1", models: [{ id: MOCK_MODEL, label: MOCK_MODEL, contextWindow: 16000, maxOutputTokens: 1024, isDefault: true }] },
});
const project = await call("projects.add", { path: projectPath });
const thread = await call("threads.create", {
  projectId: project.id,
  title: "Remote chat",
  providerId: provider.id,
  modelId: MOCK_MODEL,
  executionMode: "work",
  permissionMode: "ask",
  workspace: "folder",
});
writeFileSync(statePath, JSON.stringify({
  token: running.token,
  port: running.port,
  remotePort: running.remotePort,
  projectId: project.id,
  threadId: thread.id,
  baseUrl: publicUrl,
}), "utf8");
console.log("MOBILE_READY " + port);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  mock.close();
  await running.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

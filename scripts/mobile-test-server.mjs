import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
const SLOW_TEXT = 'Counting: ' + Array.from({ length: 40 }, (_, i) => String(i)).join(' ');
/** Markers the spec sends to make the mock fail or ask for a denied tool. */
const FAIL_WORD = 'FAIL-TURN';
const TOOL_WORD = 'run-bash';
const DENIED_TEXT = 'The command was denied.';
const ALLOWED_TEXT = 'The command ran successfully.';
const CODE_WORD = 'show-code';
const CODE_TEXT = 'Here is the constant:\n\n```ts\nconst answer = 42;\n```\n';

if (!existsSync(serverEntry)) {
  execFileSync(pnpm, ['build:server'], { cwd: root, stdio: 'inherit' });
}
if (!existsSync(join(webRoot, 'index.html'))) {
  execFileSync(pnpm, ['--filter', '@tuffcode/web', 'build'], { cwd: root, stdio: 'inherit' });
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

/** Streams one chat completion. Slow spreads the text so a stop can land mid-turn. */
function streamCompletion(res, text, intervalMs) {
  sseHead(res);
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
  }, intervalMs);
  res.on("close", () => clearInterval(timer));
}

/** One assistant message carrying a single tool call, the shape the adapter parses. */
function streamToolCall(res, id, name, args) {
  sseHead(res);
  res.write(
    "data: " + JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    }) + "\n\n",
  );
  res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "\n\n");
  res.end();
}

function mockMessages(body) {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

/**
 * Only the newest user message drives the reply. Every earlier message is still in the
 * body, so searching the whole body would make one test's marker fire on every later
 * turn in the same thread.
 */
function lastUserContent(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return typeof message.content === 'string' ? message.content : '';
  }
  return '';
}

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const messages = mockMessages(body);
    const last = messages[messages.length - 1];
    const lastRole = typeof last?.role === 'string' ? last.role : '';
    if (lastRole === 'tool') {
      const output = typeof last.content === 'string' ? last.content : '';
      streamCompletion(res, output.includes('denied') ? DENIED_TEXT : ALLOWED_TEXT, 10);
      return;
    }
    const prompt = lastUserContent(messages);
    if (prompt.includes(FAIL_WORD)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock provider failure' } }));
      return;
    }
    if (prompt.includes(TOOL_WORD)) {
      streamToolCall(res, 'call_mobile_bash', 'bash', { command: 'echo tuffcode-ok' });
      return;
    }
    if (prompt.includes(CODE_WORD)) {
      streamCompletion(res, CODE_TEXT, 10);
      return;
    }
    const slow = prompt.includes(SLOW_WORD);
    streamCompletion(res, slow ? SLOW_TEXT : FAST_TEXT, slow ? 120 : 10);
  });
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
const { hashSecret, startServer } = await import(pathToFileURL(serverEntry).href);
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
// One seeded session so the turn proofs do not each spend a pairing code: the claim
// endpoint is limited to ten a minute per address, and the suite pairs real devices
// in the drive, two-device and disable tests. The drive test still claims its own.
const seededToken = randomBytes(32).toString("hex");
const seededAt = new Date();
running.repos.remoteSessions.create({
  id: "ses_seeded_phone",
  tokenHash: hashSecret(seededToken),
  deviceName: "Seeded phone",
  createdAt: seededAt.toISOString(),
  expiresAt: new Date(seededAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
});
writeFileSync(statePath, JSON.stringify({
  token: running.token,
  port: running.port,
  remotePort: running.remotePort,
  projectId: project.id,
  threadId: thread.id,
  baseUrl: publicUrl,
  session: seededToken,
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

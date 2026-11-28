import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal OpenAI-compatible endpoint for the E2E suite. It streams SSE chunks and
 * answers with tool calls so the real `openai-compatible` adapter runs end to end.
 * Everything stays on 127.0.0.1.
 */

export const MOCK_MODEL_ID = 'mock-model';
export const MOCK_TEXT = 'Hello from the mock provider.';
export const MOCK_DENIED_TEXT = 'The command was denied.';
export const MOCK_ALLOWED_TEXT = 'The command ran successfully.';
export const MOCK_WROTE_TEXT = 'Wrote the file.';
export const MOCK_FILE_PATH = 'e2e-added.txt';
export const MOCK_FILE_CONTENT = 'added by the mock provider';
export const MOCK_THINKING = 'The project is small, so a quick scan is enough.';
export const MOCK_PROSE = 'I will inspect the project before editing it.';
export const MOCK_TIMELINE_FINAL = 'The project looks healthy and ready for changes.';
export const MOCK_TIMELINE_FILE = 'timeline-added.txt';
export const MOCK_TIMELINE_FILE_CONTENT = 'alpha\nbeta';
export const MOCK_SUBAGENT_TASK = 'map the project structure';
export const MOCK_SUBAGENT_FINAL = 'Spawned an explorer to map the project.';
/** The held marker lets a spec read the strip while this child is still running. */
export const MOCK_SUBAGENT_HOLD = 'subagent-hold';
/** Task markers that drive one child into a terminal state the proof spec reads. */
export const MOCK_SUBAGENT_CANCEL = 'subagent-cancel';
export const MOCK_SUBAGENT_FAIL = 'subagent-fail';
export const MOCK_SUBAGENT_CUT = 'subagent-cut';
export const MOCK_SUBAGENT_TRIO_TASKS = {
  explorer: 'map the project structure ' + MOCK_SUBAGENT_CANCEL,
  worker: 'implement the change ' + MOCK_SUBAGENT_FAIL,
  reviewer: 'review the change ' + MOCK_SUBAGENT_CUT,
};
export const MOCK_SUBAGENT_TWO_TASK = 'review the project ' + MOCK_SUBAGENT_HOLD;
const MOCK_SUBAGENT_HOLD_MS = 4000;
/** The planner answer: two tasks, disjoint files, one dependency edge. */
export const MOCK_COUNCIL_PLAN = {
  tasks: [
    {
      title: 'Document the answer',
      files: ['docs/answer.md'],
      dependsOn: [],
      critical: false,
      brief: 'Write docs/answer.md for the answer constant. Verify with node -e "console.log(1)".',
    },
    {
      title: 'Export the answer',
      files: ['src/index.ts'],
      dependsOn: ['Document the answer'],
      critical: false,
      brief: 'Re-export the answer from src/index.ts. Verify with node -e "console.log(1)".',
    },
  ],
  question: null,
};

/**
 * The council planner prompt carries this role line plus an uppercase BASE BRANCH
 * block. The subagent planner shares the role line but gets no BASE BRANCH block, and
 * no worker or reviewer prompt carries either.
 */
const PLANNER_MARKER = 'ROLE: Turn one goal into the smallest set of tasks';
const PLANNER_BASE_MARKER = '\nBASE BRANCH\n';
export const MOCK_ACTIVITY_COMMAND = 'node -e "console.log(\'activity-ok\')"';
export const MOCK_ACTIVITY_FINAL = 'The activity command printed its line.';
export const MOCK_INTERLEAVE_REASONING_ONE = 'First I check the readme.';
export const MOCK_INTERLEAVE_PROSE_ONE = 'Reading the readme before the source.';
export const MOCK_INTERLEAVE_REASONING_TWO = 'Now I check the source file.';
export const MOCK_INTERLEAVE_PROSE_TWO = 'Reading the source after the readme.';
export const MOCK_INTERLEAVE_FINAL = 'Both files were read in event order.';
export const MOCK_TODO_ITEMS = ['Read the project', 'Write the change', 'Run the tests'];
export const MOCK_TODO_FINAL = 'The plan is tracked in the todo list.';

const LF = String.fromCharCode(10);
const DONE = String.fromCharCode(91, 68, 79, 78, 69, 93);
const CHUNK_DELAY_MS = 15;

export interface MockOpenAI {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: number;
  /** The last user prompt of every chat request, in arrival order. */
  readonly prompts: readonly string[];
  /** Every parsed chat body, so a test can assert images and tools on the wire. */
  readonly bodies: readonly Record<string, unknown>[];
  close(): Promise<void>;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

interface ChatRequest {
  messages?: unknown;
}

function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('mock server did not bind a port'));
      return;
    }
    resolve((address as AddressInfo).port);
  });
  return promise;
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write('data: ' + JSON.stringify(payload) + LF + LF);
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): unknown {
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: MOCK_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function usageChunk(): unknown {
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: MOCK_MODEL_ID,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function streamText(response: ServerResponse, text: string): Promise<void> {
  const words = text.split(' ');
  for (let index = 0; index < words.length; index += 1) {
    const suffix = index === words.length - 1 ? '' : ' ';
    writeSse(response, chunk({ content: (words[index] ?? '') + suffix }, null));
    await delay(CHUNK_DELAY_MS);
  }
  writeSse(response, chunk({}, 'stop'));
  writeSse(response, usageChunk());
  response.write('data: ' + DONE + LF + LF);
}

function streamToolCall(
  response: ServerResponse,
  id: string,
  name: string,
  args: Record<string, unknown>,
): void {
  writeSse(
    response,
    chunk(
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      null,
    ),
  );
  writeSse(response, chunk({}, 'tool_calls'));
  writeSse(response, usageChunk());
  response.write('data: ' + DONE + LF + LF);
}

interface MockToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

async function streamReasoning(response: ServerResponse, text: string): Promise<void> {
  const words = text.split(' ');
  for (let index = 0; index < words.length; index += 1) {
    const suffix = index === words.length - 1 ? '' : ' ';
    writeSse(response, chunk({ reasoning_content: (words[index] ?? '') + suffix }, null));
    await delay(CHUNK_DELAY_MS);
  }
}

async function streamContent(response: ServerResponse, text: string): Promise<void> {
  const words = text.split(' ');
  for (let index = 0; index < words.length; index += 1) {
    const suffix = index === words.length - 1 ? '' : ' ';
    writeSse(response, chunk({ content: (words[index] ?? '') + suffix }, null));
    await delay(CHUNK_DELAY_MS);
  }
}

/** One assistant message with several calls, so a turn has a real tool group. */
function finishWithToolCalls(response: ServerResponse, calls: MockToolCall[]): void {
  writeSse(
    response,
    chunk(
      {
        role: 'assistant',
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
      null,
    ),
  );
  writeSse(response, chunk({}, 'tool_calls'));
  writeSse(response, usageChunk());
  response.write('data: ' + DONE + LF + LF);
}

function messagesOf(body: ChatRequest): ChatMessage[] {
  return Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
}

function contentOf(message: ChatMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

function lastRole(messages: ChatMessage[], role: string): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) return contentOf(message);
  }
  return '';
}

async function handleChat(
  request: IncomingMessage,
  response: ServerResponse,
  recordPrompt: (prompt: string) => void,
  recordBody: (body: Record<string, unknown>) => void,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const part of request) {
    chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  }
  let body: ChatRequest = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest;
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
    return;
  }

  const messages = messagesOf(body);
  const prompt = lastRole(messages, 'user');
  recordPrompt(prompt);
  recordBody(body as Record<string, unknown>);

  // A child whose provider call fails answers before any SSE headers go out.
  if (prompt.includes(MOCK_SUBAGENT_FAIL)) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'mock provider failure' } }));
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // A child that must stay running until the spec cancels it.
  if (prompt.includes(MOCK_SUBAGENT_CANCEL)) {
    await delay(60_000);
    await streamText(response, MOCK_TEXT);
    response.end();
    return;
  }
  // A reply cut off mid-stream: one partial SSE frame, then the socket closes.
  if (prompt.includes(MOCK_SUBAGENT_CUT)) {
    response.write('data: {"choices":[{"delta":{"content":"half an ans');
    response.end();
    return;
  }
  // Council mode asks its planner for one JSON object; the plan is the whole answer.
  if (prompt.includes(PLANNER_MARKER) && prompt.includes(PLANNER_BASE_MARKER)) {
    await streamText(response, JSON.stringify(MOCK_COUNCIL_PLAN));
    response.end();
    return;
  }
  const last = messages.at(-1);

  // A held child turn stays running long enough for a spec to read the strip while
  // the child is live. Only a task that carries the marker reaches this branch.
  if (prompt.includes(MOCK_SUBAGENT_HOLD)) {
    await delay(MOCK_SUBAGENT_HOLD_MS);
    await streamText(response, MOCK_TEXT);
    response.end();
    return;
  }

  if (prompt.includes('interleave-timeline')) {
    const toolResults = messages.filter((message) => message.role === 'tool').length;
    if (toolResults === 0) {
      await streamReasoning(response, MOCK_INTERLEAVE_REASONING_ONE);
      await streamContent(response, MOCK_INTERLEAVE_PROSE_ONE);
      finishWithToolCalls(response, [
        {
          id: 'call_e2e_interleave_readme',
          name: 'read',
          args: { path: 'README.md' },
        },
      ]);
      response.end();
      return;
    }
    if (toolResults === 1) {
      await streamReasoning(response, MOCK_INTERLEAVE_REASONING_TWO);
      await streamContent(response, MOCK_INTERLEAVE_PROSE_TWO);
      finishWithToolCalls(response, [
        {
          id: 'call_e2e_interleave_source',
          name: 'read',
          args: { path: 'src/index.ts' },
        },
      ]);
      response.end();
      return;
    }
    await streamText(response, MOCK_INTERLEAVE_FINAL);
    response.end();
    return;
  }

  if (prompt.includes('todo-plan')) {
    const toolResults = messages.filter((message) => message.role === 'tool').length;
    if (toolResults === 0) {
      finishWithToolCalls(response, [
        { id: 'call_e2e_todo_init', name: 'todo', args: { op: 'init', items: JSON.stringify(MOCK_TODO_ITEMS) } },
      ]);
    } else if (toolResults === 1) {
      finishWithToolCalls(response, [
        { id: 'call_e2e_todo_start', name: 'todo', args: { op: 'start', task: MOCK_TODO_ITEMS[0] } },
      ]);
    } else {
      await streamText(response, MOCK_TODO_FINAL);
    }
    response.end();
    return;
  }

  if (prompt.includes('activity-bash') && last?.role !== 'tool') {
    streamToolCall(response, 'call_e2e_activity', 'bash', { command: MOCK_ACTIVITY_COMMAND });
    response.end();
    return;
  }

  if (last?.role === 'tool') {
    const output = contentOf(last);
    const reply = output.includes('denied')
      ? MOCK_DENIED_TEXT
      : prompt.includes('spawn-subagent')
        ? MOCK_SUBAGENT_FINAL
        : prompt.includes('show-timeline')
          ? MOCK_TIMELINE_FINAL
          : prompt.includes('activity-bash')
            ? MOCK_ACTIVITY_FINAL
            : output.startsWith('wrote ')
              ? MOCK_WROTE_TEXT
              : MOCK_ALLOWED_TEXT;
    await streamText(response, reply);
    response.end();
    return;
  }

  if (prompt.includes('spawn-subagent-trio')) {
    finishWithToolCalls(response, [
      {
        id: 'call_e2e_trio_explorer',
        name: 'subagent',
        args: { type: 'explorer', task: MOCK_SUBAGENT_TRIO_TASKS.explorer },
      },
      {
        id: 'call_e2e_trio_worker',
        name: 'subagent',
        args: { type: 'worker', task: MOCK_SUBAGENT_TRIO_TASKS.worker },
      },
      {
        id: 'call_e2e_trio_reviewer',
        name: 'subagent',
        args: { type: 'reviewer', task: MOCK_SUBAGENT_TRIO_TASKS.reviewer },
      },
    ]);
    response.end();
    return;
  }

  if (prompt.includes('spawn-subagent-two')) {
    finishWithToolCalls(response, [
      {
        id: 'call_e2e_subagent_two',
        name: 'subagent',
        args: { type: 'reviewer', task: MOCK_SUBAGENT_TWO_TASK },
      },
    ]);
    response.end();
    return;
  }

  if (prompt.includes('spawn-subagent')) {
    finishWithToolCalls(response, [
      {
        id: 'call_e2e_subagent',
        name: 'subagent',
        args: { type: 'explorer', task: MOCK_SUBAGENT_TASK },
      },
    ]);
    response.end();
    return;
  }

  if (prompt.includes('think-only')) {
    await streamReasoning(response, MOCK_THINKING);
    await streamText(response, MOCK_TEXT);
    response.end();
    return;
  }

  if (prompt.includes('show-timeline')) {
    await streamReasoning(response, MOCK_THINKING);
    await streamContent(response, MOCK_PROSE);
    finishWithToolCalls(response, [
      {
        id: 'call_e2e_timeline_write',
        name: 'write',
        args: { path: MOCK_TIMELINE_FILE, content: MOCK_TIMELINE_FILE_CONTENT },
      },
      { id: 'call_e2e_timeline_grep', name: 'grep', args: { pattern: 'answer', path: 'src' } },
      { id: 'call_e2e_timeline_bash', name: 'bash', args: { command: 'echo timeline-ok' } },
    ]);
    response.end();
    return;
  }

  if (prompt.includes('run-bash')) {
    streamToolCall(response, 'call_e2e_bash', 'bash', { command: 'echo tuffcode-ok' });
    response.end();
    return;
  }
  if (prompt.includes('write-file')) {
    streamToolCall(response, 'call_e2e_write', 'write', {
      path: MOCK_FILE_PATH,
      content: MOCK_FILE_CONTENT,
    });
    response.end();
    return;
  }

  await streamText(response, MOCK_TEXT);
  response.end();
}

export async function startMockOpenAI(): Promise<MockOpenAI> {
  let requests = 0;
  const prompts: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests += 1;
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL_ID, object: 'model' }] }),
      );
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      void handleChat(
        request,
        response,
        (prompt) => {
          prompts.push(prompt);
        },
        (body) => {
          bodies.push(body);
        },
      ).catch(() => {
        response.destroy();
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  const port = await listen(server);
  return {
    baseUrl: 'http://127.0.0.1:' + String(port) + '/v1',
    port,
    get requests() {
      return requests;
    },
    get prompts() {
      return prompts;
    },
    get bodies() {
      return bodies;
    },
    close: () => {
      server.closeAllConnections();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => {
        resolve();
      });
      return promise;
    },
  };
}

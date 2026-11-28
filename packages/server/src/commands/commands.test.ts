import type { Command, CommandRunResult, ServerEvent } from '@tuffcode/contracts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Council } from '../council/types.js';
import { createEventBus } from '../events.js';
import { addProject } from '../projects.js';
import type { Runner } from '../runner/runner.js';
import type { Subagents } from '../subagents/types.js';
import {
  createProjectThread,
  createTestContext,
  initRepo,
  type TestContext,
} from '../test-support.js';
import {
  BUILT_IN_COMMANDS,
  createCommandHandlers,
  expandArguments,
  expandCommand,
  listCommands,
  parseCommand,
  runCommand,
} from './index.js';

function writeCommand(projectPath: string, file: string, content: string): string {
  const dir = join(projectPath, '.tuffcode', 'commands');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, file);
  writeFileSync(filePath, content);
  return filePath;
}

function commandFile(name: string, description: string, hint?: string, body = 'body'): string {
  const hintLine = hint === undefined ? '' : `argument-hint: ${hint}\n`;
  return `---\nname: ${name}\ndescription: ${description}\n${hintLine}---\n${body}\n`;
}

describe('slash commands', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.dispose();
  });

  it('parses built-in commands and treats everything else as a message', () => {
    expect(parseCommand('/plan build the parser')).toEqual({
      name: 'plan',
      args: 'build the parser',
    });
    expect(parseCommand('/help')).toEqual({ name: 'help', args: '' });
    expect(parseCommand('/compact   keep tests ')).toEqual({
      name: 'compact',
      args: 'keep tests',
    });
    expect(parseCommand('/council ship it\nsecond line')).toEqual({
      name: 'council',
      args: 'ship it\nsecond line',
    });
    expect(parseCommand('please /plan')).toEqual({ message: 'please /plan' });
    expect(parseCommand('/unknown thing')).toEqual({ message: '/unknown thing' });
    expect(parseCommand(' /plan')).toEqual({ message: ' /plan' });
    expect(parseCommand('')).toEqual({ message: '' });
  });

  it('accepts discovered command names when given them', () => {
    expect(parseCommand('/review src/app.ts', ['review'])).toEqual({
      name: 'review',
      args: 'src/app.ts',
    });
    expect(parseCommand('/review', ['review'])).toEqual({ name: 'review', args: '' });
    expect(parseCommand('/model opus', ['review'])).toEqual({ name: 'model', args: 'opus' });
  });

  it('discovers project commands and skips invalid files with warnings', () => {
    const project = join(ctx.env.root, 'project');
    const reviewPath = writeCommand(
      project,
      'review.md',
      commandFile('review', 'Review the current diff', '"[path]"', 'Review $ARGUMENTS'),
    );
    writeCommand(project, 'plain.md', 'no frontmatter here\n');
    writeCommand(project, 'nameless.md', '---\ndescription: Missing a name\n---\nbody\n');
    writeCommand(project, 'reserved.md', commandFile('model', 'Shadow the built-in'));
    writeCommand(project, 'notes.txt', 'ignored\n');

    const warnings: string[] = [];
    const commands = listCommands(project, { onWarning: (message) => warnings.push(message) });

    expect(commands.slice(0, BUILT_IN_COMMANDS.length).map((command) => command.name)).toEqual(
      BUILT_IN_COMMANDS.map((command) => command.name),
    );
    expect(commands.find((command) => command.name === 'review')).toEqual({
      name: 'review',
      description: 'Review the current diff',
      body: 'Review $ARGUMENTS',
      path: reviewPath,
      argumentHint: '[path]',
    });
    expect(commands.some((command) => command.name === 'plain')).toBe(false);
    expect(commands.some((command) => command.name === 'nameless')).toBe(false);
    expect(commands.filter((command) => command.name === 'model')).toHaveLength(1);
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('plain.md');
    expect(warnings.join('\n')).toContain('nameless.md');
    expect(warnings.join('\n')).toContain('built in');
  });

  it('keeps the first file when two commands share a name', () => {
    const project = join(ctx.env.root, 'project');
    writeCommand(project, 'a.md', commandFile('review', 'First'));
    writeCommand(project, 'b.md', commandFile('review', 'Second'));
    const warnings: string[] = [];
    const commands = listCommands(project, { onWarning: (message) => warnings.push(message) });
    expect(commands.filter((command) => command.name === 'review')).toHaveLength(1);
    expect(commands.find((command) => command.name === 'review')?.description).toBe('First');
    expect(warnings.join('\n')).toContain('duplicate command review');
  });

  it('expands $ARGUMENTS and positional placeholders in one pass', () => {
    expect(expandArguments('Goal: $ARGUMENTS\nFirst: $1\nSecond: $2\nTenth: $10', 'fix bug')).toBe(
      'Goal: fix bug\nFirst: fix\nSecond: bug\nTenth: $10',
    );
    expect(expandArguments('$1/$2/$9', 'one two')).toBe('one/two/');
    expect(expandArguments('$ARGUMENTS and $2', '$2 literal')).toBe('$2 literal and literal');
    expect(expandArguments('nothing to fill', 'ignored')).toBe('nothing to fill');
    expect(expandCommand({ body: 'run $1' }, 'tests')).toBe('run tests');
  });

  it('serves commands.list for a project', async () => {
    const repo = initRepo(join(ctx.env.root, 'repo'));
    const project = await addProject(ctx.repos, repo);
    writeCommand(
      repo,
      'deploy.md',
      commandFile('deploy', 'Deploy the app', undefined, 'Deploy $1'),
    );

    const handler = createCommandHandlers({ repos: ctx.repos }).get('commands.list');
    if (handler === undefined) throw new Error('commands.list is not registered');
    const result = (await handler({ projectId: project.id })) as Command[];
    const deploy = result.find((command) => command.name === 'deploy');
    expect(deploy).toMatchObject({
      description: 'Deploy the app',
      body: 'Deploy $1',
      path: join(project.path, '.tuffcode', 'commands', 'deploy.md'),
    });
    expect(result.map((command) => command.name)).toContain('model');
    expect(() => handler({ projectId: 'prj_missing' })).toThrow('project not found');
  });
});

interface CommandHarness {
  ctx: TestContext;
  repo: string;
  projectId: string;
  threadId: string;
  spawned: { threadId: string; spec: { type: string; task: string } }[];
  started: { threadId: string; goal: string; autonomy: string }[];
  disposed: string[];
  run(input: string): Promise<CommandRunResult>;
}

async function createHarness(ctx: TestContext): Promise<CommandHarness> {
  const repo = initRepo(join(ctx.env.root, 'commands-repo'));
  const { project, thread } = await createProjectThread(ctx.repos, repo);
  const spawned: CommandHarness['spawned'] = [];
  const started: CommandHarness['started'] = [];
  const disposed: string[] = [];
  const subagents = {
    spawn: async (input: { threadId: string; spec: { type: string; task: string } }) => {
      spawned.push(input);
      return { childId: 'sub_1' };
    },
  } as unknown as Subagents;
  const council = {
    start: async (input: { threadId: string; goal: string; autonomy: string }) => {
      started.push(input);
      return { goalId: 'goal_1' };
    },
  } as unknown as Council;
  const runner = {
    disposeThread: async (threadId: string) => {
      disposed.push(threadId);
    },
  } as unknown as Runner;
  const deps = { repos: ctx.repos, council, subagents, runner };
  return {
    ctx,
    repo,
    projectId: project.id,
    threadId: thread.id,
    spawned,
    started,
    disposed,
    run: (input) => runCommand(deps, { threadId: thread.id, input }),
  };
}

describe('commands.run', () => {
  let ctx: TestContext;
  let harness: CommandHarness;

  beforeEach(async () => {
    ctx = createTestContext();
    harness = await createHarness(ctx);
  });

  afterEach(() => {
    ctx.dispose();
  });

  it('parses arguments for commands that take them', () => {
    expect(parseCommand('/subagent explorer map the rpc')).toEqual({
      name: 'subagent',
      args: 'explorer map the rpc',
    });
    expect(parseCommand('/council ship the parser\nsecond line')).toEqual({
      name: 'council',
      args: 'ship the parser\nsecond line',
    });
    expect(parseCommand('/compact keep the tests')).toEqual({
      name: 'compact',
      args: 'keep the tests',
    });
    expect(parseCommand('/model')).toEqual({ name: 'model', args: '' });
  });

  it('lists the built-ins with their argument hints', () => {
    const hints = new Map(BUILT_IN_COMMANDS.map((command) => [command.name, command.argumentHint]));
    expect([...hints.keys()]).toEqual([
      'model',
      'plan',
      'council',
      'subagent',
      'prompt',
      'context',
      'agents',
      'compact',
      'clear',
      'help',
      'reload',
    ]);
    expect(hints.get('subagent')).toBe('<type> <task>');
    expect(hints.get('model')).toBeNull();
  });

  it('opens the model picker and refuses arguments', async () => {
    expect(await harness.run('/model')).toEqual({
      kind: 'ui',
      action: { type: 'open-model-picker' },
    });
    const rejected = await harness.run('/model opus');
    expect(rejected.kind).toBe('error');
  });

  it('switches to plan mode through threads.update and sends a goal as a turn', async () => {
    const bare = await harness.run('/plan');
    expect(bare.kind).toBe('text');
    expect(ctx.repos.threads.get(harness.threadId)?.executionMode).toBe('plan');

    const withGoal = await harness.run('/plan add a parser');
    expect(withGoal).toEqual({ kind: 'turn', text: 'add a parser' });
    expect(ctx.repos.threads.get(harness.threadId)?.executionMode).toBe('plan');
  });

  it('switches to council mode and starts a goal', async () => {
    const bare = await harness.run('/council');
    expect(bare.kind).toBe('text');
    expect(harness.started).toHaveLength(0);
    expect(ctx.repos.threads.get(harness.threadId)?.executionMode).toBe('council');

    const started = await harness.run('/council ship the parser');
    expect(started).toEqual({ kind: 'text', text: 'Council goal goal_1 started.' });
    expect(harness.started).toEqual([
      { threadId: harness.threadId, goal: 'ship the parser', autonomy: 'manual' },
    ]);

    // The slash command and the composer share one mapping: a full auto default
    // starts the goal without a plan approval gate.
    ctx.repos.settings.patch({ defaultPermissionMode: 'full-auto' });
    await harness.run('/council ship the parser again');
    expect(harness.started.at(-1)).toEqual({
      threadId: harness.threadId,
      goal: 'ship the parser again',
      autonomy: 'auto',
    });
  });

  it('spawns a typed subagent and rejects a bad type', async () => {
    const result = await harness.run('/subagent explorer map the rpc registry');
    expect(result).toEqual({
      kind: 'text',
      text: 'Spawned explorer subagent sub_1 on: map the rpc registry',
    });
    expect(harness.spawned).toEqual([
      { threadId: harness.threadId, spec: { type: 'explorer', task: 'map the rpc registry' } },
    ]);

    const unknown = await harness.run('/subagent janitor sweep');
    expect(unknown.kind).toBe('error');
    if (unknown.kind === 'error') expect(unknown.message).toContain('Unknown subagent type');

    const missingTask = await harness.run('/subagent explorer');
    expect(missingTask.kind).toBe('error');
    expect(harness.spawned).toHaveLength(1);
  });

  it('opens the instructions section for /prompt', async () => {
    expect(await harness.run('/prompt')).toEqual({
      kind: 'ui',
      action: { type: 'open-settings', section: 'instructions' },
    });
  });

  it('shows the prompt budget for /context', async () => {
    ctx.repos.messages.add({
      id: 'msg_user_1',
      threadId: harness.threadId,
      role: 'user',
      content: 'Explain the runner',
      createdAt: new Date().toISOString(),
    });
    const result = await harness.run('/context');
    expect(result.kind).toBe('ui');
    if (result.kind !== 'ui' || result.action.type !== 'show-context') {
      throw new Error('expected a show-context action');
    }
    expect(result.action.preview.sections.length).toBeGreaterThan(0);
    expect(result.action.preview.total).toBeGreaterThan(0);
    expect(result.action.preview.sections.map((section) => section.name)).toContain('user-message');
  });

  it('lists subagent types with their configured models', async () => {
    ctx.repos.settings.patch({
      subagentModels: {
        explorer: { model: 'gpt-5' },
        reviewer: {},
        notetaker: {},
        worker: {},
        planner: {},
      },
    });
    const result = await harness.run('/agents');
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') return;
    expect(result.text).toContain('explorer: gpt-5');
    expect(result.text).toContain('worker: inherits the thread model');
  });

  it('clears the transcript and event log and drops the cached session', async () => {
    ctx.repos.messages.add({
      id: 'msg_user_1',
      threadId: harness.threadId,
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    });
    ctx.repos.events.append(harness.threadId, 'turn.started', {
      type: 'turn.started',
      turnId: 'turn_1',
    });

    const result = await harness.run('/clear');
    expect(result.kind).toBe('ui');
    if (result.kind === 'ui') {
      expect(result.action.type).toBe('reload-transcript');
      if (result.action.type === 'reload-transcript') {
        expect(result.action.text).toBe('Cleared 1 messages and 1 events.');
      }
    }
    expect(harness.disposed).toEqual([harness.threadId]);
    expect(ctx.repos.messages.list(harness.threadId)).toEqual([]);
    expect(ctx.repos.events.count(harness.threadId)).toBe(0);
  });

  it('compacts older messages into one digest row', async () => {
    for (let index = 0; index < 12; index += 1) {
      ctx.repos.messages.add({
        id: `msg_${index}`,
        threadId: harness.threadId,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index}`,
        createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      });
    }

    const result = await harness.run('/compact keep the tests');
    expect(result.kind).toBe('ui');
    if (result.kind === 'ui' && result.action.type === 'reload-transcript') {
      expect(result.action.text).toBe('Compacted 4 messages; 8 kept.');
    }
    const stored = ctx.repos.messages.list(harness.threadId);
    expect(stored).toHaveLength(9);
    const digest = stored.find((message) => message.role === 'system');
    expect(digest?.content).toContain('Compacted 4 earlier messages.');
    expect(digest?.content).toContain('Instructions: keep the tests');
    expect(harness.disposed).toEqual([harness.threadId]);
  });

  it('refuses to clear or compact while a turn is running', async () => {
    ctx.repos.threads.update(harness.threadId, {
      status: 'running',
      updatedAt: new Date().toISOString(),
    });
    const cleared = await harness.run('/clear');
    expect(cleared.kind).toBe('error');
    const compacted = await harness.run('/compact');
    expect(compacted.kind).toBe('error');
    expect(harness.disposed).toEqual([]);
  });

  it('lists commands and skills for /help and explains one command', async () => {
    writeCommand(harness.repo, 'deploy.md', commandFile('deploy', 'Deploy the app', '[env]'));
    const all = await harness.run('/help');
    expect(all.kind).toBe('text');
    if (all.kind === 'text') {
      expect(all.text).toContain('/subagent <type> <task>: Spawn a typed subagent');
      expect(all.text).toContain('/deploy [env]: Deploy the app');
      expect(all.text).toContain('Skills:');
    }

    const one = await harness.run('/help subagent');
    expect(one).toEqual({
      kind: 'text',
      text: '/subagent <type> <task>\nSpawn a typed subagent with a task\nBuilt-in command.',
    });
  });

  it('expands a project command into a turn', async () => {
    writeCommand(
      harness.repo,
      'deploy.md',
      commandFile('deploy', 'Deploy the app', '[env]', 'Deploy $1 to $2'),
    );
    expect(await harness.run('/deploy staging eu')).toEqual({
      kind: 'turn',
      text: 'Deploy staging to eu',
    });
  });

  it('falls through unknown slash names as a message', async () => {
    expect(await harness.run('/nope keep this')).toEqual({
      kind: 'turn',
      text: '/nope keep this',
    });
    expect(await harness.run('plain text')).toEqual({ kind: 'turn', text: 'plain text' });
  });

  it('serves commands.run through the RPC handler map', async () => {
    const handler = createCommandHandlers({ repos: ctx.repos }).get('commands.run');
    if (handler === undefined) throw new Error('commands.run is not registered');
    const result = (await handler({
      threadId: harness.threadId,
      input: '/help',
    })) as CommandRunResult;
    expect(result.kind).toBe('text');
  });

  it('reloads live configuration and prints the summary line', async () => {
    const reload = vi.fn(() =>
      Promise.resolve('Reloaded 2 providers, 1 MCP servers, 3 skills, 11 commands.'),
    );
    const result = await runCommand(
      { repos: ctx.repos, reload },
      { threadId: harness.threadId, input: '/reload' },
    );
    expect(result).toEqual({
      kind: 'text',
      text: 'Reloaded 2 providers, 1 MCP servers, 3 skills, 11 commands.',
    });
    expect(reload).toHaveBeenCalledExactlyOnceWith(harness.projectId);
  });

  it('reports reload unavailable when the slice is not wired', async () => {
    const result = await runCommand(
      { repos: ctx.repos },
      { threadId: harness.threadId, input: '/reload' },
    );
    expect(result).toEqual({ kind: 'error', message: 'Reload is not available in this build.' });
  });

  it('turns a throwing reload into an error result instead of a rejected command', async () => {
    const result = await runCommand(
      { repos: ctx.repos, reload: () => Promise.reject(new Error('disk gone')) },
      { threadId: harness.threadId, input: '/reload' },
    );
    expect(result).toEqual({ kind: 'error', message: 'Reload failed: disk gone' });
  });

  it('reloads through the RPC handler map and broadcasts the settings frame', async () => {
    const events: ServerEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((event) => events.push(event));
    const handler = createCommandHandlers({ repos: ctx.repos, bus }).get('commands.run');
    if (handler === undefined) throw new Error('commands.run is not registered');
    const result = (await handler({
      threadId: harness.threadId,
      input: '/reload',
    })) as CommandRunResult;
    expect(result.kind).toBe('text');
    if (result.kind === 'text') expect(result.text).toMatch(/^Reloaded \d+ providers/);
    expect(events.some((event) => event.type === 'settings.updated')).toBe(true);
    expect(events.some((event) => event.type === 'commands.updated')).toBe(true);
  });
});

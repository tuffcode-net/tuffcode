import type {
  CommandRunResult,
  PromptPreview,
  Project,
  SubagentType,
  Thread,
} from '@tuffcode/contracts';
import { SubagentTypeSchema, councilAutonomy } from '@tuffcode/contracts';
import type { Council } from '../council/types.js';
import type { Repos } from '../db/repos/index.js';
import { notFound } from '../errors.js';
import type { EventBus } from '../events.js';
import { planPrompt } from '../prompt/service.js';
import type { Runner } from '../runner/runner.js';
import { discoverSkills } from '../skills/discover.js';
import { pluginCommandDirs, pluginSkillRoots } from '../skills/roots.js';
import type { Subagents } from '../subagents/types.js';
import { clearThread, compactThread, getThread, updateThread } from '../threads.js';
import { listCommands } from './discover.js';
import { expandCommand } from './expand.js';
import { parseCommand } from './parse.js';
import type { CommandDefinition } from './types.js';

/** Every subagent type, in the order the docs list them. */
export const SUBAGENT_TYPES: readonly SubagentType[] = SubagentTypeSchema.options;

export interface CommandRunDeps {
  repos: Repos;
  bus?: EventBus;
  /** Absent when the slice is not wired; the commands then report unavailable. */
  council?: Council;
  subagents?: Subagents;
  /** Drops the cached adapter session so clear and compact really free context. */
  runner?: Pick<Runner, 'disposeThread'>;
  /** Re-reads live configuration and returns the summary line `/reload` prints. */
  reload?: (projectId: string) => Promise<string>;
  onWarning?: (message: string) => void;
}

export interface CommandRunInput {
  threadId: string;
  input: string;
}

const USAGE = {
  subagent:
    'Usage: /subagent <type> <task>. Types: explorer, reviewer, notetaker, worker, planner.',
};

function emitThread(deps: CommandRunDeps, thread: Thread): void {
  deps.bus?.emit({ kind: 'event', type: 'thread.updated', threadId: thread.id, payload: thread });
}

function switchMode(deps: CommandRunDeps, thread: Thread, mode: 'plan' | 'council'): Thread {
  const updated = updateThread(deps.repos, { id: thread.id, executionMode: mode });
  emitThread(deps, updated);
  return updated;
}

/** The same planner `prompt.preview` and `threads.send` use, so the numbers match. */
function previewPrompt(
  deps: CommandRunDeps,
  thread: Thread,
  project: Project,
  message: string,
): PromptPreview {
  const { assembly } = planPrompt(deps.repos, {
    thread,
    project,
    message,
    settings: deps.repos.settings.get(),
  });
  return { sections: assembly.sections, total: assembly.total };
}

function lastUserMessage(deps: CommandRunDeps, threadId: string): string {
  const messages = deps.repos.messages.list(threadId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

function helpText(
  deps: CommandRunDeps,
  project: Project,
  commands: readonly CommandDefinition[],
  argument: string,
): CommandRunResult {
  const name = argument.replace(/^\//, '');
  if (name.length > 0) {
    const target = commands.find((command) => command.name === name);
    if (target === undefined) return { kind: 'error', message: `Unknown command: /${name}` };
    const usage = target.argumentHint === null ? '' : ` ${target.argumentHint}`;
    const origin = target.path === null ? 'Built-in command.' : `Project command: ${target.path}`;
    return {
      kind: 'text',
      text: `/${target.name}${usage}\n${target.description}\n${origin}`,
    };
  }
  const skills = discoverSkills(project.path, {
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
    pluginRoots: pluginSkillRoots(deps.repos),
  });
  const commandLines = commands.map((command) => {
    const usage = command.argumentHint === null ? '' : ` ${command.argumentHint}`;
    return `/${command.name}${usage}: ${command.description}`;
  });
  const skillLines =
    skills.length === 0
      ? ['(none discovered)']
      : skills.map((skill) => `$${skill.name}: ${skill.description}`);
  return {
    kind: 'text',
    text: ['Commands:', ...commandLines, '', 'Skills:', ...skillLines].join('\n'),
  };
}

function agentsText(deps: CommandRunDeps): string {
  const settings = deps.repos.settings.get();
  const providers = deps.repos.providers.list();
  const lines = SUBAGENT_TYPES.map((type) => {
    const choice = settings.subagentModels[type];
    if (choice.model === undefined || choice.model.length === 0) {
      return `${type}: inherits the thread model`;
    }
    const provider =
      choice.providerId === undefined
        ? undefined
        : providers.find((entry) => entry.id === choice.providerId);
    const target = provider === undefined ? choice.model : `${provider.label} / ${choice.model}`;
    const fallback =
      choice.fallbackModel === undefined ? '' : ` (fallback ${choice.fallbackModel})`;
    return `${type}: ${target}${fallback}`;
  });
  return ['Subagent models:', ...lines, '', 'Edit them in Settings > Agents.'].join('\n');
}

/**
 * Runs one slash input against the services it names. Unknown names come back as a
 * turn so composer text is never lost, and every built-in calls a real service:
 * `threads.update`, `subagents.spawn`, `council.start`, the prompt planner, the
 * thread operations, or a settings route the composer opens.
 */
export async function runCommand(
  deps: CommandRunDeps,
  input: CommandRunInput,
): Promise<CommandRunResult> {
  const thread = getThread(deps.repos, input.threadId);
  const project = deps.repos.projects.get(thread.projectId);
  if (project === undefined) throw notFound('project not found');

  const commands = listCommands(project.path, {
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
    pluginDirs: pluginCommandDirs(deps.repos),
  });
  const parsed = parseCommand(
    input.input,
    commands.map((command) => command.name),
  );
  if ('message' in parsed) return { kind: 'turn', text: parsed.message };

  const command = commands.find((candidate) => candidate.name === parsed.name);
  if (command === undefined) return { kind: 'turn', text: input.input };

  if (command.path !== null) {
    const text = expandCommand(command, parsed.args).trim();
    if (text.length === 0) {
      return { kind: 'error', message: `/${command.name} has no prompt body.` };
    }
    return { kind: 'turn', text };
  }

  switch (command.name) {
    case 'model': {
      if (parsed.args.length > 0) {
        return { kind: 'error', message: '/model opens the picker and takes no arguments.' };
      }
      return { kind: 'ui', action: { type: 'open-model-picker' } };
    }
    case 'plan': {
      switchMode(deps, thread, 'plan');
      if (parsed.args.length > 0) return { kind: 'turn', text: parsed.args };
      return {
        kind: 'text',
        text: 'Plan mode is on. Describe the goal to draft a plan.',
      };
    }
    case 'council': {
      switchMode(deps, thread, 'council');
      if (parsed.args.length === 0) {
        return { kind: 'text', text: 'Council mode is on. Enter a goal to start a run.' };
      }
      if (deps.council === undefined) {
        return { kind: 'error', message: 'Council is not available in this build.' };
      }
      const { goalId } = await deps.council.start({
        threadId: thread.id,
        goal: parsed.args,
        autonomy: councilAutonomy(deps.repos.settings.get()),
      });
      return { kind: 'text', text: `Council goal ${goalId} started.` };
    }
    case 'subagent': {
      const [rawType, ...rest] = parsed.args.split(/\s+/).filter((part) => part.length > 0);
      const task = rest.join(' ');
      if (rawType === undefined || task.length === 0) {
        return { kind: 'error', message: USAGE.subagent };
      }
      const type = SubagentTypeSchema.safeParse(rawType);
      if (!type.success) {
        return { kind: 'error', message: `Unknown subagent type "${rawType}". ${USAGE.subagent}` };
      }
      if (deps.subagents === undefined) {
        return { kind: 'error', message: 'Subagents are not available in this build.' };
      }
      const { childId } = await deps.subagents.spawn({
        threadId: thread.id,
        spec: { type: type.data, task },
      });
      return { kind: 'text', text: `Spawned ${type.data} subagent ${childId} on: ${task}` };
    }
    case 'prompt':
      return { kind: 'ui', action: { type: 'open-settings', section: 'instructions' } };
    case 'context': {
      const preview = previewPrompt(deps, thread, project, lastUserMessage(deps, thread.id));
      return { kind: 'ui', action: { type: 'show-context', preview } };
    }
    case 'agents':
      return { kind: 'text', text: agentsText(deps) };
    case 'clear': {
      if (thread.status === 'running') {
        return { kind: 'error', message: 'Stop the running turn before clearing.' };
      }
      await deps.runner?.disposeThread(thread.id);
      const result = await clearThread(deps.repos, thread.id);
      return {
        kind: 'ui',
        action: {
          type: 'reload-transcript',
          text: `Cleared ${result.messages} messages and ${result.events} events.`,
        },
      };
    }
    case 'compact': {
      if (thread.status === 'running') {
        return { kind: 'error', message: 'Stop the running turn before compacting.' };
      }
      await deps.runner?.disposeThread(thread.id);
      const result = await compactThread(deps.repos, thread.id, parsed.args);
      if (result.removed === 0) {
        return {
          kind: 'text',
          text: `Nothing to compact: ${result.kept} messages are already recent.`,
        };
      }
      return {
        kind: 'ui',
        action: {
          type: 'reload-transcript',
          text: `Compacted ${result.removed} messages; ${result.kept} kept.`,
        },
      };
    }
    case 'help':
      return helpText(deps, project, commands, parsed.args);
    case 'reload': {
      if (deps.reload === undefined) {
        return { kind: 'error', message: 'Reload is not available in this build.' };
      }
      try {
        return { kind: 'text', text: await deps.reload(thread.projectId) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { kind: 'error', message: `Reload failed: ${detail}` };
      }
    }
    default:
      return { kind: 'error', message: `/${command.name} has no handler.` };
  }
}

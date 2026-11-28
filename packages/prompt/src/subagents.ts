import type { SubagentDepth, ToolProfile } from '@tuffcode/contracts';
import type { ToolParameters } from './tools';

/**
 * Subagent prompts and the `subagent` harness tool.
 *
 * Each type body is compact and type specific. `buildSubagentMessage` wraps it in one
 * shared header and footer, fills the TOOLS line from `SUBAGENT_TOOL_PROFILES` (the
 * same table the executor enforces), and appends the task and a short context block, so
 * the prompt cannot drift from the tools the child is actually offered.
 */

export const SUBAGENT_TYPES = ['explorer', 'reviewer', 'notetaker', 'worker', 'planner'] as const;

export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export function isSubagentType(value: unknown): value is SubagentType {
  return typeof value === 'string' && (SUBAGENT_TYPES as readonly string[]).includes(value);
}

/** How thoroughly a child works. The caller picks it; the prompt states it and the row keeps it. */
export const SUBAGENT_DEPTHS = ['quick', 'normal', 'thorough'] as const;

export function isSubagentDepth(value: unknown): value is SubagentDepth {
  return typeof value === 'string' && (SUBAGENT_DEPTHS as readonly string[]).includes(value);
}

/** Rework rounds the main agent sends back to one worker before it stops and asks. */
export const SUBAGENT_REWORK_LIMIT = 3;

/** Tasks a planner subagent may return; the council planner uses COUNCIL_CAPS.tasksPerGoal. */
export const SUBAGENT_PLANNER_TASKS = 8;

/**
 * Wall clock one child may run, per type. The service stops the child when it expires;
 * there is no turn cap, because an adapter has no iteration hook the server can count.
 */
export const SUBAGENT_RUN_MINUTES: Record<SubagentType, number> = {
  explorer: 10,
  planner: 30,
  reviewer: 30,
  notetaker: 30,
  worker: 30,
};

/** Words the shared footer allows, by depth: quick answers stay short. */
const SUMMARY_WORDS: Record<SubagentDepth, number> = { quick: 150, normal: 300, thorough: 300 };

export const EXPLORER_PROMPT = `ROLE: Find where and how something works in this codebase, and return a map the parent can act on without reading everything again.
METHOD:
1. On your first turn, run several different searches at once: names, string literals, callers, tests, configuration.
2. Read the files that matter and follow imports until the flow is clear.
3. Drop false leads. Keep only locations you read in this session.
DO: cite path:Lstart-Lend with one reason for each location. When a target does not exist, say "not found" and list what you searched.
DO NOT: change code, propose fixes the brief did not ask for, or cite a line you did not open.
STOP: as soon as the map answers the brief.`;

export const REVIEWER_PROMPT = `ROLE: Judge one change against its brief and return a verdict the parent can act on.
METHOD:
1. Read the diff first, then the code around each hunk.
2. Run the brief's check when your tools allow it. Your own output is the evidence; the author's report is not. If the check needs a command you cannot run, say so in the notes and review the diff without claiming it passed.
3. Look for problems in order of risk: wrong results on bad, empty or concurrent input; a missing requirement; changes outside the brief; security (secrets, input validation, paths, SQL); tests that would still pass if the code were wrong.
DO: give each finding a number, a severity (blocker, major, minor), path:line, what is wrong, and what correct looks like. The author fixes findings by number.
DO NOT: fix anything, comment on code you have not read, or pass a change because the author says it works.
OUTPUT: the first line is VERDICT: pass | changes-requested | escalate. Use escalate only for a decision the author cannot make: a product choice, a security call, or a brief that contradicts itself.`;

export const NOTETAKER_PROMPT = `ROLE: Keep the facts this work proved, so later sessions do not relearn them.
METHOD: read what happened; keep only facts that will still be true next week and that the code does not already state; replace a stale fact instead of adding a second one.
RULES: at most 8 facts, each under 400 characters, each with tags and an importance. Write a Markdown digest only when the brief asks for one.
OUTPUT: exactly one JSON object, no prose and no code fence:
{"facts":[{"text":"...","tags":"comma,separated","importance":0.5}]}
Return {"facts":[]} when nothing is durable. A supersedes fact begins supersedes: "<old text>" and then states the corrected fact.`;

export const WORKER_PROMPT = `ROLE: Implement one task in your own worktree ({{worktree}}, branch {{branch}}) and prove it works.
METHOD:
1. Read the brief, then the whole function or section you will change, its callers and its tests.
2. Make one logical change at a time, following the conventions already in each file.
3. Run the check the brief names and fix until it passes. Then run the package typecheck if there is one.
REWORK: if a message brings review findings, fix each numbered finding and nothing else. Rerun the check, commit to the same branch (the open pull request updates itself), and answer finding by finding: fixed at path:line, or not fixed and why.
DO NOT: touch files outside the brief, add dependencies, edit lockfiles, skip or weaken tests, or leave stubs.
ASK the parent before you widen scope.`;

export const PLANNER_PROMPT = `ROLE: Turn one goal into the smallest set of tasks that can each be built, checked and reviewed on their own.
METHOD:
1. Read the entry points, the files that will change, and the tests that will judge them. Confirm every path exists.
2. Find what is already in place, so no task redoes it.
3. Split by shared decisions first, then by file ownership. If two pieces must agree on an interface, define it in the first task and make the others depend on it.
4. Order the tasks so the earliest unblock the rest. Keep the dependency graph shallow.
RULES:
- 1 to {{max_tasks}} tasks. Fewer is better.
- Each task owns its files. No two tasks own the same file.
- Each task names one command that proves it is done.
- Mark a task critical only if it blocks the goal or touches auth, secrets, data loss or destructive commands.
- Add no requirements, cleanup or refactors the goal did not ask for.
ASK: if the goal cannot be planned without a decision only the user can make, return the question form instead of a plan.
OUTPUT: exactly one JSON object, with no prose and no code fence:
{"tasks":[{"title":"...","files":["..."],"dependsOn":[],"critical":false,"check":"<command>","brief":"<target, change, check, conventions: enough for a worker with no history>"}],"question":null}
or {"tasks":[],"question":"<one short question>"}`;

export const SUBAGENT_PROMPTS: Record<SubagentType, string> = {
  explorer: EXPLORER_PROMPT,
  reviewer: REVIEWER_PROMPT,
  notetaker: NOTETAKER_PROMPT,
  worker: WORKER_PROMPT,
  planner: PLANNER_PROMPT,
};

/**
 * The tools a read-only type is offered: everything except writing code, with Markdown
 * allowed for documentation, read-only bash, and only the reporting side of subagents.
 */
const DOCUMENTING_TOOLS = [
  'read',
  'glob',
  'grep',
  'bash',
  'mcp:list',
  'mcp:call',
  'web_fetch',
  'memory:search',
  'todo',
  'write',
  'edit',
  'subagent:status',
  'subagent:report',
  'subagent:ask',
] as const;

/** The worker's tools: the same, plus whole-tool MCP and memory writes, in its worktree. */
const WORKER_TOOLS = [
  'read',
  'glob',
  'grep',
  'bash',
  'write',
  'edit',
  'mcp',
  'memory:search',
  'memory:add',
  'web_fetch',
  'todo',
  'subagent:status',
  'subagent:report',
  'subagent:ask',
] as const;

/**
 * What each subagent type may be offered and may do, one table beside the prompts.
 * Everything except writing code, and Markdown allowed for documentation; the worker
 * is the exception and writes code inside its own worktree. No child gets `config`,
 * because a child must not change the user's providers or settings, and no child gets
 * spawn, message, stop, wait or inbox, because children report to the parent and never
 * fan out.
 */
export const SUBAGENT_TOOL_PROFILES: Record<SubagentType, ToolProfile> = {
  explorer: { offer: [...DOCUMENTING_TOOLS], writeGlobs: ['**/*.md'], bash: 'read-only' },
  planner: { offer: [...DOCUMENTING_TOOLS], writeGlobs: ['**/*.md'], bash: 'read-only' },
  reviewer: { offer: [...DOCUMENTING_TOOLS], writeGlobs: ['**/*.md'], bash: 'read-only' },
  notetaker: {
    offer: [...DOCUMENTING_TOOLS, 'memory:add'],
    writeGlobs: ['**/*.md'],
    bash: 'read-only',
  },
  worker: { offer: [...WORKER_TOOLS], writeGlobs: ['**'], bash: 'worktree' },
};

export interface SubagentMessageInput {
  type: SubagentType;
  task: string;
  /** Absolute worktree the child runs in, so the prompt and the turn agree. */
  cwd?: string;
  /** The child's own checkout when the type gets one; the worker prompt names it. */
  worktree?: string;
  /** The branch checked out in that worktree. */
  branch?: string;
  /** quick, normal or thorough; the caller sets it at spawn and the prompt states it. */
  depth?: SubagentDepth;
  projectName?: string;
  /** One-line description of the parent thread, for orientation only. */
  parentTitle?: string;
}

/** The words one offered tool maps to. A name missing here is never promised in a prompt. */
const TOOL_WORDS: Record<string, string> = {
  read: 'read and search',
  glob: 'read and search',
  grep: 'read and search',
  mcp: 'MCP lookups',
  web_fetch: 'web fetch',
};

/** What a profile may write, or null when it may not write files at all. */
function writeClause(profile: ToolProfile): string | null {
  const globs = profile.writeGlobs ?? [];
  if (globs.length === 0) return null;
  return globs.every((glob) => glob.endsWith('.md'))
    ? 'you may write .md files only'
    : 'you may write any file in your worktree';
}

/**
 * The exact read-only shell surface, named so a child does not spend a turn guessing.
 * The prompt package cannot import the adapter that enforces the allowlist, so the
 * adapter test pins the same program and subcommand names.
 */
const READ_ONLY_SHELL_DETAIL =
  'read-only shell commands: ls, dir, pwd, cd, echo, cat, type, head, tail, wc, where, grep, rg, find, and git status, log, show, diff, branch, rev-parse, ls-files, grep, blame, remote; no file redirects (stderr to the null device is allowed)';

/**
 * The TOOLS line for one profile, generated from the same table the executor enforces,
 * so a prompt cannot offer a tool its turn denies. Tool names become human words here
 * and nowhere else; `todo` and the reporting side of `subagent` are not worth a line.
 */
export function describeToolProfile(profile: ToolProfile): string {
  const words: string[] = [];
  const push = (word: string | null): void => {
    if (word !== null && !words.includes(word)) words.push(word);
  };
  for (const entry of profile.offer) {
    const name = entry.split(':')[0] ?? entry;
    const mapped = TOOL_WORDS[name];
    if (mapped !== undefined) {
      push(mapped);
    } else if (name === 'bash') {
      push(profile.bash === 'read-only' ? READ_ONLY_SHELL_DETAIL : 'shell commands');
    } else if (name === 'memory') {
      push(profile.offer.includes('memory:add') ? 'memory search and notes' : 'memory search');
    }
  }
  const clause = writeClause(profile);
  const line = words.join(', ');
  return clause === null ? `${line}.` : `${line}; ${clause}.`;
}

const SUBAGENT_HEADER = `You are the {{type}} subagent working for a parent agent. You have no conversation history: the brief below is everything you know.

TOOLS: {{tools_line}} Anything else will fail, so do not try it.
DEPTH: {{depth}}. Limit: {{max_minutes}} minutes.
ASKING: if you reach a decision only the parent can make, use subagent ask with one short question and wait. If you can check something yourself, check it instead of asking. If no answer comes, state your assumption, carry on, and list it under OPEN QUESTIONS.
Other agents may be working in this repository at the same time. Never revert, reformat or delete work you did not make.`;

const SUBAGENT_FOOTER = `YOUR LAST MESSAGE is the only thing the parent reads:
STATUS: done | partial | blocked
SUMMARY: {{summary_words}} words at most
FILES: path:line for each place that matters, most important first
OPEN QUESTIONS: assumptions you made and anything unresolved, or "none"
Put long material in a Markdown file and give its path instead of pasting it.`;

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

/** Fills one template. An unknown placeholder is a bug in this file, not model input. */
function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`prompt template has an unknown placeholder: ${match}`);
    }
    return value;
  });
}

/**
 * Shared header, the type body, the shared footer, then the task and a bounded context
 * block. The planner returns JSON, so it replaces the footer with its own contract.
 */
export function buildSubagentMessage(input: SubagentMessageInput): string {
  const depth = input.depth ?? 'normal';
  const values: Record<string, string> = {
    type: input.type,
    tools_line: describeToolProfile(SUBAGENT_TOOL_PROFILES[input.type]),
    depth,
    max_minutes: String(SUBAGENT_RUN_MINUTES[input.type]),
    summary_words: String(SUMMARY_WORDS[depth]),
    max_tasks: String(SUBAGENT_PLANNER_TASKS),
    worktree: input.worktree ?? input.cwd ?? 'the worktree you were given',
    branch: input.branch ?? 'the branch checked out there',
  };
  const parts = [
    fillTemplate(SUBAGENT_HEADER, values),
    fillTemplate(SUBAGENT_PROMPTS[input.type], values),
  ];
  if (input.type !== 'planner') parts.push(fillTemplate(SUBAGENT_FOOTER, values));
  parts.push(`TASK\n${input.task.trim()}`);
  const context: string[] = [];
  if (input.projectName !== undefined && input.projectName.trim().length > 0) {
    context.push(`project: ${input.projectName.trim()}`);
  }
  if (input.cwd !== undefined && input.cwd.trim().length > 0) {
    context.push(`cwd: ${input.cwd.trim()}`);
  }
  if (input.parentTitle !== undefined && input.parentTitle.trim().length > 0) {
    context.push(`parent thread: ${input.parentTitle.trim()}`);
  }
  if (context.length > 0) parts.push(`CONTEXT\n${context.join('\n')}`);
  return parts.join('\n\n');
}

export interface NotetakerFact {
  text: string;
  tags: string;
  importance: number;
}

const MAX_FACTS = 8;
const MAX_FACT_CHARS = 400;

function clampImportance(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

function cleanTags(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .slice(0, 5)
    .join(',');
}

/**
 * Reads the notetaker's JSON object out of its answer. A fenced block or surrounding
 * prose is tolerated, a malformed answer yields no facts instead of throwing, and the
 * text is capped so one runaway fact cannot bloat the brain.
 */
export function parseNotetakerFacts(answer: string): NotetakerFact[] {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || !('facts' in parsed)) return [];
  const facts: unknown = parsed.facts;
  if (!Array.isArray(facts)) return [];
  const out: NotetakerFact[] = [];
  for (const raw of facts) {
    if (typeof raw !== 'object' || raw === null || !('text' in raw)) continue;
    if (typeof raw.text !== 'string') continue;
    const text = raw.text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
    if (text.length === 0) continue;
    out.push({
      text,
      tags: 'tags' in raw ? cleanTags(raw.tags) : '',
      importance: 'importance' in raw ? clampImportance(raw.importance) : 0.5,
    });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

export const SUBAGENT_TOOL_NAME = 'subagent';

/** spawn starts a child; the rest inspect, steer, answer, close or read children of the current thread. */
export const SUBAGENT_ACTIONS = [
  'spawn',
  'status',
  'wait',
  'message',
  'stop',
  'inbox',
  'report',
  'ask',
  'answer',
  'close',
  'read',
] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

export function isSubagentAction(value: unknown): value is SubagentAction {
  return typeof value === 'string' && (SUBAGENT_ACTIONS as readonly string[]).includes(value);
}

/**
 * The `subagent` tool. It is not part of the file-tool list: the server offers it
 * separately, so `enabledTools` (which lists file tools) never hides delegation.
 */
export const SUBAGENT_TOOL: {
  readonly name: typeof SUBAGENT_TOOL_NAME;
  readonly description: string;
  readonly parameters: ToolParameters;
} = {
  name: SUBAGENT_TOOL_NAME,
  description:
    'Run and control typed subagents. action spawn (the default) starts a child in its own session and returns its id at once: explorer maps code read-only with file:line citations; reviewer judges the diff against its brief and runs the check when its tools allow it; notetaker extracts durable facts into the project brain; worker implements and verifies a task in its own worktree; planner returns a JSON task list. status lists children with state, tool count, tokens, elapsed time and current activity; wait blocks until the given child (or every child) settles, a child asks a question, or timeout_s passes, and returns open questions first; message sends a follow-up to a child (queued while it runs, a new turn once it settled); stop cancels a child and kills its processes; inbox returns unread reports from children. ask posts one blocking question to the parent and waits for the answer (default 300 s, then state your assumption and continue); answer replies to a question id; close stops and archives a child, keeping its transcript, and refuses to delete a worktree with unpushed commits; read returns the latest full report of a child and then its whole mailbox in both directions, paged with cursor, so nothing a child said is lost; a bounded summary names the report that holds the rest. A child calls report to send a progress note to its parent. Spawn independent children together, then wait. Keep tasks self-contained: the child has no conversation history.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'spawn, status, wait, message, stop, inbox, report, ask, answer, close or read. Default spawn.',
      },
      id: {
        type: 'string',
        description:
          'Child id for message, stop, close and read; optional filter for status and wait.',
      },
      text: {
        type: 'string',
        description: 'Message text for message and report; question text for ask; reply text for answer.',
      },
      rework: {
        type: 'boolean',
        description:
          'For message: true when sending reviewer findings back as a rework round. The child gets at most three rework rounds.',
      },
      question_id: {
        type: 'string',
        description: 'For answer: the question id wait or a subagent.question event reported.',
      },
      cursor: {
        type: 'string',
        description: 'For read: the last message id already read; the next page starts after it.',
      },
      timeout_s: {
        type: 'integer',
        description: 'For wait: seconds to wait before returning. Default 120.',
        minimum: 1,
        maximum: 600,
      },
      type: {
        type: 'string',
        description: 'For spawn: explorer, reviewer, notetaker, worker, or planner.',
      },
      task: {
        type: 'string',
        description:
          'For spawn: the complete task for the child, with target files or symbols, the change, and the acceptance check. The child sees nothing else.',
      },
      model: {
        type: 'string',
        description:
          'Optional model override. Omit to use the per-type model from settings with its fallback.',
      },
      depth: {
        type: 'string',
        description: 'For spawn: quick, normal or thorough. Default normal.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export type SubagentToolDefinition = typeof SUBAGENT_TOOL;

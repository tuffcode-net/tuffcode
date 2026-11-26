import {
  toolSummary,
  type ApprovalItem,
  type NoticeItem,
  type TimelineItem,
  type ToolItem,
  type UserItem,
} from './grouping';

export interface ReasoningBlock {
  kind: 'reasoning';
  key: string;
  turnId: string;
  text: string;
  streaming: boolean;
  durationMs: number | null;
}

/** Assistant text that precedes a tool call: context, not the answer. */
export interface ProseBlock {
  kind: 'prose';
  key: string;
  turnId: string;
  text: string;
  streaming: boolean;
}

export interface ToolGroupBlock {
  kind: 'tools';
  key: string;
  turnId: string;
  tools: ToolItem[];
  durationMs: number | null;
}

/** The closing assistant text, rendered as the answer with hover actions. */
export interface FinalBlock {
  kind: 'final';
  key: string;
  turnId: string;
  text: string;
  streaming: boolean;
  /** The user message this answer replies to, used by retry and edit. */
  prompt: UserItem | null;
}

export interface UserBlock {
  kind: 'user';
  key: string;
  item: UserItem;
}

export interface ApprovalBlock {
  kind: 'approval';
  key: string;
  item: ApprovalItem;
}

export interface NoticeBlock {
  kind: 'notice';
  key: string;
  item: NoticeItem;
}

/**
 * The pre-answer work of one finished turn: every reasoning, prose and tool block
 * that came before the answer, folded under one disclosure row. Only those kinds
 * are folded, so no user, approval or notice block can appear here.
 */
export interface StepsBlock {
  kind: 'steps';
  key: string;
  turnId: string;
  /** Total tool calls across the folded tool blocks, not the number of groups. */
  tools: number;
  /** Sum of the reasoning durations that are known, or null when none is. */
  durationMs: number | null;
  children: TimelineBlock[];
}

export type TimelineBlock =
  | UserBlock
  | ReasoningBlock
  | ProseBlock
  | ToolGroupBlock
  | FinalBlock
  | ApprovalBlock
  | NoticeBlock
  | StepsBlock;

/** Milliseconds between two ISO timestamps, or null when either is unusable. */
export function elapsedMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (startedAt === null || finishedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** Compact duration for a row: "<1s", "12s", "1m 5s", "2h 3m". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * The one-line summary of a folded steps block: "Ran 3 tools and thought for 12s".
 * Each half stands alone when the other is missing, and a turn with neither a
 * tool call nor a measured thought keeps the neutral "Worked".
 */
export function stepsSummary(tools: number, durationMs: number | null): string {
  const duration = formatDuration(durationMs);
  const calls = tools > 0 ? `Ran ${tools} ${tools === 1 ? 'tool' : 'tools'}` : '';
  if (calls.length > 0 && duration.length > 0) return `${calls} and thought for ${duration}`;
  if (calls.length > 0) return calls;
  if (duration.length > 0) return `Thought for ${duration}`;
  return 'Worked';
}

const VERBS: Record<string, string> = {
  read: 'Read',
  read_file: 'Read',
  view: 'Read',
  write: 'Wrote',
  write_file: 'Wrote',
  create: 'Created',
  edit: 'Edited',
  edit_file: 'Edited',
  multi_edit: 'Edited',
  apply_patch: 'Edited',
  str_replace_editor: 'Edited',
  bash: 'Ran',
  shell: 'Ran',
  exec: 'Ran',
  run: 'Ran',
  terminal: 'Ran',
  grep: 'Searched',
  search: 'Searched',
  find: 'Searched',
  glob: 'Listed',
  ls: 'Listed',
  list: 'Listed',
  fetch: 'Fetched',
  web_fetch: 'Fetched',
  webfetch: 'Fetched',
};

/** The leading word of a tool row: "Read", "Ran", "Searched". */
export function toolVerb(name: string): string {
  const known = VERBS[name.toLowerCase()];
  if (known !== undefined) return known;
  const cleaned = name.replace(/[_-]+/g, ' ').trim();
  return cleaned.length === 0 ? 'Used' : `Used ${cleaned}`;
}

const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell'] as const;
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'dir', 'directory'] as const;
const PATTERN_KEYS = ['pattern', 'query', 'regex'] as const;

function firstLine(value: string): string {
  const [line = ''] = value.split(/\r?\n/);
  return line.trim();
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * What a tool row points at: the path it touched, the first line of a command, or
 * the pattern it searched for. Generic tools fall back to any short string input.
 */
export function toolTarget(input: unknown): string {
  if (typeof input === 'string') return firstLine(input);
  if (input === null || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const path = firstString(record, PATH_KEYS);
  if (path !== null) return firstLine(path);
  const command = firstString(record, COMMAND_KEYS);
  if (command !== null) return firstLine(command);
  const pattern = firstString(record, PATTERN_KEYS);
  if (pattern !== null) return firstLine(pattern);
  return toolSummary(input);
}

/** "Read src/index.ts" for a row and for copied tool text. */
export function toolHeadline(name: string, input: unknown): string {
  const target = toolTarget(input);
  const verb = toolVerb(name);
  return target.length === 0 ? verb : `${verb} ${target}`;
}

export type ToolDetail = 'diff' | 'output' | 'matches';

/** Which expanded body a tool gets: a diff, an output tail, or matches. */
export function toolDetail(name: string): ToolDetail {
  const normalized = name.toLowerCase();
  if (/(^|_)(edit|write|patch|create|replace)(_|$)/.test(normalized)) return 'diff';
  if (/(^|_)(grep|search)(_|$)/.test(normalized)) return 'matches';
  return 'output';
}

export interface ToolDiffLine {
  kind: 'add' | 'remove' | 'context';
  text: string;
}

const OLD_KEYS = ['old_string', 'old_str', 'oldText', 'old_text'] as const;
const NEW_KEYS = ['new_string', 'new_str', 'newText', 'new_text', 'content'] as const;

function patchLines(text: string): ToolDiffLine[] {
  const lines: ToolDiffLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('@@')) {
      lines.push({ kind: 'context', text: raw });
      continue;
    }
    if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ kind: 'remove', text: raw.slice(1) });
    else lines.push({ kind: 'context', text: raw.replace(/^ /, '') });
  }
  return lines;
}

/**
 * The changed lines an edit or write produced. A unified patch is used as-is;
 * otherwise the old and new fragments become removed and added lines.
 */
export function toolDiffLines(input: unknown): ToolDiffLine[] {
  if (input === null || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  const patch = firstString(record, ['diff', 'patch']);
  if (patch !== null) return patchLines(patch);

  const lines: ToolDiffLine[] = [];
  const oldValue = firstString(record, OLD_KEYS);
  const newValue = firstString(record, NEW_KEYS);
  if (oldValue !== null) {
    for (const line of oldValue.split(/\r?\n/)) lines.push({ kind: 'remove', text: line });
  }
  if (newValue !== null) {
    for (const line of newValue.split(/\r?\n/)) lines.push({ kind: 'add', text: line });
  }
  return lines;
}

export interface OutputTail {
  lines: string[];
  hidden: number;
}

/** A slice of tool output, with counts for the lines hidden above and below it. */
export interface OutputWindow extends OutputTail {
  hiddenBefore: number;
}

/**
 * The last few lines of tool output, with a count for what scrolled past. When a
 * needle is given and appears in the output, the window centres on that line so a
 * search hit is rendered instead of being hidden above the tail.
 */
export function outputWindow(output: string, needle: string | null, maxLines = 12): OutputWindow {
  if (output.trim().length === 0) return { lines: [], hidden: 0, hiddenBefore: 0 };
  const lines = output.replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  const at = needle === null || needle.length === 0 ? -1 : matchLine(lines, needle);
  if (lines.length <= maxLines) return { lines, hidden: 0, hiddenBefore: 0 };
  if (at === -1) {
    return { lines: lines.slice(-maxLines), hidden: lines.length - maxLines, hiddenBefore: 0 };
  }
  const before = Math.max(0, Math.min(at - Math.floor(maxLines / 2), lines.length - maxLines));
  return {
    lines: lines.slice(before, before + maxLines),
    hidden: lines.length - before - maxLines,
    hiddenBefore: before,
  };
}

/** The line that holds the first case-insensitive occurrence of a needle, or -1. */
function matchLine(lines: readonly string[], needle: string): number {
  const lower = needle.toLowerCase();
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? '').toLowerCase().includes(lower)) return index;
  }
  return -1;
}

/** The last few lines of tool output, with a count for what scrolled past. */
export function outputTail(output: string, maxLines = 12): OutputTail {
  const { lines, hidden } = outputWindow(output, null, maxLines);
  return { lines, hidden };
}

/** What the copy action puts on the clipboard for a block. */
export function blockCopyText(block: TimelineBlock): string {
  switch (block.kind) {
    case 'reasoning':
    case 'prose':
    case 'final':
      return block.text;
    case 'user':
      return block.item.text;
    case 'tools':
      return block.tools
        .map((tool) => {
          const body = tool.output.trim().length > 0 ? `\n${tool.output.trim()}` : '';
          return `${toolHeadline(tool.name, tool.input)}${body}`;
        })
        .join('\n\n');
    default:
      return '';
  }
}

/**
 * Folds flat timeline rows into Claude-style turn blocks: reasoning, prose and
 * tool runs keep their event order, and consecutive tools share one surface.
 * The answer is the last assistant text of a turn and only when no tool call
 * follows it; text before a later tool, like earlier text, is prose.
 */
export function groupTurnBlocks(items: readonly TimelineItem[]): TimelineBlock[] {
  const lastAssistantIndex = new Map<string, number>();
  const lastToolIndex = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind === 'assistant') lastAssistantIndex.set(item.turnId, index);
    else if (item.kind === 'tool' || item.kind === 'tool-group') {
      lastToolIndex.set(item.turnId, index);
    }
  });

  const blocks: TimelineBlock[] = [];
  let prompt: UserItem | null = null;

  items.forEach((item, index) => {
    switch (item.kind) {
      case 'user': {
        prompt = item;
        blocks.push({ kind: 'user', key: item.key, item });
        break;
      }
      case 'reasoning': {
        blocks.push({
          kind: 'reasoning',
          key: item.key,
          turnId: item.turnId,
          text: item.text,
          streaming: item.streaming,
          durationMs: elapsedMs(item.startedAt, item.finishedAt),
        });
        break;
      }
      case 'assistant': {
        const closing =
          index === lastAssistantIndex.get(item.turnId) &&
          index > (lastToolIndex.get(item.turnId) ?? -1);
        if (closing) {
          blocks.push({
            kind: 'final',
            key: item.key,
            turnId: item.turnId,
            text: item.text,
            streaming: item.streaming,
            prompt,
          });
        } else {
          blocks.push({
            kind: 'prose',
            key: item.key,
            turnId: item.turnId,
            text: item.text,
            streaming: item.streaming,
          });
        }
        break;
      }
      case 'tool': {
        blocks.push({
          kind: 'tools',
          key: item.key,
          turnId: item.turnId,
          tools: [item],
          durationMs: elapsedMs(item.startedAt, item.finishedAt),
        });
        break;
      }
      case 'tool-group': {
        const first = item.tools[0];
        const last = item.tools.at(-1);
        blocks.push({
          kind: 'tools',
          key: item.key,
          turnId: item.turnId,
          tools: item.tools,
          durationMs: elapsedMs(first?.startedAt ?? null, last?.finishedAt ?? null),
        });
        break;
      }
      case 'approval': {
        blocks.push({ kind: 'approval', key: item.key, item });
        break;
      }
      case 'notice': {
        blocks.push({ kind: 'notice', key: item.key, item });
        break;
      }
    }
  });

  return blocks;
}

/** The kinds a steps row absorbs; everything else keeps its own row. */
function foldable(block: TimelineBlock): block is ReasoningBlock | ProseBlock | ToolGroupBlock {
  return block.kind === 'reasoning' || block.kind === 'prose' || block.kind === 'tools';
}

function stepsBlock(turnId: string, children: TimelineBlock[]): StepsBlock {
  let tools = 0;
  let duration = 0;
  let measured = false;
  for (const child of children) {
    if (child.kind === 'tools') tools += child.tools.length;
    else if (child.kind === 'reasoning' && child.durationMs !== null) {
      duration += child.durationMs;
      measured = true;
    }
  }
  return {
    kind: 'steps',
    key: `steps-${turnId}`,
    turnId,
    tools,
    durationMs: measured ? duration : null,
    children,
  };
}

/**
 * Folds the work before a settled answer into one steps row. The thread timeline
 * applies this on top of groupTurnBlocks; a compact surface that renders blocks
 * itself can keep the flat list. A turn keeps today's flat blocks while its answer
 * streams or while no answer exists, so live progress stays visible; only a
 * finished answer pulls its own turn's reasoning, prose and tools together.
 * Approvals, notices and user rows are never folded, and the steps row sits
 * directly above the answer it belongs to.
 */
export function foldTurnSteps(blocks: readonly TimelineBlock[]): TimelineBlock[] {
  const settled = new Set<string>();
  for (const block of blocks) {
    if (block.kind === 'final' && !block.streaming) settled.add(block.turnId);
  }
  if (settled.size === 0) return blocks.slice();

  const result: TimelineBlock[] = [];
  const pending = new Map<string, TimelineBlock[]>();

  for (const block of blocks) {
    if (foldable(block) && settled.has(block.turnId)) {
      const children = pending.get(block.turnId) ?? [];
      children.push(block);
      pending.set(block.turnId, children);
      continue;
    }
    if (block.kind === 'final' && settled.has(block.turnId)) {
      const children = pending.get(block.turnId) ?? [];
      pending.delete(block.turnId);
      if (children.length > 0) result.push(stepsBlock(block.turnId, children));
    }
    result.push(block);
  }

  // A settled turn always ends with its answer, so this only guards the fold from
  // silently dropping rows if a future shape breaks that invariant.
  for (const children of pending.values()) result.push(...children);

  return result;
}

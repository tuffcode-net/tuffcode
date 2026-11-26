import { describe, expect, it } from 'vitest';
import type { ApprovalItem, NoticeItem, ToolItem, UserItem } from './grouping';
import type { TimelineBlock } from './turn-blocks';
import {
  MAX_FIND_MATCHES,
  expandKeysForMatch,
  findTimeline,
  openExpansion,
} from './use-thread-find';

const user: UserItem = {
  kind: 'user',
  key: 'user-1',
  messageId: 'm-1',
  turnId: 'turn-1',
  text: 'Search the ALPHA notes',
  attachments: [],
  status: 'sent',
};

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool',
    key: 'tool-bash',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    name: 'bash',
    input: { command: 'echo needle-ok' },
    output: 'needle-ok',
    isError: false,
    running: false,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const approval: ApprovalItem = {
  kind: 'approval',
  key: 'approval-1',
  turnId: 'turn-1',
  approvalId: 'a-1',
  name: 'shell.exec',
  input: { command: 'rm -rf needle-dir' },
  decision: null,
};

const notice: NoticeItem = {
  kind: 'notice',
  key: 'notice-1',
  tone: 'error',
  text: 'The needle-command failed',
};

const reasoning: TimelineBlock = {
  kind: 'reasoning',
  key: 'reasoning-1',
  turnId: 'turn-1',
  text: 'I should find the NEEDLE first',
  streaming: false,
  durationMs: 1200,
};

const prose: TimelineBlock = {
  kind: 'prose',
  key: 'prose-1',
  turnId: 'turn-1',
  text: 'Looking for needle evidence',
  streaming: false,
};

const tools: TimelineBlock = {
  kind: 'tools',
  key: 'tools-1',
  turnId: 'turn-1',
  durationMs: 1000,
  tools: [tool()],
};

const final: TimelineBlock = {
  kind: 'final',
  key: 'final-1',
  turnId: 'turn-1',
  text: 'Done with the needle',
  streaming: false,
  prompt: user,
};

const steps: TimelineBlock = {
  kind: 'steps',
  key: 'steps-turn-1',
  turnId: 'turn-1',
  tools: 1,
  durationMs: 1200,
  children: [reasoning, prose, tools],
};

function timeline(): TimelineBlock[] {
  return [
    { kind: 'user', key: user.key, item: user },
    steps,
    { kind: 'approval', key: approval.key, item: approval },
    { kind: 'notice', key: notice.key, item: notice },
    final,
  ];
}

describe('findTimeline', () => {
  it('searches user, prose, reasoning, final, approval and notice text', () => {
    const matches = findTimeline(timeline(), 'needle');
    expect(matches.map((match) => match.field)).toEqual([
      'reasoning',
      'prose',
      'tool-input',
      'tool-output',
      'approval',
      'notice',
      'final',
    ]);
    expect(matches.map((match) => match.blockKey)).toEqual([
      'steps-turn-1',
      'steps-turn-1',
      'steps-turn-1',
      'steps-turn-1',
      'approval-1',
      'notice-1',
      'final-1',
    ]);
    expect(matches.map((match) => match.blockIndex)).toEqual([1, 1, 1, 1, 2, 3, 4]);
  });

  it('is case insensitive and reports the offset of each hit', () => {
    const [match] = findTimeline(timeline(), 'alpha');
    expect(match?.field).toBe('user');
    expect(match?.start).toBe('Search the '.length);
    expect(match?.length).toBe('alpha'.length);
    expect(findTimeline(timeline(), 'NEEDLE').length).toBe(7);
  });

  it('treats the query as a literal, not a regular expression', () => {
    const blocks: TimelineBlock[] = [
      { ...final, key: 'final-2', text: 'Call a.b(c) and $d^e[f] then 1+1' },
    ];
    expect(findTimeline(blocks, 'a.b(c)').length).toBe(1);
    expect(findTimeline(blocks, '$d^e[f]').length).toBe(1);
    expect(findTimeline(blocks, '1+1').length).toBe(1);
    expect(findTimeline(blocks, 'a.*c').length).toBe(0);
  });

  it('matches every occurrence inside one field', () => {
    const blocks: TimelineBlock[] = [{ ...final, key: 'final-3', text: 'tick tick tick' }];
    const matches = findTimeline(blocks, 'tick');
    expect(matches.map((match) => match.start)).toEqual([0, 5, 10]);
    expect(new Set(matches.map((match) => match.id)).size).toBe(3);
  });

  it('returns nothing for an empty query or a missing needle', () => {
    expect(findTimeline(timeline(), '')).toEqual([]);
    expect(findTimeline(timeline(), 'absent-token')).toEqual([]);
    expect(findTimeline([], 'needle')).toEqual([]);
  });

  it('reads inside a folded steps row and names the rows to open', () => {
    const matches = findTimeline(timeline(), 'needle-ok');
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match.blockKey).toBe('steps-turn-1');
      expect(match.expandKeys).toEqual(['steps-turn-1', 'tools-1', 'tool-bash']);
    }
    const [reasoningHit] = findTimeline(timeline(), 'NEEDLE first');
    expect(reasoningHit?.expandKeys).toEqual(['steps-turn-1', 'reasoning-1']);
  });

  it('caps a pathological query instead of building an unbounded list', () => {
    const blocks: TimelineBlock[] = [
      { ...final, key: 'final-4', text: 'e'.repeat(MAX_FIND_MATCHES + 50) },
    ];
    expect(findTimeline(blocks, 'e')).toHaveLength(MAX_FIND_MATCHES);
  });
});

describe('expansion', () => {
  it('opens the steps row and the child tool group for a tool hit', () => {
    const [match] = findTimeline(timeline(), 'needle-ok');
    expect(match).toBeDefined();
    if (match === undefined) return;
    const keys = expandKeysForMatch(match);
    const expanded = openExpansion({}, keys);
    expect(expanded).toEqual({ 'steps-turn-1': true, 'tools-1': true, 'tool-bash': true });
  });

  it('returns the same map when every key is already open', () => {
    const current = { 'steps-turn-1': true, 'tools-1': true, 'tool-bash': true };
    expect(openExpansion(current, ['steps-turn-1', 'tool-bash'])).toBe(current);
  });
});

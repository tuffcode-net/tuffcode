import type { AdapterEvent, ThreadEventRow } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import { groupTimeline } from './grouping';
import {
  blockCopyText,
  foldTurnSteps,
  formatDuration,
  groupTurnBlocks,
  outputTail,
  outputWindow,
  stepsSummary,
  toolDetail,
  toolDiffLines,
  toolHeadline,
  toolTarget,
  toolVerb,
  type TimelineBlock,
} from './turn-blocks';

function event(seq: number, payload: AdapterEvent, at: string): ThreadEventRow {
  return {
    id: seq + 1,
    threadId: 'thread-1',
    seq,
    type: payload.type,
    payload,
    createdAt: `2026-01-01T00:00:${at}.000Z`,
  };
}

function blocksOf(events: ThreadEventRow[], supersededTurns?: ReadonlySet<string>) {
  return foldTurnSteps(
    groupTurnBlocks(
      groupTimeline({
        events,
        userMessages: [],
        approvals: {},
        ...(supersededTurns ? { supersededTurns } : {}),
      }),
    ),
  );
}

function toolCall(
  turnId: string,
  startSeq: number,
  id: string,
  name: string,
  input: unknown,
  startedAt: string,
  finishedAt: string,
  output = 'ok',
): ThreadEventRow[] {
  return [
    event(startSeq, { type: 'tool.started', turnId, toolCallId: id, name, input }, startedAt),
    event(
      startSeq + 1,
      { type: 'tool.finished', turnId, toolCallId: id, output, isError: false },
      finishedAt,
    ),
  ];
}

describe('groupTurnBlocks', () => {
  it('folds reasoning, prose and one tool group into steps above the closing answer', () => {
    const blocks = blocksOf([
      event(1, { type: 'reasoning.delta', turnId: 'turn-1', text: 'Plan ' }, '00'),
      event(2, { type: 'reasoning.delta', turnId: 'turn-1', text: 'the change' }, '01'),
      event(3, { type: 'text.delta', turnId: 'turn-1', text: 'First I inspect.' }, '02'),
      ...toolCall('turn-1', 4, 'c1', 'read', { path: 'src/index.ts' }, '02', '03'),
      ...toolCall('turn-1', 6, 'c2', 'grep', { pattern: 'answer' }, '03', '04'),
      event(8, { type: 'text.delta', turnId: 'turn-1', text: 'The answer is 42.' }, '05'),
      event(9, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '05'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['steps', 'final']);
    const [steps, final] = blocks;
    if (steps?.kind !== 'steps') throw new Error('Expected a steps block.');
    expect(steps.children.map((child) => child.kind)).toEqual(['reasoning', 'prose', 'tools']);
    expect(steps.tools).toBe(2);
    expect(steps.durationMs).toBe(2000);
    expect(stepsSummary(steps.tools, steps.durationMs)).toBe(
      'Ran 2 tools and thought for 2s',
    );
    const [reasoning, prose, tools] = steps.children;
    if (reasoning?.kind !== 'reasoning') throw new Error('Expected a reasoning block.');
    expect(reasoning.text).toBe('Plan the change');
    expect(reasoning.durationMs).toBe(2000);
    if (prose?.kind !== 'prose') throw new Error('Expected a prose block.');
    expect(prose.text).toBe('First I inspect.');
    if (tools?.kind !== 'tools') throw new Error('Expected a tool block.');
    expect(tools.tools.map((tool) => tool.name)).toEqual(['read', 'grep']);
    if (final?.kind !== 'final') throw new Error('Expected a final block.');
    expect(final.text).toBe('The answer is 42.');
  });

  it('treats a lone answer with no tools as the final block', () => {
    const blocks = blocksOf([
      event(1, { type: 'text.delta', turnId: 'turn-1', text: 'All done.' }, '00'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['final']);
  });

  it('folds a lone reasoning block into steps when the turn runs no tools', () => {
    const blocks = blocksOf([
      event(1, { type: 'reasoning.delta', turnId: 'turn-1', text: 'Weigh ' }, '00'),
      event(2, { type: 'reasoning.delta', turnId: 'turn-1', text: 'the options' }, '01'),
      event(3, { type: 'text.delta', turnId: 'turn-1', text: 'All ' }, '02'),
      event(4, { type: 'text.delta', turnId: 'turn-1', text: 'done.' }, '03'),
      event(5, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '03'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['steps', 'final']);
    const [steps, final] = blocks;
    if (steps?.kind !== 'steps') throw new Error('Expected a steps block.');
    expect(steps.tools).toBe(0);
    expect(steps.durationMs).toBe(2000);
    expect(stepsSummary(steps.tools, steps.durationMs)).toBe('Thought for 2s');
    const [reasoning] = steps.children;
    if (reasoning?.kind !== 'reasoning') throw new Error('Expected a reasoning block.');
    expect(reasoning.text).toBe('Weigh the options');
    expect(reasoning.durationMs).toBe(2000);
    if (final?.kind !== 'final') throw new Error('Expected a final block.');
    expect(final.text).toBe('All done.');
  });

  it('keeps the interleaved prose and tool order inside the folded steps', () => {
    const blocks = blocksOf([
      event(1, { type: 'text.delta', turnId: 'turn-1', text: 'Opening the file.' }, '00'),
      ...toolCall('turn-1', 2, 'c1', 'read', { path: 'a.ts' }, '01', '02'),
      event(4, { type: 'text.delta', turnId: 'turn-1', text: 'Now searching.' }, '03'),
      ...toolCall('turn-1', 5, 'c2', 'grep', { pattern: 'todo' }, '04', '05'),
      event(7, { type: 'text.delta', turnId: 'turn-1', text: 'Found two.' }, '06'),
      event(8, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '06'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['steps', 'final']);
    const steps = blocks[0];
    if (steps?.kind !== 'steps') throw new Error('Expected a steps block.');
    expect(steps.children.map((child) => child.kind)).toEqual([
      'prose',
      'tools',
      'prose',
      'tools',
    ]);
    expect(steps.tools).toBe(2);
    const texts = steps.children.map((child) =>
      child.kind === 'prose' ? child.text : null,
    );
    expect(texts).toEqual(['Opening the file.', null, 'Now searching.', null]);
    const final = blocks.at(-1);
    if (final?.kind !== 'final') throw new Error('Expected a final block.');
    expect(final.text).toBe('Found two.');
  });

  it('keeps the closing prose as prose when the turn ends with a tool call', () => {
    const blocks = blocksOf([
      event(1, { type: 'text.delta', turnId: 'turn-1', text: 'Checking the config.' }, '00'),
      ...toolCall('turn-1', 2, 'c1', 'read', { path: 'tsconfig.json' }, '01', '02'),
      event(4, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '02'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['prose', 'tools']);
    const prose = blocks[0];
    if (prose?.kind !== 'prose') throw new Error('Expected a prose block.');
    expect(prose.text).toBe('Checking the config.');
  });

  it('keeps the user prompt on the final block for retry and edit', () => {
    const blocks = blocksOf([
      event(1, { type: 'text.delta', turnId: 'turn-1', text: 'Answer' }, '00'),
    ]);
    const final = blocks.at(-1);
    if (final?.kind !== 'final') throw new Error('Expected a final block.');
    expect(final.prompt).toBeNull();
  });

  it('folds consecutive tools into one group with a combined duration', () => {
    const blocks = blocksOf([
      ...toolCall('turn-1', 1, 'c1', 'read', { path: 'a.ts' }, '00', '01'),
      ...toolCall('turn-1', 3, 'c2', 'bash', { command: 'pnpm test' }, '01', '04'),
    ]);

    const tools = blocks[0];
    if (tools?.kind !== 'tools') throw new Error('Expected a tool block.');
    expect(tools.tools).toHaveLength(2);
    expect(tools.durationMs).toBe(4000);
  });

  it('drops superseded turns from the rendered blocks', () => {
    const blocks = blocksOf(
      [
        event(1, { type: 'text.delta', turnId: 'turn-1', text: 'Old answer' }, '00'),
        event(2, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '00'),
        event(3, { type: 'text.delta', turnId: 'turn-2', text: 'New answer' }, '01'),
      ],
      new Set(['turn-1']),
    );

    expect(blocks).toHaveLength(1);
    const final = blocks[0];
    if (final?.kind !== 'final') throw new Error('Expected a final block.');
    expect(final.text).toBe('New answer');
  });

  it('strips the prose the server folded into the persisted answer', () => {
    const items = groupTimeline({
      events: [
        event(1, { type: 'text.delta', turnId: 'turn-1', text: 'Prose. ' }, '00'),
        ...toolCall('turn-1', 2, 'c1', 'read', { path: 'a.ts' }, '01', '02'),
        event(4, { type: 'text.delta', turnId: 'turn-1', text: 'Final.' }, '03'),
        event(5, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '03'),
      ],
      messages: [
        {
          id: 'msg_turn-1_assistant',
          threadId: 'thread-1',
          role: 'assistant',
          content: 'Prose. Final.',
          createdAt: '2026-01-01T00:00:04.000Z',
        },
      ],
      userMessages: [],
      approvals: {},
    });

    const blocks = foldTurnSteps(groupTurnBlocks(items));
    expect(blocks.map((block) => block.kind)).toEqual(['steps', 'final']);
    const steps = blocks[0];
    if (steps?.kind !== 'steps') throw new Error('Expected a steps block.');
    expect(steps.children.map((child) => child.kind)).toEqual(['prose', 'tools']);
    const final = blocks.at(-1);
    if (final?.kind !== 'final') throw new Error('Expected a final block.');
    expect(final.text).toBe('Final.');
  });

  it('keeps the flat blocks while the answer still streams', () => {
    const blocks = blocksOf([
      event(1, { type: 'reasoning.delta', turnId: 'turn-1', text: 'Plan' }, '00'),
      ...toolCall('turn-1', 2, 'c1', 'read', { path: 'a.ts' }, '01', '02'),
      event(4, { type: 'text.delta', turnId: 'turn-1', text: 'Writing' }, '03'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['reasoning', 'tools', 'final']);
    const final = blocks.at(-1);
    if (final?.kind !== 'final') throw new Error('Expected a final block.');
    expect(final.streaming).toBe(true);
  });

  it('counts individual tool calls, not groups, in the steps row', () => {
    const blocks = blocksOf([
      event(1, { type: 'text.delta', turnId: 'turn-1', text: 'Working' }, '00'),
      ...toolCall('turn-1', 2, 'c1', 'read', { path: 'a.ts' }, '01', '02'),
      ...toolCall('turn-1', 4, 'c2', 'bash', { command: 'pnpm test' }, '02', '03'),
      ...toolCall('turn-1', 6, 'c3', 'edit', { path: 'a.ts' }, '03', '04'),
      event(8, { type: 'text.delta', turnId: 'turn-1', text: 'Done.' }, '05'),
      event(9, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '05'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['steps', 'final']);
    const steps = blocks[0];
    if (steps?.kind !== 'steps') throw new Error('Expected a steps block.');
    expect(steps.children.map((child) => child.kind)).toEqual(['prose', 'tools']);
    expect(steps.tools).toBe(3);
    expect(steps.durationMs).toBeNull();
    expect(stepsSummary(steps.tools, steps.durationMs)).toBe('Ran 3 tools');
  });

  it('never folds user, approval or notice blocks into the steps row', () => {
    const items = groupTimeline({
      events: [
        event(1, { type: 'turn.started', turnId: 'turn-1' }, '2026-01-01T00:00:01.000Z'),
        event(2, { type: 'reasoning.delta', turnId: 'turn-1', text: 'Plan' }, '2026-01-01T00:00:02.000Z'),
        event(
          3,
          {
            type: 'approval.requested',
            turnId: 'turn-1',
            approvalId: 'a1',
            toolCallId: 'c1',
            name: 'write',
            input: {},
          },
          '2026-01-01T00:00:03.000Z',
        ),
        event(
          4,
          {
            type: 'tool.started',
            turnId: 'turn-1',
            toolCallId: 'c1',
            name: 'write',
            input: { path: 'a.ts', content: 'x' },
          },
          '2026-01-01T00:00:04.000Z',
        ),
        event(
          5,
          { type: 'tool.finished', turnId: 'turn-1', toolCallId: 'c1', output: 'ok', isError: false },
          '2026-01-01T00:00:05.000Z',
        ),
        event(6, { type: 'text.delta', turnId: 'turn-1', text: 'Done.' }, '2026-01-01T00:00:06.000Z'),
        event(
          7,
          { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' },
          '2026-01-01T00:00:06.000Z',
        ),
        event(8, { type: 'session.ended', reason: 'complete' }, '2026-01-01T00:00:07.000Z'),
      ],
      messages: [
        {
          id: 'msg_turn-1_user',
          threadId: 'thread-1',
          role: 'user',
          content: 'Do it',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      userMessages: [],
      approvals: {},
    });

    const blocks = foldTurnSteps(groupTurnBlocks(items));
    expect(blocks.map((block) => block.kind)).toEqual([
      'user',
      'approval',
      'steps',
      'final',
      'notice',
    ]);
    const steps = blocks[2];
    if (steps?.kind !== 'steps') throw new Error('Expected a steps block.');
    expect(steps.children.map((child) => child.kind)).toEqual(['reasoning', 'tools']);
  });

  it('folds each settled turn into its own steps row', () => {
    const blocks = blocksOf([
      event(1, { type: 'reasoning.delta', turnId: 'turn-1', text: 'A' }, '00'),
      event(2, { type: 'text.delta', turnId: 'turn-1', text: 'Answer one' }, '00'),
      event(3, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '00'),
      event(4, { type: 'reasoning.delta', turnId: 'turn-2', text: 'B' }, '01'),
      event(5, { type: 'text.delta', turnId: 'turn-2', text: 'Answer two' }, '02'),
      event(6, { type: 'turn.finished', turnId: 'turn-2', reason: 'complete' }, '02'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual(['steps', 'final', 'steps', 'final']);
    const [first, , second] = blocks;
    if (first?.kind !== 'steps' || second?.kind !== 'steps') {
      throw new Error('Expected two steps blocks.');
    }
    expect(first.turnId).toBe('turn-1');
    expect(second.turnId).toBe('turn-2');
    expect(first.children).toHaveLength(1);
    expect(second.children).toHaveLength(1);
  });
});

describe('foldTurnSteps', () => {
  it('is a separate pass, so a compact surface keeps the flat blocks', () => {
    const events = [
      event(1, { type: 'reasoning.delta', turnId: 'turn-1', text: 'Plan' }, '00'),
      event(2, { type: 'text.delta', turnId: 'turn-1', text: 'Answer' }, '01'),
      event(3, { type: 'turn.finished', turnId: 'turn-1', reason: 'complete' }, '01'),
    ];
    const items = groupTimeline({ events, userMessages: [], approvals: {} });

    expect(groupTurnBlocks(items).map((block) => block.kind)).toEqual(['reasoning', 'final']);
    expect(foldTurnSteps(groupTurnBlocks(items)).map((block) => block.kind)).toEqual([
      'steps',
      'final',
    ]);
  });

  it('leaves the list alone while the answer still streams', () => {
    const blocks = groupTurnBlocks(
      groupTimeline({
        events: [
          event(1, { type: 'reasoning.delta', turnId: 'turn-1', text: 'Plan' }, '00'),
          event(2, { type: 'text.delta', turnId: 'turn-1', text: 'Writing' }, '01'),
        ],
        userMessages: [],
        approvals: {},
      }),
    );

    expect(foldTurnSteps(blocks).map((block) => block.kind)).toEqual(['reasoning', 'final']);
  });
});

describe('stepsSummary', () => {
  it('combines the tool count and the measured thought time', () => {
    expect(stepsSummary(3, 12_000)).toBe('Ran 3 tools and thought for 12s');
    expect(stepsSummary(1, 2_000)).toBe('Ran 1 tool and thought for 2s');
  });

  it('drops the half that has no data', () => {
    expect(stepsSummary(0, 12_000)).toBe('Thought for 12s');
    expect(stepsSummary(4, null)).toBe('Ran 4 tools');
    expect(stepsSummary(1, null)).toBe('Ran 1 tool');
  });

  it('falls back to a neutral label with no tools and no measured thought', () => {
    expect(stepsSummary(0, null)).toBe('Worked');
  });
});

describe('formatDuration', () => {
  it('formats sub-second, second, minute and hour spans', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(999)).toBe('<1s');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(1500)).toBe('2s');
    expect(formatDuration(59_500)).toBe('1m');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});

describe('toolTarget', () => {
  it('prefers a path, then the first line of a command, then a pattern', () => {
    expect(toolTarget({ path: 'src/index.ts', content: 'x' })).toBe('src/index.ts');
    expect(toolTarget({ file_path: 'docs/readme.md' })).toBe('docs/readme.md');
    expect(toolTarget({ command: 'git status\n  && git diff' })).toBe('git status');
    expect(toolTarget({ pattern: 'TODO' })).toBe('TODO');
  });

  it('falls back to a short string and ignores empty input', () => {
    expect(toolTarget({ description: 'List the files' })).toBe('List the files');
    expect(toolTarget('echo hello')).toBe('echo hello');
    expect(toolTarget(null)).toBe('');
    expect(toolTarget({})).toBe('');
  });
});

describe('toolHeadline and toolVerb', () => {
  it('names the action before the target', () => {
    expect(toolVerb('read')).toBe('Read');
    expect(toolVerb('write_file')).toBe('Wrote');
    expect(toolVerb('bash')).toBe('Ran');
    expect(toolVerb('grep')).toBe('Searched');
    expect(toolVerb('custom_tool')).toBe('Used custom tool');
    expect(toolHeadline('bash', { command: 'pnpm test' })).toBe('Ran pnpm test');
    expect(toolHeadline('grep', {})).toBe('Searched');
  });
});

describe('toolDetail', () => {
  it('routes edit and write to a diff, grep to matches, everything else to output', () => {
    expect(toolDetail('edit')).toBe('diff');
    expect(toolDetail('write_file')).toBe('diff');
    expect(toolDetail('apply_patch')).toBe('diff');
    expect(toolDetail('grep')).toBe('matches');
    expect(toolDetail('bash')).toBe('output');
  });
});

describe('toolDiffLines', () => {
  it('marks a write body as added lines', () => {
    expect(toolDiffLines({ path: 'a.ts', content: 'one\ntwo' })).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
  });

  it('renders the replaced fragment as removals then additions', () => {
    expect(toolDiffLines({ old_string: 'old', new_string: 'new' })).toEqual([
      { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });

  it('parses a unified patch and ignores its file headers', () => {
    expect(toolDiffLines({ patch: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new' })).toEqual([
      { kind: 'context', text: '@@ -1 +1 @@' },
      { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });

  it('returns nothing for inputs without a change', () => {
    expect(toolDiffLines({ path: 'a.ts' })).toEqual([]);
    expect(toolDiffLines(null)).toEqual([]);
  });
});

describe('outputTail', () => {
  it('keeps short output whole and counts the lines it hides', () => {
    expect(outputTail('a\nb')).toEqual({ lines: ['a', 'b'], hidden: 0 });
    const long = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n');
    expect(outputTail(long, 12)).toEqual({
      lines: ['line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 13', 'line 14', 'line 15'],
      hidden: 3,
    });
    expect(outputTail('   ')).toEqual({ lines: [], hidden: 0 });
  });
});

describe('outputWindow', () => {
  const long = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');

  it('keeps the tail when no needle is given or the needle is absent', () => {
    expect(outputWindow(long, null, 4)).toEqual({
      lines: ['line 27', 'line 28', 'line 29', 'line 30'],
      hidden: 26,
      hiddenBefore: 0,
    });
    expect(outputWindow(long, 'missing', 4)).toEqual({
      lines: ['line 27', 'line 28', 'line 29', 'line 30'],
      hidden: 26,
      hiddenBefore: 0,
    });
  });

  it('centres the window on the line that holds the needle', () => {
    const window = outputWindow(long, 'line 15', 4);
    expect(window.lines).toEqual(['line 13', 'line 14', 'line 15', 'line 16']);
    expect(window.hiddenBefore).toBe(12);
    expect(window.hidden).toBe(14);
  });

  it('does not shift past either end', () => {
    expect(outputWindow(long, 'line 29', 4).lines).toEqual([
      'line 27',
      'line 28',
      'line 29',
      'line 30',
    ]);
    expect(outputWindow(long, 'line 1', 4).lines).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
  });
});

describe('blockCopyText', () => {
  it('copies the answer text for a final block', () => {
    const block: TimelineBlock = {
      kind: 'final',
      key: 'final-1',
      turnId: 'turn-1',
      text: '# Answer\n\nBody.',
      streaming: false,
      prompt: null,
    };
    expect(blockCopyText(block)).toBe('# Answer\n\nBody.');
  });

  it('copies each tool headline with its output', () => {
    const blocks = blocksOf([
      ...toolCall('turn-1', 1, 'c1', 'read', { path: 'a.ts' }, '00', '01', 'contents'),
      ...toolCall('turn-1', 3, 'c2', 'bash', { command: 'pnpm test' }, '01', '02', 'passed'),
    ]);
    const tools = blocks[0];
    if (tools?.kind !== 'tools') throw new Error('Expected a tool block.');
    expect(blockCopyText(tools)).toBe('Read a.ts\ncontents\n\nRan pnpm test\npassed');
  });
});

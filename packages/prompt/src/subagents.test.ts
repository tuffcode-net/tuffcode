import { describe, expect, it } from 'vitest';
import type { SubagentType } from '@tuffcode/contracts';
import {
  SUBAGENT_PROMPTS,
  SUBAGENT_RUN_MINUTES,
  SUBAGENT_TOOL,
  SUBAGENT_TOOL_PROFILES,
  SUBAGENT_TYPES,
  buildSubagentMessage,
  describeToolProfile,
  parseNotetakerFacts,
} from './subagents';

/** The one sentence each profile must produce; the prompt never writes it by hand. */
const TOOLS_LINES: Record<SubagentType, string> = {
  explorer:
    'read and search, read-only shell commands, MCP lookups, web fetch, memory search; you may write .md files only.',
  planner:
    'read and search, read-only shell commands, MCP lookups, web fetch, memory search; you may write .md files only.',
  reviewer:
    'read and search, read-only shell commands, MCP lookups, web fetch, memory search; you may write .md files only.',
  notetaker:
    'read and search, read-only shell commands, MCP lookups, web fetch, memory search and notes; you may write .md files only.',
  worker:
    'read and search, shell commands, MCP lookups, memory search and notes, web fetch; you may write any file in your worktree.',
};

describe('subagent prompts', () => {
  it('has one compact type body per type', () => {
    for (const type of SUBAGENT_TYPES) {
      const words = SUBAGENT_PROMPTS[type].trim().split(/\s+/);
      expect(words.length, type).toBeGreaterThan(40);
      expect(words.length, type).toBeLessThan(250);
    }
  });

  it('generates the TOOLS line from the profile that enforces it', () => {
    for (const type of SUBAGENT_TYPES) {
      expect(describeToolProfile(SUBAGENT_TOOL_PROFILES[type]), type).toBe(TOOLS_LINES[type]);
      const message = buildSubagentMessage({ type, task: 'Do the work' });
      expect(message, type).toContain(`TOOLS: ${TOOLS_LINES[type]} Anything else will fail`);
    }
  });

  it('never offers shell writing to a read-only profile', () => {
    expect(describeToolProfile(SUBAGENT_TOOL_PROFILES.explorer)).toContain(
      'read-only shell commands',
    );
    expect(describeToolProfile(SUBAGENT_TOOL_PROFILES.worker)).not.toContain('read-only');
    expect(describeToolProfile(SUBAGENT_TOOL_PROFILES.explorer)).not.toContain('any file');
  });

  it('fills every placeholder in the header, body and footer', () => {
    for (const type of SUBAGENT_TYPES) {
      for (const depth of ['quick', 'normal', 'thorough'] as const) {
        const message = buildSubagentMessage({ type, task: 'Do the work', depth });
        expect(message, `${type}/${depth}`).not.toMatch(/\{\{/);
        expect(message, `${type}/${depth}`).toContain(`DEPTH: ${depth}.`);
        expect(message, `${type}/${depth}`).toContain(
          `Limit: ${SUBAGENT_RUN_MINUTES[type]} minutes.`,
        );
      }
    }
  });

  it('shrinks the summary budget at quick depth and keeps 300 words otherwise', () => {
    const quick = buildSubagentMessage({ type: 'explorer', task: 'Map it', depth: 'quick' });
    expect(quick).toContain('SUMMARY: 150 words at most');
    const normal = buildSubagentMessage({ type: 'explorer', task: 'Map it' });
    expect(normal).toContain('SUMMARY: 300 words at most');
    const thorough = buildSubagentMessage({ type: 'explorer', task: 'Map it', depth: 'thorough' });
    expect(thorough).toContain('SUMMARY: 300 words at most');
  });

  it('gives the planner its JSON contract instead of the shared footer', () => {
    const planner = buildSubagentMessage({ type: 'planner', task: 'Split the goal' });
    expect(planner).toContain('"tasks"');
    expect(planner).toContain('"question"');
    expect(planner).toContain('1 to 8 tasks');
    expect(planner).not.toContain('YOUR LAST MESSAGE');
    for (const type of ['explorer', 'reviewer', 'notetaker', 'worker'] as const) {
      expect(buildSubagentMessage({ type, task: 'Do the work' })).toContain(
        'YOUR LAST MESSAGE is the only thing the parent reads:',
      );
    }
  });

  it('names the worker worktree and branch, and defaults them when unset', () => {
    const named = buildSubagentMessage({
      type: 'worker',
      task: 'Fix the parser',
      worktree: 'C:/worktrees/thr_1',
      branch: 'tuffcode/thr_1',
    });
    expect(named).toContain('(C:/worktrees/thr_1, branch tuffcode/thr_1)');
    const bare = buildSubagentMessage({ type: 'worker', task: 'Fix the parser' });
    expect(bare).not.toMatch(/\{\{/);
    expect(bare).toContain('the worktree you were given');
  });

  it('puts the header first, then the body, then the footer, the task and the context', () => {
    const message = buildSubagentMessage({
      type: 'explorer',
      task: 'Map the runner',
      cwd: 'C:/worktrees/x',
      projectName: 'Demo',
      parentTitle: 'Parent',
    });
    const header = 'You are the explorer subagent working for a parent agent.';
    expect(message.startsWith(header)).toBe(true);
    expect(message.indexOf('ROLE: Find where and how something works')).toBeGreaterThan(
      message.indexOf('TOOLS:'),
    );
    expect(message.indexOf('YOUR LAST MESSAGE')).toBeGreaterThan(
      message.indexOf('ROLE: Find where and how something works'),
    );
    expect(message.indexOf('TASK\nMap the runner')).toBeGreaterThan(
      message.indexOf('YOUR LAST MESSAGE'),
    );
    expect(message).toContain('project: Demo');
    expect(message).toContain('cwd: C:/worktrees/x');
    expect(message).toContain('parent thread: Parent');
  });

  it('declares the depth parameter on the subagent tool', () => {
    expect(SUBAGENT_TOOL.name).toBe('subagent');
    expect(Object.keys(SUBAGENT_TOOL.parameters.properties)).toEqual([
      'action',
      'id',
      'text',
      'rework',
      'question_id',
      'cursor',
      'timeout_s',
      'type',
      'task',
      'model',
      'depth',
    ]);
    expect(SUBAGENT_TOOL.parameters.properties.depth?.description).toContain(
      'quick, normal or thorough',
    );
    expect(SUBAGENT_TOOL.parameters.required).toEqual([]);
  });
});

describe('parseNotetakerFacts', () => {
  it('reads facts out of prose and clamps them', () => {
    const facts = parseNotetakerFacts(
      'Here you go:\n```json\n{"facts":[{"text":"  Two   spaces  ","tags":"A, b","importance":2}]}\n```',
    );
    expect(facts).toEqual([{ text: 'Two spaces', tags: 'a,b', importance: 1 }]);
  });

  it('returns nothing for malformed or empty answers', () => {
    expect(parseNotetakerFacts('no json here')).toEqual([]);
    expect(parseNotetakerFacts('{"facts":"nope"}')).toEqual([]);
    expect(parseNotetakerFacts('{"facts":[]}')).toEqual([]);
  });

  it('caps the list at eight facts', () => {
    const facts = Array.from({ length: 12 }, (_, index) => ({ text: `fact ${index}` }));
    expect(parseNotetakerFacts(JSON.stringify({ facts }))).toHaveLength(8);
  });
});

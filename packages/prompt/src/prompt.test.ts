import { describe, expect, it } from 'vitest';

import {
  BASE_SYSTEM_PROMPT,
  CONFIG_TOOL,
  COUNCIL_PLANNER_PROMPT,
  COUNCIL_REVIEWER_PROMPT,
  COUNCIL_WORKER_BRIEF_TEMPLATE,
  CUSTOM_INSTRUCTION_TOKEN_BUDGET,
  CUSTOM_INSTRUCTIONS_HEADING,
  EXTRA_TOOL_NAMES,
  EXTRA_TOOL_SCHEMAS,
  MCP_TOOL,
  MEMORY_TOOL,
  PLAN_MODE_PROMPT,
  PROJECT_RULES_HEADING,
  REVIEWER_PROMPT,
  SUBAGENT_REWORK_LIMIT,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  assemblePrompt,
  buildCustomInstructions,
  buildSystemPrompt,
  buildTurnContext,
  estimateTokens,
} from './index';

declare const console: { log: (...args: unknown[]) => void };

const DASHES = /[\u2013\u2014]/;

const COUNCIL_HEADINGS = [
  'TASK',
  'PROJECT',
  'GOAL',
  'CONTEXT',
  'CONSTRAINTS',
  'DEFINITION OF DONE',
  'EVIDENCE',
  'REPORT BACK',
];

describe('base system prompt', () => {
  it('fits the token budget', () => {
    const tokens = estimateTokens(BASE_SYSTEM_PROMPT);
    console.log(`base system prompt: ${tokens} tokens (${BASE_SYSTEM_PROMPT.length} chars)`);
    expect(tokens).toBeGreaterThanOrEqual(1500);
    expect(tokens).toBeLessThanOrEqual(2200);
    expect(tokens).toBeLessThan(2300);
  });

  it('is ASCII only', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('scopes reviewer independence to delegated review', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('Delegated review runs on a different model family');
    expect(BASE_SYSTEM_PROMPT).toContain('verifying your own change in the same turn is normal');
    expect(BASE_SYSTEM_PROMPT).toContain('the independence rule applies to delegated review');
  });

  it('steers shell search to the grep and glob tools', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('Use grep and glob');
    for (const shell of ['Select-String', 'Get-ChildItem -Recurse', 'findstr', 'grep in bash']) {
      expect(BASE_SYSTEM_PROMPT).toContain(shell);
    }
    expect(BASE_SYSTEM_PROMPT).toContain('respect .gitignore');
    expect(BASE_SYSTEM_PROMPT).toContain('structured tool cards');
    expect(BASE_SYSTEM_PROMPT).toContain('grep modes: content, files, count');
  });

  it('covers the required rules', () => {
    for (const phrase of [
      'Tuffcode',
      'one project worktree',
      'Operating loop',
      'Investigation',
      'Subagents',
      'Memory',
      'Safety',
      'Never edit a file whose relevant context you have not read',
      'never fabricate output',
      'Lookup budget',
      'Brain notes',
      'Untrusted input',
      'SUPPORTED',
      'BLOCKED',
      'Standing rules',
      'worktree',
      'pwsh.exe',
      'CRLF',
      '248 characters',
      'taskkill /T /F',
      'ConPTY',
      'subagent',
      'memory',
    ]) {
      expect(BASE_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it('carries the delegation contract and keeps plan mode out of the base', () => {
    expect(BASE_SYSTEM_PROMPT).not.toContain('# Plan mode');
    expect(BASE_SYSTEM_PROMPT).toContain('# Subagents');
    expect(BASE_SYSTEM_PROMPT).toContain('Choose by job:');
    expect(BASE_SYSTEM_PROMPT).toContain('Each child knows only your brief');
    expect(BASE_SYSTEM_PROMPT).toContain(
      `after ${SUBAGENT_REWORK_LIMIT} rounds, stop and bring them to the user.`,
    );

    expect(PLAN_MODE_PROMPT).toContain('# Plan mode');
    expect(PLAN_MODE_PROMPT).toContain('You are planning, not building.');
    expect(PLAN_MODE_PROMPT).toContain('as Markdown under .tuffcode/plans/');
    expect(PLAN_MODE_PROMPT).toContain(
      'You are done when a worker with no history could start step 1 from the plan alone.',
    );
  });

  it('drops the old plan mode and delegation text', () => {
    expect(BASE_SYSTEM_PROMPT).not.toContain('# Delegation');
    expect(BASE_SYSTEM_PROMPT).not.toContain(
      'In plan mode change nothing: no edits, no writes, no commits.',
    );
    expect(BASE_SYSTEM_PROMPT).not.toContain(
      'A subagent has no conversation history and sees only its task string.',
    );
  });

  it('orders the fourteen base sections', () => {
    const headings = [
      '# Operating loop',
      '# Investigation',
      '# Editing',
      '# Verification',
      '# Subagents',
      '# Memory',
      '# Communication',
      '# Safety',
      '# Untrusted input',
      '# Claims',
      '# Standing rules',
      '# Windows',
      '# Output',
    ];
    let previous = -1;
    for (const heading of headings) {
      const at = BASE_SYSTEM_PROMPT.indexOf(heading);
      expect(at, heading).toBeGreaterThan(previous);
      previous = at;
    }
    expect(BASE_SYSTEM_PROMPT.indexOf('You are Tuffcode')).toBeLessThan(previous);
  });
});

describe('tool schemas', () => {
  it('serializes under the token budget', () => {
    const serialized = JSON.stringify(TOOL_SCHEMAS);
    const tokens = estimateTokens(serialized);
    console.log(`tool schemas: ${tokens} tokens (${serialized.length} chars)`);
    expect(tokens).toBeLessThan(1600);
  });

  it('defines exactly the six harness tools', () => {
    expect(TOOL_SCHEMAS).toHaveLength(6);
    expect(TOOL_SCHEMAS.map((tool) => tool.name).toSorted()).toEqual([...TOOL_NAMES].toSorted());
  });

  it('keeps descriptions short and schemas valid', () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.description.trim().split(/\s+/).length).toBeLessThanOrEqual(40);
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.parameters.required.length).toBeGreaterThan(0);
      for (const key of tool.parameters.required) {
        expect(tool.parameters.properties).toHaveProperty(key);
      }
      for (const property of Object.values(tool.parameters.properties)) {
        expect(['string', 'integer', 'boolean']).toContain(property.type);
      }
    }
  });

  it('documents the bash idle window', () => {
    const bash = TOOL_SCHEMAS.find((tool) => tool.name === 'bash');
    const idle = bash?.parameters.properties.idle_timeout_ms;
    expect(idle?.type).toBe('integer');
    expect(idle?.default).toBe(60000);
    expect(idle?.description).toContain('cannot exceed timeout_ms');
  });

  it('declares the documented parameters', () => {
    const byName = new Map(TOOL_SCHEMAS.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName.get('bash')?.parameters.properties ?? {})).toEqual([
      'command',
      'timeout_ms',
      'idle_timeout_ms',
      'cwd',
    ]);
    expect(Object.keys(byName.get('read')?.parameters.properties ?? {})).toEqual([
      'path',
      'offset',
      'limit',
    ]);
    expect(Object.keys(byName.get('edit')?.parameters.properties ?? {})).toEqual([
      'path',
      'old_string',
      'new_string',
      'replace_all',
    ]);
    expect(Object.keys(byName.get('write')?.parameters.properties ?? {})).toEqual([
      'path',
      'content',
    ]);
    expect(Object.keys(byName.get('glob')?.parameters.properties ?? {})).toEqual([
      'pattern',
      'path',
    ]);
    expect(Object.keys(byName.get('grep')?.parameters.properties ?? {})).toEqual([
      'pattern',
      'mode',
      'path',
      'glob',
      'case_sensitive',
      'max_results',
    ]);
  });
});

describe('extra tool schemas', () => {
  it('declares mcp, memory, config, todo, skill and web_fetch in order', () => {
    expect(EXTRA_TOOL_SCHEMAS).toHaveLength(6);
    expect(EXTRA_TOOL_SCHEMAS.map((tool) => tool.name)).toEqual([...EXTRA_TOOL_NAMES]);
    expect(EXTRA_TOOL_NAMES).toEqual(['mcp', 'memory', 'config', 'todo', 'skill', 'web_fetch']);
    expect(EXTRA_TOOL_SCHEMAS[0]).toBe(MCP_TOOL);
    expect(EXTRA_TOOL_SCHEMAS[1]).toBe(MEMORY_TOOL);
    expect(EXTRA_TOOL_SCHEMAS[2]).toBe(CONFIG_TOOL);
    for (const name of EXTRA_TOOL_NAMES) {
      expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    }
  });

  it('serializes under the extra token budget', () => {
    const serialized = JSON.stringify(EXTRA_TOOL_SCHEMAS);
    const tokens = estimateTokens(serialized);
    console.log(`extra tool schemas: ${tokens} tokens (${serialized.length} chars)`);
    // Six schemas since round 4 (todo, skill and web_fetch joined); the turn sends only
    // the ones its capabilities enable.
    expect(tokens).toBeLessThan(1500);
  });

  it('keeps every extra schema valid', () => {
    for (const tool of EXTRA_TOOL_SCHEMAS) {
      expect(tool.description.trim().length).toBeGreaterThan(20);
      expect(tool.parameters.type).toBe('object');
      expect(tool.parameters.additionalProperties).toBe(false);
      const required =
        { todo: 'op', skill: 'name', web_fetch: 'url' }[tool.name as string] ?? 'action';
      expect(tool.parameters.required).toContain(required);
      for (const key of tool.parameters.required) {
        expect(tool.parameters.properties).toHaveProperty(key);
      }
      for (const property of Object.values(tool.parameters.properties)) {
        expect(['string', 'integer', 'boolean']).toContain(property.type);
      }
    }
  });

  it('documents the action values in the descriptions', () => {
    const mcpAction = MCP_TOOL.parameters.properties.action?.description ?? '';
    expect(mcpAction).toContain('list');
    expect(mcpAction).toContain('call');
    expect(MCP_TOOL.parameters.properties.arguments?.type).toBe('string');

    const memoryAction = MEMORY_TOOL.parameters.properties.action?.description ?? '';
    expect(memoryAction).toContain('search');
    expect(memoryAction).toContain('add');
    const kind = MEMORY_TOOL.parameters.properties.kind?.description ?? '';
    for (const value of ['identity', 'preference', 'rule', 'project', 'memory', 'working-note']) {
      expect(kind).toContain(value);
    }

    const configAction = CONFIG_TOOL.parameters.properties.action?.description ?? '';
    for (const value of ['provider.add', 'provider.model.add', 'mcp.add', 'settings.set']) {
      expect(configAction).toContain(value);
    }
    expect(Object.keys(CONFIG_TOOL.parameters.properties)).toEqual([
      'action',
      'providerId',
      'kind',
      'label',
      'baseUrl',
      'model',
      'modelId',
      'contextWindow',
      'maxOutputTokens',
      'capabilities',
      'reasoning',
      'command',
      'args',
      'env',
      'transport',
      'url',
      'cwd',
      'token',
      'secretEnv',
      'secret',
      'apiKey',
      'key',
      'value',
    ]);
    expect(CONFIG_TOOL.parameters.properties.contextWindow?.type).toBe('integer');
    expect(CONFIG_TOOL.parameters.properties.maxOutputTokens?.type).toBe('integer');
    expect(CONFIG_TOOL.parameters.properties.capabilities?.type).toBe('string');
    expect(CONFIG_TOOL.parameters.properties.args?.type).toBe('string');
    expect(CONFIG_TOOL.parameters.properties.env?.type).toBe('string');
  });

  it('accepts credentials only through keychain fields with explicit descriptions', () => {
    const properties = CONFIG_TOOL.parameters.properties;

    for (const key of ['secret', 'apiKey', 'token', 'secretEnv', 'transport', 'url']) {
      expect(properties).toHaveProperty(key);
      expect(properties[key]?.type).toBe('string');
    }
    expect(CONFIG_TOOL.description).toContain('OS keychain');
    expect(CONFIG_TOOL.description).toContain('never echoed');
    for (const key of ['secret', 'apiKey', 'token', 'secretEnv']) {
      expect((properties[key]?.description ?? '').toLowerCase()).toContain('keychain');
    }
    expect(properties.transport?.description).toContain('stdio');
    expect(properties.transport?.description).toContain('http');
    expect(properties.url?.description).toContain('http');
    expect(properties.env?.description).toContain('secretEnv');
    expect(properties).not.toHaveProperty('api_key');
  });
});

describe('council prompts', () => {
  it('contains every worker brief heading', () => {
    for (const heading of COUNCIL_HEADINGS) {
      expect(COUNCIL_WORKER_BRIEF_TEMPLATE).toMatch(new RegExp(`^${heading}$`, 'm'));
    }
  });

  it('fills the council task cap into the planner body', () => {
    expect(COUNCIL_PLANNER_PROMPT).toContain('"tasks"');
    expect(COUNCIL_PLANNER_PROMPT).toContain('"question"');
    expect(COUNCIL_PLANNER_PROMPT).toContain('1 to 12 tasks');
    expect(COUNCIL_PLANNER_PROMPT).not.toContain('{{');
  });

  it('gives the planner one method and one JSON contract', () => {
    expect(COUNCIL_PLANNER_PROMPT).toContain(
      'ROLE: Turn one goal into the smallest set of tasks',
    );
    expect(COUNCIL_PLANNER_PROMPT).toContain('Confirm every path exists.');
    expect(COUNCIL_PLANNER_PROMPT).toContain('No two tasks own the same file.');
    expect(COUNCIL_PLANNER_PROMPT).toContain('"check":"<command>"');
    expect(COUNCIL_PLANNER_PROMPT.match(/exactly one JSON object/g)).toHaveLength(1);
    expect(COUNCIL_PLANNER_PROMPT.match(/question form/g)).toHaveLength(1);
  });

  it('gives the reviewer one three step rubric and three verdicts', () => {
    expect(COUNCIL_REVIEWER_PROMPT).toBe(REVIEWER_PROMPT);
    expect(COUNCIL_REVIEWER_PROMPT.match(/^\d\. /gm)).toHaveLength(3);
    for (const verdict of ['pass', 'changes-requested', 'escalate']) {
      expect(COUNCIL_REVIEWER_PROMPT).toContain(verdict);
    }
    for (const severity of ['blocker', 'major', 'minor']) {
      expect(COUNCIL_REVIEWER_PROMPT).toContain(severity);
    }
    expect(COUNCIL_REVIEWER_PROMPT).not.toContain('nine');
    expect(COUNCIL_REVIEWER_PROMPT).not.toContain('eleven');
    expect(COUNCIL_REVIEWER_PROMPT).toContain('DO NOT: fix anything');
    expect(COUNCIL_REVIEWER_PROMPT).toContain(
      'the first line is VERDICT: pass | changes-requested | escalate',
    );
  });

  it('requires a verify step and a stop line in the worker brief', () => {
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE).toContain('VERIFY:');
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE).toContain('output tail');
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE).toContain('STOP AND REPORT:');
    const done = COUNCIL_WORKER_BRIEF_TEMPLATE.indexOf('DEFINITION OF DONE');
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE.indexOf('VERIFY:')).toBeGreaterThan(done);
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE.indexOf('EVIDENCE')).toBeGreaterThan(
      COUNCIL_WORKER_BRIEF_TEMPLATE.indexOf('STOP AND REPORT:'),
    );
  });

  it('names council as the only pull request owner', () => {
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE).not.toContain('gh pr create');
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE).not.toContain('open the pull request');
    expect(COUNCIL_WORKER_BRIEF_TEMPLATE).toContain('the open pull request updates itself');
  });

  it('stops the worker on a missing worktree, dependency, foreign file, or contradictory brief', () => {
    const stop = COUNCIL_WORKER_BRIEF_TEMPLATE.split('\n').find((line) =>
      line.startsWith('- STOP AND REPORT:'),
    );
    expect(stop).toBeDefined();
    for (const part of [
      'worktree is missing',
      'dependency is unavailable',
      'owned by another task',
      'the brief contradicts the repository',
      'both citations',
    ]) {
      expect(stop).toContain(part);
    }
  });
});

describe('turn context', () => {
  const input = {
    date: '2026-11-24',
    mode: 'work' as const,
    cwd: 'D:\\tuffcode-wt\\prompt',
    brainSlice: 'User prefers pnpm. Windows host. No force pushes.',
    projectName: 'tuffcode',
  };

  it('renders a compact context block', () => {
    const block = buildTurnContext(input);
    const tokens = estimateTokens(block);
    console.log(`turn context: ${tokens} tokens (${block.length} chars)`);
    expect(tokens).toBeLessThan(200);
    expect(block.startsWith('<context>')).toBe(true);
    expect(block.endsWith('</context>')).toBe(true);
    expect(block).toContain('mode: work');
    expect(block).toContain('project: tuffcode');
  });

  it('stays under budget with a huge brain slice and path', () => {
    const block = buildTurnContext({
      ...input,
      cwd: `D:\\${'very-long-segment\\'.repeat(200)}`,
      brainSlice: `${'remember this. '.repeat(2000)}\nsecond line`,
    });
    expect(estimateTokens(block)).toBeLessThan(200);
    expect(block).not.toContain('\nsecond line');
  });

  it('omits the brain line when the slice is empty', () => {
    expect(buildTurnContext({ ...input, brainSlice: '   ' })).not.toContain('brain:');
  });

  it('estimates tokens at four characters each', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('buildSystemPrompt', () => {
  it('returns the base prompt without extra rules', () => {
    expect(buildSystemPrompt()).toBe(BASE_SYSTEM_PROMPT);
    expect(buildSystemPrompt({ extraRules: [] })).toBe(BASE_SYSTEM_PROMPT);
  });

  it('appends trimmed rules in order and skips blanks', () => {
    const prompt = buildSystemPrompt({
      extraRules: ['  never force push  ', '', '   ', 'use pnpm'],
    });
    expect(prompt).toContain('## Additional rules');
    expect(prompt).toContain('1. never force push');
    expect(prompt).toContain('2. use pnpm');
    expect(prompt.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
  });
});

describe('custom instructions', () => {
  it('returns undefined for empty or whitespace-only text', () => {
    expect(buildCustomInstructions('')).toBeUndefined();
    expect(buildCustomInstructions('   \n\t ')).toBeUndefined();
  });

  it('trims and normalizes line endings without changing the text', () => {
    expect(buildCustomInstructions('  Prefer pnpm.\r\nNever force push.  ')).toBe(
      'Prefer pnpm.\nNever force push.',
    );
  });

  it('keeps text inside the budget untouched', () => {
    const text = 'Use pnpm for installs. '.repeat(40).trim();
    expect(estimateTokens(text)).toBeLessThanOrEqual(CUSTOM_INSTRUCTION_TOKEN_BUDGET);
    expect(buildCustomInstructions(text)).toBe(text);
  });

  it('keeps a custom prompt at the full 16,000 character UI limit', () => {
    const text = 'x'.repeat(16_000);
    const kept = buildCustomInstructions(text);
    expect(kept).toBe(text);
    expect(kept?.length).toBe(16_000);
  });

  it('caps at the token budget and cuts on a sentence boundary', () => {
    const sentence = 'Always run the narrow test before claiming a change works. ';
    const text = sentence.repeat(300);
    const capped = buildCustomInstructions(text);
    expect(capped).toBeDefined();
    expect(estimateTokens(capped ?? '')).toBeLessThanOrEqual(CUSTOM_INSTRUCTION_TOKEN_BUDGET);
    expect(capped?.endsWith('works.')).toBe(true);
    expect(text.startsWith(capped ?? '\u0000')).toBe(true);
  });

  it('falls back to a word boundary when the cap lands inside one long sentence', () => {
    const capped = buildCustomInstructions(`${'word '.repeat(4000)}end`);
    expect(estimateTokens(capped ?? '')).toBeLessThanOrEqual(CUSTOM_INSTRUCTION_TOKEN_BUDGET);
    expect(capped?.endsWith('word')).toBe(true);
  });
});

describe('assemblePrompt', () => {
  const turnContext = {
    date: '2026-11-24',
    mode: 'work' as const,
    cwd: 'D:\\repo',
    projectName: 'demo',
    brainSlice: '',
  };

  it('orders base, custom instructions, brain, memory, context, then the user message', () => {
    const assembly = assemblePrompt({
      customInstructions: 'Prefer pnpm.',
      brainAlways: '- [rule] never force push',
      retrievedMemory: '- [memory] tests live in packages',
      turnContext,
      userMessage: 'run the tests',
    });

    expect(assembly.sections.map((entry) => entry.name)).toEqual([
      'base',
      'custom-instructions',
      'brain-always',
      'retrieved-memory',
      'turn-context',
      'user-message',
    ]);
    expect(assembly.sections[0]?.text).toBe(BASE_SYSTEM_PROMPT);
    expect(assembly.sections.at(-1)?.text).toBe('run the tests');

    const system = assembly.systemPrompt;
    expect(system.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain('## Brain notes\n- [rule] never force push');
    expect(system).toContain('## Retrieved memory\n- [memory] tests live in packages');
    expect(system.indexOf(CUSTOM_INSTRUCTIONS_HEADING)).toBeLessThan(
      system.indexOf('never force push'),
    );
    expect(system.indexOf('## Brain notes')).toBeLessThan(system.indexOf('never force push'));
    expect(system.indexOf('never force push')).toBeLessThan(system.indexOf('## Retrieved memory'));
    expect(system.indexOf('tests live in packages')).toBeLessThan(system.indexOf('<context>'));
    expect(system).not.toContain('run the tests');
    expect(assembly.total).toBe(assembly.sections.reduce((sum, entry) => sum + entry.tokens, 0));
  });

  it('keeps the cached prefix identical when the message changes rules and skills', () => {
    const first = assemblePrompt({
      projectRules: '- alpha rule',
      skills: 'alpha skill body',
      availableSkills: '- alpha: does alpha',
      turnContext,
      userMessage: 'first message',
    });
    const second = assemblePrompt({
      projectRules: '- beta rule',
      skills: 'beta skill body',
      availableSkills: '- beta: does beta',
      turnContext,
      userMessage: 'second message',
    });

    expect(first.staticPrefix).toBe(second.staticPrefix);
    expect(first.staticPrefix).not.toContain('alpha rule');
    expect(first.staticPrefix).not.toContain('alpha skill');
    expect(first.dynamicPrompt).toContain('alpha rule');
    expect(second.dynamicPrompt).toContain('beta rule');
  });

  it('adds the plan mode rubric only on a plan turn', () => {
    const work = assemblePrompt({ turnContext, userMessage: 'build it' });
    expect(work.sections.some((entry) => entry.name === 'plan-mode')).toBe(false);
    expect(work.systemPrompt).not.toContain('# Plan mode');

    const plan = assemblePrompt({
      turnContext: { ...turnContext, mode: 'plan' },
      userMessage: 'plan it',
    });
    expect(plan.sections.map((entry) => entry.name)).toEqual([
      'base',
      'plan-mode',
      'turn-context',
      'user-message',
    ]);
    expect(plan.systemPrompt).toContain('# Plan mode');
    expect(plan.total).toBeGreaterThan(work.total);
  });

  it('omits empty custom instructions and empty brain blocks', () => {
    const assembly = assemblePrompt({
      customInstructions: '   ',
      brainAlways: '  ',
      retrievedMemory: '',
      turnContext,
      userMessage: 'hi',
    });
    expect(assembly.sections.map((entry) => entry.name)).toEqual([
      'base',
      'turn-context',
      'user-message',
    ]);
    expect(assembly.systemPrompt).not.toContain(CUSTOM_INSTRUCTIONS_HEADING);
    const texts = assembly.sections.map((entry) => entry.text);
    expect(texts.some((text) => text.startsWith('## Brain notes'))).toBe(false);
    expect(texts.some((text) => text.startsWith('## Retrieved memory'))).toBe(false);
  });

  it('adds each brain heading only when its block is non-empty', () => {
    const alwaysOnly = assemblePrompt({
      brainAlways: '- [rule] stage explicit paths',
      turnContext,
      userMessage: 'hi',
    });
    expect(alwaysOnly.sections.find((entry) => entry.name === 'brain-always')?.text).toBe(
      '## Brain notes\n- [rule] stage explicit paths',
    );
    expect(alwaysOnly.sections.some((entry) => entry.name === 'retrieved-memory')).toBe(false);

    const retrievedOnly = assemblePrompt({
      retrievedMemory: '- [memory] run the narrow test first',
      turnContext,
      userMessage: 'hi',
    });
    expect(retrievedOnly.sections.find((entry) => entry.name === 'retrieved-memory')?.text).toBe(
      '## Retrieved memory\n- [memory] run the narrow test first',
    );
    expect(retrievedOnly.sections.some((entry) => entry.name === 'brain-always')).toBe(false);
  });

  it('counts every section at four characters per token', () => {
    const assembly = assemblePrompt({ turnContext, userMessage: 'abcd' });
    for (const entry of assembly.sections) {
      expect(entry.tokens).toBe(estimateTokens(entry.text));
    }
    expect(assembly.sections.at(-1)?.tokens).toBe(1);
  });

  it('places project rules after custom instructions and before brain notes', () => {
    const rules = '### AGENTS.md\nRun the narrow test first.';
    const assembly = assemblePrompt({
      customInstructions: 'Prefer pnpm.',
      projectRules: rules,
      brainAlways: '- [rule] never force push',
      turnContext,
      userMessage: 'run the tests',
    });

    expect(assembly.sections.map((entry) => entry.name)).toEqual([
      'base',
      'custom-instructions',
      'project-rules',
      'brain-always',
      'turn-context',
      'user-message',
    ]);
    const section = assembly.sections.find((entry) => entry.name === 'project-rules');
    expect(section?.text).toBe(
      `${PROJECT_RULES_HEADING}\nRules committed in this repository. Follow them for this turn.\n${rules}`,
    );
    expect(section?.tokens).toBe(estimateTokens(section?.text ?? ''));
    expect(section?.tokens).toBeGreaterThan(0);
    const system = assembly.systemPrompt;
    expect(system.indexOf(CUSTOM_INSTRUCTIONS_HEADING)).toBeLessThan(
      system.indexOf(PROJECT_RULES_HEADING),
    );
    expect(system.indexOf(PROJECT_RULES_HEADING)).toBeLessThan(system.indexOf('never force push'));
    expect(system).toContain('### AGENTS.md');
  });

  it('omits the project rules section when no rule applies', () => {
    const assembly = assemblePrompt({
      projectRules: '   ',
      turnContext,
      userMessage: 'hi',
    });
    expect(assembly.sections.map((entry) => entry.name)).toEqual([
      'base',
      'turn-context',
      'user-message',
    ]);
    expect(assembly.systemPrompt).not.toContain(PROJECT_RULES_HEADING);
  });
});

describe('character hygiene', () => {
  it('contains no em dash or en dash in any prompt or schema', () => {
    for (const text of [
      BASE_SYSTEM_PROMPT,
      COUNCIL_PLANNER_PROMPT,
      COUNCIL_WORKER_BRIEF_TEMPLATE,
      COUNCIL_REVIEWER_PROMPT,
      JSON.stringify(TOOL_SCHEMAS),
      JSON.stringify(EXTRA_TOOL_SCHEMAS),
      buildSystemPrompt({ extraRules: ['plain rule'] }),
      buildTurnContext({
        date: '2026-11-24',
        mode: 'plan',
        cwd: 'C:\\repo',
        brainSlice: 'slice',
        projectName: 'demo',
      }),
    ]) {
      expect(text).not.toMatch(DASHES);
    }
  });
});

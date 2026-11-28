import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptSection } from '@tuffcode/prompt';
import {
  BASE_SYSTEM_PROMPT,
  CUSTOM_INSTRUCTIONS_HEADING,
  CUSTOM_INSTRUCTION_TOKEN_BUDGET,
  PROJECT_RULES_HEADING,
  estimateTokens,
} from '@tuffcode/prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALWAYS_TOKEN_BUDGET, RETRIEVAL_TOKEN_BUDGET } from '../brain/selector.js';
import { RpcError } from '../errors.js';
import { createTestContext, type TestContext } from '../test-support.js';
import { createPromptHandlers } from './rpc.js';
import {
  REVIEW_COMMENT_CHARS,
  REVIEW_COMMENT_LIMIT,
  REVIEW_COMMENT_TOKEN_BUDGET,
  planPrompt,
} from './service.js';

const ISO = '2026-11-24T10:00:00.000Z';

interface PreviewResult {
  sections: PromptSection[];
  total: number;
  injectedIds?: string[];
  injectionReasons?: Record<string, string>;
}

function preview(ctx: TestContext, message: string): PreviewResult {
  const handler = createPromptHandlers({ repos: ctx.repos }).get('prompt.preview');
  if (handler === undefined) throw new Error('prompt.preview is not registered');
  return handler({ threadId: 'thr_p', message }) as PreviewResult;
}

describe('prompt planning', () => {
  let contexts: TestContext[] = [];

  function setup(): TestContext {
    const ctx = createTestContext();
    contexts.push(ctx);
    ctx.repos.projects.add({
      id: 'prj_p',
      name: 'preview',
      path: ctx.env.root,
      defaultBranch: 'main',
      createdAt: ISO,
    });
    ctx.repos.threads.create({
      id: 'thr_p',
      projectId: 'prj_p',
      parentThreadId: null,
      title: 'preview thread',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'ask',
      status: 'idle',
      worktreePath: null,
      branch: null,
      baseBranch: 'main',
      createdAt: ISO,
      updatedAt: ISO,
    });
    return ctx;
  }

  beforeEach(() => {
    contexts = [];
  });

  afterEach(() => {
    for (const ctx of contexts) ctx.dispose();
    contexts = [];
  });

  it('returns exactly the sections the runner assembles, in order', () => {
    const ctx = setup();
    ctx.repos.settings.patch({ customInstructions: 'Prefer pnpm. Never force push.' });
    ctx.repos.brain.upsert({
      kind: 'rule',
      scope: 'global',
      text: 'never use emdash',
      appliesTo: 'all',
    });
    ctx.repos.brain.upsert({
      kind: 'memory',
      scope: 'global',
      text: 'preview must match the send path',
    });
    const message = 'how do I run the preview';
    const thread = ctx.repos.threads.get('thr_p');
    const project = ctx.repos.projects.get('prj_p');
    if (thread === undefined || project === undefined) throw new Error('fixture is incomplete');

    const plan = planPrompt(ctx.repos, {
      thread,
      project,
      message,
      settings: ctx.repos.settings.get(),
    });
    const result = preview(ctx, message);

    expect(result.sections).toEqual(plan.assembly.sections);
    expect(result.total).toBe(plan.assembly.total);
    expect(result.sections.map((section) => section.name)).toEqual([
      'base',
      'custom-instructions',
      'available-skills',
      'brain-always',
      'retrieved-memory',
      'turn-context',
      'user-message',
    ]);
    expect(result.sections[0]?.text).toBe(BASE_SYSTEM_PROMPT);
    expect(result.sections.at(-1)?.text).toBe(message);

    const system = result.sections
      .filter((section) => section.name !== 'user-message')
      .map((section) => section.text)
      .join('\n\n');
    expect(system).toBe(plan.assembly.systemPrompt);
    expect(system).toContain('Prefer pnpm. Never force push.');
    expect(system).toContain('never use emdash');
    expect(system).toContain('preview must match the send path');
    // A thread without a worktree previews against the project path.
    expect(system).toContain(ctx.env.root);
  });

  it('previews the project rules section with its token count and file paths', () => {
    const ctx = setup();
    ctx.repos.settings.patch({ customInstructions: 'Prefer pnpm.' });
    writeFileSync(join(ctx.env.root, 'AGENTS.md'), 'Run the narrow test first.\n');
    mkdirSync(join(ctx.env.root, '.tuffcode', 'rules'), { recursive: true });
    writeFileSync(
      join(ctx.env.root, '.tuffcode', 'rules', 'testing.md'),
      'Name tests after the behaviour they pin.\n',
    );

    const result = preview(ctx, 'run the tests');

    expect(result.sections.map((section) => section.name)).toEqual([
      'base',
      'custom-instructions',
      'project-rules',
      'available-skills',
      'turn-context',
      'user-message',
    ]);
    const section = result.sections.find((entry) => entry.name === 'project-rules');
    expect(section?.text.startsWith(PROJECT_RULES_HEADING)).toBe(true);
    expect(section?.tokens).toBe(estimateTokens(section?.text ?? ''));
    expect(section?.tokens).toBeGreaterThan(0);
    expect(section?.text).toContain('### AGENTS.md');
    expect(section?.text).toContain('### .tuffcode/rules/testing.md');
    expect(section?.text.indexOf('### AGENTS.md')).toBeLessThan(
      section?.text.indexOf('### .tuffcode/rules/testing.md') ?? -1,
    );
    expect(result.total).toBe(result.sections.reduce((sum, entry) => sum + entry.tokens, 0));
  });

  it('applies a glob-scoped rule only when the message names a matching path', () => {
    const ctx = setup();
    mkdirSync(join(ctx.env.root, '.tuffcode', 'rules'), { recursive: true });
    writeFileSync(
      join(ctx.env.root, '.tuffcode', 'rules', 'web.md'),
      ['---', 'globs: apps/web/**', '---', 'Use the design tokens for colour.'].join('\n'),
    );

    const matching = preview(ctx, 'fix apps/web/src/app.tsx');
    const section = matching.sections.find((entry) => entry.name === 'project-rules');
    expect(section?.text).toContain('### .tuffcode/rules/web.md');
    expect(section?.text).toContain('Use the design tokens for colour.');

    const unrelated = preview(ctx, 'fix the server tests');
    expect(unrelated.sections.some((entry) => entry.name === 'project-rules')).toBe(false);
  });

  it('injects the edit-tuffcode body when the message asks to change Tuffcode', () => {
    const ctx = setup();

    const result = preview(ctx, 'add this MCP server with this token');
    const skills = result.sections.find((section) => section.name === 'skills');

    expect(skills).toBeDefined();
    expect(skills?.text).toContain('### Skill: edit-tuffcode');
    expect(skills?.text).toContain('`config` tool');
    expect(skills?.text).toContain('keychain');
    const available = result.sections.find((section) => section.name === 'available-skills');
    expect(available?.text ?? '').not.toContain('- edit-tuffcode:');
  });

  it('does not inject the edit-tuffcode body for an ordinary request', () => {
    const ctx = setup();

    const result = preview(ctx, 'how do I run the preview');

    expect(result.sections.some((section) => section.name === 'skills')).toBe(false);
    const available = result.sections.find((section) => section.name === 'available-skills');
    expect(available?.text).toContain('- edit-tuffcode:');
  });

  it('reports the injected brain ids and their reasons', () => {
    const ctx = setup();
    const rule = ctx.repos.brain.upsert({
      kind: 'rule',
      scope: 'global',
      text: 'never use emdash',
      appliesTo: 'all',
    });

    const result = preview(ctx, 'hello');
    expect(result.injectedIds).toEqual([rule.id]);
    expect(result.injectionReasons).toEqual({ [rule.id]: 'standing rule for every turn' });
    expect(result.sections.some((section) => section.name === 'brain-always')).toBe(true);
  });

  it('reports no injected ids when the brain kill switch is off', () => {
    const ctx = setup();
    ctx.repos.brain.upsert({
      kind: 'rule',
      scope: 'global',
      text: 'never use emdash',
      appliesTo: 'all',
    });
    ctx.repos.settings.patch({ brainEnabled: false });

    const result = preview(ctx, 'hello');
    expect(result.injectedIds).toEqual([]);
    expect(result.injectionReasons).toEqual({});
    expect(result.sections.some((section) => section.name === 'brain-always')).toBe(false);
  });

  it('never advances brain usage counters', () => {
    const ctx = setup();
    const entry = ctx.repos.brain.upsert({
      kind: 'memory',
      scope: 'global',
      text: 'countercheck marker',
    });
    preview(ctx, 'countercheck');
    expect(ctx.repos.brain.get(entry.id)?.useCount).toBe(0);
    expect(ctx.repos.brain.get(entry.id)?.lastUsedAt).toBeNull();
  });

  it('caps custom instructions at the shared token budget on a sentence boundary', () => {
    const ctx = setup();
    ctx.repos.settings.patch({
      customInstructions: 'Keep every answer short and concrete. '.repeat(400),
    });
    const section = preview(ctx, 'hello').sections.find(
      (entry) => entry.name === 'custom-instructions',
    );
    expect(section).toBeDefined();
    expect(section?.text.startsWith(CUSTOM_INSTRUCTIONS_HEADING)).toBe(true);
    const body = (section?.text ?? '').slice(CUSTOM_INSTRUCTIONS_HEADING.length).trim();
    expect(estimateTokens(body)).toBeLessThanOrEqual(CUSTOM_INSTRUCTION_TOKEN_BUDGET);
    expect(estimateTokens(body)).toBeGreaterThan(CUSTOM_INSTRUCTION_TOKEN_BUDGET - 500);
    expect(body.endsWith('concrete.')).toBe(true);
  });

  it('includes unresolved review comments and leaves resolved ones out', () => {
    const ctx = setup();
    ctx.repos.comments.create({
      id: 'rc_open',
      threadId: 'thr_p',
      filePath: 'src/a.ts',
      line: 12,
      side: 'new',
      body: 'Handle the null case.',
      createdAt: ISO,
    });
    ctx.repos.comments.create({
      id: 'rc_done',
      threadId: 'thr_p',
      filePath: 'src/b.ts',
      line: 3,
      side: 'old',
      body: 'Already fixed.',
      createdAt: ISO,
    });
    ctx.repos.comments.setResolved('rc_done', true);

    const section = preview(ctx, 'fix the review').sections.find(
      (entry) => entry.name === 'review-comments',
    );

    expect(section?.text).toContain('src/a.ts:12 (new): Handle the null case.');
    expect(section?.text).not.toContain('Already fixed.');
  });

  it('leaves out a comment an earlier turn already carried', () => {
    const ctx = setup();
    ctx.repos.comments.create({
      id: 'rc_sent',
      threadId: 'thr_p',
      filePath: 'src/sent.ts',
      line: 1,
      side: 'new',
      body: 'Already sent to the agent.',
      createdAt: ISO,
    });
    ctx.repos.comments.markDelivered(['rc_sent'], ISO);
    ctx.repos.comments.create({
      id: 'rc_new',
      threadId: 'thr_p',
      filePath: 'src/new.ts',
      line: 2,
      side: 'new',
      body: 'Not sent yet.',
      createdAt: ISO,
    });

    const section = preview(ctx, 'fix the review').sections.find(
      (entry) => entry.name === 'review-comments',
    );

    expect(section?.text).toContain('src/new.ts:2 (new): Not sent yet.');
    expect(section?.text).not.toContain('Already sent to the agent.');
  });

  it('keeps the newest comments and says how many were left out', () => {
    const ctx = setup();
    for (let index = 1; index <= REVIEW_COMMENT_LIMIT + 1; index += 1) {
      ctx.repos.comments.create({
        id: `rc_${index}`,
        threadId: 'thr_p',
        filePath: `src/f${index}.ts`,
        line: index,
        side: 'new',
        body: `body-${index}`,
        createdAt: ISO,
      });
    }

    const section = preview(ctx, 'fix the review').sections.find(
      (entry) => entry.name === 'review-comments',
    );
    const lines = section?.text.split('\n') ?? [];
    const entries = lines.filter((line) => line.startsWith('- '));

    expect(entries).toHaveLength(REVIEW_COMMENT_LIMIT);
    // Newest first: the last comment written is the first line, the oldest is dropped.
    expect(entries[0]).toContain(`src/f${REVIEW_COMMENT_LIMIT + 1}.ts`);
    expect(entries.at(-1)).toContain('src/f2.ts');
    expect(section?.text).not.toContain('src/f1.ts');
    expect(section?.text).toContain('1 more comment omitted');
  });

  it('truncates a long comment body to the character cap', () => {
    const ctx = setup();
    ctx.repos.comments.create({
      id: 'rc_long',
      threadId: 'thr_p',
      filePath: 'src/long.ts',
      line: 4,
      side: 'new',
      body: 'x'.repeat(REVIEW_COMMENT_CHARS + 100),
      createdAt: ISO,
    });

    const section = preview(ctx, 'fix the review').sections.find(
      (entry) => entry.name === 'review-comments',
    );

    expect(section?.text).toContain(`${'x'.repeat(REVIEW_COMMENT_CHARS - 3)}...`);
    expect(section?.text).not.toContain('x'.repeat(REVIEW_COMMENT_CHARS + 1));
  });

  it('holds the review comment section inside its token budget', () => {
    const ctx = setup();
    for (let index = 1; index <= 40; index += 1) {
      ctx.repos.comments.create({
        id: `rc_big_${index}`,
        threadId: 'thr_p',
        filePath: `src/big${index}.ts`,
        line: index,
        side: 'new',
        body: 'y'.repeat(REVIEW_COMMENT_CHARS),
        createdAt: ISO,
      });
    }

    const section = preview(ctx, 'fix the review').sections.find(
      (entry) => entry.name === 'review-comments',
    );
    const entries = (section?.text.split('\n') ?? []).filter((line) => line.startsWith('- '));

    expect(section).toBeDefined();
    // The heading and instruction add a small fixed cost over the list budget.
    expect(section?.tokens ?? 0).toBeLessThanOrEqual(REVIEW_COMMENT_TOKEN_BUDGET + 80);
    expect(entries.length).toBeLessThan(40);
    expect(entries[0]).toContain('src/big40.ts');
    expect(section?.text).toMatch(/\d+ more comments? omitted/);
  });

  it('omits the custom section when settings hold only whitespace', () => {
    const ctx = setup();
    ctx.repos.settings.patch({ customInstructions: '   \n  ' });
    const result = preview(ctx, 'hello');
    expect(result.sections.map((section) => section.name)).toEqual([
      'base',
      'available-skills',
      'turn-context',
      'user-message',
    ]);
    expect(
      result.sections.some((section) => section.text.includes(CUSTOM_INSTRUCTIONS_HEADING)),
    ).toBe(false);
  });

  it('keeps the brain budgets at 400 tokens each', () => {
    const ctx = setup();
    for (let index = 0; index < 40; index += 1) {
      ctx.repos.brain.upsert({
        kind: 'preference',
        scope: 'global',
        text: `preference ${index} ${'detail '.repeat(20)}`,
        importance: 0.5,
      });
    }
    for (let index = 0; index < 20; index += 1) {
      ctx.repos.brain.upsert({
        kind: 'memory',
        scope: 'global',
        text: `budgetmarker ${index} ${'context '.repeat(20)}`,
        importance: 0.9,
      });
    }

    const result = preview(ctx, 'budgetmarker context');
    const always = result.sections.find((section) => section.name === 'brain-always');
    const retrieved = result.sections.find((section) => section.name === 'retrieved-memory');

    expect(ALWAYS_TOKEN_BUDGET).toBe(400);
    expect(RETRIEVAL_TOKEN_BUDGET).toBe(400);
    expect(always).toBeDefined();
    expect(retrieved).toBeDefined();
    expect(always?.tokens).toBeLessThanOrEqual(ALWAYS_TOKEN_BUDGET);
    expect(retrieved?.tokens).toBeLessThanOrEqual(RETRIEVAL_TOKEN_BUDGET);
  });

  it('rejects an unknown thread instead of previewing an empty prompt', () => {
    const ctx = setup();
    const handler = createPromptHandlers({ repos: ctx.repos }).get('prompt.preview');
    if (handler === undefined) throw new Error('prompt.preview is not registered');
    try {
      handler({ threadId: 'thr_missing', message: 'hello' });
      expect.unreachable('preview should throw for an unknown thread');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe('not-found');
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildPlannerPrompt,
  buildReviewPrompt,
  buildRevisionBrief,
  buildWorkerBrief,
  parsePullRequestUrl,
  parseReviewVerdict,
} from './prompts.js';
import type { PlanTask } from './types.js';

const task: PlanTask = {
  title: 'Wire the widget',
  files: ['src/widget.ts'],
  dependsOn: [],
  critical: false,
  brief: 'Add the widget and test it.',
};

const workerBriefInput = {
  task,
  goal: 'Ship widgets',
  goalId: 'gol_1',
  projectName: 'Demo',
  projectPath: 'C:/demo',
  baseBranch: 'main',
  worktreePath: 'C:/worktrees/thr_1',
  branch: 'tuffcode/thr_1',
  taskIndex: 0,
  taskCount: 2,
};

describe('buildPlannerPrompt', () => {
  it('carries the goal, project, and base branch', () => {
    const prompt = buildPlannerPrompt({
      goal: 'Ship widgets',
      projectName: 'Demo',
      projectPath: 'C:/demo',
      baseBranch: 'main',
    });
    expect(prompt).toContain('Ship widgets');
    expect(prompt).toContain('Demo at C:/demo');
    expect(prompt).toContain('main');
    expect(prompt).toContain('{"tasks":');
  });

  it('fills the council task cap and leaves no placeholder', () => {
    const prompt = buildPlannerPrompt({
      goal: 'Ship widgets',
      projectName: 'Demo',
      projectPath: 'C:/demo',
      baseBranch: 'main',
    });
    expect(prompt).toContain('1 to 12 tasks');
    expect(prompt).not.toContain('{{');
  });
});

describe('buildWorkerBrief', () => {
  it('fills every template placeholder and adds the council addendum', () => {
    const brief = buildWorkerBrief(workerBriefInput);
    expect(brief).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(brief).toContain('Wire the widget');
    expect(brief).toContain('C:/worktrees/thr_1');
    expect(brief).toContain('tuffcode/thr_1');
    expect(brief).toContain('Task 1 of 2');
    expect(brief).toContain('do not run gh pr create');
  });

  it('states the pull request owner exactly once', () => {
    const brief = buildWorkerBrief(workerBriefInput);
    expect(brief.match(/gh pr create/g)).toHaveLength(1);
    expect(brief.match(/Council opens the pull request/g)).toHaveLength(1);
  });
});

describe('buildReviewPrompt', () => {
  it('includes the brief, the pull request and the diff', () => {
    const prompt = buildReviewPrompt({
      task,
      prUrl: 'https://example.test/pull/7',
      workerReport: 'Tests pass.',
      patch: 'diff --git a/src/widget.ts b/src/widget.ts',
    });
    expect(prompt).toContain('VERDICT: pass | changes-requested | escalate');
    expect(prompt).toContain('https://example.test/pull/7');
    expect(prompt).toContain('BRIEF');
    expect(prompt).toContain('diff --git');
  });

  it('never shows the worker report to the reviewer', () => {
    const prompt = buildReviewPrompt({
      task,
      prUrl: 'https://example.test/pull/7',
      workerReport: 'Tests pass and every check is green.',
      patch: 'diff --git a/src/widget.ts b/src/widget.ts',
    });
    expect(prompt).not.toContain('Tests pass and every check is green.');
    expect(prompt).not.toContain('WORKER REPORT');
  });

  it('marks an empty patch instead of sending an empty section', () => {
    const prompt = buildReviewPrompt({
      task,
      prUrl: 'https://example.test/pull/7',
      workerReport: 'Nothing.',
      patch: '   ',
    });
    expect(prompt).toContain('(no patch available)');
  });
});

describe('buildRevisionBrief', () => {
  it('prints the round and the limit', () => {
    const brief = buildRevisionBrief({
      round: 2,
      findings: '1. [blocker] src/widget.ts:3: the null check is missing. Expected: a guard.',
    });
    expect(brief).toContain('REWORK ROUND 2 OF 3');
    expect(brief).toContain('the null check is missing');
    expect(brief).toContain('Then rerun: the check from your brief');
    expect(brief).toContain('one line per finding');
  });

  it('uses the pull request and the check when the caller knows them', () => {
    const brief = buildRevisionBrief({
      round: 1,
      findings: '1. [major] src/widget.ts:9: wrong branch.',
      prUrlOrBranch: 'https://example.test/pull/7',
      check: 'pnpm test widget',
    });
    expect(brief).toContain('REWORK ROUND 1 OF 3 for https://example.test/pull/7');
    expect(brief).toContain('Then rerun: pnpm test widget');
  });
});

describe('parseReviewVerdict', () => {
  it('reads the verdict line regardless of case or spacing', () => {
    expect(parseReviewVerdict('VERDICT: pass\nFINDINGS: none')).toBe('pass');
    expect(parseReviewVerdict('  verdict :   changes-requested ')).toBe('changes-requested');
    expect(parseReviewVerdict('VERDICT: ESCALATE')).toBe('escalate');
  });

  it('escalates a reply without a valid verdict', () => {
    expect(parseReviewVerdict('Looks fine to me.')).toBe('escalate');
    expect(parseReviewVerdict('VERDICT: maybe')).toBe('escalate');
  });
});

describe('parsePullRequestUrl', () => {
  it('finds and trims a pull request URL', () => {
    expect(parsePullRequestUrl('Opened https://github.com/o/r/pull/42.')).toBe(
      'https://github.com/o/r/pull/42',
    );
    expect(parsePullRequestUrl('no link here')).toBeNull();
  });
});

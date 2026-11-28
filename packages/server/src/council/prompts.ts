import type { ReviewVerdict } from '@tuffcode/contracts';
import {
  COUNCIL_PLANNER_PROMPT,
  COUNCIL_REVIEWER_PROMPT,
  COUNCIL_WORKER_BRIEF_TEMPLATE,
} from '@tuffcode/prompt';
import { COUNCIL_CAPS } from './caps.js';
import type { PlanTask } from './types.js';

const MAX_PROMPT_PATCH_CHARS = 80_000;

const WORKER_ADDENDUM = `COUNCIL COORDINATION
Council opens the pull request; do not run gh pr create.
Commit only the paths you own with explicit git add arguments, then push your branch with git push -u origin HEAD.
Leave the worktree clean: no uncommitted files, no lockfile edits, no new dependencies.`;

export interface PlannerPromptInput {
  goal: string;
  projectName: string;
  projectPath: string;
  baseBranch: string;
  /** Set when the captain sent the previous plan back; the planner revises that plan. */
  revision?: { round: number; feedback: string };
}

export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const lines = [
    COUNCIL_PLANNER_PROMPT,
    '',
    'GOAL',
    input.goal,
    '',
    'PROJECT',
    `${input.projectName} at ${input.projectPath}`,
    '',
    'BASE BRANCH',
    input.baseBranch,
  ];
  if (input.revision !== undefined) {
    lines.push(
      '',
      'REVISION',
      `Round ${input.revision.round} of ${COUNCIL_CAPS.planRevisions}: the captain rejected the previous plan.`,
      'CAPTAIN FEEDBACK',
      input.revision.feedback.trim(),
      'Return a corrected plan in the same JSON shape. Change only what the feedback asks for.',
    );
  }
  return lines.join('\n');
}

export interface WorkerBriefInput {
  task: PlanTask;
  goal: string;
  goalId: string;
  projectName: string;
  projectPath: string;
  baseBranch: string;
  worktreePath: string;
  branch: string;
  taskIndex: number;
  taskCount: number;
}

export function buildWorkerBrief(input: WorkerBriefInput): string {
  const values: Record<string, string> = {
    task_title: input.task.title,
    task_brief: input.task.brief,
    project_name: input.projectName,
    project_path: input.projectPath,
    base_branch: input.baseBranch,
    issue_ref: `council goal ${input.goalId}`,
    worktree: input.worktreePath,
    branch: input.branch,
    goal: input.goal,
    context: `Task ${input.taskIndex + 1} of ${input.taskCount}. You own: ${input.task.files.join(', ')}. Other council workers own every other path; do not touch them.`,
    acceptance_checks: [
      '- Implement the brief exactly, with no unrelated changes.',
      '- Run the checks that cover the change and paste the tail of their output.',
      '- Commit your changes and push the branch.',
    ].join('\n'),
    evidence_requirements:
      'Report the exact commands you ran with their tail output, and state anything you could not verify.',
  };

  let brief = COUNCIL_WORKER_BRIEF_TEMPLATE;
  for (const [key, value] of Object.entries(values)) {
    brief = brief.replaceAll(`{{${key}}}`, value);
  }
  const leftover = /\{\{[a-z_]+\}\}/.exec(brief);
  if (leftover !== null) {
    throw new Error(`worker brief has an unknown placeholder: ${leftover[0]}`);
  }
  return `${brief}\n\n${WORKER_ADDENDUM}`;
}

export interface ReviewPromptInput {
  task: PlanTask;
  prUrl: string;
  /**
   * Kept for the call site only. The reviewer never reads the worker's own claims of
   * success: the check it runs itself is the evidence.
   */
  workerReport: string;
  patch: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const patch =
    input.patch.trim().length === 0
      ? '(no patch available)'
      : input.patch.slice(0, MAX_PROMPT_PATCH_CHARS);
  return [
    COUNCIL_REVIEWER_PROMPT,
    '',
    'TASK',
    input.task.title,
    '',
    'BRIEF',
    input.task.brief,
    '',
    'OWNED FILES',
    ...input.task.files.map((file) => `- ${file}`),
    '',
    'PULL REQUEST',
    input.prUrl,
    '',
    'DIFF',
    patch,
  ].join('\n');
}

export interface RevisionBriefInput {
  round: number;
  findings: string;
  /** The pull request or branch under review, when the caller knows it. */
  prUrlOrBranch?: string;
  /** The check the worker must rerun; the brief's own check when unset. */
  check?: string;
}

export function buildRevisionBrief(input: RevisionBriefInput): string {
  const target = input.prUrlOrBranch?.trim();
  const check = input.check?.trim();
  return [
    `REWORK ROUND ${input.round} OF ${COUNCIL_CAPS.reviewRounds} for ${target === undefined || target.length === 0 ? 'the same branch and pull request' : target}`,
    'A review of your change found these problems. Fix each one and change nothing else.',
    input.findings.trim(),
    '(each: [severity] path:line: what is wrong. Expected: what correct looks like)',
    '',
    `Then rerun: ${check === undefined || check.length === 0 ? 'the check from your brief' : check}`,
    'Commit to the same branch so the pull request updates, and reply with one line per finding: "N fixed at path:line" or "N not fixed: reason".',
  ].join('\n');
}

export interface CaptainRevisionInput {
  /** The escalation question the reviewer or the round cap raised. */
  question: string;
  /** What the captain wants changed. */
  feedback: string;
}

/**
 * The turn a captain answer sends to an escalated task's existing child thread. It
 * carries both the question and the feedback, because the worker never saw either.
 */
export function buildCaptainRevisionBrief(input: CaptainRevisionInput): string {
  return [
    'CAPTAIN REVISION for the same branch and pull request',
    'A reviewer escalated this task and the captain asked for one more change. Address the captain feedback and change nothing else.',
    '',
    'ESCALATION',
    input.question.trim(),
    '',
    'CAPTAIN FEEDBACK',
    input.feedback.trim(),
    '',
    'Then rerun the check from your brief.',
    'Commit to the same branch so the pull request updates, and reply with one line per change.',
  ].join('\n');
}

/** Reads the reviewer verdict. A reply without a valid verdict escalates. */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const match = /^\s*VERDICT\s*:\s*(pass|changes-requested|escalate)\b/im.exec(text);
  const value = match?.[1]?.toLowerCase();
  if (value === 'pass') return 'pass';
  if (value === 'changes-requested') return 'changes-requested';
  return 'escalate';
}

const PULL_REQUEST_URL = /https?:\/\/[^\s]+\/pull\/\d+/;

/** Finds a pull request URL the worker may have opened despite the addendum. */
export function parsePullRequestUrl(text: string): string | null {
  const match = PULL_REQUEST_URL.exec(text);
  if (match === null) return null;
  return match[0].replace(/[.,)]+$/, '');
}

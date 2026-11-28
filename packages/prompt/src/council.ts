/**
 * Prompts for council mode: one planner decomposes a goal, workers execute one
 * task each in an isolated worktree, and a reviewer with a different model
 * family gates every result. The planner and the reviewer reuse the subagent
 * bodies, so council and subagents cannot drift into two rubrics.
 */
import { PLANNER_PROMPT, REVIEWER_PROMPT, WORKER_PROMPT } from './subagents';

/** Mirrors COUNCIL_CAPS.tasksPerGoal; the prompt package cannot import the server. */
const COUNCIL_MAX_TASKS = 12;

/** The planner body with the council cap filled, plus the blocks the server appends. */
export const COUNCIL_PLANNER_PROMPT = PLANNER_PROMPT.replaceAll(
  '{{max_tasks}}',
  String(COUNCIL_MAX_TASKS),
);

/** The reviewer body: one rubric for a council review and a subagent review. */
export const COUNCIL_REVIEWER_PROMPT = REVIEWER_PROMPT;

/**
 * One council worker's brief: the worker body, then the task, the goal and the
 * acceptance blocks the server fills. Council opens the pull request; the worker
 * pushes its branch and never runs `gh pr create`.
 */
export const COUNCIL_WORKER_BRIEF_TEMPLATE = `${WORKER_PROMPT}

TASK
{{task_title}}: {{task_brief}}

PROJECT
{{project_name}} at {{project_path}}. Base branch {{base_branch}}. Issue: {{issue_ref}}.

GOAL
{{goal}}

CONTEXT
{{context}}

CONSTRAINTS
- Touch only the files listed above; ask before widening scope.
- Work only inside your worktree; never touch the main checkout or another task's files.
- Follow the existing conventions in each file. No second pattern beside an existing one.
- No new dependencies, no installs, no lockfile edits.
- No stubs, placeholders, skipped tests, or narrowed assertions.
- Zero em dash and en dash characters in every file and name.
- Windows first: pwsh or cmd, CRLF preserved, long paths handled.
- Commit only your own paths with explicit git add arguments.

DEFINITION OF DONE
{{acceptance_checks}}
- VERIFY: run the narrowest command that exercises the change and paste its output tail. A claim without output is not done.
- STOP AND REPORT: if the worktree is missing, a dependency is unavailable, a file you need is owned by another task, or the brief contradicts the repository, stop and report it with both citations. Do not guess a workaround and do not widen scope.

EVIDENCE
{{evidence_requirements}}

REPORT BACK
Return: branch and commit SHA, checks run with results, deviations from the brief, and open questions. Keep it short.`;

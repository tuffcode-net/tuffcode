import type { Goal } from '@tuffcode/contracts';
import { newId, type Logger } from '@tuffcode/shared';
import type { Repos } from '../db/repos/index.js';
import { hasUncommittedWork, tryRunGit } from '../git/index.js';
import { TERMINAL_GOAL_STATES, TERMINAL_TASK_STATES } from './caps.js';
import { deleteChildThread } from './threads.js';

/** The error every task orphaned by a restart carries, so the report is readable. */
export const RESTART_TASK_ERROR = 'server restarted before the task finished';

export interface CouncilRecoveryResult {
  goals: number;
  tasksFailed: number;
  worktreesRemoved: number;
  worktreesKept: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Closes the goals a restart orphaned and reclaims the worktrees they left behind.
 *
 * No goal run survives a restart, so every non-terminal goal is dead. Tasks in a
 * non-terminal state become failed, then each task thread is inspected: a folder
 * thread is left alone, a worktree with commits ahead of its base is kept, and a
 * worktree with none is removed with its thread row. A git failure keeps the
 * worktree, because deleting work that could not be inspected loses the user's work.
 */
export async function recoverOrphanedGoals(input: {
  repos: Repos;
  logger: Logger;
}): Promise<CouncilRecoveryResult> {
  const { repos, logger } = input;
  const result: CouncilRecoveryResult = {
    goals: 0,
    tasksFailed: 0,
    worktreesRemoved: 0,
    worktreesKept: 0,
  };

  let goals: Goal[];
  try {
    goals = repos.council.listGoals();
  } catch (error) {
    logger.warn('council recovery could not list goals', { message: errorMessage(error) });
    return result;
  }

  for (const goal of goals) {
    if (TERMINAL_GOAL_STATES[goal.state] === true) continue;
    const counts: CouncilRecoveryResult = {
      goals: 1,
      tasksFailed: 0,
      worktreesRemoved: 0,
      worktreesKept: 0,
    };
    try {
      const tasks = repos.council.listTasks(goal.id);
      for (const task of tasks) {
        if (TERMINAL_TASK_STATES[task.state] === true) continue;
        const failed = repos.council.setTaskState(task.id, 'failed', { error: RESTART_TASK_ERROR });
        if (failed !== undefined) counts.tasksFailed += 1;
      }

      const inspected = new Set<string>();
      for (const task of tasks) {
        const threadId = task.threadId;
        if (threadId === null || inspected.has(threadId)) continue;
        inspected.add(threadId);
        const thread = repos.threads.get(threadId);
        if (thread === undefined) continue;
        // Only this goal's own child thread may be removed; anything else is not ours.
        if (thread.parentThreadId !== goal.threadId) continue;
        // A folder thread shares the project checkout; recovery never touches it.
        if (thread.branch === null) continue;
        const worktreePath = thread.worktreePath;
        if (worktreePath === null) {
          counts.worktreesKept += 1;
          continue;
        }
        const base = thread.baseBranch ?? 'main';
        const commits = await tryRunGit(['rev-list', '--count', `${base}..HEAD`], worktreePath);
        const count = commits.ok ? Number.parseInt(commits.stdout.trim(), 10) : Number.NaN;
        if (!Number.isFinite(count)) {
          counts.worktreesKept += 1;
          continue;
        }
        // A task interrupted mid run has uncommitted edits and no commit of its own, so
        // the checkout is kept whenever it holds work no commit carries, and the thread
        // says where that work is. This is the same rule the subagent archive uses.
        const dirty = await hasUncommittedWork(worktreePath);
        if (count > 0 || dirty) {
          counts.worktreesKept += 1;
          if (dirty) {
            const held = count > 0 ? 'uncommitted changes' : 'uncommitted changes and no commit';
            try {
              repos.messages.add({
                id: newId('msg'),
                threadId,
                role: 'assistant',
                content:
                  `Council recovery kept this checkout at ${worktreePath} because it holds ` +
                  `${held}. The goal was closed by a restart, so the work is not part of any ` +
                  'pull request; commit or copy it before deleting this thread.',
                createdAt: new Date().toISOString(),
              });
            } catch (error) {
              logger.warn('council recovery could not note a kept worktree', {
                goalId: goal.id,
                threadId,
                message: errorMessage(error),
              });
            }
          }
          continue;
        }
        try {
          await deleteChildThread(repos, threadId);
          counts.worktreesRemoved += 1;
        } catch (error) {
          logger.warn('council recovery could not remove worktree', {
            goalId: goal.id,
            threadId,
            message: errorMessage(error),
          });
          counts.worktreesKept += 1;
        }
      }

      const content = [
        `Council recovery report for goal ${goal.id}: ${goal.text}`,
        '',
        'The server restarted before this goal finished, so it was closed as failed.',
        `- tasks failed: ${counts.tasksFailed}`,
        `- worktrees kept: ${counts.worktreesKept}`,
        `- worktrees removed: ${counts.worktreesRemoved}`,
      ].join('\n');
      try {
        repos.messages.add({
          id: newId('msg'),
          threadId: goal.threadId,
          role: 'assistant',
          content,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.warn('council recovery could not write the goal report', {
          goalId: goal.id,
          message: errorMessage(error),
        });
      }
    } catch (error) {
      logger.warn('council recovery failed for goal', {
        goalId: goal.id,
        message: errorMessage(error),
      });
    }
    // The goal is closed even when a task or worktree step failed, so a restart can
    // never leave a goal that nothing will ever advance again.
    try {
      repos.council.setGoalState(goal.id, 'failed');
    } catch (error) {
      logger.warn('council recovery could not close goal', {
        goalId: goal.id,
        message: errorMessage(error),
      });
    }
    result.goals += counts.goals;
    result.tasksFailed += counts.tasksFailed;
    result.worktreesRemoved += counts.worktreesRemoved;
    result.worktreesKept += counts.worktreesKept;
  }

  return result;
}

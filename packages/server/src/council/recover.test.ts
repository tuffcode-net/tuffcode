import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@tuffcode/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../projects.js';
import {
  createTestContext,
  git,
  initRepo,
  silentLogger,
  type TestContext,
} from '../test-support.js';
import { recoverOrphanedGoals, RESTART_TASK_ERROR } from './recover.js';
import { provisionChildThread } from './threads.js';

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.dispose();
  ctx = undefined;
});

/** A repository, a provider, and the council goal thread a child hangs from. */
async function seed(context: TestContext): Promise<Project> {
  const repoPath = initRepo(join(context.env.root, 'repo'));
  const project = await addProject(context.repos, repoPath);
  context.repos.providers.upsert({ id: 'prv_test', kind: 'claude', label: 'Test', config: {} });
  const now = new Date().toISOString();
  context.repos.threads.create({
    id: 'thr_goal',
    projectId: project.id,
    parentThreadId: null,
    title: 'Goal',
    providerId: 'prv_test',
    modelId: 'model-x',
    executionMode: 'council',
    permissionMode: 'full-auto',
    status: 'idle',
    worktreePath: null,
    branch: null,
    baseBranch: null,
    createdAt: now,
    updatedAt: now,
  });
  return project;
}

function provision(context: TestContext, project: Project, title: string) {
  return provisionChildThread(context.repos, {
    projectId: project.id,
    parentThreadId: 'thr_goal',
    title,
    providerId: 'prv_test',
    modelId: 'model-x',
    executionMode: 'work',
    permissionMode: 'full-auto',
    baseBranch: project.defaultBranch,
  });
}

function runningTask(
  context: TestContext,
  goalId: string,
  threadId: string | null,
  title: string,
): void {
  context.repos.council.createTask({
    goalId,
    threadId,
    title,
    brief: `Do ${title}.`,
    state: 'running',
    authorProvider: 'prv_test',
    authorModel: 'model-x',
  });
}

describe('recoverOrphanedGoals', () => {
  it('fails orphaned goals and removes only worktrees without commits', async () => {
    ctx = createTestContext();
    const project = await seed(ctx);
    const kept = await provision(ctx, project, 'Council: Kept');
    const removed = await provision(ctx, project, 'Council: Removed');
    const keptPath = kept.worktreePath ?? '';
    writeFileSync(join(keptPath, 'kept.ts'), 'export const kept = 1;\n');
    git(keptPath, ['add', 'kept.ts']);
    git(keptPath, ['commit', '-m', 'feat: kept work']);

    const goal = ctx.repos.council.createGoal({
      threadId: 'thr_goal',
      text: 'Ship the widget',
      autonomy: 'auto',
      state: 'running',
    });
    runningTask(ctx, goal.id, kept.id, 'Kept');
    runningTask(ctx, goal.id, removed.id, 'Removed');

    const result = await recoverOrphanedGoals({ repos: ctx.repos, logger: silentLogger() });

    expect(result).toEqual({ goals: 1, tasksFailed: 2, worktreesRemoved: 1, worktreesKept: 1 });
    expect(ctx.repos.council.getGoal(goal.id)?.state).toBe('failed');
    const tasks = ctx.repos.council.listTasks(goal.id);
    expect(tasks.map((task) => task.state)).toEqual(['failed', 'failed']);
    expect(tasks.every((task) => task.error === RESTART_TASK_ERROR)).toBe(true);
    expect(ctx.repos.threads.get(kept.id)).toBeDefined();
    expect(existsSync(keptPath)).toBe(true);
    expect(ctx.repos.threads.get(removed.id)).toBeUndefined();
    expect(existsSync(removed.worktreePath ?? '')).toBe(false);

    const report = ctx.repos.messages
      .list('thr_goal')
      .find((message) => message.content.includes('Council recovery report'));
    expect(report?.content).toContain('tasks failed: 2');
    expect(report?.content).toContain('worktrees kept: 1');
    expect(report?.content).toContain('worktrees removed: 1');
  });

  it('keeps a worktree that holds uncommitted work and says where it is', async () => {
    ctx = createTestContext();
    const project = await seed(ctx);
    const child = await provision(ctx, project, 'Council: Interrupted');
    const childPath = child.worktreePath ?? '';
    // The normal state after a crash: an edit the task never committed.
    writeFileSync(join(childPath, 'work-in-progress.ts'), 'export const wip = 1;\n');
    const goal = ctx.repos.council.createGoal({
      threadId: 'thr_goal',
      text: 'Ship the widget',
      autonomy: 'auto',
      state: 'running',
    });
    runningTask(ctx, goal.id, child.id, 'Interrupted');

    const result = await recoverOrphanedGoals({ repos: ctx.repos, logger: silentLogger() });

    expect(result).toEqual({ goals: 1, tasksFailed: 1, worktreesRemoved: 0, worktreesKept: 1 });
    expect(ctx.repos.threads.get(child.id)).toBeDefined();
    expect(existsSync(childPath)).toBe(true);
    expect(existsSync(join(childPath, 'work-in-progress.ts'))).toBe(true);
    const note = ctx.repos.messages
      .list(child.id)
      .find((message) => message.content.includes('Council recovery kept this checkout'));
    expect(note?.content).toContain(childPath);
    expect(note?.content).toContain('uncommitted changes');
  });

  it('keeps a worktree when git cannot report its commits', async () => {
    ctx = createTestContext();
    const project = await seed(ctx);
    const child = await provision(ctx, project, 'Council: Unreadable');
    ctx.repos.threads.setWorktree(child.id, {
      path: child.worktreePath ?? '',
      branch: child.branch ?? '',
      baseBranch: 'missing-base',
    });
    const goal = ctx.repos.council.createGoal({
      threadId: 'thr_goal',
      text: 'Ship the widget',
      autonomy: 'auto',
      state: 'running',
    });
    runningTask(ctx, goal.id, child.id, 'Unreadable');

    const result = await recoverOrphanedGoals({ repos: ctx.repos, logger: silentLogger() });

    expect(result.worktreesKept).toBe(1);
    expect(result.worktreesRemoved).toBe(0);
    expect(ctx.repos.threads.get(child.id)).toBeDefined();
    expect(existsSync(child.worktreePath ?? '')).toBe(true);
  });

  it('leaves a folder thread alone', async () => {
    ctx = createTestContext();
    const project = await seed(ctx);
    const now = new Date().toISOString();
    ctx.repos.threads.create({
      id: 'thr_folder',
      projectId: project.id,
      parentThreadId: 'thr_goal',
      title: 'Folder work',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'full-auto',
      status: 'idle',
      worktreePath: project.path,
      branch: null,
      baseBranch: null,
      createdAt: now,
      updatedAt: now,
    });
    const goal = ctx.repos.council.createGoal({
      threadId: 'thr_goal',
      text: 'Ship the widget',
      autonomy: 'auto',
      state: 'running',
    });
    runningTask(ctx, goal.id, 'thr_folder', 'Folder');

    const result = await recoverOrphanedGoals({ repos: ctx.repos, logger: silentLogger() });

    expect(result).toEqual({ goals: 1, tasksFailed: 1, worktreesRemoved: 0, worktreesKept: 0 });
    expect(ctx.repos.threads.get('thr_folder')).toBeDefined();
  });
});

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addProject } from '../projects.js';
import { createTestContext, git, initRepo, type TestContext } from '../test-support.js';
import { changesForThread } from './git.js';
import { deleteChildThread, provisionChildThread } from './threads.js';

let ctx: TestContext | undefined;

afterEach(() => {
  ctx?.dispose();
  ctx = undefined;
});

/**
 * The goal thread a child hangs from. `threads.parent_thread_id` references
 * `threads(id)`, so a fixture that passes a parent id must insert that row first.
 */
function seedGoalThread(ctx: TestContext, projectId: string): void {
  const now = new Date().toISOString();
  ctx.repos.threads.create({
    id: 'thr_goal',
    projectId,
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
}

describe('provisionChildThread', () => {
  it('creates a worktree and parent link, then disposes both', async () => {
    ctx = createTestContext();
    const repoPath = initRepo(join(ctx.env.root, 'repo'));
    const project = await addProject(ctx.repos, repoPath);
    ctx.repos.providers.upsert({ id: 'prv_test', kind: 'claude', label: 'Test', config: {} });
    const now = new Date().toISOString();
    const goal = ctx.repos.threads.create({
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
      baseBranch: project.defaultBranch,
      createdAt: now,
      updatedAt: now,
    });

    const child = await provisionChildThread(ctx.repos, {
      projectId: project.id,
      parentThreadId: goal.id,
      title: 'Council: Add widget',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'full-auto',
      baseBranch: project.defaultBranch,
      effort: 'high',
    });

    expect(child.parentThreadId).toBe(goal.id);
    expect(child.title).toBe('Council: Add widget');
    expect(child.reasoningEffort).toBe('high');
    expect(child.branch).toBe(`tuffcode/${child.id}`);
    expect(child.worktreePath).not.toBeNull();
    expect(existsSync(child.worktreePath ?? '')).toBe(true);

    await deleteChildThread(ctx.repos, child.id);
    expect(ctx.repos.threads.get(child.id)).toBeUndefined();
    expect(existsSync(child.worktreePath ?? '')).toBe(false);
  });

  it('treats a missing child thread as already disposed', async () => {
    ctx = createTestContext();
    await expect(deleteChildThread(ctx.repos, 'thr_missing')).resolves.toBeUndefined();
  });

  it('rejects a disabled provider without touching git', async () => {
    ctx = createTestContext();
    const repoPath = initRepo(join(ctx.env.root, 'repo'));
    const project = await addProject(ctx.repos, repoPath);
    ctx.repos.providers.upsert({
      id: 'prv_off',
      kind: 'claude',
      label: 'Off',
      config: {},
      enabled: false,
    });
    await expect(
      provisionChildThread(ctx.repos, {
        projectId: project.id,
        parentThreadId: 'thr_goal',
        title: 'Council: Nope',
        providerId: 'prv_off',
        modelId: 'model-x',
        executionMode: 'work',
        permissionMode: 'full-auto',
        baseBranch: project.defaultBranch,
      }),
    ).rejects.toThrow(/provider is disabled/i);
  });

  it('starts the worktree from the start ref and records it as the base', async () => {
    ctx = createTestContext();
    const repoPath = initRepo(join(ctx.env.root, 'repo'));
    git(repoPath, ['checkout', '-b', 'tuffcode/dependency']);
    writeFileSync(join(repoPath, 'dep.ts'), 'export const dep = 1;\n');
    git(repoPath, ['add', 'dep.ts']);
    git(repoPath, ['commit', '-m', 'feat: dependency']);
    git(repoPath, ['checkout', 'main']);
    const project = await addProject(ctx.repos, repoPath);
    ctx.repos.providers.upsert({ id: 'prv_test', kind: 'claude', label: 'Test', config: {} });
    seedGoalThread(ctx, project.id);

    const child = await provisionChildThread(ctx.repos, {
      projectId: project.id,
      parentThreadId: 'thr_goal',
      title: 'Council: Dependent',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'full-auto',
      baseBranch: project.defaultBranch,
      startRef: 'tuffcode/dependency',
    });

    expect(child.baseBranch).toBe('tuffcode/dependency');
    expect(existsSync(join(child.worktreePath ?? '', 'dep.ts'))).toBe(true);
    await deleteChildThread(ctx.repos, child.id);
  });

  it('records the commit when the start ref is a temporary integration branch', async () => {
    ctx = createTestContext();
    const repoPath = initRepo(join(ctx.env.root, 'repo'));
    git(repoPath, ['checkout', '-b', 'council/tsk_one/base']);
    writeFileSync(join(repoPath, 'dep.ts'), 'export const dep = 1;\n');
    git(repoPath, ['add', 'dep.ts']);
    git(repoPath, ['commit', '-m', 'feat: dependency']);
    git(repoPath, ['checkout', 'main']);
    const commit = git(repoPath, ['rev-parse', 'council/tsk_one/base']);
    const project = await addProject(ctx.repos, repoPath);
    ctx.repos.providers.upsert({ id: 'prv_test', kind: 'claude', label: 'Test', config: {} });
    seedGoalThread(ctx, project.id);

    const child = await provisionChildThread(ctx.repos, {
      projectId: project.id,
      parentThreadId: 'thr_goal',
      title: 'Council: Integrated',
      providerId: 'prv_test',
      modelId: 'model-x',
      executionMode: 'work',
      permissionMode: 'full-auto',
      baseBranch: project.defaultBranch,
      startRef: 'council/tsk_one/base',
    });

    expect(child.baseBranch).toBe(commit);

    const worktree = child.worktreePath ?? '';
    writeFileSync(join(worktree, 'feature.ts'), 'export const feature = 1;\n');
    git(worktree, ['add', 'feature.ts']);
    git(worktree, ['commit', '-m', 'feat: task work']);
    git(repoPath, ['branch', '-D', 'council/tsk_one/base']);

    const changes = await changesForThread(ctx.repos, child.id);
    expect(changes.changed).toBe(true);
    expect(changes.files).toEqual(['feature.ts']);
    await deleteChildThread(ctx.repos, child.id);
  });
});

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, git, initRepo, type TestContext } from '../test-support.js';
import { createIntegrationBranch } from './integration.js';

let ctx: TestContext;
let repo: string;
let root: string;

beforeEach(() => {
  ctx = createTestContext();
  repo = initRepo(join(ctx.env.root, 'repo'));
  root = join(ctx.env.root, 'worktrees');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  ctx.dispose();
});

/** Commits `file` on a new branch from main, then returns to main. */
function commitOnBranch(branch: string, file: string, content: string): void {
  git(repo, ['checkout', '-b', branch, 'main']);
  writeFileSync(join(repo, file), content);
  git(repo, ['add', file]);
  git(repo, ['commit', '-m', `feat: ${branch}`]);
  git(repo, ['checkout', 'main']);
}

describe('createIntegrationBranch', () => {
  it('merges every branch into one temporary base and removes it on cleanup', async () => {
    commitOnBranch('feature/a', 'a.ts', 'export const a = 1;\n');
    commitOnBranch('feature/b', 'b.ts', 'export const b = 2;\n');

    const integration = await createIntegrationBranch({
      repoPath: repo,
      worktreesRoot: root,
      projectId: 'prj',
      taskId: 'tsk_one',
      branches: ['feature/a', 'feature/b'],
    });

    const target = join(root, 'prj', 'tsk_one-base');
    expect(integration.branch).toBe('council/tsk_one/base');
    expect(existsSync(join(target, 'a.ts'))).toBe(true);
    expect(existsSync(join(target, 'b.ts'))).toBe(true);
    expect(git(repo, ['rev-list', '--count', 'main..council/tsk_one/base'])).toBe('3');

    await integration.cleanup();
    expect(existsSync(target)).toBe(false);
    expect(git(repo, ['branch', '--list', 'council/tsk_one/base'])).toBe('');
    await expect(integration.cleanup()).resolves.toBeUndefined();
  });

  it('reports both branches and the conflicting file, and leaves nothing behind', async () => {
    writeFileSync(join(repo, 'shared.ts'), 'export const shared = "base";\n');
    git(repo, ['add', 'shared.ts']);
    git(repo, ['commit', '-m', 'feat: shared base']);
    commitOnBranch('feature/left', 'shared.ts', 'export const shared = "left";\n');
    commitOnBranch('feature/right', 'shared.ts', 'export const shared = "right";\n');

    const target = join(root, 'prj', 'tsk_two-base');
    const error: unknown = await createIntegrationBranch({
      repoPath: repo,
      worktreesRoot: root,
      projectId: 'prj',
      taskId: 'tsk_two',
      branches: ['feature/left', 'feature/right'],
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    const failure = error as Error & { code?: string };
    expect(failure.code).toBe('conflict');
    expect(failure.message).toContain('feature/left');
    expect(failure.message).toContain('feature/right');
    expect(failure.message).toContain('shared.ts');

    expect(existsSync(target)).toBe(false);
    expect(git(repo, ['branch', '--list', 'council/tsk_two/base'])).toBe('');
  });

  it('refuses a single branch, which the caller passes straight through', async () => {
    commitOnBranch('feature/a', 'a.ts', 'export const a = 1;\n');
    await expect(
      createIntegrationBranch({
        repoPath: repo,
        worktreesRoot: root,
        projectId: 'prj',
        taskId: 'tsk_three',
        branches: ['feature/a'],
      }),
    ).rejects.toThrow(/at least two branches/);
  });
});

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  createThreadThroughSidebar,
  expectAssistantText,
  seedDefaultModel,
  sendMessage,
  setPermissionMode,
} from './helpers';
import { MOCK_FILE_PATH, MOCK_WROTE_TEXT } from './mock-openai';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

interface ThreadGitState {
  branch: string | null;
  worktreePath: string | null;
}

/**
 * The button stages everything the turn left behind, untracked files included, commits
 * it and pushes the thread branch. The card also has to survive the two push failures
 * a real repository produces: nothing to commit, and a remote that moved ahead.
 */
test('commit and push commits pending work and reports a rejected push', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;

  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);
  await createThreadThroughSidebar(page, { workspace: 'worktree' });
  await setPermissionMode(page, 'Full auto');
  await sendMessage(page, 'write-file now');
  await expectAssistantText(page, MOCK_WROTE_TEXT);
  await expect(page.getByTestId('turn-summary')).toBeVisible();

  const threadId = await page
    .locator('[data-testid="thread-row"][aria-current="page"]')
    .getAttribute('data-thread-id');
  expect(threadId).not.toBeNull();
  const thread = (await rpc.request('threads.get', { id: threadId ?? '' })) as ThreadGitState;
  if (thread.branch === null || thread.worktreePath === null) {
    throw new Error('the thread has no worktree branch');
  }

  // The button names what it will stage, so the untracked file is visible before it leaves.
  await expect(page.getByTestId('turn-summary-commit-push')).toHaveAttribute(
    'title',
    new RegExp(MOCK_FILE_PATH),
  );

  await page.getByTestId('turn-summary-commit-push').click();
  await expect(page.getByText('Committed and pushed.')).toBeVisible();
  const localHead = git(thread.worktreePath, ['rev-parse', 'HEAD']);
  const remoteHead = git(join(workspace.root, 'origin.git'), [
    'rev-parse',
    `refs/heads/${thread.branch}`,
  ]);
  expect(remoteHead).toBe(localHead);

  // Nothing left to commit: the push still runs and the toast says only that.
  await page.getByTestId('turn-summary-commit-push').click();
  await expect(page.getByText('Pushed.', { exact: true })).toBeVisible();

  // Move the remote branch ahead from a second clone, then commit locally.
  const ahead = join(workspace.root, 'ahead');
  execFileSync('git', ['clone', join(workspace.root, 'origin.git'), ahead], { stdio: 'ignore' });
  git(ahead, ['checkout', thread.branch]);
  git(ahead, ['config', 'user.email', 'ahead@example.test']);
  git(ahead, ['config', 'user.name', 'Ahead']);
  writeFileSync(join(ahead, 'ahead.txt'), 'ahead\n');
  git(ahead, ['add', '-A']);
  git(ahead, ['commit', '-m', 'ahead']);
  git(ahead, ['push', 'origin', thread.branch]);

  writeFileSync(join(thread.worktreePath, 'local.txt'), 'local\n');
  await page.getByTestId('turn-summary-commit-push').click();
  const error = page.getByTestId('turn-summary-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('! [rejected]');
  await expect(error).not.toContainText('hint:');
});

/** Without a remote the useful line is git's `fatal:`, not the trailing advice. */
test('commit and push shows the fatal line when there is no origin', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;

  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);
  await createThreadThroughSidebar(page, { workspace: 'worktree' });
  await setPermissionMode(page, 'Full auto');
  // The worktree shares the project's config, so this removes origin for both.
  git(workspace.projectPath, ['remote', 'remove', 'origin']);

  await sendMessage(page, 'write-file now');
  await expectAssistantText(page, MOCK_WROTE_TEXT);
  await expect(page.getByTestId('turn-summary')).toBeVisible();

  await page.getByTestId('turn-summary-commit-push').click();
  const error = page.getByTestId('turn-summary-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText("fatal: 'origin' does not appear to be a git repository");
  await expect(error).not.toContainText('and the repository exists.');
});

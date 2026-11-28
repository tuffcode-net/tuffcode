import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  confirmNewThreadDialog,
  openDock,
  seedDefaultModel,
} from './helpers';

interface ThreadDetail {
  id: string;
  projectId: string;
  worktreePath: string | null;
  branch: string | null;
}

/** Paths compare case-insensitively on Windows, so normalise before comparing. */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

async function currentThreadId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-testid="thread-row"][aria-current="page"]')
    .getAttribute('data-thread-id');
  if (id === null) throw new Error('the new thread has no selected sidebar row');
  return id;
}

test('New chat opens the workspace dialog and runs in the project folder by default', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;
  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);

  await page.getByTestId('sidebar-new-chat').click();
  const dialog = page.getByTestId('new-thread-dialog');
  await expect(dialog).toBeVisible();
  // Nothing is created until Start: no thread row exists yet.
  await expect(page.getByTestId('thread-row')).toHaveCount(0);
  await expect(dialog.getByTestId('workspace-folder')).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByTestId('workspace-worktree')).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByTestId('workspace-summary')).toContainText('main');

  await confirmNewThreadDialog(page);
  await expect(page.getByTestId('thread-title')).toBeVisible();
  // The header keeps showing the workspace the thread runs in.
  await expect(page.getByTestId('thread-header')).toContainText('project');
  await expect(page.getByTestId('thread-branch')).toHaveCount(0);

  const thread = (await rpc.request('threads.get', {
    id: await currentThreadId(page),
  })) as ThreadDetail;
  expect(thread.branch).toBeNull();
  expect(thread.worktreePath).not.toBeNull();
  expect(normalize(thread.worktreePath ?? '')).toBe(normalize(workspace.projectPath));

  // The pty opens on the thread's worktree path, so a folder thread's terminal is
  // the project checkout. Open it to prove the path is usable.
  await openDock(page, 'terminal');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
});

test('the worktree option creates an isolated branch outside the project', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;
  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);

  await page.getByTestId('sidebar-new-thread').click();
  const dialog = page.getByTestId('new-thread-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('workspace-worktree').click();
  await expect(dialog.getByTestId('workspace-worktree')).toHaveAttribute('aria-checked', 'true');

  await confirmNewThreadDialog(page, { workspace: 'worktree' });
  await expect(page.getByTestId('thread-title')).toBeVisible();

  const threadId = await currentThreadId(page);
  const thread = (await rpc.request('threads.get', { id: threadId })) as ThreadDetail;
  expect(thread.branch).toBe(`tuffcode/${threadId}`);
  expect(thread.worktreePath).not.toBeNull();
  expect(normalize(thread.worktreePath ?? '')).not.toBe(normalize(workspace.projectPath));
  await expect(page.getByTestId('thread-branch')).toHaveAttribute('title', `tuffcode/${threadId}`);
});

test('with no projects the dialog offers Add project instead of creating one', async ({
  session,
}) => {
  const { page } = session;
  await page.getByTestId('sidebar-new-chat').click();
  const dialog = page.getByTestId('new-thread-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('project folder');
  await expect(dialog.getByTestId('new-thread-add-project')).toBeVisible();
  await expect(page.getByTestId('thread-row')).toHaveCount(0);
});

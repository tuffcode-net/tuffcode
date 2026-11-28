import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  createThreadThroughSidebar,
  expectAssistantText,
  seedDefaultModel,
  sendMessage,
  setPermissionMode,
  openDock,
} from './helpers';
import { MOCK_FILE_PATH, MOCK_WROTE_TEXT } from './mock-openai';

test('diff panel shows the file the mock provider wrote', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;

  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);
  await createThreadThroughSidebar(page);

  await setPermissionMode(page, 'Full auto');
  await sendMessage(page, 'write-file now');
  await expectAssistantText(page, MOCK_WROTE_TEXT);

  await openDock(page, 'diff');
  const panel = page.getByTestId('diff-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Refresh diff' }).click();
  const added = panel.getByTestId('diff-file').filter({ hasText: MOCK_FILE_PATH });
  await expect(added).toBeVisible();
  await added.click();
  await expect(panel).toContainText(MOCK_FILE_PATH);

  // A checkpoint snapshots the worktree and becomes a base option.
  await panel.getByTestId('diff-save-checkpoint').click();
  await expect(page.getByText('Checkpoint saved.')).toBeVisible();
  // Saving must not rebase the panel onto the new checkpoint.
  await expect(panel.getByLabel('Diff base')).toHaveText(/Working tree/);

  await panel.getByLabel('Diff base').click();
  const savedBase = page.getByRole('option', { name: /Checkpoint/ });
  await expect(savedBase).toBeVisible();
  await savedBase.click();
  // The checkpoint captured the file the mock wrote, so nothing changed since it.
  await expect(panel.getByText('Nothing changed since this checkpoint.')).toBeVisible();
  await expect(panel.getByTestId('diff-file')).toHaveCount(0);
});

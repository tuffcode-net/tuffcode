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
import { MOCK_ALLOWED_TEXT, MOCK_TEXT } from './mock-openai';

const FIRST_MESSAGE = 'run-bash before the queue';
const SECOND_MESSAGE = 'queue this second message';
const QUEUED_NOTICE_TEXT = 'Queued; it sends when the current turn ends.';

/**
 * A send behind a live turn is accepted and queued, not rejected. The live turn is
 * held at the approval gate (the suite's existing way to freeze a turn mid-run), so
 * the queued window is a stable state rather than a frame between polls.
 */
test('queues a send behind a live turn and runs it once that turn settles', async ({
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

  // Ask mode parks the mock's bash call at the approval gate; nothing settles until
  // this test clicks Allow.
  await setPermissionMode(page, 'Ask');

  await sendMessage(page, FIRST_MESSAGE);
  await expect(page.getByTestId('approval-card')).toBeVisible();
  await expect(page.getByTestId('thread-status')).toHaveAttribute('data-status', 'needs-approval');

  // The composer still accepts input while the turn is live; Enter queues the send.
  const input = page.getByTestId('composer-input');
  await input.fill(SECOND_MESSAGE);
  await input.press('Enter');

  const notice = page.getByTestId('composer-queued-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(QUEUED_NOTICE_TEXT);
  // A queued send is a success path, so no error toast may appear.
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

  const queuedBubble = page.getByTestId('user-message').filter({ hasText: SECOND_MESSAGE });
  await expect(queuedBubble).toHaveAttribute('data-status', 'queued');
  const queuedMarker = page.getByTestId('user-message-queued');
  await expect(queuedMarker).toHaveCount(1);
  await expect(queuedMarker).toHaveText('Queued');

  // Releasing the first turn lets the queue start the second one.
  await page.getByTestId('approval-allow').last().click();
  await expectAssistantText(page, MOCK_ALLOWED_TEXT);
  await expectAssistantText(page, MOCK_TEXT);
  await expect.poll(() => mock.prompts.includes(SECOND_MESSAGE)).toBe(true);

  // The transcript ends with both user turns and both replies.
  await expect(page.getByTestId('user-message')).toHaveCount(2);
  await expect(page.getByTestId('assistant-message')).toHaveCount(2);

  // The backlog drained, so the notice no longer describes pending work.
  await expect(notice).toBeHidden();
});

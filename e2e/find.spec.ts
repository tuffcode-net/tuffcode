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
import { MOCK_TIMELINE_FINAL } from './mock-openai';

test('Ctrl+F finds a needle inside a collapsed tool call and opens it', async ({
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

  await sendMessage(page, 'show-timeline');
  await expectAssistantText(page, MOCK_TIMELINE_FINAL);

  // The finished turn is one collapsed steps row above its answer.
  const steps = page.getByTestId('steps-block').last();
  await expect(steps).toBeVisible();
  await expect(steps.getByTestId('steps-body')).toHaveCount(0);

  await expect(page.getByTestId('find-bar')).toHaveCount(0);
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('find-bar')).toBeVisible();
  await expect(page.getByTestId('find-input')).toBeFocused();
  // The sidebar search owns Ctrl+Shift+F and "/", never Ctrl+F.
  await expect(page.getByTestId('search-dialog')).toHaveCount(0);

  // "echo timeline-ok" only exists inside the bash tool call, which is collapsed.
  const input = page.getByTestId('find-input');
  await input.fill('echo timeline-ok');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 1');

  // Stepping opens the steps row and the tool group, then scrolls the hit into view.
  const body = steps.getByTestId('steps-body');
  await expect(body).toBeVisible();
  const group = body.getByTestId('tool-group');
  await expect(group).toBeVisible();
  const row = group.getByTestId('tool-row').filter({ hasText: 'echo timeline-ok' });
  await expect(row).toBeVisible();
  await expect(row).toBeInViewport();

  // The hit is painted with the CSS Custom Highlight API, so the markdown is untouched.
  const painted = await page.evaluate(() => {
    const registry = (
      globalThis as unknown as {
        CSS?: { highlights?: { get(name: string): { size: number } | undefined } };
      }
    ).CSS?.highlights;
    if (registry === undefined) return -1;
    return (
      (registry.get('thread-find-active')?.size ?? 0) + (registry.get('thread-find')?.size ?? 0)
    );
  });
  expect(painted).toBeGreaterThan(0);

  // The bare token appears in the call input and its output, so it cycles.
  await input.fill('timeline-ok');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 2');
  await input.press('Enter');
  await expect(page.getByTestId('find-count')).toHaveText('2 of 2');
  await input.press('Shift+Enter');
  await expect(page.getByTestId('find-count')).toHaveText('1 of 2');

  // Esc closes the bar and returns the focus to the composer.
  await input.press('Escape');
  await expect(page.getByTestId('find-bar')).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toBeFocused();
  await expect(page.getByTestId('search-dialog')).toHaveCount(0);
  // Closing drops the painted highlights instead of leaving them on the markdown.
  const afterClose = await page.evaluate(() => {
    const registry = (
      globalThis as unknown as {
        CSS?: { highlights?: { get(name: string): { size: number } | undefined } };
      }
    ).CSS?.highlights;
    return registry?.get('thread-find')?.size ?? 0;
  });
  expect(afterClose).toBe(0);

  // The header control opens the same bar.
  await page.getByTestId('thread-find-button').click();
  await expect(page.getByTestId('find-bar')).toBeVisible();
  await expect(page.getByTestId('find-input')).toBeFocused();
});

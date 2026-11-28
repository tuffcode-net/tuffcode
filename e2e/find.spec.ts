import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  closeDock,
  confirmNewThreadDialog,
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

/**
 * Two conversations mounted at once: the clicked tile owns Ctrl+F even when the
 * routed thread lives in the other tile. This is the regression guard for the pane
 * lookup, which must read the tile's data-focused attribute rather than a testid.
 */
test('Ctrl+F opens in the clicked pane, not the routed thread', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;

  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);

  // Two threads: the routed one returns to pane one, the other becomes a side tile.
  await createThreadThroughSidebar(page);
  const routedThreadId = await page
    .locator('[data-testid="thread-row"][aria-current="page"]')
    .getAttribute('data-thread-id');
  await page.getByTestId('sidebar-new-thread').click();
  await confirmNewThreadDialog(page);
  await expect(page.getByTestId('thread-title')).toBeVisible();
  await expect(page.getByTestId('thread-row')).toHaveCount(2);
  const otherThreadId = await page
    .locator(`[data-testid="thread-row"]:not([data-thread-id="${routedThreadId}"])`)
    .getAttribute('data-thread-id');
  expect(otherThreadId).not.toBe(routedThreadId);

  await page.locator(`[data-testid="thread-row"][data-thread-id="${routedThreadId}"]`).click();
  await expect(page.getByTestId('pane-leaf-pane-1')).toHaveAttribute('data-surface', 'thread');
  await closeDock(page);

  await page
    .locator(`[data-testid="thread-row"][data-thread-id="${otherThreadId}"]`)
    .dragTo(page.getByTestId('pane-leaf-pane-1').getByTestId('pane-drop-zone-right'), {
      force: true,
      steps: 8,
    });

  const routedLeaf = page.getByTestId('pane-leaf-pane-1');
  const sideLeaf = page.getByTestId('pane-leaf-pane-2');
  await expect(sideLeaf).toHaveAttribute('data-surface', /^thread:/);
  await expect(sideLeaf.getByTestId('composer-input')).toBeVisible();
  // Both tiles must have their thread view mounted before the shortcut runs: each
  // mounted view registers its own find host, and the pane lookup can only pick the
  // clicked one once the second host exists. The header control proves the view and
  // its hook are live, so the keypress never races the side tile's first render.
  await expect(routedLeaf.getByTestId('thread-find-button')).toBeVisible();
  await expect(sideLeaf.getByTestId('thread-find-button')).toBeVisible();
  await expect(routedLeaf).not.toHaveAttribute('data-focused', 'true');

  // Clicking the tile's chrome focuses it without focusing anything in a timeline.
  await sideLeaf.getByTestId('pane-header').click();
  await expect(sideLeaf).toHaveAttribute('data-focused', 'true');
  // The shortcut prefers the focused element's own pane, so a stale focus left inside
  // the routed tile by the drag would legitimately win. Clear that possibility by
  // asserting the click left focus outside both timelines.
  expect(
    await routedLeaf.evaluate((leaf) => leaf.contains(document.activeElement)),
  ).toBe(false);

  await page.keyboard.press('Control+f');
  await expect(sideLeaf.getByTestId('find-bar')).toBeVisible();
  await expect(routedLeaf.getByTestId('find-bar')).toHaveCount(0);
});

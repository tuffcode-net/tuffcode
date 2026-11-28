import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  clickNewThread,
  closeDock,
  confirmNewThreadDialog,
  createThreadThroughSidebar,
  openDock,
  seedDefaultModel,
} from './helpers';

/** Every leaf carries its pane id, so the row can be counted and scoped. */
const LEAF = /^pane-leaf-/;
const VERTICAL_SPLITTER = '[data-testid="pane-splitter"][data-split-orientation="vertical"]';

/**
 * The split workspace: drop zones that build a 2x2 out of drags alone, a
 * resized splitter, a side chat opened from a sidebar row, two independent
 * composers, a closed tile, a nested layout that survives a restart, the narrow
 * collapse, and the keyboard chords.
 */
test('splits with drop zones into a 2x2, resizes, persists, and opens a side chat', async ({
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
  const selectedRow = page.locator('[data-testid="thread-row"][aria-current="page"]');
  const firstThreadId = await selectedRow.getAttribute('data-thread-id');
  // A second thread gives the sidebar a row to drag into a tile.
  await clickNewThread(page);
  await confirmNewThreadDialog(page);
  await expect(page.getByTestId('thread-title')).toBeVisible();
  await expect(page.getByTestId('thread-row')).toHaveCount(2);
  const secondThreadId = await page
    .locator(`[data-testid="thread-row"]:not([data-thread-id="${firstThreadId}"])`)
    .getAttribute('data-thread-id');
  expect(secondThreadId).not.toBe(firstThreadId);
  const rowOf = (threadId: string | null) =>
    page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"]`);
  await rowOf(firstThreadId).click();

  // The inspector's column would put the row below 1100px, where panes
  // deliberately collapse into tabs.
  await closeDock(page);

  const workspaceEl = page.getByTestId('pane-workspace');
  const leaves = page.getByTestId(LEAF);
  await expect(workspaceEl).toHaveAttribute('data-narrow', 'false');
  await expect(leaves).toHaveCount(1);
  await expect(page.getByTestId('pane-tab').filter({ hasText: 'Thread' })).toBeVisible();

  // A sidebar thread row dropped on the right edge opens a side chat tile.
  const threadLeaf = page.getByTestId('pane-leaf-pane-1');
  await rowOf(secondThreadId).dragTo(threadLeaf.getByTestId('pane-drop-zone-right'), {
    force: true,
    steps: 8,
  });

  await expect(leaves).toHaveCount(2);
  const sideLeaf = page.getByTestId('pane-leaf-pane-2');
  await expect(sideLeaf).toHaveAttribute('data-surface', /^thread:/);
  await expect(page.getByTestId('pane-splitter')).toHaveCount(1);

  // Each tile is a full session surface with its own composer and its own draft.
  await expect(page.getByTestId('composer-input')).toHaveCount(2);
  await expect(threadLeaf.getByTestId('composer-input')).toBeVisible();
  await expect(sideLeaf.getByTestId('composer-input')).toBeVisible();
  await sideLeaf.getByTestId('composer-input').fill('side chat draft');
  await expect(threadLeaf.getByTestId('composer-input')).toHaveValue('');

  const shots = process.env['TUFFCODE_E2E_SHOTS'];
  const prefix = process.env['TUFFCODE_E2E_SHOT_PREFIX'] ?? 'panes';
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${prefix}-two-tiles.png`) });
  }

  // A tab dragged onto the bottom edge splits that tile downwards.
  await threadLeaf.getByTestId('pane-add-tab').click();
  await page.getByTestId('pane-add-surface-diff').click();
  await expect(threadLeaf.getByTestId('pane-tab')).toHaveCount(2);
  await threadLeaf
    .getByTestId('pane-tab')
    .filter({ hasText: 'Changes' })
    .dragTo(threadLeaf.getByTestId('pane-drop-zone-bottom'), { force: true, steps: 8 });

  await expect(leaves).toHaveCount(3);
  const diffLeaf = page.getByTestId('pane-leaf-pane-3');
  await expect(diffLeaf).toHaveAttribute('data-surface', 'diff');
  await expect(diffLeaf.getByTestId('diff-panel')).toBeVisible();
  await expect(threadLeaf).toHaveAttribute('data-surface', 'thread');

  // The same gesture on the other column completes the 2x2.
  await sideLeaf.getByTestId('pane-add-tab').click();
  await page.getByTestId('pane-add-surface-terminal').click();
  await sideLeaf
    .getByTestId('pane-tab')
    .filter({ hasText: 'Terminal' })
    .dragTo(sideLeaf.getByTestId('pane-drop-zone-bottom'), { force: true, steps: 8 });

  await expect(leaves).toHaveCount(4);
  const terminalLeaf = page.getByTestId('pane-leaf-pane-4');
  await expect(terminalLeaf).toHaveAttribute('data-surface', 'terminal');
  await expect(terminalLeaf.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.getByTestId('pane-splitter')).toHaveCount(3);
  await expect(page.locator(VERTICAL_SPLITTER)).toHaveCount(2);

  const grid = await Promise.all([0, 1, 2, 3].map((index) => leaves.nth(index).boundingBox()));
  expect(Math.max(...grid.map((box) => box?.width ?? 0)) - Math.min(...grid.map((box) => box?.width ?? 0))).toBeLessThan(6);
  if (shots) {
    await page.screenshot({ path: join(shots, `${prefix}-grid.png`) });
  }

  // The stacked splitter trades height with its neighbour; a double click evens it.
  const stackedSplitter = page.locator(VERTICAL_SPLITTER).first();
  const beforeResize = await threadLeaf.boundingBox();
  const barBox = await stackedSplitter.boundingBox();
  if (beforeResize === null || barBox === null) throw new Error('the left column has no box');
  await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2 + 70, {
    steps: 8,
  });
  await page.mouse.up();
  const afterResize = await threadLeaf.boundingBox();
  expect(afterResize?.height ?? 0).toBeGreaterThan((beforeResize.height ?? 0) + 40);

  await stackedSplitter.dblclick();
  const resetTop = await threadLeaf.boundingBox();
  const resetBottom = await diffLeaf.boundingBox();
  expect(Math.abs((resetTop?.height ?? 0) - (resetBottom?.height ?? 0))).toBeLessThan(4);

  // Closing one tile leaves the rest of the tree alone.
  await terminalLeaf.getByTestId('pane-close').click();
  await expect(leaves).toHaveCount(3);
  await expect(page.getByTestId('composer-input')).toHaveCount(2);
  await expect(workspaceEl).toHaveAttribute('data-pane-count', '3');

  // The nested layout survives a restart: one horizontal split, one vertical.
  await session.relaunch();
  await expect(session.page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  );
  // The app reopens the newest thread, so go back to the split one by hand.
  await session.page
    .locator(`[data-testid="thread-row"][data-thread-id="${firstThreadId}"]`)
    .click();
  const relaunched = session.page.getByTestId('pane-workspace');
  await expect(relaunched).toHaveAttribute('data-pane-count', '3');
  await closeDock(session.page);
  await expect(relaunched).toHaveAttribute('data-narrow', 'false');
  const reloaded = session.page.getByTestId(LEAF);
  await expect(reloaded).toHaveCount(3);
  await expect(session.page.locator(VERTICAL_SPLITTER)).toHaveCount(1);
  await expect(session.page.getByTestId('pane-splitter')).toHaveCount(2);
  await expect(reloaded.nth(0)).toHaveAttribute('data-surface', 'thread');
  await expect(reloaded.nth(1)).toHaveAttribute('data-surface', 'diff');
  await expect(reloaded.nth(2)).toHaveAttribute('data-surface', /^thread:/);
  await expect(session.page.getByTestId('composer-input')).toHaveCount(2);

  // Below 1100px the row keeps one leaf; every surface becomes a tab.
  await openDock(session.page, 'activity');
  await expect(relaunched).toHaveAttribute('data-narrow', 'true');
  await expect(reloaded).toHaveCount(1);
  await expect(session.page.getByTestId('pane-tab')).toHaveCount(3);
  await expect(session.page.getByTestId('pane-tab').filter({ hasText: 'Changes' })).toBeVisible();
  if (shots) {
    await session.page.screenshot({ path: join(shots, `${prefix}-narrow.png`) });
  }

  // Selecting a tab in the narrow row writes back to its owning leaf.
  await session.page.getByTestId('pane-tab').filter({ hasText: 'Thread' }).click();
  await expect(reloaded).toHaveAttribute('data-surface', 'thread');
  await closeDock(session.page);
  await expect(relaunched).toHaveAttribute('data-narrow', 'false');
  await expect(reloaded).toHaveCount(3);
  await expect(reloaded.first()).toHaveAttribute('data-surface', 'thread');

  // Ctrl+W closes the focused leaf while more than one is open.
  await session.page.getByTestId('pane-leaf-pane-3').getByTestId('pane-drag-handle').click();
  await session.page.keyboard.press('Control+W');
  await expect(reloaded).toHaveCount(2);

  // Ctrl+\ splits with the first unopened surface.
  await session.page.keyboard.press('Control+\\');
  await expect(reloaded).toHaveCount(3);
  await expect(reloaded.nth(1)).toHaveAttribute('data-surface', 'diff');
});

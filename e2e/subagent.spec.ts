import { mkdirSync } from 'node:fs';
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
  closeDock,
  openDock,
} from './helpers';
import {
  MOCK_SUBAGENT_FINAL,
  MOCK_SUBAGENT_TASK,
  MOCK_SUBAGENT_TWO_TASK,
  MOCK_TEXT,
} from './mock-openai';

test('spawns a child, shows its card under the spawn turn, and opens the pane', async ({
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
  // The spec's two-pane view: thread plus subagent pane, no inspector competing
  // for the right side. The overlay case is asserted at the end.
  await closeDock(page);

  await sendMessage(page, 'spawn-subagent');
  await expectAssistantText(page, MOCK_SUBAGENT_FINAL);

  // Closed pane: one compact chip row (D40). A settled child folds into one
  // finished chip; while it runs the strip shows its explorer chip instead.
  const strip = page.getByTestId('subagent-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('data-child-count', '1');
  const stripChips = strip.locator(
    '[data-testid="subagent-strip-chip"], [data-testid="subagent-strip-finished"]',
  );
  await expect(stripChips).toHaveCount(1);
  await expect
    .poll(async () => {
      const running = strip.getByTestId('subagent-strip-chip');
      if ((await running.count()) > 0) {
        return (await running.getAttribute('data-subagent-type')) ?? '';
      }
      const finished = await strip.getByTestId('subagent-strip-finished').count();
      return finished > 0 ? 'finished' : 'missing';
    })
    .toMatch(/^(explorer|finished)$/);

  await stripChips.click();

  const pane = page.getByTestId('subagent-pane');
  await expect(pane).toBeVisible();
  const header = page.getByTestId('subagent-pane-header');
  await expect(header).toContainText('Explorer');
  await expect(page.getByTestId('subagent-pane-model')).toContainText('mock-model');

  // D40 removed the in-timeline card grid and its connector; the spawn stays in
  // the parent timeline as one tool row attributed to the turn that ran it, folded
  // under that finished turn's steps row. The verb and target are separate spans,
  // so textContent has no space between them.
  const spawnSteps = page.getByTestId('steps-block').last();
  await spawnSteps.getByRole('button').first().click();
  const spawnRow = spawnSteps.getByTestId('tool-row').filter({ hasText: /Used subagent/ });
  await expect(spawnRow).toBeVisible();

  await expect(page.getByTestId('subagent-task')).toContainText(MOCK_SUBAGENT_TASK);

  // The child runs the same mock provider, so its own turn renders in the pane.
  await expect(page.getByTestId('subagent-timeline')).toContainText(MOCK_TEXT);
  await expect(page.getByTestId('subagent-pane-status')).toHaveAttribute('data-status', 'done');

  // A reload keeps the child's own turn: the pane replays its durable events.
  await page.reload();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  const replayedStrip = page.getByTestId('subagent-strip');
  await expect(replayedStrip).toHaveAttribute('data-child-count', '1');
  await replayedStrip
    .locator('[data-testid="subagent-strip-finished"], [data-testid="subagent-strip-chip"]')
    .first()
    .click();
  await expect(page.getByTestId('subagent-pane')).toBeVisible();
  await expect(page.getByTestId('subagent-timeline')).toContainText(MOCK_TEXT);

  const shots = process.env['TUFFCODE_E2E_SHOTS'];
  const prefix = process.env['TUFFCODE_E2E_SHOT_PREFIX'] ?? 'subagent';
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${prefix}-pane.png`) });
  }

  // Reopening the inspector narrows the thread row below the pane's split width, so
  // the pane becomes a sheet but stays mounted.
  await openDock(page, 'activity');
  await expect(page.getByTestId('inspector-header')).toBeVisible();
  await expect(page.getByTestId('subagent-pane')).toBeVisible();
  if (shots) {
    await page.screenshot({ path: join(shots, `${prefix}-pane-narrow.png`) });
  }

  // A second child adds a tab; selecting it switches the pane header and task.
  await sendMessage(page, 'spawn-subagent-two');
  const tabs = page.getByTestId('subagent-tabs');
  await expect(tabs).toBeVisible();
  await expect(page.getByTestId('subagent-tab')).toHaveCount(2);

  await tabs.getByRole('tab', { name: /Reviewer/ }).click();
  await expect(header).toContainText('Reviewer');
  // Every child panel stays mounted, so scope to the selected reviewer panel
  // instead of matching the first task element. The task text arrives with the
  // debounced subagents.list merge.
  const reviewerPanel = page.getByRole('tabpanel', { name: /Reviewer/ });
  await expect(reviewerPanel.getByTestId('subagent-task')).toContainText(
    MOCK_SUBAGENT_TWO_TASK,
  );

  // Closing the pane returns to the strip without losing either child.
  await page.getByTestId('subagent-pane-close').click();
  await expect(pane).toBeHidden();
  const closingStrip = page.getByTestId('subagent-strip');
  await expect(closingStrip).toBeVisible();
  await expect(closingStrip).toHaveAttribute('data-child-count', '2');
});

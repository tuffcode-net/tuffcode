import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  closeDock,
  createThreadThroughSidebar,
  seedDefaultModel,
  setPermissionMode,
} from './helpers';

interface ThreadSummary {
  id: string;
  title: string;
}

/**
 * One council goal end to end on the mock provider: the planner and workers run the
 * models configured in settings, the board draws the plan, and a worker that produces
 * no changes leaves a failed goal whose report is visible above the nodes.
 */
test('runs a council goal with the configured models and reports the failure', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;

  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  const providerId = await seedDefaultModel(rpc);
  await createThreadThroughSidebar(page);
  await setPermissionMode(page, 'Full auto');
  await closeDock(page);

  // The models the council roles run: ids the mock answers whatever the name is, so
  // the board labels prove which setting the orchestrator used.
  await rpc.request('settings.set', {
    patch: {
      subagentModels: {
        planner: { providerId, model: 'planner-mock' },
        worker: { providerId, model: 'worker-mock' },
      },
    },
  });

  const modeSwitch = page.getByTestId('thread-mode-switch');
  await modeSwitch.getByRole('radio', { name: 'Council' }).click();
  await expect(modeSwitch.getByRole('radio', { name: 'Council' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  const goalInput = page.getByTestId('council-goal-input');
  await expect(goalInput).toBeVisible();
  await goalInput.fill('Document the answer constant and re-export it');
  await page.getByTestId('council-send').click();

  const board = page.getByTestId('council-board');
  await expect(board).toHaveAttribute('data-empty', 'false', { timeout: 60_000 });

  const plannerNode = board.locator('[data-testid="council-board-node"][data-kind="planner"]');
  await expect(plannerNode).toBeVisible({ timeout: 60_000 });
  await expect(plannerNode).toContainText('planner-mock');

  // The composer starts goals in manual autonomy unless the settings default is full
  // auto, so the plan parks for approval before any worker is dispatched.
  await expect(page.getByTestId('council-plan-approval')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('council-plan-task')).toHaveCount(2);
  await page.getByTestId('council-approve-plan').click();

  const taskNodes = board.locator('[data-testid="council-board-node"][data-kind="task"]');
  await expect(taskNodes).toHaveCount(2, { timeout: 60_000 });
  await expect(taskNodes.first()).toContainText('worker-mock');
  await expect(taskNodes.last()).toContainText('worker-mock');

  // The workers are real child threads titled after their task.
  await expect
    .poll(
      async () => {
        const threads = (await rpc.request('threads.list', {})) as ThreadSummary[];
        return threads.filter((thread) => thread.title.startsWith('Council:')).length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(1);

  // The mock worker writes nothing, so PR creation fails with the exact reason and
  // the goal ends failed; the board must show that text, not only Failed.
  const failure = page.getByTestId('council-board-failure');
  await expect(failure).toBeVisible({ timeout: 120_000 });
  await expect(failure).toContainText('worker produced no changes');
  await expect(page.getByTestId('council-thread-board')).toContainText('Failed');
});

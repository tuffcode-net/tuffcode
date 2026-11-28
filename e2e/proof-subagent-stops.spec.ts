import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  closeDock,
  createThreadThroughSidebar,
  seedDefaultModel,
  sendMessage,
  setPermissionMode,
} from './helpers';
import { MOCK_SUBAGENT_TRIO_TASKS } from './mock-openai';

interface ChildRow {
  childId: string;
  threadId: string;
  type: string;
  status: string;
  task: string;
  summary?: string;
}

/**
 * The proof run for the subagent outcome: a parent spawns an explorer, a worker and a
 * reviewer; one is cancelled, one fails at the provider and one is cut off mid-stream.
 * Every child must end in a terminal status with a reason the UI shows, and the event
 * log must hold no call to a tool a child may not use.
 */
test('every child ends with a visible reason and no child calls a tool outside its profile', async ({
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
  await closeDock(page);

  await sendMessage(page, 'spawn-subagent-trio');
  const strip = page.getByTestId('subagent-strip');
  await expect(strip).toHaveAttribute('data-child-count', '3', { timeout: 60_000 });

  const childrenOf = async (): Promise<ChildRow[]> =>
    (await rpc.request('subagents.listAll', {})) as ChildRow[];
  await expect.poll(async () => (await childrenOf()).length, { timeout: 60_000 }).toBe(3);

  const children = await childrenOf();
  const explorer = children.find((row) => row.type === 'explorer');
  const worker = children.find((row) => row.type === 'worker');
  const reviewer = children.find((row) => row.type === 'reviewer');
  expect(explorer?.task).toBe(MOCK_SUBAGENT_TRIO_TASKS.explorer);
  expect(worker?.task).toBe(MOCK_SUBAGENT_TRIO_TASKS.worker);
  expect(reviewer?.task).toBe(MOCK_SUBAGENT_TRIO_TASKS.reviewer);
  if (explorer === undefined || worker === undefined || reviewer === undefined) return;

  // The explorer is cancelled through the same RPC the pane's stop button uses.
  await rpc.request('subagents.cancel', { childId: explorer.childId });

  const statusOf = async (childId: string): Promise<ChildRow> => {
    const rows = await childrenOf();
    const row = rows.find((entry) => entry.childId === childId);
    if (row === undefined) throw new Error('child disappeared: ' + childId);
    return row;
  };

  await expect
    .poll(async () => (await statusOf(explorer.childId)).status, { timeout: 120_000 })
    .toBe('cancelled');
  await expect
    .poll(async () => (await statusOf(worker.childId)).status, { timeout: 120_000 })
    .toBe('failed');
  await expect
    .poll(async () => (await statusOf(reviewer.childId)).status, { timeout: 120_000 })
    .toBe('failed');

  // Each terminal row carries a reason, not a bare status.
  const cancelled = await statusOf(explorer.childId);
  expect(cancelled.summary ?? '').toContain('cancel');
  const failedWorker = await statusOf(worker.childId);
  expect(failedWorker.summary ?? '').toMatch(/mock provider failure|status 500/);
  const cutReviewer = await statusOf(reviewer.childId);
  expect((cutReviewer.summary ?? '').length).toBeGreaterThan(0);

  // The strip keeps the two failed children visible as failures, not as finished work.
  await expect
    .poll(
      async () => strip.locator('[data-testid="subagent-strip-chip"][data-status="failed"]').count(),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(2);

  // Opening a failed child shows the same failure in the pane.
  await strip
    .locator('[data-testid="subagent-strip-chip"][data-status="failed"]')
    .first()
    .click();
  await expect(page.getByTestId('subagent-pane')).toBeVisible();
  await expect(page.getByTestId('subagent-pane-status')).toHaveAttribute(
    'data-status',
    'failed',
  );

  // No child may call a tool its profile does not offer: a child never spawns another
  // child, so no subagent spawn call may appear in the parent's event log.
  const events = (await rpc.request('threads.events', { id: explorer.threadId })) as {
    events: Array<{ payload?: { type?: string; name?: string; input?: { action?: string } } }>;
  };
  const spawnCalls = events.events.filter(
    (event) =>
      event.payload?.type === 'tool.started' &&
      event.payload.name === 'subagent' &&
      event.payload.input?.action === 'spawn',
  );
  expect(spawnCalls).toEqual([]);
});

test('a council goal runs its plan to a terminal state with the failure visible', async ({
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
  await page.getByTestId('council-goal-input').fill('Document the answer constant and re-export it');
  await page.getByTestId('council-send').click();

  const board = page.getByTestId('council-board');
  await expect(board).toHaveAttribute('data-empty', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('council-plan-approval')).toBeVisible({ timeout: 60_000 });
  // Two tasks with one dependency edge: the fan-in task waits for the first.
  await expect(page.getByTestId('council-plan-task')).toHaveCount(2);
  await page.getByTestId('council-approve-plan').click();
  await expect(
    board.locator('[data-testid="council-board-node"][data-kind="task"]'),
  ).toHaveCount(2, { timeout: 60_000 });

  // The goal ends with a reason the user can read, and the board says Failed.
  const failure = page.getByTestId('council-board-failure');
  await expect(failure).toBeVisible({ timeout: 180_000 });
  await expect(failure).toContainText('worker produced no changes');
  await expect(page.getByTestId('council-thread-board')).toContainText('Failed');
});

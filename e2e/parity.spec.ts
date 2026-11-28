import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import type { AppSession } from './fixtures';
import type { Page } from '@playwright/test';
import {
  addMockProvider,
  addProjectThroughUi,
  closeDock,
  createThreadThroughSidebar,
  expectAssistantText,
  seedDefaultModel,
  sendMessage,
  setPermissionMode,
} from './helpers';
import {
  MOCK_ACTIVITY_FINAL,
  MOCK_SUBAGENT_FINAL,
  MOCK_TEXT,
  MOCK_TIMELINE_FINAL,
  MOCK_TODO_FINAL,
  MOCK_TODO_ITEMS,
} from './mock-openai';

/**
 * Round 5 parity verification: the dock toolbar and its `+` menu, the auto title
 * and its legacy repair, the merged Activity panel, and the Turn Summary actions.
 * Everything is driven through the real app against the in-process mock provider.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SHOTS_DIR = process.env['TUFFCODE_E2E_SHOTS'] ?? join(repoRoot, '.tuffcode-ops', 'shots', 'r5');

async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const path = join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  return path;
}

/**
 * Applies the requested size to the real BrowserWindow. A maximized or fullscreen
 * window ignores setSize, and a setSize issued while the window is still settling
 * can be dropped, so the caller may apply this more than once.
 */
async function applyWindowBounds(
  session: Pick<AppSession, 'app'>,
  width: number,
  height: number,
): Promise<void> {
  await session.app.evaluate(
    ({ BrowserWindow }, size: [number, number]) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return;
      if (window.isFullScreen()) window.setFullScreen(false);
      if (window.isMaximized()) window.unmaximize();
      const [x, y] = window.getPosition();
      window.setBounds({ x, y, width: size[0], height: size[1] });
      window.setSize(size[0], size[1]);
    },
    [width, height] as [number, number],
  );
}

/** Resizes the real BrowserWindow, then waits until the renderer agrees. */
async function resizeWindow(
  session: Pick<AppSession, 'app' | 'page'>,
  width: number,
  height: number,
): Promise<number> {
  const waitForWidth = async (timeout: number): Promise<void> => {
    await expect
      .poll(() => session.page.evaluate(() => window.innerWidth), { timeout })
      .toBeGreaterThan(width - 80);
    await expect
      .poll(() => session.page.evaluate(() => window.innerWidth), { timeout })
      .toBeLessThanOrEqual(width);
  };

  await applyWindowBounds(session, width, height);
  try {
    await waitForWidth(5_000);
  } catch {
    // The resize was dropped under load; re-apply it once and give it the full window.
    await applyWindowBounds(session, width, height);
    await waitForWidth(15_000);
  }
  return session.page.evaluate(() => window.innerWidth);
}

async function openThreadRow(page: Page, threadId: string) {
  return page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"]`);
}

test('dock toolbar, + menu and no reserved space when closed', async ({ session, workspace, mock, rpc }) => {
  const { page } = session;
  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);
  await createThreadThroughSidebar(page);

  // The dock starts closed: no panel column, no terminal, and the workspace owns
  // the full width to the window edge.
  await expect(page.getByTestId('dock')).toHaveCount(0);
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  const closed = await page.evaluate(() => {
    const workspace = document.querySelector('[data-testid="pane-workspace"]');
    if (!(workspace instanceof HTMLElement)) return null;
    const box = workspace.getBoundingClientRect();
    return { right: box.right, innerWidth: window.innerWidth };
  });
  expect(closed).not.toBeNull();
  expect(Math.abs((closed?.right ?? 0) - (closed?.innerWidth ?? 0))).toBeLessThanOrEqual(2);

  // Every toolbar toggle and the whole + menu are present.
  for (const tab of ['activity', 'terminal', 'diff', 'browser', 'files']) {
    await expect(page.getByTestId(`dock-toggle-${tab}`)).toBeVisible();
  }
  await page.getByTestId('dock-add-menu').click();
  await expect(page.getByTestId('dock-add-items')).toBeVisible();
  for (const item of ['dock-add-terminal', 'dock-add-browser', 'dock-add-files', 'dock-add-side-chat', 'dock-add-split']) {
    await expect(page.getByTestId(item)).toBeVisible();
  }
  await page.keyboard.press('Escape');

  // A toggle opens its panel and the button reports the pressed state.
  await page.getByTestId('dock-toggle-activity').click();
  await expect(page.getByTestId('dock')).toBeVisible();
  await expect(page.getByTestId('inspector-tab-activity')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('dock-toggle-activity')).toHaveAttribute('aria-pressed', 'true');
  const dockWidth = await page.getByTestId('dock').evaluate((element) => element.getBoundingClientRect().width);
  console.log(`PARITY_METRICS dock=activity width=${String(dockWidth)} inner=${String(closed?.innerWidth)}`);
  expect(dockWidth).toBeGreaterThanOrEqual(280);
  expect(dockWidth).toBeLessThanOrEqual(Math.floor((closed?.innerWidth ?? 0) * 0.6));

  // The same toggle closes it and the workspace edge returns.
  await page.getByTestId('dock-toggle-activity').click();
  await expect(page.getByTestId('dock')).toHaveCount(0);
  const reopened = await page.evaluate(() => {
    const workspace = document.querySelector('[data-testid="pane-workspace"]');
    const box = workspace instanceof HTMLElement ? workspace.getBoundingClientRect() : null;
    return { right: box?.right ?? 0, innerWidth: window.innerWidth };
  });
  expect(Math.abs(reopened.right - reopened.innerWidth)).toBeLessThanOrEqual(2);

  // The + menu opens a real terminal, and collapsing the dock unmounts it.
  await page.getByTestId('dock-add-menu').click();
  await page.getByTestId('dock-add-terminal').click();
  await expect(page.getByTestId('inspector-tab-terminal')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await closeDock(page);
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  const afterTerminal = await page.evaluate(() => {
    const workspace = document.querySelector('[data-testid="pane-workspace"]');
    const box = workspace instanceof HTMLElement ? workspace.getBoundingClientRect() : null;
    return { right: box?.right ?? 0, innerWidth: window.innerWidth };
  });
  expect(Math.abs(afterTerminal.right - afterTerminal.innerWidth)).toBeLessThanOrEqual(2);

  // Below 900px the open dock hides the sidebar instead of squeezing the chat.
  const compact = await resizeWindow(session, 880, 720);
  await page.getByTestId('dock-toggle-activity').click();
  await expect(page.getByTestId('dock')).toBeVisible();
  await expect(page.locator('aside[aria-label="Projects and threads"]')).toHaveCount(0);
  const chat = await page.getByTestId('pane-workspace').boundingBox();
  expect(chat?.width ?? 0).toBeGreaterThan(300);
  console.log(`PARITY_METRICS compact inner=${String(compact)} chat=${String(chat?.width)}`);
  await shot(page, 'parity-compact-dock');
  await page.getByTestId('dock-toggle-activity').click();
  await resizeWindow(session, 1440, 900);
  await expect(page.locator('aside[aria-label="Projects and threads"]')).toBeVisible();
});

test('a new chat titles itself, keeps renames and repairs legacy titles on startup', async ({
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

  await sendMessage(page, 'fix the flaky login test please');
  await expectAssistantText(page, MOCK_TEXT);
  await expect(page.getByTestId('thread-title')).toHaveText('Fix the flaky login test');

  const firstRow = page.getByTestId('thread-row').first();
  const threadId = await firstRow.getAttribute('data-thread-id');
  expect(threadId).not.toBeNull();
  if (threadId === null) return;
  await expect(firstRow).toHaveAttribute('title', 'Fix the flaky login test');

  // A title longer than the row truncates to one line and keeps the full text in
  // the native tooltip; it never wraps to a second line.
  const longTitle =
    'Refactor the provider discovery service so that every adapter reports its models through one normalized path and every capability hint survives a restart';
  await rpc.request('threads.update', { id: threadId, title: longTitle });
  const row = await openThreadRow(page, threadId);
  await expect(row).toHaveAttribute('title', longTitle);
  const metrics = await row.evaluate((element) => {
    const title = element.querySelector('span.truncate');
    const titleBox = title instanceof HTMLElement ? title.getBoundingClientRect() : null;
    const style = title instanceof HTMLElement ? getComputedStyle(title) : null;
    return {
      rowHeight: element.getBoundingClientRect().height,
      titleHeight: titleBox?.height ?? 0,
      titleClientWidth: title instanceof HTMLElement ? title.clientWidth : 0,
      titleScrollWidth: title instanceof HTMLElement ? title.scrollWidth : 0,
      whiteSpace: style?.whiteSpace ?? '',
      tooltip: element.getAttribute('title'),
    };
  });
  expect(metrics.rowHeight).toBeCloseTo(48, 0);
  expect(metrics.titleHeight).toBeLessThanOrEqual(21);
  expect(metrics.titleScrollWidth).toBeGreaterThan(metrics.titleClientWidth);
  expect(metrics.whiteSpace).toBe('nowrap');
  expect(metrics.tooltip).toBe(longTitle);
  console.log(
    `PARITY_METRICS row=${JSON.stringify({ rowHeight: metrics.rowHeight, titleHeight: metrics.titleHeight, client: metrics.titleClientWidth, scroll: metrics.titleScrollWidth })}`,
  );
  const shotPath = await shot(page, 'parity-long-title');
  console.log(`PARITY_SHOT ${shotPath}`);

  // A legacy id title is repaired from the first user message on the next startup.
  await rpc.request('threads.update', { id: threadId, title: 'Thread abcd1234' });
  await expect(row).toHaveAttribute('title', 'Thread abcd1234');
  await session.relaunch();
  await expect(session.page.getByTestId('connection-status')).toHaveAttribute('data-status', 'open');
  const repaired = await openThreadRow(session.page, threadId);
  await expect(repaired).toHaveAttribute('title', 'Fix the flaky login test');
  await expect(session.page.getByText('Thread abcd1234')).toHaveCount(0);
  await repaired.click();
  await expect(session.page.getByTestId('thread-title')).toHaveText('Fix the flaky login test');
});

test('Activity merges environment, context, prompt, todo, tools and subagents', async ({
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

  await sendMessage(page, 'todo-plan for the release notes');
  await expectAssistantText(page, MOCK_TODO_FINAL);
  await sendMessage(page, 'activity-bash');
  await expectAssistantText(page, MOCK_ACTIVITY_FINAL);
  await sendMessage(page, 'spawn-subagent');
  await expectAssistantText(page, MOCK_SUBAGENT_FINAL);

  await page.getByTestId('dock-toggle-activity').click();
  const panel = page.getByTestId('activity-panel');
  await expect(panel).toBeVisible();

  // Each merged section exists exactly once; the old Context tab is gone.
  await expect(page.getByTestId('activity-context')).toHaveCount(1);
  await expect(page.getByTestId('activity-context')).toContainText('Environment');
  await expect(page.getByTestId('activity-context-usage')).toHaveCount(1);
  await expect(page.getByTestId('activity-prompt-toggle')).toBeVisible();
  await expect(page.getByTestId('activity-todo')).toHaveCount(1);
  await expect(page.getByTestId('activity-todo').getByTestId('todo-item')).toHaveCount(MOCK_TODO_ITEMS.length);
  await expect(page.getByTestId('activity-finished-tool').filter({ hasText: 'node -e' })).toHaveCount(1);
  await expect(page.getByTestId('activity-subagent-usage').first()).toContainText(/tools|usage/);
  await expect(page.getByTestId('inspector-tab-context')).toHaveCount(0);

  async function measure(label: string): Promise<void> {
    const result = await page.evaluate(() => {
      const dock = document.querySelector('[data-testid="dock"]');
      const activity = document.querySelector('[data-testid="activity-panel"]');
      if (!(dock instanceof HTMLElement) || !(activity instanceof HTMLElement)) return null;
      const clippedWithoutTooltip: string[] = [];
      for (const element of activity.querySelectorAll<HTMLElement>('*')) {
        if (element.scrollWidth <= element.clientWidth + 1) continue;
        if (element.getAttribute('title') !== null || element.closest('[title]') !== null) continue;
        if (getComputedStyle(element).overflowX === 'visible') continue;
        const text = (element.textContent ?? '').trim().slice(0, 40);
        if (text.length > 0) clippedWithoutTooltip.push(text);
      }
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dockWidth: dock.getBoundingClientRect().width,
        panelScrollWidth: activity.scrollWidth,
        panelClientWidth: activity.clientWidth,
        sectionHeights: [...activity.querySelectorAll('section')].map((section) =>
          Math.round(section.getBoundingClientRect().height),
        ),
        rowHeight: document.querySelector('[data-testid="thread-row"]')?.getBoundingClientRect().height ?? 0,
        clippedWithoutTooltip,
      };
    });
    expect(result).not.toBeNull();
    console.log(`PARITY_METRICS ${label} ${JSON.stringify(result)}`);
    expect(result?.panelScrollWidth ?? 1).toBeLessThanOrEqual((result?.panelClientWidth ?? 0) + 1);
    expect(result?.clippedWithoutTooltip ?? ['missing']).toEqual([]);
    expect(result?.sectionHeights.every((height) => height > 0) ?? false).toBe(true);
  }

  await resizeWindow(session, 1440, 900);
  await measure('activity@1440x900');
  console.log(`PARITY_SHOT ${await shot(page, 'parity-1440-activity')}`);

  await resizeWindow(session, 1280, 800);
  await measure('activity@1280x800');
  console.log(`PARITY_SHOT ${await shot(page, 'parity-1280-activity')}`);

  // The narrowest laptop width the dock must stay readable at.
  await resizeWindow(session, 1024, 768);
  await measure('activity@1024x768');
  console.log(`PARITY_SHOT ${await shot(page, 'parity-1024-activity')}`);
});

test('Turn Summary shows the diff totals, opens the diff and reports PR errors inline', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;
  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);
  // New chats default to the project folder, where the thread has no branch: the card
  // renders, but Create PR stays disabled and never reaches the server. This test
  // drives the real git.pr error path, so it asks the dialog for the worktree.
  await createThreadThroughSidebar(page, { workspace: 'worktree' });
  await setPermissionMode(page, 'Full auto');

  await sendMessage(page, 'show-timeline');
  await expectAssistantText(page, MOCK_TIMELINE_FINAL);

  const summary = page.getByTestId('turn-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(/\d+ files? changed/);
  await expect(summary).toContainText(/\+\d+/);
  await expect(summary).toContainText(/-\d+/);
  await expect(page.getByTestId('turn-summary-review')).toBeVisible();
  // The thread owns a worktree branch, so Create PR is enabled and reaches the server.
  await expect(page.getByTestId('turn-summary-pr')).toBeEnabled();
  console.log(`PARITY_SHOT ${await shot(page, 'parity-1440-turn-summary')}`);

  // Review changes opens the real diff panel in the dock.
  await page.getByTestId('turn-summary-review').click();
  await expect(page.getByTestId('dock')).toBeVisible();
  await expect(page.getByTestId('inspector-tab-diff')).toHaveAttribute('aria-selected', 'true');
  await closeDock(page);

  // Create PR reaches the server's git.pr handler. The workspace has no gh login, so the
  // handler fails at the preflight before committing or pushing anything, and the card
  // must show that error inline.
  const threadId = await page.getByTestId('thread-row').first().getAttribute('data-thread-id');
  expect(threadId).not.toBeNull();
  await page.getByTestId('turn-summary-pr').click();
  const error = page.getByTestId('turn-summary-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/gh|GitHub CLI|pull request/i);
  console.log(`PARITY_METRICS pr-error=${JSON.stringify((await error.innerText()).trim())}`);
  const thread = (await rpc.request('threads.get', { id: threadId ?? '' })) as { prUrl: string | null };
  expect(thread.prUrl).toBeNull();
  console.log(`PARITY_SHOT ${await shot(page, 'parity-1440-turn-summary-error')}`);

  // The default New chat path: the thread runs in the project folder, so it has no
  // branch. The card still reports the working-tree diff, but Create PR is disabled
  // and carries the reason instead of calling the handler.
  await createThreadThroughSidebar(page);
  await setPermissionMode(page, 'Full auto');
  await sendMessage(page, 'show-timeline');
  await expectAssistantText(page, MOCK_TIMELINE_FINAL);
  const folderSummary = page.getByTestId('turn-summary');
  await expect(folderSummary).toBeVisible();
  const folderPr = folderSummary.getByTestId('turn-summary-pr');
  await expect(folderPr).toBeDisabled();
  await expect(folderPr).toHaveAttribute('title', 'Pull requests need a worktree branch.');
  const folderThreadId = await page
    .locator('[data-testid="thread-row"][aria-current="page"]')
    .getAttribute('data-thread-id');
  expect(folderThreadId).not.toBeNull();
  const folderThread = (await rpc.request('threads.get', { id: folderThreadId ?? '' })) as {
    branch: string | null;
    worktreePath: string | null;
  };
  expect(folderThread.branch).toBeNull();
  expect(folderThread.worktreePath).not.toBeNull();
  console.log(`PARITY_SHOT ${await shot(page, 'parity-1440-turn-summary-folder')}`);
});

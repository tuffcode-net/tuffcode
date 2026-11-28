import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  createThreadThroughSidebar,
  openDock,
  openSettingsSection,
  seedDefaultModel,
  sendMessage,
} from './helpers';

/** Reads a palette token from the document element. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (tokenName) =>
      getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
    name,
  );
}

/** Opens Appearance unless a reload restored that route already. */
async function ensureAppearance(page: Page): Promise<void> {
  if ((await page.getByTestId('theme-picker').count()) > 0) return;
  await openSettingsSection(page, 'Appearance');
  await expect(page.getByTestId('theme-picker')).toBeVisible();
}

test('applies a named palette on click and keeps it after a relaunch', async ({ session }) => {
  const { page } = session;

  await ensureAppearance(page);
  const picker = page.getByTestId('theme-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('radio')).toHaveCount(15);

  // One click applies and saves: no separate Save step for the theme.
  await page.getByTestId('theme-nord').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
  await expect(page.getByTestId('theme-nord')).toHaveAttribute('aria-checked', 'true');
  expect(await token(page, '--background')).toBe('#2e3440');

  // Code blocks and the terminal follow the same palette through Shiki/xterm.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
  await ensureAppearance(page);
  await expect(page.getByTestId('theme-nord')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await token(page, '--background')).toBe('#ffffff');

  await session.relaunch();
  const relaunched = session.page;
  await expect(relaunched.getByTestId('app-shell')).toBeVisible();
  await expect(relaunched.locator('html')).toHaveAttribute('data-theme', 'light');
  await ensureAppearance(relaunched);
  await expect(relaunched.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true');
});

/**
 * Two of the four acceptance criteria in #220 are invisible to a token read: the Shiki
 * highlighter behind code blocks and the xterm theme behind an open terminal. This test
 * paints both under a named palette and under Light and asserts they moved with it.
 */
test('code blocks and the terminal follow the palette', async ({
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

  await sendMessage(page, 'show-code');
  const highlighted = page.locator('pre span').first();
  await expect(highlighted).toBeVisible({ timeout: 30_000 });

  const codeColours = async (): Promise<string[]> =>
    page
      .locator('pre span')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color).toSorted());

  const darkTerminal = await token(page, '--terminal-background');
  const darkCode = await codeColours();
  expect(darkCode.length).toBeGreaterThan(0);

  // The terminal wrapper carries the palette's terminal background; it has to match the
  // CSS token, and the xterm theme is built from the same palette.
  await openDock(page, 'terminal');
  const surface = page.getByTestId('terminal-panel').locator('[data-terminal-background]');
  await expect(surface).toBeVisible({ timeout: 30_000 });
  expect(await surface.getAttribute('data-terminal-background')).toBe(
    await token(page, '--terminal-background'),
  );

  // Nord, then Light: both the token and the two painters have to move.
  await openSettingsSection(page, 'Appearance');
  await page.getByTestId('theme-nord').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
  const nordTerminal = await token(page, '--terminal-background');
  expect(nordTerminal).not.toBe(darkTerminal);

  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await expect(page.getByTestId('thread-title')).toBeVisible();
  const surfaceNord = page.getByTestId('terminal-panel').locator('[data-terminal-background]');
  await expect(surfaceNord).toHaveAttribute('data-terminal-background', nordTerminal);
  const nordCode = await codeColours();
  expect(nordCode).not.toEqual(darkCode);

  await openSettingsSection(page, 'Appearance');
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightTerminal = await token(page, '--terminal-background');
  expect(lightTerminal).toBe('#ffffff');

  await page.getByRole('link', { name: 'Back to workspace' }).click();
  await expect(page.getByTestId('thread-title')).toBeVisible();
  await expect(
    page.getByTestId('terminal-panel').locator('[data-terminal-background]'),
  ).toHaveAttribute('data-terminal-background', lightTerminal);
  expect(await codeColours()).not.toEqual(nordCode);
});

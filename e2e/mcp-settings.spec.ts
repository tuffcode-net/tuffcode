import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';

/** The stdio fixture the server spawns through the real MCP client. */
const ECHO_SERVER_PATH = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const TOOL_COUNT = /\((\d+) tools?\)/;

test('adds, tests and removes a stdio MCP server', async ({ session }) => {
  const { page } = session;

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  // MCP servers live under Plugins since round 4.
  await page.getByRole('link', { name: 'Plugins', exact: true }).click();
  await expect(page.getByText('No MCP servers yet')).toBeVisible();

  await page.getByTestId('mcp-add-server').click();
  await page.getByTestId('mcp-label-input').fill('Echo fixture');
  await page.getByTestId('mcp-command-input').fill('node');
  await page
    .getByLabel('Arguments', { exact: true })
    .fill(`"${ECHO_SERVER_PATH}"`);
  await page.locator('form').getByRole('button', { name: 'Add server' }).click();

  const row = page.getByRole('listitem').filter({ hasText: 'Echo fixture' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('node');

  await row.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(row).toContainText('OK: Connected');

  const status = (await row.textContent()) ?? '';
  const match = TOOL_COUNT.exec(status);
  if (match === null) throw new Error('the test result did not report a tool count');
  expect(Number(match[1])).toBeGreaterThanOrEqual(1);

  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Remove MCP server');
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();

  await expect(page.getByText('No MCP servers yet')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Echo fixture' })).toHaveCount(0);
});

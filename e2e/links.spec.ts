import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  createThreadThroughSidebar,
  expectAssistantText,
  seedDefaultModel,
  sendMessage,
} from './helpers';
import { MOCK_LINK_TEXT } from './mock-openai';

/**
 * The app-level regression test for link routing: a click on assistant markdown must
 * reach `shell.openExternal` for http and https, and must never reach it for any other
 * target, whatever the link text says.
 */
test('assistant links reach the system browser only for http and https', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page, app } = session;

  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);
  await createThreadThroughSidebar(page);

  // Record the OS handoff instead of launching a real browser.
  await app.evaluate(({ shell }) => {
    const target = globalThis as unknown as { openedLinks?: string[] };
    target.openedLinks = [];
    shell.openExternal = async (url: string) => {
      target.openedLinks?.push(url);
    };
  });

  await sendMessage(page, 'link-test now');
  await expectAssistantText(page, MOCK_LINK_TEXT);

  for (const name of [
    'the docs',
    'local file',
    'run script',
    'custom app',
    'unc path',
    'misleading',
    'safe https',
  ]) {
    const link = page.getByTestId('assistant-message').getByText(name, { exact: true }).last();
    await expect(link).toBeVisible();
    await link.click();
  }

  const opened = await app.evaluate(() => {
    // Test-only hook installed above on the main process global.
    const target = globalThis as unknown as { openedLinks?: string[] };
    return target.openedLinks;
  });
  expect(opened).toEqual(['https://example.com/docs', 'https://example.com/safe']);
});

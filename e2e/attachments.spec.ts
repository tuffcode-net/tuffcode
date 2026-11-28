import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  addMockProvider,
  addProjectThroughUi,
  createThreadThroughSidebar,
  expectAssistantText,
  seedDefaultModel,
  sendMessage,
} from './helpers';
import { MOCK_TEXT } from './mock-openai';

/** A 1x1 transparent PNG: small enough to inline and decodable by createImageBitmap. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Dispatches a real paste event carrying one PNG, the way the OS clipboard does. */
async function pasteImage(page: Page): Promise<void> {
  await page.evaluate((base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const file = new File([bytes], 'pasted.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('[data-testid="composer-input"]');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('composer is not mounted');
    input.focus();
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, PNG_BASE64);
}

test('a vision model receives the pasted image bytes', async ({
  session,
  workspace,
  mock,
  rpc,
}) => {
  const { page } = session;

  await addProjectThroughUi(session, workspace);
  await addMockProvider(page, mock);
  await seedDefaultModel(rpc);
  const providers = (await rpc.request('providers.list', {})) as {
    id: string;
    kind: string;
    label: string;
    config: Record<string, unknown>;
  }[];
  const provider = providers.find((entry) => entry.label === 'Mock Provider');
  if (provider === undefined) throw new Error('the mock provider was not saved');
  await rpc.request('providers.upsert', {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    config: {
      ...provider.config,
      capabilities: { tools: true, vision: true, reasoning: false, reasoningEfforts: [] },
    },
  });
  // The renderer loaded providers before the toggle; a reload picks up the new config.
  await page.reload();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await createThreadThroughSidebar(page);

  await pasteImage(page);
  await expect(page.getByText('pasted.png')).toBeVisible();
  await expect(page.getByTestId('composer-image-blind')).toHaveCount(0);

  await sendMessage(page, 'Look at this image');
  await expectAssistantText(page, MOCK_TEXT);

  const body = mock.bodies.at(-1);
  const messages = (body?.['messages'] ?? []) as { role?: unknown; content?: unknown }[];
  const lastUser = messages.filter((message) => message.role === 'user').at(-1);
  expect(Array.isArray(lastUser?.content)).toBe(true);
  const parts = lastUser?.content as { type?: unknown; image_url?: { url?: unknown } }[];
  expect(
    parts.some(
      (part) =>
        part.type === 'image_url' &&
        typeof part.image_url?.url === 'string' &&
        part.image_url.url.startsWith('data:image/png;base64,'),
    ),
  ).toBe(true);
});

test('a pasted image becomes a chip and survives the send', async ({
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

  await pasteImage(page);
  const chip = page.getByText('pasted.png');
  await expect(chip).toBeVisible();

  await sendMessage(page, 'Look at this image');
  await expectAssistantText(page, MOCK_TEXT);

  // The turn is resolved, so the bubble now comes from the persisted row.
  const bubble = page.getByTestId('user-message').filter({ hasText: 'Look at this image' });
  await expect(bubble).toBeVisible();
  await expect(bubble.getByText('pasted.png')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('thread-title')).toHaveText('Look at this image');
  const reloaded = page.getByTestId('user-message').filter({ hasText: 'Look at this image' });
  await expect(reloaded).toBeVisible();
  await expect(reloaded.getByText('pasted.png')).toBeVisible();
});

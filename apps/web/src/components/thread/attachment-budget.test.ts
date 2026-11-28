import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_SEND_BASE64_CHARS,
  type Attachment,
} from '@tuffcode/contracts';
import { attachmentBudget } from './attachment-budget.js';

function image(name: string, chars: number): Attachment {
  return { name, mimeType: 'image/png', data: 'a'.repeat(chars) };
}

describe('attachmentBudget', () => {
  it('reads the caps the server enforces from the one shared definition', () => {
    // The server imports these same constants, so this pins the numbers the composer
    // warns with to the numbers a send is judged by.
    expect(MAX_ATTACHMENT_BASE64_CHARS).toBe(8 * 1024 * 1024);
    expect(MAX_SEND_BASE64_CHARS).toBe(32 * 1024 * 1024);
  });

  it('keeps every image that fits under both caps', () => {
    const attachments = [image('one.png', 4 * 1024 * 1024), image('two.png', 4 * 1024 * 1024)];
    expect(attachmentBudget(attachments)).toEqual({ omitted: [], inlineChars: 8 * 1024 * 1024 });
  });

  it('names the image that is over the per-file cap', () => {
    const attachments = [image('small.png', 1024), image('huge.png', MAX_ATTACHMENT_BASE64_CHARS + 1)];
    const budget = attachmentBudget(attachments);
    expect(budget.omitted).toEqual(['huge.png']);
    expect(budget.inlineChars).toBe(1024);
  });

  it('names the images the send cap will drop, in order', () => {
    const each = 5 * 1024 * 1024;
    const attachments = Array.from({ length: 7 }, (_, index) =>
      image(`shot-${String(index)}.png`, each),
    );
    const budget = attachmentBudget(attachments);
    // Six fit (30 MB of base64); the seventh would pass 32 MB.
    expect(budget.omitted).toEqual(['shot-6.png']);
    expect(budget.inlineChars).toBe(each * 6);
  });

  it('never counts a path attachment, which the server sends as a reference', () => {
    const attachments: Attachment[] = [
      { name: 'src/app.ts', path: 'src/app.ts' },
      image('shot.png', 1024),
    ];
    expect(attachmentBudget(attachments)).toEqual({ omitted: [], inlineChars: 1024 });
  });

  it('does not stop counting after a dropped file, so later small ones still fit', () => {
    const attachments = [
      image('huge.png', MAX_ATTACHMENT_BASE64_CHARS + 1),
      image('after.png', 2048),
    ];
    expect(attachmentBudget(attachments)).toEqual({ omitted: ['huge.png'], inlineChars: 2048 });
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BASE64_CHARS } from '@tuffcode/contracts';
import { createTempEnv } from '../test-support.js';
import { persistAttachments, readStoredAttachment, removeStoredAttachments, storeAttachmentBytes } from './store.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

describe('attachment store', () => {
  it('refuses a stored file larger than the cap the composer warns with', async () => {
    const env = createTempEnv();
    try {
      // One byte past the decoded size the shared base64 cap allows.
      const oversized = Buffer.alloc((MAX_ATTACHMENT_BASE64_CHARS * 3) / 4 + 1, 0x41);
      const id = await storeAttachmentBytes(oversized.toString('base64'), 'image/png');
      expect(await readStoredAttachment(id, 'image/png')).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it('stores bytes under a content hash and reads them back', async () => {
    const env = createTempEnv();
    try {
      const id = await storeAttachmentBytes(PNG, 'image/png');
      expect(id).toMatch(/^[a-f0-9]{64}\.png$/);

      const stored = await readStoredAttachment(id, 'image/png');
      expect(stored).toEqual({ data: PNG, mimeType: 'image/png' });
    } finally {
      env.dispose();
    }
  });

  it('returns the same id for the same bytes and keeps one file', async () => {
    const env = createTempEnv();
    try {
      const first = await storeAttachmentBytes(PNG, 'image/png');
      const second = await storeAttachmentBytes(PNG, 'image/png');
      expect(second).toBe(first);
    } finally {
      env.dispose();
    }
  });

  it('refuses a path that is not a stored id', async () => {
    const env = createTempEnv();
    try {
      expect(await readStoredAttachment('../secrets.bin')).toBeNull();
      expect(await readStoredAttachment('not-a-hash.png')).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it('removes a stored file and tolerates an unknown id', async () => {
    const env = createTempEnv();
    try {
      const id = await storeAttachmentBytes(PNG, 'image/png');
      await removeStoredAttachments([id, '../not-a-file', 'missing.png']);
      expect(await readStoredAttachment(id)).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it('persists inline bytes as an id and keeps a worktree path', async () => {
    const env = createTempEnv();
    try {
      const stored = await persistAttachments([
        { name: 'shot.png', data: PNG, mimeType: 'image/png', kind: 'image' },
        { name: 'notes.txt', path: '/worktree/notes.txt', kind: 'file' },
      ]);
      expect(stored[0]).toMatchObject({ name: 'shot.png', mimeType: 'image/png' });
      expect(stored[0]?.id).toMatch(/^[a-f0-9]{64}\.png$/);
      expect(stored[1]).toEqual({ name: 'notes.txt', path: '/worktree/notes.txt' });
    } finally {
      env.dispose();
    }
  });
});

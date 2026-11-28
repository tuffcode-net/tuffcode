/**
 * Content-addressed storage for attachments the user sent with a message.
 *
 * Inline image bytes arrive over the wire as base64. Persisting them inside the
 * messages table would make every transcript read carry megabytes, so the bytes go to
 * `<localAppData>/attachments/<sha256>.<ext>` and the row keeps only `{ name, id }`.
 * The id is the hash, so the same screenshot attached twice is stored once, and a
 * replay or retry resolves the id back to the same bytes.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attachment, TurnAttachment } from '@tuffcode/contracts';
import { attachmentsDir } from '@tuffcode/shared';

/** A stored id is a lowercase SHA-256 hex digest plus the extension for its format. */
const STORED_ID = /^[a-f0-9]{64}\.[a-z0-9]{1,5}$/;

/** Base64 characters one attachment may carry; the renderer caps at 5 MB decoded. */
export const MAX_ATTACHMENT_BASE64_CHARS = 8 * 1024 * 1024;

/** Base64 characters all attachments in one send may carry together. */
export const MAX_SEND_BASE64_CHARS = 32 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
};

function extensionFor(mimeType: string | undefined): string {
  if (mimeType === undefined) return 'bin';
  return EXTENSION_BY_MIME[mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''] ?? 'bin';
}

function pathFor(id: string): string {
  if (!STORED_ID.test(id)) throw new Error(`invalid attachment id: ${id}`);
  return join(attachmentsDir(), id);
}

/** Writes base64 bytes and returns the content-addressed id. */
export async function storeAttachmentBytes(data: string, mimeType?: string): Promise<string> {
  const bytes = Buffer.from(data, 'base64');
  const id = `${createHash('sha256').update(bytes).digest('hex')}.${extensionFor(mimeType)}`;
  const target = pathFor(id);
  await mkdir(attachmentsDir(), { recursive: true });
  // The content hash names the file, so an existing file already holds these bytes.
  await writeFile(target, bytes, { flag: 'wx' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return id;
}

/** Reads a stored attachment back as base64, or null when the file is gone. */
export async function readStoredAttachment(
  id: string,
  mimeType?: string,
): Promise<{ data: string; mimeType: string } | null> {
  let target: string;
  try {
    target = pathFor(id);
  } catch {
    return null;
  }
  let bytes: Buffer;
  try {
    const info = await stat(target);
    // A tampered or corrupted file must not be read into memory whole.
    if (info.size > (MAX_ATTACHMENT_BASE64_CHARS * 3) / 4) return null;
    bytes = await readFile(target);
  } catch {
    return null;
  }
  const extension = id.slice(id.lastIndexOf('.') + 1);
  return {
    data: bytes.toString('base64'),
    mimeType: mimeType ?? MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
  };
}

/** Deletes the given stored attachments; a missing file or a bad id is ignored. */
export async function removeStoredAttachments(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await rm(pathFor(id), { force: true });
    } catch {
      // An id that fails validation names no file this store wrote.
    }
  }
}

/**
 * The wire attachments to store on the user's message. Inline bytes become a stored
 * id; a worktree path stays a path, because the worktree is what the turn reads.
 */
export async function persistAttachments(
  attachments: readonly TurnAttachment[],
): Promise<Attachment[]> {
  const stored: Attachment[] = [];
  for (const attachment of attachments) {
    const name =
      attachment.name ?? (attachment.path === undefined ? 'attachment' : attachment.path);
    const mime = attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType };
    const size =
      attachment.width === undefined || attachment.height === undefined
        ? {}
        : { width: attachment.width, height: attachment.height };
    if (attachment.data !== undefined) {
      stored.push({
        name,
        id: await storeAttachmentBytes(attachment.data, attachment.mimeType),
        ...mime,
        ...size,
      });
      continue;
    }
    if (attachment.path !== undefined) {
      stored.push({ name, path: attachment.path, ...mime, ...size });
    }
  }
  return stored;
}

import {
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_SEND_BASE64_CHARS,
  type Attachment,
} from '@tuffcode/contracts';

export interface AttachmentBudget {
  /** Names of the attachments the server will drop, in the order it will drop them. */
  omitted: readonly string[];
  /** Base64 characters the send still carries. */
  inlineChars: number;
}

/**
 * Which attachments the server will refuse, using the same rule and the same numbers
 * it enforces in `resolveAttachments`: only inline base64 counts, one attachment over
 * the per-file cap is dropped, and the rest are dropped once the send cap is reached.
 * A path attachment is a filesystem reference and never counts. The composer warns
 * with this before send, so a file the model will not see is named while it is still
 * a chip the user can remove.
 */
export function attachmentBudget(attachments: readonly Attachment[]): AttachmentBudget {
  const omitted: string[] = [];
  let inlineChars = 0;
  for (const attachment of attachments) {
    const data = attachment.data;
    if (data === undefined) continue;
    if (data.length > MAX_ATTACHMENT_BASE64_CHARS) {
      omitted.push(attachment.name);
      continue;
    }
    if (inlineChars + data.length > MAX_SEND_BASE64_CHARS) {
      omitted.push(attachment.name);
      continue;
    }
    inlineChars += data.length;
  }
  return { omitted, inlineChars };
}

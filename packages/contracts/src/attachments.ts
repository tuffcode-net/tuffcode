/**
 * The base64 budget one send may carry.
 *
 * The server enforces these numbers when it resolves a message and the composer warns
 * with them before send, so both read the same constants and cannot drift apart.
 */

/** Base64 characters one attachment may carry. */
export const MAX_ATTACHMENT_BASE64_CHARS = 8 * 1024 * 1024;

/** Base64 characters all attachments in one send may carry together. */
export const MAX_SEND_BASE64_CHARS = 32 * 1024 * 1024;

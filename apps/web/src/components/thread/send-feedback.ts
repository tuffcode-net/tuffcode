/** Shown when the server accepted a message behind a live turn instead of refusing it. */
export const QUEUED_NOTICE = 'Queued; it sends when the current turn ends.';

export interface SendFeedback {
  /** The echo stays queued until the live turn settles. */
  queued: boolean;
  /** Inline notice above the input; null when the send started at once. */
  notice: string | null;
}

/**
 * What the composer reports for one accepted `threads.send`. A queued reply is a
 * success, so it carries a notice and no error channel at all: the composer's error
 * toast belongs to the rejection path only.
 */
export function sendFeedback(reply: { queued?: boolean }): SendFeedback {
  const queued = reply.queued === true;
  return { queued, notice: queued ? QUEUED_NOTICE : null };
}

import { describe, expect, it } from 'vitest';
import { QUEUED_NOTICE, sendFeedback } from './send-feedback';

describe('sendFeedback', () => {
  it('shows the queued notice for a queued send and nothing for an immediate one', () => {
    expect(sendFeedback({ queued: true })).toEqual({ queued: true, notice: QUEUED_NOTICE });
    expect(sendFeedback({})).toEqual({ queued: false, notice: null });
  });

  it('gives a queued send no error channel, so it can never reach the error toast', () => {
    const feedback = sendFeedback({ queued: true });
    expect(QUEUED_NOTICE).toBe('Queued; it sends when the current turn ends.');
    expect(feedback.notice).toContain('when the current turn ends');
    expect('error' in feedback).toBe(false);
  });
});

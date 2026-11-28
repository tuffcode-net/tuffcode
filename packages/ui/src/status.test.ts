import { describe, expect, it } from 'vitest';
import {
  STATUS_DOT_CLASS,
  STATUS_LABEL,
  STATUS_TEXT_CLASS,
  STATUS_TONE,
  THREAD_STATUSES,
  type StatusKey,
} from './status';

const ALL_KEYS: StatusKey[] = [...THREAD_STATUSES, 'plan-ready'];

describe('status mapping', () => {
  it('covers every status key with a tone, label, and color classes', () => {
    for (const key of ALL_KEYS) {
      expect(STATUS_TONE[key], `tone for ${key}`).toBeDefined();
      expect(STATUS_LABEL[key], `label for ${key}`).toBeTruthy();
      const tone = STATUS_TONE[key];
      expect(STATUS_DOT_CLASS[tone], `dot class for ${key}`).toBeTruthy();
      expect(STATUS_TEXT_CLASS[tone], `text class for ${key}`).toBeTruthy();
    }
  });

  it('uses the spec hues for thread statuses', () => {
    expect(STATUS_DOT_CLASS[STATUS_TONE.running]).toContain('sky');
    expect(STATUS_DOT_CLASS[STATUS_TONE['needs-approval']]).toContain('amber');
    expect(STATUS_DOT_CLASS[STATUS_TONE['ready-to-review']]).toContain('emerald');
    expect(STATUS_DOT_CLASS[STATUS_TONE.failed]).toContain('red');
    expect(STATUS_DOT_CLASS[STATUS_TONE['plan-ready']]).toContain('violet');
  });

  it('maps terminal statuses onto the neutral and success tones', () => {
    expect(STATUS_TONE.merged).toBe('success');
    expect(STATUS_TONE.idle).toBe('neutral');
    expect(STATUS_TONE.closed).toBe('neutral');
  });

  it('labels statuses for display', () => {
    expect(STATUS_LABEL['needs-approval']).toBe('Needs approval');
    expect(STATUS_LABEL['ready-to-review']).toBe('Ready to review');
    expect(STATUS_LABEL['plan-ready']).toBe('Plan ready');
  });
});

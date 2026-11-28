import { describe, expect, it } from 'vitest';
import { statusChip } from './status-chip';

describe('statusChip', () => {
  it('maps the five working statuses to their tinted hues', () => {
    expect(statusChip('running')).toMatchObject({
      label: 'Running',
      tone: 'running',
      className: 'bg-sky-400/10 text-sky-400',
    });
    expect(statusChip('needs-approval')).toMatchObject({
      label: 'Needs approval',
      tone: 'warning',
      className: 'bg-amber-400/10 text-amber-400',
    });
    expect(statusChip('ready-to-review')).toMatchObject({
      label: 'Ready to review',
      tone: 'success',
      className: 'bg-emerald-400/10 text-emerald-400',
    });
    expect(statusChip('failed')).toMatchObject({
      label: 'Failed',
      tone: 'error',
      className: 'bg-red-400/10 text-red-400',
    });
    expect(statusChip('idle')).toMatchObject({
      label: 'Idle',
      tone: 'neutral',
      className: 'bg-muted-foreground/10 text-muted-foreground',
    });
  });

  it('keeps quiet and plan statuses legible', () => {
    expect(statusChip('merged').tone).toBe('success');
    expect(statusChip('closed').tone).toBe('neutral');
    expect(statusChip('plan-ready')).toMatchObject({ label: 'Plan ready', tone: 'plan' });
  });

  it('gives every chip a 10 percent tinted background', () => {
    for (const status of [
      'idle',
      'running',
      'needs-approval',
      'ready-to-review',
      'failed',
      'merged',
      'closed',
      'plan-ready',
    ] as const) {
      expect(statusChip(status).className).toContain('/10');
    }
  });
});

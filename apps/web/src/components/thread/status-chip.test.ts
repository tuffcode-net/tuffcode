import { describe, expect, it } from 'vitest';
import { statusChip } from './status-chip';

describe('statusChip', () => {
  it('maps the five working statuses to their tinted hues', () => {
    expect(statusChip('running')).toMatchObject({
      label: 'Running',
      tone: 'running',
      className: 'bg-info/10 text-info-foreground',
    });
    expect(statusChip('needs-approval')).toMatchObject({
      label: 'Needs approval',
      tone: 'warning',
      className: 'bg-warning/10 text-warning-foreground',
    });
    expect(statusChip('ready-to-review')).toMatchObject({
      label: 'Ready to review',
      tone: 'success',
      className: 'bg-success/10 text-success-foreground',
    });
    expect(statusChip('failed')).toMatchObject({
      label: 'Failed',
      tone: 'error',
      className: 'bg-error/10 text-error-foreground',
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
    expect(statusChip('plan-ready').className).toContain('text-plan-foreground');
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

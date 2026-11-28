/**
 * Thread status to color mapping.
 *
 * Every tone is a theme token, so a palette switch repaints the dots and chips.
 * Plan has its own token: it must stay readable as text and stay clearly apart from
 * the running blue in every palette.
 */

export const THREAD_STATUSES = [
  'idle',
  'running',
  'needs-approval',
  'ready-to-review',
  'failed',
  'merged',
  'closed',
] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** A thread status plus the transient plan-ready marker. */
export type StatusKey = ThreadStatus | 'plan-ready';

export type StatusTone = 'neutral' | 'running' | 'warning' | 'success' | 'error' | 'plan';

export const STATUS_TONE: Record<StatusKey, StatusTone> = {
  idle: 'neutral',
  running: 'running',
  'needs-approval': 'warning',
  'ready-to-review': 'success',
  failed: 'error',
  merged: 'success',
  closed: 'neutral',
  'plan-ready': 'plan',
};

export const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  running: 'bg-info',
  warning: 'bg-warning',
  success: 'bg-success',
  error: 'bg-error',
  plan: 'bg-plan-foreground',
};

export const STATUS_TEXT_CLASS: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  running: 'text-info-foreground',
  warning: 'text-warning-foreground',
  success: 'text-success-foreground',
  error: 'text-error-foreground',
  plan: 'text-plan-foreground',
};

export const STATUS_LABEL: Record<StatusKey, string> = {
  idle: 'Idle',
  running: 'Running',
  'needs-approval': 'Needs approval',
  'ready-to-review': 'Ready to review',
  failed: 'Failed',
  merged: 'Merged',
  closed: 'Closed',
  'plan-ready': 'Plan ready',
};

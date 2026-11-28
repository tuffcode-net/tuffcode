/**
 * Thread status to color mapping.
 *
 * Hues are fixed by the design system: running sky, needs-approval amber,
 * ready-to-review emerald, failed red, plan-ready violet.
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
  running: 'bg-sky-400',
  warning: 'bg-amber-400',
  success: 'bg-emerald-400',
  error: 'bg-red-400',
  plan: 'bg-violet-400',
};

export const STATUS_TEXT_CLASS: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  running: 'text-sky-400',
  warning: 'text-amber-400',
  success: 'text-emerald-400',
  error: 'text-red-400',
  plan: 'text-violet-400',
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

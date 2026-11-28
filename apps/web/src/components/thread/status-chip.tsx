import { STATUS_LABEL, cn, type StatusKey } from '@tuffcode/ui';

/** Chip hues: running sky, needs-approval amber, ready-to-review emerald, failed red. */
export type StatusChipTone = 'neutral' | 'running' | 'warning' | 'success' | 'error' | 'plan';

export interface StatusChipSpec {
  label: string;
  tone: StatusChipTone;
  className: string;
}

const STATUS_CHIP_TONE: Record<StatusKey, StatusChipTone> = {
  idle: 'neutral',
  running: 'running',
  'needs-approval': 'warning',
  'ready-to-review': 'success',
  failed: 'error',
  merged: 'success',
  closed: 'neutral',
  'plan-ready': 'plan',
};

const STATUS_CHIP_CLASS: Record<StatusChipTone, string> = {
  neutral: 'bg-muted-foreground/10 text-muted-foreground',
  running: 'bg-sky-400/10 text-sky-400',
  warning: 'bg-amber-400/10 text-amber-400',
  success: 'bg-emerald-400/10 text-emerald-400',
  error: 'bg-red-400/10 text-red-400',
  plan: 'bg-violet-400/10 text-violet-400',
};

/** Maps a thread status onto its tinted chip label and 10 percent background. */
export function statusChip(status: StatusKey): StatusChipSpec {
  const tone = STATUS_CHIP_TONE[status];
  return { label: STATUS_LABEL[status], tone, className: STATUS_CHIP_CLASS[tone] };
}

export interface StatusChipProps {
  status: StatusKey;
  className?: string;
}

export function StatusChip({ status, className }: StatusChipProps) {
  const chip = statusChip(status);
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-2xs font-medium whitespace-nowrap',
        chip.className,
        className,
      )}
    >
      {chip.label}
    </span>
  );
}

import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 text-2xs font-medium tabular-nums',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-muted text-muted-foreground',
        primary: 'border-transparent bg-primary/15 text-primary-soft',
        success: 'border-transparent bg-success/15 text-success-foreground',
        warning: 'border-transparent bg-warning/15 text-warning-foreground',
        error: 'border-transparent bg-error/15 text-error-foreground',
        info: 'border-transparent bg-info/15 text-info-foreground',
        outline: 'border-border bg-transparent text-foreground',
      },
      size: {
        sm: 'h-4',
        md: 'h-5',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      size: 'md',
    },
  },
);

export type BadgeProps = ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    className?: string;
  };

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

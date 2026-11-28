import type { ServerEvent } from '@tuffcode/contracts';
import {
  Button,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@tuffcode/ui';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import {
  CONTEXT_BAR_MIN_WIDTH_PX,
  CONTEXT_BAR_TONE_CLASS,
  CONTEXT_METER_TONE_CLASS,
  barWidthPercent,
  contextBarTone,
  contextMeterTone,
  contextTokenLine,
  contextTooltip,
  formatPercent,
  formatSegmentPercent,
  formatTokenCount,
  segmentPercent,
  usagePercent,
  type ContextSegment,
  type ContextUsage,
} from './context-meter';

export interface ContextMeterProps {
  threadId: string;
  /** Settings `contextWarningThreshold`; the chip turns warning above it. */
  threshold: number;
}

type ContextUpdate = Extract<ServerEvent, { type: 'context.updated' }>['payload'];

function usageFromUpdate(update: ContextUpdate, previous: ContextUsage | null): ContextUsage {
  const segments: ContextSegment[] = previous?.segments ?? [];
  return {
    usedTokens: update.usedTokens,
    maxTokens: update.maxTokens,
    percent: update.percent,
    limitSource: update.limitSource,
    segments,
    ...(previous?.compactedAt ? { compactedAt: previous.compactedAt } : {}),
  };
}

/**
 * Compact token meter beside the model chip. It asks `threads.context` once when
 * the thread opens, then follows `context.updated`. A server that does not know
 * the method simply leaves the meter hidden instead of showing an error.
 */
export function ContextMeter({ threadId, threshold }: ContextMeterProps) {
  const rpc = useRpc();
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    let disposed = false;
    setUsage(null);

    function load(): void {
      void rpc.request('threads.context', { threadId }).then(
        (result) => {
          if (disposed) return;
          setUsage({
            usedTokens: result.usedTokens,
            maxTokens: result.maxTokens,
            percent: result.percent,
            limitSource: result.limitSource,
            segments: result.segments,
            ...(result.compactedAt ? { compactedAt: result.compactedAt } : {}),
          });
        },
        () => {
          // Unknown on an older server: keep the chip hidden.
        },
      );
    }

    load();
    const unsubscribe = rpc.onEvent((event) => {
      if (event.type !== 'context.updated' || event.payload.threadId !== threadId) return;
      setUsage((previous) => usageFromUpdate(event.payload, previous));
      // The event carries totals only; compaction replaces the segments.
      if (event.payload.compacted) load();
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [rpc, threadId]);

  if (usage === null) return null;

  const percent = usagePercent(usage);
  const tone = contextMeterTone(percent, threshold);
  const barTone = contextBarTone(percent, threshold);
  const warning = tone === 'warning';
  const barStyle = {
    width: `${barWidthPercent(percent)}%`,
    minWidth: percent > 0 ? `${CONTEXT_BAR_MIN_WIDTH_PX}px` : undefined,
  };

  async function compactNow(): Promise<void> {
    if (compacting) return;
    setCompacting(true);
    try {
      await rpc.request('threads.send', { id: threadId, text: '/compact' });
      setOpen(false);
      toast('Compacting the conversation.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not compact the conversation.');
    } finally {
      setCompacting(false);
    }
  }

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              data-testid="context-meter"
              data-tone={tone}
              aria-label={`Context ${formatPercent(percent)} used`}
              className={cn(
                'flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-2xs tabular-nums',
                'outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                CONTEXT_METER_TONE_CLASS[tone],
              )}
            >
              <span
                aria-hidden="true"
                className="relative h-1 w-8 overflow-hidden rounded-full bg-border"
              >
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-full',
                    CONTEXT_BAR_TONE_CLASS[barTone],
                  )}
                  style={barStyle}
                />
              </span>
              <span className="font-medium">{formatPercent(percent)}</span>
            </PopoverTrigger>
          }
        />
        <TooltipContent className="whitespace-pre-line">{contextTooltip(usage)}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" side="top" className="w-64 p-2" data-testid="context-breakdown">
        <div className="flex items-baseline justify-between gap-2 px-0.5">
          <span className="text-xs font-medium text-foreground">Context</span>
          <span className={cn('text-2xs tabular-nums', CONTEXT_METER_TONE_CLASS[tone])}>
            {formatPercent(percent)}
          </span>
        </div>
        <p className="px-0.5 text-2xs text-muted-foreground">{contextTokenLine(usage)}</p>

        <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
          <div
            className={cn('h-full rounded-full', CONTEXT_BAR_TONE_CLASS[barTone])}
            style={barStyle}
          />
        </div>

        {usage.segments.length > 0 ? (
          <ul aria-label="Context segments" className="mt-2 flex flex-col gap-1">
            {usage.segments.map((segment) => (
              <li key={segment.name} className="flex items-center gap-2 text-2xs">
                <span
                  className="min-w-0 flex-1 truncate text-muted-foreground"
                  title={segment.name}
                >
                  {segment.name}
                </span>
                <span className="tabular-nums text-foreground">
                  {formatTokenCount(segment.tokens)}
                </span>
                <span className="w-9 text-right tabular-nums text-muted-foreground">
                  {formatSegmentPercent(segmentPercent(segment.tokens, usage.maxTokens))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-2xs text-muted-foreground">No breakdown reported yet.</p>
        )}

        {warning ? (
          <p className="mt-2 rounded-sm bg-warning-surface px-2 py-1.5 text-2xs leading-4 text-warning-foreground">
            Above the {formatPercent(threshold)} warning threshold. Auto-compact trims older history
            before the next turn.
          </p>
        ) : null}

        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="context-compact-now"
            disabled={compacting}
            onClick={() => void compactNow()}
          >
            {compacting ? <Spinner size="sm" /> : null}
            Compact now
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

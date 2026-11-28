import { Check } from 'lucide-react';
import { StatusDot, cn } from '@tuffcode/ui';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/app-store';
import { formatDuration } from '../thread/turn-blocks';
import {
  SUBAGENT_STATUS_TONE,
  SUBAGENT_TYPE_ICON,
  SUBAGENT_TYPE_LABEL,
  isRunningSubagent,
  runningSubagentCount,
  subagentElapsedMs,
  subagentStripChips,
  subagentsOfThread,
} from './subagent-model';
import { useSubagentClock } from './use-subagents';

export interface SubagentStripProps {
  threadId: string;
  onOpen(childId: string): void;
}

const MORE_CHIP_CLASS =
  'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors duration-150 ease-out hover:bg-accent hover:text-foreground';

/**
 * The dock above the composer, decision D40: one compact chip row with no task
 * text, no model and no cards. Each chip opens the pane on its child; a crowded row
 * folds the extra children into a count, and a fully settled set folds into one
 * finished chip.
 */
export function SubagentStrip({ threadId, onOpen }: SubagentStripProps) {
  const subagents = useAppStore(
    useShallow((state) => subagentsOfThread(state.subagents, threadId)),
  );
  const now = useSubagentClock(subagents);
  const chips = subagentStripChips(subagents);

  if (chips.length === 0) return null;

  const running = runningSubagentCount(subagents);

  return (
    <div className="flex shrink-0 justify-center px-4 pt-1 pb-0.5">
      <div
        data-testid="subagent-strip"
        data-running={running > 0 ? 'true' : 'false'}
        data-running-count={running}
        data-child-count={subagents.length}
        className="flex h-8 max-w-[var(--chat-content-max-width)] items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card/60 px-1.5 py-1"
      >
        {chips.map((chip) => {
          if (chip.kind === 'finished') {
            return (
              <button
                key="finished"
                type="button"
                data-testid="subagent-strip-finished"
                data-child-id={chip.childId}
                onClick={() => onOpen(chip.childId)}
                className={MORE_CHIP_CLASS}
              >
                <Check aria-hidden="true" strokeWidth={1.75} className="size-3 shrink-0" />
                <span className="truncate">{chip.label}</span>
              </button>
            );
          }

          if (chip.kind === 'more') {
            return (
              <button
                key="more"
                type="button"
                data-testid="subagent-strip-more"
                data-child-id={chip.childId}
                aria-label={`Open the running subagent, ${chip.count} more hidden`}
                onClick={() => onOpen(chip.childId)}
                className={MORE_CHIP_CLASS}
              >
                <span className="tabular-nums">+{chip.count} more</span>
              </button>
            );
          }

          const { child } = chip;
          const Icon = SUBAGENT_TYPE_ICON[child.type];
          const live = isRunningSubagent(child);
          const elapsed = live ? formatDuration(subagentElapsedMs(child, now)) : '';
          const task = child.task.replace(/\s+/g, ' ').trim();
          const snippet = task.length <= 28 ? task : `${task.slice(0, 27)}...`;

          return (
            <button
              key={child.childId}
              type="button"
              data-testid="subagent-strip-chip"
              data-child-id={child.childId}
              data-subagent-type={child.type}
              data-status={child.status}
              aria-label={`Open the ${SUBAGENT_TYPE_LABEL[child.type]} subagent: ${snippet}`}
              title={task}
              onClick={() => onOpen(child.childId)}
              className={cn(
                'flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-2xs transition-colors duration-150 ease-out',
                live
                  ? 'border-primary/30 bg-primary/10 text-foreground hover:bg-primary/15'
                  : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" strokeWidth={1.75} className="size-3 shrink-0" />
              <span className="max-w-24 truncate">
                {SUBAGENT_TYPE_LABEL[child.type]}
                {snippet.length > 0 ? `: ${snippet}` : ''}
              </span>
              {elapsed.length > 0 ? (
                <span className="shrink-0 tabular-nums text-muted-foreground/70">{elapsed}</span>
              ) : null}
              <StatusDot status={SUBAGENT_STATUS_TONE[child.status]} className="shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

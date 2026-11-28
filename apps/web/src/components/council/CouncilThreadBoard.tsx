import type { Task } from '@tuffcode/contracts';
import { Badge, Button, Spinner, cn } from '@tuffcode/ui';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import {
  GOAL_STATE_LABEL,
  GOAL_STATE_TONE,
  countFinishedTasks,
  isGoalTerminal,
} from '../inspector/council-model';
import { CouncilBoard } from './CouncilBoard';
import { CouncilDecisions } from './CouncilDecisions';
import type { BoardNode } from './council-board';
import { useCouncilStatus } from './use-council-status';

export interface CouncilThreadBoardProps {
  threadId: string;
}

/**
 * The council board inside a council thread, decisions D42 and D51: a bordered
 * surface with the goal state and the task counts in its header and the node board
 * below it, collapsible so the timeline keeps the room. It never starts a goal; the
 * composer's goal box is the only entry point.
 */
export function CouncilThreadBoard({ threadId }: CouncilThreadBoardProps) {
  const rpc = useRpc();
  const navigate = useNavigate();
  const projectId = useAppStore((state) => state.threads[threadId]?.projectId);
  const { status, error, loading, reload } = useCouncilStatus(threadId);
  const [open, setOpen] = useState(true);
  const [selectedNode, setSelectedNode] = useState<BoardNode | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const goal = status?.goal ?? null;
  const tasks = status?.tasks ?? [];
  const terminal = goal === null || isGoalTerminal(goal.state);

  async function cancel(goalId: string): Promise<void> {
    if (cancelling) return;
    setCancelling(true);
    try {
      await rpc.request('council.cancel', { goalId });
      reload();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not cancel the council goal.');
    } finally {
      setCancelling(false);
    }
  }

  function openTask(task: Task): void {
    if (task.threadId === null || projectId === undefined) return;
    void navigate({
      to: '/project/$projectId/thread/$threadId',
      params: { projectId, threadId: task.threadId },
    });
  }

  return (
    <section data-testid="council-thread-board" aria-label="Council board" className="shrink-0 px-4 pb-1">
      <div className="mx-auto w-full max-w-[var(--chat-content-max-width)] overflow-hidden rounded-xl border border-border bg-card/40">
        <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
          <span className="shrink-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Council
          </span>
          {goal === null ? null : (
            <Badge variant={GOAL_STATE_TONE[goal.state]} size="sm">
              {GOAL_STATE_LABEL[goal.state]}
            </Badge>
          )}
          {tasks.length > 0 ? (
            <span
              data-testid="council-thread-board-counts"
              className="shrink-0 text-2xs tabular-nums text-muted-foreground"
            >
              {countFinishedTasks(tasks)}/{tasks.length} tasks
            </span>
          ) : null}
          <span className="min-w-0 flex-1" />
          {loading && status === null ? <Spinner size="sm" label="Reading the council goal" /> : null}
          <Button
            size="sm"
            variant="ghost"
            data-testid="council-thread-board-toggle"
            aria-label={open ? 'Collapse the council board' : 'Expand the council board'}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown
              aria-hidden="true"
              strokeWidth={1.75}
              className={cn('transition-transform duration-150', open ? 'rotate-180' : 'rotate-0')}
            />
          </Button>
        </div>

        {error === null ? null : (
          <p role="alert" className="border-t border-border px-2.5 py-1.5 text-2xs text-error">
            {error}
          </p>
        )}

        {/* Kept outside the collapse so a pending decision never hides with the board. */}
        <CouncilDecisions status={status} onChanged={reload} />

        {open ? (
          goal === null ? (
            <p
              data-testid="council-thread-board-empty"
              className="border-t border-border px-2.5 py-2 text-2xs leading-5 text-muted-foreground"
            >
              No council goal yet. Write a goal below to start the planner.
            </p>
          ) : (
            <CouncilBoard
              status={status}
              selectedNodeId={selectedNode?.id ?? null}
              onSelectNode={setSelectedNode}
              onOpenTask={openTask}
              onCancel={() => void cancel(goal.id)}
              cancelling={cancelling}
              canCancel={!terminal}
              className="h-64 border-t border-border min-[64rem]:h-80"
            />
          )
        ) : null}
      </div>
    </section>
  );
}

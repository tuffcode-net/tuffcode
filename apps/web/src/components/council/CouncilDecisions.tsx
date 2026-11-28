import type { RpcResult, Task } from '@tuffcode/contracts';
import { Badge, Button, Textarea, cn } from '@tuffcode/ui';
import { useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';

export interface CouncilDecisionsProps {
  status: RpcResult<'council.status'> | null;
  /** Re-reads the goal after the server accepted an answer. */
  onChanged: () => void;
  className?: string;
}

/**
 * The two places a council goal waits for the captain, decisions D43 and D47: a
 * manual plan that has not been approved yet, and a task a reviewer escalated. Both
 * answers go through the same RPC client the board uses; the board itself is left
 * alone so the plan stays the same picture before and after approval.
 */
export function CouncilDecisions({ status, onChanged, className }: CouncilDecisionsProps) {
  const rpc = useRpc();
  const [pending, setPending] = useState<string | null>(null);
  const [planFeedback, setPlanFeedback] = useState('');
  const [taskFeedback, setTaskFeedback] = useState<Record<string, string>>({});

  const goal = status?.goal ?? null;
  const tasks = status?.tasks ?? [];
  const escalations = status?.escalations ?? [];
  const plan = status?.plan ?? [];
  const awaitingApproval = goal !== null && goal.state === 'awaiting-approval';
  const escalated = tasks.filter((task) => task.state === 'awaiting-captain');

  if (goal === null || (!awaitingApproval && escalated.length === 0)) return null;

  async function answer(key: string, action: () => Promise<unknown>): Promise<void> {
    if (pending !== null) return;
    setPending(key);
    try {
      await action();
      onChanged();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : 'The council did not accept that answer.',
      );
    } finally {
      setPending(null);
    }
  }

  function openQuestion(task: Task): string | null {
    const open = escalations.findLast(
      (row) => row.taskId === task.id && row.resolvedAt === null,
    );
    return open?.question ?? null;
  }

  return (
    <div
      data-testid="council-decisions"
      className={cn('flex flex-col gap-3 border-t border-border px-2.5 py-2', className)}
    >
      {awaitingApproval && goal !== null ? (
        <div data-testid="council-plan-approval" className="flex flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              Plan approval
            </span>
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {plan.length === 0 ? 'no plan in memory' : `${plan.length} tasks`}
            </span>
            <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground" title={goal.text}>
              {goal.text}
            </span>
          </div>
          {plan.length === 0 ? null : (
            <ul className="flex flex-col gap-1">
              {plan.map((entry) => (
                <li
                  key={entry.taskId}
                  data-testid="council-plan-task"
                  data-task-id={entry.taskId}
                  className="text-2xs leading-4"
                >
                  <span className="font-medium text-foreground">{entry.title}</span>
                  {entry.critical ? (
                    <Badge variant="warning" size="sm" className="ml-1.5">
                      Critical
                    </Badge>
                  ) : null}
                  {entry.dependsOn.length > 0 ? (
                    <span className="text-muted-foreground">
                      {' '}
                      after {entry.dependsOn.join(', ')}
                    </span>
                  ) : null}
                  <span className="block truncate font-mono text-muted-foreground">
                    {entry.files.length === 0 ? 'no files declared' : entry.files.join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Textarea
            data-testid="council-plan-feedback"
            value={planFeedback}
            rows={2}
            aria-label="Plan revision feedback"
            placeholder="What should the planner change? Required to revise."
            onChange={(event) => setPlanFeedback(event.target.value)}
            className="min-h-14 text-xs"
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              data-testid="council-approve-plan"
              disabled={pending !== null}
              onClick={() =>
                void answer('approve', () =>
                  rpc.request('council.approvePlan', { goalId: goal.id }),
                )
              }
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="council-revise-plan"
              disabled={pending !== null || planFeedback.trim().length === 0}
              onClick={() =>
                void answer('revise', () =>
                  rpc.request('council.revisePlan', {
                    goalId: goal.id,
                    feedback: planFeedback.trim(),
                  }),
                )
              }
            >
              Revise plan
            </Button>
          </div>
        </div>
      ) : null}

      {escalated.map((task) => {
        const feedback = taskFeedback[task.id] ?? '';
        const question = openQuestion(task);
        return (
          <div
            key={task.id}
            data-testid="council-escalation"
            data-task-id={task.id}
            className="flex flex-col gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                Captain decision
              </span>
              <span
                className="min-w-0 flex-1 truncate text-2xs font-medium text-foreground"
                title={task.title}
              >
                {task.title}
              </span>
              {task.round > 0 ? (
                <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                  round {task.round}
                </span>
              ) : null}
            </div>
            <p
              data-testid="council-escalation-question"
              className="max-h-24 overflow-y-auto text-2xs leading-4 break-words whitespace-pre-wrap text-muted-foreground"
            >
              {question ?? 'This task awaits a captain decision.'}
            </p>
            <Textarea
              data-testid="council-escalation-feedback"
              value={feedback}
              rows={2}
              aria-label={`Revision feedback for ${task.title}`}
              placeholder="What should the worker change? Required to revise."
              onChange={(event) =>
                setTaskFeedback((current) => ({ ...current, [task.id]: event.target.value }))
              }
              className="min-h-14 text-xs"
            />
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="primary"
                data-testid="council-escalation-accept"
                disabled={pending !== null}
                onClick={() =>
                  void answer(`accept:${task.id}`, () =>
                    rpc.request('council.answerEscalation', {
                      taskId: task.id,
                      decision: 'accept',
                    }),
                  )
                }
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="council-escalation-revise"
                disabled={pending !== null || feedback.trim().length === 0}
                onClick={() =>
                  void answer(`revise:${task.id}`, () =>
                    rpc.request('council.answerEscalation', {
                      taskId: task.id,
                      decision: 'revise',
                      feedback: feedback.trim(),
                    }),
                  )
                }
              >
                Revise
              </Button>
              <Button
                size="sm"
                variant="danger"
                data-testid="council-escalation-drop"
                disabled={pending !== null}
                onClick={() =>
                  void answer(`drop:${task.id}`, () =>
                    rpc.request('council.answerEscalation', {
                      taskId: task.id,
                      decision: 'drop',
                    }),
                  )
                }
              >
                Drop
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

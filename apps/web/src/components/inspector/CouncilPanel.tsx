import type { RpcResult, Review, Task, TaskState } from '@tuffcode/contracts';
import { Badge, Button, ScrollArea, Spinner } from '@tuffcode/ui';
import { useNavigate } from '@tanstack/react-router';
import { MessagesSquare, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import { CouncilBoard } from '../council/CouncilBoard';
import type { BoardNode } from '../council/council-board';
import { goalIdFromLatest } from '../council/council-goal-source';
import {
  GOAL_STATE_LABEL,
  GOAL_STATE_TONE,
  REVIEW_VERDICT_LABEL,
  REVIEW_VERDICT_TONE,
  TASK_STATE_LABEL,
  TASK_STATE_TONE,
  councilErrorMessage,
  countFinishedTasks,
  isGoalTerminal,
  isPermanentCouncilFailure,
} from './council-model';

export interface CouncilPanelProps {
  threadId: string;
}

type CouncilStatus = RpcResult<'council.status'>;

const POLL_INTERVAL_MS = 3000;

/**
 * Council dashboard: follow this thread's goal state, cancel it, and read the
 * reviewer verdicts. Goals are started from the thread composer, which owns the
 * only goal input, so the panel never renders a second one.
 */
export function CouncilPanel({ threadId }: CouncilPanelProps) {
  const rpc = useRpc();
  const navigate = useNavigate();
  const projectId = useAppStore((state) => state.threads[threadId]?.projectId);
  const executionMode = useAppStore((state) => state.threads[threadId]?.executionMode ?? 'work');
  const upsertThread = useAppStore((state) => state.upsertThread);

  const [goalId, setGoalId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(executionMode === 'council');
  // The goal the user dismissed with New goal; it stays hidden until a different
  // goal replaces it.
  const dismissedGoal = useRef<string | null>(null);
  const [status, setStatus] = useState<CouncilStatus | null>(null);
  const [selectedNode, setSelectedNode] = useState<BoardNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const [switchingMode, setSwitchingMode] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (goalId === null) return;
    setLoading(true);
    try {
      const next = await rpc.request('council.status', { goalId });
      setStatus(next);
      setError(null);
      setPollingStopped(false);
    } catch (cause) {
      setError(councilErrorMessage(cause));
      // A stale or forbidden goal id will never recover by polling; Retry or a
      // new goal is the only way forward.
      if (isPermanentCouncilFailure(cause)) setPollingStopped(true);
    } finally {
      setLoading(false);
    }
  }, [rpc, goalId]);

  const resolveLatest = useCallback(async (): Promise<void> => {
    try {
      const latest = await rpc.request('council.latest', { threadId });
      setGoalId(goalIdFromLatest(latest, dismissedGoal.current));
      setPollingStopped(false);
    } catch {
      // A failed lookup must not block the composer from starting a goal.
      setGoalId(null);
    }
  }, [rpc, threadId]);

  // Only the first lookup for a thread shows the resolving state; the adoption poll
  // stays silent so the empty board does not flash every few seconds.
  const refreshGoal = useCallback(async (): Promise<void> => {
    setResolving(true);
    try {
      await resolveLatest();
    } finally {
      setResolving(false);
    }
  }, [resolveLatest]);

  // A goal id lives on the server, so a reload reattaches to whatever the thread ran
  // last. Work-mode threads have no council goal, so they never ask.
  useEffect(() => {
    if (executionMode !== 'council') {
      setResolving(false);
      return;
    }
    void refreshGoal();
  }, [executionMode, refreshGoal]);

  useEffect(() => {
    if (goalId === null) {
      setStatus(null);
      setError(null);
      return;
    }
    void load();
  }, [goalId, load, reloadToken]);

  // The board follows events between polls so a state change shows up in the same
  // frame the server announces it. With no goal yet, the first event for this thread
  // (a goal started from the composer) pulls in the new goal.
  useEffect(() => {
    return rpc.onEvent((event) => {
      if (event.type !== 'council.updated') return;
      if (goalId !== null) {
        if (event.payload.goalId === goalId) void load();
        return;
      }
      if (event.threadId === threadId) void resolveLatest();
    });
  }, [goalId, load, resolveLatest, rpc, threadId]);

  const goalState = status?.goal.state;
  useEffect(() => {
    if (goalId === null || pollingStopped) return;
    if (goalState !== undefined && isGoalTerminal(goalState)) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [goalId, goalState, load, pollingStopped]);

  // The composer starts the goal, so the panel keeps asking for the thread's newest
  // one while it has none; a missed event still resolves within a poll.
  useEffect(() => {
    if (goalId !== null || executionMode !== 'council' || resolving) return;
    const timer = setInterval(() => void resolveLatest(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [executionMode, goalId, resolveLatest, resolving]);

  async function switchToCouncil(): Promise<void> {
    if (switchingMode) return;
    setSwitchingMode(true);
    setSwitchError(null);
    try {
      upsertThread(
        await rpc.request('threads.update', { id: threadId, executionMode: 'council' }),
      );
    } catch (cause) {
      setSwitchError(councilErrorMessage(cause));
    } finally {
      setSwitchingMode(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (goalId === null || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await rpc.request('council.cancel', { goalId });
      await load();
    } catch (cause) {
      setCancelError(councilErrorMessage(cause));
    } finally {
      setCancelling(false);
    }
  }

  function handleNewGoal(): void {
    dismissedGoal.current = goalId;
    setGoalId(null);
    setStatus(null);
    setSelectedNode(null);
    setError(null);
    setPollingStopped(false);
    setCancelError(null);
  }

  function retry(): void {
    setPollingStopped(false);
    setReloadToken((token) => token + 1);
  }

  function openTaskThread(task: Task): void {
    if (task.threadId === null || projectId === undefined) return;
    void navigate({
      to: '/project/$projectId/thread/$threadId',
      params: { projectId, threadId: task.threadId },
    });
  }

  const selectedReview = useMemo<Review | null>(() => {
    const taskId = selectedNode?.taskId ?? null;
    if (taskId === null || status === null) return null;
    const forTask = status.reviews.filter((review) => review.taskId === taskId);
    return forTask[forTask.length - 1] ?? null;
  }, [selectedNode, status]);

  if (goalId === null && resolving) {
    return (
      <section
        aria-label="Council"
        data-testid="council-panel"
        data-resolving="true"
        className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-background text-foreground"
      >
        <Spinner size="sm" label="Looking for a goal" />
        <p className="text-xs text-muted-foreground">Looking for this thread's last goal</p>
      </section>
    );
  }

  if (goalId === null) {
    return (
      <section
        aria-label="Council"
        data-testid="council-panel"
        className="flex h-full min-h-0 flex-col bg-background text-foreground"
      >
        {executionMode === 'council' ? null : (
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="council-switch-mode"
              disabled={switchingMode}
              onClick={() => void switchToCouncil()}
            >
              {switchingMode ? (
                <Spinner size="sm" label="Switching to council" />
              ) : (
                <MessagesSquare strokeWidth={1.75} />
              )}
              Switch thread to council
            </Button>
            {switchError === null ? null : (
              <p role="alert" className="text-2xs leading-5 text-error">
                {switchError}
              </p>
            )}
          </div>
        )}

        <CouncilBoard
          status={null}
          selectedNodeId={null}
          onSelectNode={() => undefined}
          onOpenTask={() => undefined}
          onCancel={() => undefined}
          cancelling={false}
          canCancel={false}
          className="min-h-0 flex-1"
        />
      </section>
    );
  }

  const terminal = goalState !== undefined && isGoalTerminal(goalState);

  return (
    <section
      aria-label="Council"
      data-testid="council-panel"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      {status === null ? (
        <div className="flex flex-1 items-center justify-center p-4">
          {error === null ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size="sm" label="Loading goal" />
              Loading goal
            </span>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <p role="alert" className="max-w-72 text-center text-xs leading-5 text-error">
                {error}
              </p>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={retry}>
                  Retry
                </Button>
                <Button size="sm" variant="ghost" onClick={handleNewGoal}>
                  New goal
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <Badge variant={GOAL_STATE_TONE[status.goal.state]}>
              {GOAL_STATE_LABEL[status.goal.state]}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-xs" title={status.goal.text}>
              {status.goal.text}
            </span>
            {loading ? <Spinner size="sm" label="Refreshing goal" /> : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-2xs text-muted-foreground">
            <span>{status.goal.autonomy === 'auto' ? 'Auto' : 'Manual'}</span>
            <span className="tabular-nums">
              {countFinishedTasks(status.tasks)}/{status.tasks.length} tasks finished
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={loading} onClick={retry}>
                <RefreshCw strokeWidth={1.75} />
                Refresh
              </Button>
              {terminal ? (
                <Button size="sm" variant="outline" onClick={handleNewGoal}>
                  New goal
                </Button>
              ) : null}
            </div>
          </div>

          {error ? (
            <p
              role="alert"
              className="shrink-0 border-b border-border px-3 py-2 text-2xs text-error"
            >
              {error}
            </p>
          ) : null}
          {cancelError ? (
            <p
              role="alert"
              className="shrink-0 border-b border-border px-3 py-2 text-2xs text-error"
            >
              {cancelError}
            </p>
          ) : null}

          <CouncilBoard
            status={status}
            selectedNodeId={selectedNode?.id ?? null}
            onSelectNode={setSelectedNode}
            onOpenTask={openTaskThread}
            onCancel={() => void handleCancel()}
            cancelling={cancelling}
            canCancel={!terminal}
            className="h-80 shrink-0 border-b border-border"
          />

          {selectedNode === null ? null : (
            <div
              data-testid="council-node-details"
              data-kind={selectedNode.kind}
              className="shrink-0 border-b border-border bg-message-surface/40 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  {selectedNode.kind === 'reviewer' ? 'Review' : selectedNode.kind}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                  title={selectedNode.title}
                >
                  {selectedNode.kind === 'planner' || selectedNode.kind === 'report'
                    ? status.goal.text
                    : selectedNode.title}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Close node details"
                  onClick={() => setSelectedNode(null)}
                >
                  <X strokeWidth={1.75} />
                </Button>
              </div>

              {selectedNode.kind === 'planner' ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
                  <Badge variant={GOAL_STATE_TONE[status.goal.state]} size="sm">
                    {GOAL_STATE_LABEL[status.goal.state]}
                  </Badge>
                  <span>{status.goal.autonomy === 'auto' ? 'Auto' : 'Manual'}</span>
                  <span className="tabular-nums">
                    {status.tasks.length} {status.tasks.length === 1 ? 'task' : 'tasks'} planned
                  </span>
                  <p className="w-full leading-5">{status.goal.text}</p>
                </div>
              ) : null}

              {selectedNode.kind === 'report' ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
                  <Badge variant={GOAL_STATE_TONE[status.goal.state]} size="sm">
                    {GOAL_STATE_LABEL[status.goal.state]}
                  </Badge>
                  <span className="tabular-nums">
                    {countFinishedTasks(status.tasks)}/{status.tasks.length} tasks finished
                  </span>
                  <span className="tabular-nums">
                    {status.reviews.filter((review) => review.verdict === 'pass').length} passed
                  </span>
                  <span className="tabular-nums">
                    {
                      status.reviews.filter((review) => review.verdict === 'changes-requested')
                        .length
                    }{' '}
                    changes
                  </span>
                  <span className="tabular-nums">
                    {status.reviews.filter((review) => review.verdict === 'escalate').length}{' '}
                    escalated
                  </span>
                </div>
              ) : null}

              {selectedNode.kind === 'reviewer' ? (
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
                    {selectedReview === null ? (
                      <span>No verdict yet.</span>
                    ) : (
                      <Badge variant={REVIEW_VERDICT_TONE[selectedReview.verdict]} size="sm">
                        {REVIEW_VERDICT_LABEL[selectedReview.verdict]}
                      </Badge>
                    )}
                    <span className="truncate font-mono">
                      {selectedReview?.modelId ?? selectedNode.model ?? 'no reviewer assigned'}
                    </span>
                  </div>
                  {selectedReview !== null && selectedReview.body.length > 0 ? (
                    <p className="max-h-24 overflow-y-auto text-xs leading-5 break-words whitespace-pre-wrap">
                      {selectedReview.body}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {selectedNode.kind === 'task' ? (
                <div className="flex flex-col gap-1 text-2xs text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant={TASK_STATE_TONE[selectedNode.state as TaskState]} size="sm">
                      {TASK_STATE_LABEL[selectedNode.state as TaskState]}
                    </Badge>
                    <span className="truncate font-mono">{selectedNode.model ?? 'no model'}</span>
                    <span>
                      {status.tasks.find((task) => task.id === selectedNode.taskId)?.threadId ===
                      null
                        ? 'No child thread yet'
                        : 'Click the node to open its thread'}
                    </span>
                  </div>
                  <p className="leading-5">
                    {status.tasks.find((task) => task.id === selectedNode.taskId)?.brief ?? ''}
                  </p>
                </div>
              ) : null}
            </div>
          )}

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  Tasks
                </span>
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {status.tasks.length}
                </span>
              </div>
              {status.tasks.length === 0 ? (
                <p className="px-3 pb-2 text-2xs leading-5 text-muted-foreground">
                  The goal has not split into tasks yet.
                </p>
              ) : (
                <ul
                  aria-label="Council tasks"
                  className="divide-y divide-border border-y border-border"
                >
                  {status.tasks.map((task) => (
                    <li key={task.id} className="flex flex-col gap-1 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Badge variant={TASK_STATE_TONE[task.state]} size="sm">
                          {TASK_STATE_LABEL[task.state]}
                        </Badge>
                        <span
                          className="min-w-0 flex-1 truncate text-xs font-medium"
                          title={task.title}
                        >
                          {task.title}
                        </span>
                        {task.critical ? (
                          <span className="shrink-0 text-2xs text-warning-foreground">
                            critical
                          </span>
                        ) : null}
                        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                          round {task.round}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-2 text-2xs text-muted-foreground">
                        <span>
                          author {task.authorProvider}/{task.authorModel}
                        </span>
                        {task.reviewerModel !== null ? (
                          <span>
                            review {task.reviewerProvider ?? 'unknown'}/{task.reviewerModel}
                          </span>
                        ) : null}
                      </div>
                      {task.error !== null ? (
                        <p className="text-2xs leading-5 text-error">{task.error}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  Reviews
                </span>
                <span className="text-2xs tabular-nums text-muted-foreground">
                  {status.reviews.length}
                </span>
              </div>
              {status.reviews.length === 0 ? (
                <p className="px-3 pb-2 text-2xs leading-5 text-muted-foreground">
                  No reviewer verdicts yet.
                </p>
              ) : (
                <ul
                  aria-label="Council reviews"
                  className="divide-y divide-border border-t border-border"
                >
                  {status.reviews.map((review) => (
                    <li key={review.id} className="flex flex-col gap-1 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Badge variant={REVIEW_VERDICT_TONE[review.verdict]} size="sm">
                          {REVIEW_VERDICT_LABEL[review.verdict]}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                          {status.tasks.find((task) => task.id === review.taskId)?.title ??
                            review.taskId}
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {review.modelId}
                        </span>
                      </div>
                      {review.body.length > 0 ? (
                        <p className="text-xs leading-5 break-words whitespace-pre-wrap">
                          {review.body}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </section>
  );
}

import type { SubagentType, ThreadEventRow } from '@tuffcode/contracts';
import { Badge, Button, cn, EmptyState, IconButton, Input, ScrollArea } from '@tuffcode/ui';
import { Activity, ChevronRight, MessageSquare, Square } from 'lucide-react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { TodoList, todoProgress, useThreadTodos } from '../todos/TodoList';
import { ActivityContext } from './ActivityContext';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/app-store';
import { useCouncilStatus } from '../council/use-council-status';
import {
  SUBAGENT_STATUS_LABEL,
  SUBAGENT_STATUS_TONE,
  SUBAGENT_TYPE_ICON,
  SUBAGENT_TYPE_LABEL,
  isRunningSubagent,
  subagentElapsedMs,
  subagentsOfThread,
} from '../subagents/subagent-model';
import { StatusChip } from '../thread/status-chip';
import { formatDuration, outputTail } from '../thread/turn-blocks';
import {
  councilActivityOf,
  finishedToolRows,
  runningElapsedMs,
  runningToolRows,
  waitingItems,
  type CouncilActivity,
} from './activity-model';

export interface ActivityPanelProps {
  threadId: string;
  /** Opens the prompt sections, as `/context` asks. */
  showPrompt?: boolean;
}

const EMPTY_EVENTS: readonly ThreadEventRow[] = [];

/** A one-second clock that runs only while something is live. */
function useLiveClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

/**
 * The Activity tab: what the thread is doing right now. A council thread adds a
 * Council section read from its goal; a work thread shows only tools, subagents
 * and the work waiting on the user or a slot.
 */
export function ActivityPanel({ threadId, showPrompt = false }: ActivityPanelProps) {
  const executionMode = useAppStore((state) => state.threads[threadId]?.executionMode);
  if (executionMode === 'council') return <CouncilActivityPanel threadId={threadId} showPrompt={showPrompt} />;
  return <ActivityBody threadId={threadId} council={null} councilResolving={false} showPrompt={showPrompt} />;
}

/** Council threads own a goal, so the status hook lives in this branch only. */
function CouncilActivityPanel({ threadId, showPrompt = false }: ActivityPanelProps) {
  const { status, loading } = useCouncilStatus(threadId);
  return (
    <ActivityBody
      threadId={threadId}
      council={councilActivityOf(status)}
      councilResolving={status === null && loading}
      showPrompt={showPrompt}
    />
  );
}

interface ActivityBodyProps {
  threadId: string;
  /** The council goal of a council thread; null for work threads and no goal. */
  council: CouncilActivity | null;
  /** True while a council thread's goal is still being looked up. */
  councilResolving: boolean;
  showPrompt?: boolean;
}

/**
 * Open tool calls with their output tail, the calls that already finished this
 * session, every subagent of the thread, the council goal when there is one, and
 * the work waiting on the user or a slot. Rows expand in place; nothing here
 * navigates away from the thread.
 */
function ActivityBody({ threadId, council, councilResolving, showPrompt = false }: ActivityBodyProps) {
  const rpc = useRpc();
  const events = useAppStore((state) => state.events[threadId]);
  const todos = useThreadTodos(threadId);
  const progress = todoProgress(todos);
  const [messaging, setMessaging] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState<string | null>(null);
  const subagents = useAppStore(
    useShallow((state) => subagentsOfThread(state.subagents, threadId)),
  );
  const questions = useAppStore(
    useShallow((state) =>
      Object.values(state.questions).filter((question) => question.threadId === threadId),
    ),
  );
  const openSubagent = useAppStore((state) => state.openSubagent);
  const threadStatus = useAppStore((state) => state.threads[threadId]?.status);

  // Seed open questions from the server so a reload still offers the answer box for a
  // child blocked right now. A question that already arrived by event keeps its copy.
  useEffect(() => {
    let disposed = false;
    void rpc.request('subagents.questions', { threadId }).then(
      (questions) => {
        if (!disposed) useAppStore.getState().mergeSubagentQuestions(questions);
      },
      // A failed read leaves the live events on screen; the next question event retries.
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [rpc, threadId]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const tools = useMemo(
    () => runningToolRows(events ?? EMPTY_EVENTS, subagents),
    [events, subagents],
  );
  const finished = useMemo(
    () => finishedToolRows(events ?? EMPTY_EVENTS, subagents),
    [events, subagents],
  );
  const waiting = waitingItems(subagents, threadStatus);
  const live = tools.length > 0 || subagents.some(isRunningSubagent);
  const now = useLiveClock(live);

  const toggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const idle =
    tools.length === 0 &&
    finished.length === 0 &&
    subagents.length === 0 &&
    questions.length === 0 &&
    waiting.length === 0 &&
    progress.total === 0 &&
    !councilResolving &&
    !(council?.goalActive ?? false);

  async function sendToChild(childId: string): Promise<void> {
    const text = draft.trim();
    if (text.length === 0) return;
    try {
      const result = await rpc.request('subagents.message', { childId, text });
      toast.success(result.delivered === 'queued' ? 'Queued for the subagent.' : 'Subagent reopened with your message.');
      setDraft('');
      setMessaging(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not message the subagent.');
    }
  }

  async function stopChild(childId: string): Promise<void> {
    try {
      await rpc.request('subagents.cancel', { childId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not stop the subagent.');
    }
  }

  /**
   * Answers a blocked child's question. The main agent may be idle here, so the user
   * answers directly; the child's turn resumes with this text.
   */
  async function answerChild(questionId: string): Promise<void> {
    const text = (answers[questionId] ?? '').trim();
    if (text.length === 0) return;
    setAnswering(questionId);
    try {
      await rpc.request('subagents.answer', { threadId, questionId, text });
      setAnswers((current) => {
        const next = { ...current };
        delete next[questionId];
        return next;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not answer the subagent.');
    } finally {
      setAnswering(null);
    }
  }

  return (
    <ScrollArea className="h-full min-h-0">
      <div data-testid="activity-panel" className="flex flex-col gap-3 p-2">
        <ActivityContext threadId={threadId} showPrompt={showPrompt} />

        {progress.total > 0 ? (
          <section aria-label="Todo" data-testid="activity-todo" className="flex flex-col gap-0.5">
            <SectionHeading label={`Todo ${progress.done}/${progress.total}`} count={progress.total - progress.done} />
            <TodoList phases={todos} compact />
          </section>
        ) : null}

        {idle ? (
          <EmptyState
            variant="inline"
            icon={Activity}
            title="Nothing running"
            description="Tool calls and subagents appear here while a turn runs."
            className="px-1 py-2"
          />
        ) : null}

        {council === null ? null : (
          <section
            aria-label="Council"
            data-testid="activity-council"
            className="flex flex-col gap-0.5"
          >
            <SectionHeading label="Council" count={council.tasks.length} />
            <div
              data-testid="activity-council-goal"
              data-state={council.goalState}
              className="flex h-8 min-w-0 items-center gap-1.5 px-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">Goal</span>
              <Badge variant={council.goalTone} size="sm">
                {council.goalLabel}
              </Badge>
            </div>
            {council.tasks.map((task) => (
              <div
                key={task.id}
                data-testid="activity-council-task"
                data-state={task.state}
                className="flex h-8 min-w-0 items-center gap-1.5 px-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate text-foreground" title={task.title}>
                  {task.title}
                </span>
                <Badge variant={task.tone} size="sm">
                  {task.stateLabel}
                </Badge>
              </div>
            ))}
          </section>
        )}

        {tools.length > 0 ? (
          <section aria-label="Running tools" className="flex flex-col gap-0.5">
            <SectionHeading label="Running" count={tools.length} />
            {tools.map((tool) => {
              const elapsed = formatDuration(runningElapsedMs(tool.startedAt, now));
              return (
                <ToolRow
                  key={tool.key}
                  testId="activity-running-tool"
                  headline={tool.headline}
                  childType={tool.childType}
                  output={tool.output}
                  expanded={expanded.has(tool.key)}
                  onToggle={() => toggle(tool.key)}
                  emptyLabel="No output yet."
                  trailing={
                    elapsed === '' ? null : (
                      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                        {elapsed}
                      </span>
                    )
                  }
                />
              );
            })}
          </section>
        ) : null}

        {finished.length > 0 ? (
          <section aria-label="Finished tools" className="flex flex-col gap-0.5">
            <SectionHeading label="Finished" count={finished.length} />
            {finished.map((tool) => (
              <ToolRow
                key={tool.key}
                testId="activity-finished-tool"
                headline={tool.headline}
                childType={tool.childType}
                output={tool.output}
                expanded={expanded.has(tool.key)}
                onToggle={() => toggle(tool.key)}
                emptyLabel="No output."
                error={tool.isError}
                trailing={
                  tool.isError ? (
                    <span className="shrink-0 text-2xs text-error-foreground">Error</span>
                  ) : null
                }
              />
            ))}
          </section>
        ) : null}

        {questions.length > 0 ? (
          <section
            aria-label="Subagent questions"
            data-testid="activity-questions"
            className="flex flex-col gap-1"
          >
            <SectionHeading label="Questions" count={questions.length} />
            {questions.map((question) => (
              <form
                key={question.questionId}
                data-testid="activity-question"
                data-question-id={question.questionId}
                className="flex flex-col gap-1 rounded-md border border-border px-1.5 py-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void answerChild(question.questionId);
                }}
              >
                <button
                  type="button"
                  onClick={() => openSubagent(question.childId)}
                  title="Open the blocked subagent"
                  className="min-w-0 text-left text-xs text-foreground"
                >
                  {question.text}
                </button>
                <div className="flex gap-1">
                  <Input
                    value={answers[question.questionId] ?? ''}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.questionId]: event.target.value,
                      }))
                    }
                    placeholder="Your answer; the child continues with it"
                    aria-label="Answer for the subagent"
                    className="h-7 flex-1 text-xs"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    data-testid="activity-question-answer"
                    disabled={
                      (answers[question.questionId] ?? '').trim().length === 0 ||
                      answering === question.questionId
                    }
                  >
                    Answer
                  </Button>
                </div>
              </form>
            ))}
          </section>
        ) : null}

        {subagents.length > 0 ? (
          <section aria-label="Subagents" className="flex flex-col gap-0.5">
            <SectionHeading label="Subagents" count={subagents.length} />
            {subagents.map((child) => {
              const Icon = SUBAGENT_TYPE_ICON[child.type];
              const elapsed = formatDuration(subagentElapsedMs(child, now));
              const running = isRunningSubagent(child);
              const usage =
                child.toolCount === undefined
                  ? 'usage -'
                  : `${child.toolCount} tools · ${formatCompact((child.inputTokens ?? 0) + (child.outputTokens ?? 0))} tok`;
              return (
                <div key={child.childId} className="flex flex-col rounded-md hover:bg-accent/60">
                  <div className="flex h-8 min-w-0 items-center gap-1">
                    <button
                      type="button"
                      data-testid="activity-subagent-row"
                      data-status={child.status}
                      onClick={() => openSubagent(child.childId)}
                      title={child.task.length === 0 ? SUBAGENT_TYPE_LABEL[child.type] : child.task}
                      className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-xs text-foreground"
                    >
                      <Icon aria-hidden="true" strokeWidth={1.75} className="size-3 shrink-0 text-muted-foreground" />
                      <span className="shrink-0">{SUBAGENT_TYPE_LABEL[child.type]}</span>
                      <StatusChip status={SUBAGENT_STATUS_TONE[child.status]} className="h-3.5 px-1" />
                      {child.closedAt === null ? null : (
                        <Badge variant="outline" size="sm" data-testid="activity-subagent-closed">
                          closed
                        </Badge>
                      )}
                      <span data-testid="activity-subagent-usage" className="min-w-0 flex-1 truncate text-2xs tabular-nums text-muted-foreground">
                        {usage}
                      </span>
                      {(child.unread ?? 0) > 0 ? (
                        <Badge variant="info" size="sm">{child.unread}</Badge>
                      ) : null}
                      {elapsed === '' ? null : (
                        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{elapsed}</span>
                      )}
                    </button>
                    {child.status === 'cancelled' || child.closedAt !== null ? null : (
                      <IconButton
                        icon={MessageSquare}
                        label="Message subagent"
                        size="sm"
                        className="size-6"
                        data-testid="activity-subagent-message"
                        onClick={() => setMessaging((current) => (current === child.childId ? null : child.childId))}
                      />
                    )}
                    {running ? (
                      <IconButton
                        icon={Square}
                        label="Stop subagent"
                        size="sm"
                        className="size-6"
                        data-testid="activity-subagent-stop"
                        onClick={() => void stopChild(child.childId)}
                      />
                    ) : null}
                  </div>
                  {child.activity && running ? (
                    <p className="truncate px-6 pb-1 font-mono text-2xs text-muted-foreground" title={child.activity}>
                      {child.activity}
                    </p>
                  ) : null}
                  {messaging === child.childId ? (
                    <form
                      className="flex gap-1 px-1.5 pb-1.5"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void sendToChild(child.childId);
                      }}
                    >
                      <Input
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={running ? 'Queued for after its current step' : 'Reopens the subagent'}
                        aria-label="Message for the subagent"
                        className="h-7 flex-1 text-xs"
                      />
                    </form>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        <section aria-label="Waiting" className="flex flex-col gap-0.5">
          <SectionHeading label="Waiting" count={waiting.length} />
          {waiting.length === 0 ? (
            <p
              data-testid="activity-waiting-empty"
              className="px-1.5 text-2xs text-muted-foreground"
            >
              Nothing is waiting
            </p>
          ) : (
            waiting.map((item) =>
              item.kind === 'approval' ? (
                <p
                  key="approval"
                  data-testid="activity-waiting-approval"
                  className="flex h-8 items-center px-1.5 text-xs text-muted-foreground"
                >
                  An approval is waiting in the timeline
                </p>
              ) : (
                <button
                  key={item.child.childId}
                  type="button"
                  data-testid="activity-waiting-row"
                  onClick={() => openSubagent(item.child.childId)}
                  className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {SUBAGENT_TYPE_LABEL[item.child.type]}{' '}
                    {SUBAGENT_STATUS_LABEL[item.child.status]}
                  </span>
                </button>
              ),
            )
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function formatCompact(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="flex items-baseline gap-1.5 px-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
      {label}
      {count > 0 ? <span className="tabular-nums">{count}</span> : null}
    </h3>
  );
}

interface ToolRowProps {
  testId: string;
  headline: string;
  childType: SubagentType | null;
  output: string;
  expanded: boolean;
  onToggle: () => void;
  emptyLabel: string;
  trailing?: ReactNode;
  error?: boolean;
}

/**
 * One tool row shared by Running and Finished: the headline, an optional
 * subagent prefix and trailing slot, and the output tail opened in place.
 */
function ToolRow({
  testId,
  headline,
  childType,
  output,
  expanded,
  onToggle,
  emptyLabel,
  trailing,
  error = false,
}: ToolRowProps) {
  const tail = outputTail(output);
  return (
    <div>
      <button
        type="button"
        data-testid={testId}
        data-error={error ? 'true' : undefined}
        aria-expanded={expanded}
        onClick={onToggle}
        title={headline}
        className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-foreground transition-colors duration-150 hover:bg-accent"
      >
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.75}
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {childType === null ? null : (
          <span className="shrink-0 text-2xs text-muted-foreground">
            {SUBAGENT_TYPE_LABEL[childType]}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{headline}</span>
        {trailing}
      </button>
      {expanded ? (
        <div className="mt-0.5 mb-1 rounded-md border border-border bg-card px-2 py-1.5">
          {tail.lines.length === 0 ? (
            <p className="text-2xs text-muted-foreground">{emptyLabel}</p>
          ) : (
            <>
              {tail.hidden > 0 ? (
                <p className="text-2xs text-muted-foreground">{tail.hidden} earlier lines</p>
              ) : null}
              <pre className="max-h-48 overflow-auto font-mono text-2xs leading-4 break-words whitespace-pre-wrap text-muted-foreground">
                {tail.lines.join('\n')}
              </pre>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

import type {
  AdapterEvent,
  InstalledPlugin,
  Message,
  Project,
  ProviderView,
  RpcMethod,
  RpcParams,
  RpcResult,
  Settings,
  SubagentMessage,
  SubagentStatus,
  SubagentType,
  SubagentView,
  Thread,
  ThreadEventRow,
  TodoPhase,
} from '@tuffcode/contracts';
import { create } from 'zustand';
import type { BootstrapInfo, ConnectionStatus } from '../types';

export const MAX_EVENTS_PER_THREAD = 5000;

/** A child turn streams into one pane; its log stays bounded like a thread's. */
export const MAX_EVENTS_PER_SUBAGENT = 2000;

const TERMINAL_SUBAGENT_STATUSES: readonly SubagentStatus[] = ['done', 'failed', 'cancelled'];

/** A settled child never returns to running, whatever a late frame claims. */
export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.includes(status);
}

/**
 * The skeleton of a transcript: turn boundaries, tool calls, approvals and errors.
 * Trimming never drops these, because losing one breaks the grouped view.
 */
const STRUCTURAL_EVENT_TYPES: Record<string, true> = {
  'turn.started': true,
  'turn.finished': true,
  'tool.started': true,
  'tool.finished': true,
  'approval.requested': true,
  error: true,
  usage: true,
};

export function isStructuralEventType(type: string): boolean {
  return STRUCTURAL_EVENT_TYPES[type] === true || type.startsWith('session.');
}

/** Streamed token rows; contiguous rows of one type merge into a single row. */
const MERGEABLE_DELTA_TYPES: Record<string, true> = {
  'text.delta': true,
  'reasoning.delta': true,
};

/**
 * Drops the oldest delta rows until the list fits `max`. Structural rows stay even
 * when they alone exceed the cap, so a reopened 10k-event thread still has every
 * tool call and turn boundary.
 */
export function trimThreadEvents(
  events: ThreadEventRow[],
  max = MAX_EVENTS_PER_THREAD,
): ThreadEventRow[] {
  const overflow = events.length - max;
  if (overflow <= 0) return events;
  const drop = new Set<number>();
  for (let index = 0; index < events.length && drop.size < overflow; index += 1) {
    if (!isStructuralEventType(events[index]!.type)) drop.add(index);
  }
  if (drop.size === 0) return events;
  return events.filter((_, index) => !drop.has(index));
}

/**
 * Merges a contiguous delta into the row it extends: the segment keeps its first
 * `createdAt` (so "Thought for Ns" counts from the start) and takes the newest
 * `seq` (so the replay cursor stays exact). A tool event, a turn change or a gap
 * in the sequence leaves the rows separate.
 */
export function coalesceStreamDelta(
  previous: ThreadEventRow | undefined,
  event: ThreadEventRow,
): ThreadEventRow | null {
  if (previous === undefined) return null;
  if (event.seq !== previous.seq + 1) return null;
  if (event.type !== previous.type) return null;
  if (MERGEABLE_DELTA_TYPES[event.type] !== true) return null;
  if (event.payload.type !== previous.payload.type) return null;
  if (event.payload.type === 'text.delta' && previous.payload.type === 'text.delta') {
    if (event.payload.turnId !== previous.payload.turnId) return null;
    return {
      ...previous,
      seq: event.seq,
      payload: { ...event.payload, text: previous.payload.text + event.payload.text },
    };
  }
  if (event.payload.type === 'reasoning.delta' && previous.payload.type === 'reasoning.delta') {
    if (event.payload.turnId !== previous.payload.turnId) return null;
    return {
      ...previous,
      seq: event.seq,
      payload: { ...event.payload, text: previous.payload.text + event.payload.text },
    };
  }
  return null;
}

/** One spawned child, keyed by `childId`, with its own event log. */
export interface SubagentChild {
  childId: string;
  /** The parent thread that spawned it. */
  threadId: string;
  /** The child thread it runs in, known only once a list row arrives. */
  childThreadId: string | null;
  type: SubagentType;
  model: string;
  status: SubagentStatus;
  task: string;
  summary: string | null;
  /** When the child was created, from `subagents.list` or the first frame. */
  createdAt: string | null;
  /** When it started running; the elapsed label counts from here. */
  startedAt: string | null;
  finishedAt: string | null;
  events: ThreadEventRow[];
  /** Monotonic per-child cursor for the next appended event row. */
  nextSeq: number;
  /** Live telemetry; undefined means not measured yet ("usage -"). */
  toolCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  activity?: string | null;
  /** Reports from the child the parent has not read. */
  unread?: number;
  /** Set when the parent closed the child; the transcript stays readable. */
  closedAt: string | null;
  /** The mailbox both ways, oldest first, bounded. */
  messages: SubagentMessage[];
  /**
   * Set when a follow-up was sent to a settled child: the next started frame reopens
   * it. Without this flag a late started frame still cannot revive a settled child.
   */
  awaitingReopen: boolean;
}

export interface SubagentTelemetryInput {
  childId: string;
  threadId: string;
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  activity: string | null;
}

export interface SubagentMessageInput {
  childId: string;
  threadId: string;
  message: SubagentMessage;
}

/** One child blocked on a question the parent or the user has not answered yet. */
export interface SubagentQuestion {
  questionId: string;
  childId: string;
  /** The parent thread the question was posted to. */
  threadId: string;
  text: string;
  createdAt: string;
}

export interface SubagentQuestionInput {
  childId: string;
  threadId: string;
  questionId: string;
  text: string;
}

export interface SubagentAnsweredInput {
  childId: string;
  threadId: string;
  questionId: string;
  text: string;
  by: 'parent' | 'user';
}

/** Mailbox rows kept per child in the store. */
export const MAX_MESSAGES_PER_SUBAGENT = 100;

export interface SubagentStartedInput {
  childId: string;
  threadId: string;
  type: SubagentType;
  model: string;
}

export interface SubagentEventInput {
  childId: string;
  threadId: string;
  event: AdapterEvent;
}

export interface SubagentFinishedInput {
  childId: string;
  threadId: string;
  status: SubagentStatus;
  summary?: string;
}

/** Right-hand child pane: open state and the selected tab, session-scoped. */
export interface SubagentPaneState {
  open: boolean;
  activeChildId: string | null;
}

export function newSubagentChild(input: SubagentStartedInput, now: string): SubagentChild {
  return {
    childId: input.childId,
    threadId: input.threadId,
    childThreadId: null,
    type: input.type,
    model: input.model,
    status: 'running',
    task: '',
    summary: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    events: [],
    nextSeq: 0,
    closedAt: null,
    messages: [],
    awaitingReopen: false,
  };
}

/** Drops every open question of one child: it settled, so nothing can answer it now. */
function withoutChildQuestions(
  questions: Record<string, SubagentQuestion>,
  childId: string,
): Record<string, SubagentQuestion> {
  let next: Record<string, SubagentQuestion> | null = null;
  for (const [questionId, question] of Object.entries(questions)) {
    if (question.childId !== childId) continue;
    next ??= { ...questions };
    delete next[questionId];
  }
  return next ?? questions;
}

function telemetryOfView(view: SubagentView): Partial<SubagentChild> {
  return {
    ...(view.toolCount === undefined ? {} : { toolCount: view.toolCount }),
    ...(view.inputTokens === undefined ? {} : { inputTokens: view.inputTokens }),
    ...(view.outputTokens === undefined ? {} : { outputTokens: view.outputTokens }),
    ...(view.activity === undefined ? {} : { activity: view.activity }),
    ...(view.unread === undefined ? {} : { unread: view.unread }),
  };
}

/**
 * Merges a `subagents.list` row into the live child. The list is authoritative for
 * task, model and summary; a settled status already in the store wins over a stale
 * list row so a finished child cannot flip back to running.
 */
export function mergeSubagentView(
  child: SubagentChild | undefined,
  view: SubagentView,
): SubagentChild {
  const finishedAt = isTerminalSubagentStatus(view.status) ? view.updatedAt : null;
  if (child === undefined) {
    return {
      childId: view.childId,
      threadId: view.threadId,
      childThreadId: view.childThreadId,
      type: view.type,
      model: view.model,
      status: view.status,
      task: view.task,
      summary: view.summary ?? null,
      createdAt: view.createdAt,
      startedAt: view.startedAt ?? view.createdAt,
      finishedAt: view.finishedAt ?? finishedAt,
      ...telemetryOfView(view),
      closedAt: view.closedAt ?? null,
      messages: [],
      awaitingReopen: false,
      events: [],
      nextSeq: 0,
    };
  }
  const status = isTerminalSubagentStatus(child.status) ? child.status : view.status;
  return {
    ...child,
    childThreadId: view.childThreadId ?? child.childThreadId,
    type: view.type,
    model: view.model,
    task: view.task.length > 0 ? view.task : child.task,
    summary: view.summary ?? child.summary,
    createdAt: child.createdAt ?? view.createdAt,
    startedAt: child.startedAt ?? view.startedAt ?? view.createdAt,
    finishedAt: child.finishedAt ?? view.finishedAt ?? finishedAt,
    ...telemetryOfView(view),
    closedAt: view.closedAt ?? child.closedAt,
    status,
  };
}

export interface RpcRequester {
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
}

export interface AppState {
  connection: ConnectionStatus;
  bootstrap: BootstrapInfo | null;
  projects: Project[];
  threads: Record<string, Thread>;
  events: Record<string, ThreadEventRow[]>;
  messages: Record<string, Message[]>;
  settings: Settings | null;
  providers: ProviderView[];
  activeThreadId: string | null;
  /** Every known child across threads, keyed by `childId`. */
  subagents: Record<string, SubagentChild>;
  /** Open child questions, keyed by `questionId`, until an answer or the child settles. */
  questions: Record<string, SubagentQuestion>;
  subagentPane: SubagentPaneState;
  /** The live todo list per thread, from `todo.updated` and `todos.get`. */
  todos: Record<string, TodoPhase[]>;
  /** Installed plugins, refreshed by `plugins.updated`. */
  plugins: InstalledPlugin[];

  setBootstrap(bootstrap: BootstrapInfo): void;
  setConnection(connection: ConnectionStatus): void;
  loadInitial(rpc: RpcRequester): Promise<void>;
  upsertProject(project: Project): void;
  removeProject(projectId: string): void;
  upsertThread(thread: Thread): void;
  removeThread(threadId: string): void;
  appendEvent(threadId: string, event: ThreadEventRow): void;
  /** Replaces the event list, for a transcript the server rewrote (clear or compact). */
  setEvents(threadId: string, events: ThreadEventRow[]): void;
  setMessages(threadId: string, messages: Message[]): void;
  removeMessage(threadId: string, messageId: string): void;
  setSettings(settings: Settings): void;
  upsertProvider(provider: ProviderView): void;
  setActiveThread(threadId: string | null): void;
  subagentStarted(input: SubagentStartedInput): void;
  subagentEvent(input: SubagentEventInput): void;
  subagentFinished(input: SubagentFinishedInput): void;
  subagentTelemetry(input: SubagentTelemetryInput): void;
  subagentMessage(input: SubagentMessageInput): void;
  /** A child is blocked on this question; the Activity panel offers an answer box. */
  subagentQuestion(input: SubagentQuestionInput): void;
  /** The question was answered (by the parent or the user) or the child settled. */
  subagentAnswered(input: SubagentAnsweredInput): void;
  /**
   * Seeds questions fetched from the server after a reload. An id that already
   * arrived by event keeps the event's copy, so a merge never clobbers live state.
   */
  mergeSubagentQuestions(questions: readonly SubagentQuestion[]): void;
  setTodos(threadId: string, phases: TodoPhase[]): void;
  setPlugins(plugins: InstalledPlugin[]): void;
  mergeSubagentViews(threadId: string, views: readonly SubagentView[]): void;
  openSubagent(childId: string): void;
  closeSubagentPane(): void;
  selectSubagent(childId: string): void;
}

const initialState = {
  connection: 'connecting' as ConnectionStatus,
  bootstrap: null,
  projects: [] as Project[],
  threads: {} as Record<string, Thread>,
  events: {} as Record<string, ThreadEventRow[]>,
  messages: {} as Record<string, Message[]>,
  settings: null,
  providers: [] as ProviderView[],
  activeThreadId: null,
  subagents: {} as Record<string, SubagentChild>,
  questions: {} as Record<string, SubagentQuestion>,
  subagentPane: { open: false, activeChildId: null } as SubagentPaneState,
  todos: {} as Record<string, TodoPhase[]>,
  plugins: [] as InstalledPlugin[],
};

export function createAppStore() {
  return create<AppState>()((set) => ({
    ...initialState,

    setBootstrap: (bootstrap) => set({ bootstrap }),

    setConnection: (connection) => set({ connection }),

    loadInitial: async (rpc) => {
      const [projects, threads, settings, providers] = await Promise.all([
        rpc.request('projects.list', {}),
        rpc.request('threads.list', {}),
        rpc.request('settings.get', {}),
        rpc.request('providers.list', {}),
      ]);

      set({
        projects,
        threads: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
        settings,
        providers,
      });
    },

    upsertProject: (project) =>
      set((state) => {
        const index = state.projects.findIndex((entry) => entry.id === project.id);
        if (index === -1) return { projects: [...state.projects, project] };
        const projects = state.projects.slice();
        projects[index] = project;
        return { projects };
      }),

    removeProject: (projectId) =>
      set((state) => {
        const removedThreadIds = new Set(
          Object.values(state.threads)
            .filter((thread) => thread.projectId === projectId)
            .map((thread) => thread.id),
        );
        const threads = Object.fromEntries(
          Object.entries(state.threads).filter(([threadId]) => !removedThreadIds.has(threadId)),
        );
        const events = Object.fromEntries(
          Object.entries(state.events).filter(([threadId]) => !removedThreadIds.has(threadId)),
        );
        const messages = Object.fromEntries(
          Object.entries(state.messages).filter(([threadId]) => !removedThreadIds.has(threadId)),
        );
        const subagents = Object.fromEntries(
          Object.entries(state.subagents).filter(
            ([, child]) => !removedThreadIds.has(child.threadId),
          ),
        );
        const activeChildId = state.subagentPane.activeChildId;
        const activeChildGone = activeChildId !== null && subagents[activeChildId] === undefined;
        const subagentPane = activeChildGone
          ? { open: false, activeChildId: null }
          : state.subagentPane;
        return {
          projects: state.projects.filter((project) => project.id !== projectId),
          threads,
          events,
          messages,
          subagents,
          subagentPane,
          activeThreadId:
            state.activeThreadId && removedThreadIds.has(state.activeThreadId)
              ? null
              : state.activeThreadId,
        };
      }),

    upsertThread: (thread) =>
      set((state) => ({
        threads: { ...state.threads, [thread.id]: thread },
      })),

    removeThread: (threadId) =>
      set((state) => {
        const threads = { ...state.threads };
        delete threads[threadId];
        const events = { ...state.events };
        delete events[threadId];
        const messages = { ...state.messages };
        delete messages[threadId];
        const subagents = Object.fromEntries(
          Object.entries(state.subagents).filter(([, child]) => child.threadId !== threadId),
        );
        const questions = Object.fromEntries(
          Object.entries(state.questions).filter(([, question]) => question.threadId !== threadId),
        );
        const activeChildId = state.subagentPane.activeChildId;
        const activeChildGone = activeChildId !== null && subagents[activeChildId] === undefined;
        return {
          threads,
          events,
          messages,
          subagents,
          questions,
          subagentPane: activeChildGone ? { open: false, activeChildId: null } : state.subagentPane,
          activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
        };
      }),

    appendEvent: (threadId, event) =>
      set((state) => {
        const list = state.events[threadId] ?? [];
        const last = list[list.length - 1];
        if (last && event.seq <= last.seq) return {};

        // A contiguous delta extends the open segment instead of adding a row.
        const merged = coalesceStreamDelta(last, event);
        const appended =
          merged === null ? [...list, event] : [...list.slice(0, -1), merged];
        const next = trimThreadEvents(appended);

        const thread = state.threads[threadId];
        const threads =
          thread && event.seq > thread.lastSeq
            ? { ...state.threads, [threadId]: { ...thread, lastSeq: event.seq } }
            : state.threads;

        return {
          events: { ...state.events, [threadId]: next },
          threads,
        };
      }),

    setEvents: (threadId, events) =>
      set((state) => ({
        events: { ...state.events, [threadId]: events },
      })),

    setMessages: (threadId, messages) =>
      set((state) => ({
        messages: { ...state.messages, [threadId]: messages },
      })),

    removeMessage: (threadId, messageId) =>
      set((state) => {
        const list = state.messages[threadId];
        if (list === undefined) return {};
        const next = list.filter((message) => message.id !== messageId);
        if (next.length === list.length) return {};
        return { messages: { ...state.messages, [threadId]: next } };
      }),

    setSettings: (settings) => set({ settings }),

    upsertProvider: (provider) =>
      set((state) => {
        const index = state.providers.findIndex((entry) => entry.id === provider.id);
        if (index === -1) return { providers: [...state.providers, provider] };
        const providers = state.providers.slice();
        providers[index] = provider;
        return { providers };
      }),

    setActiveThread: (activeThreadId) => set({ activeThreadId }),

    subagentStarted: (input) =>
      set((state) => {
        const now = new Date().toISOString();
        const existing = state.subagents[input.childId];
        const child: SubagentChild =
          existing === undefined
            ? newSubagentChild(input, now)
            : {
                ...existing,
                type: input.type,
                model: input.model,
                startedAt: existing.startedAt ?? now,
                // A late started frame cannot resurrect a settled child; a follow-up can.
                ...(isTerminalSubagentStatus(existing.status) && !existing.awaitingReopen
                  ? { status: existing.status }
                  : { status: 'running' as const, finishedAt: null, awaitingReopen: false }),
              };
        return { subagents: { ...state.subagents, [input.childId]: child } };
      }),

    subagentEvent: (input) =>
      set((state) => {
        const now = new Date().toISOString();
        const existing =
          state.subagents[input.childId] ??
          newSubagentChild(
            {
              childId: input.childId,
              threadId: input.threadId,
              type: 'explorer',
              model: '',
            },
            now,
          );
        const seq = existing.nextSeq;
        const row: ThreadEventRow = {
          // Live child frames carry no database row id; the per-child seq is the cursor.
          id: seq + 1,
          threadId: input.threadId,
          seq,
          type: input.event.type,
          payload: input.event,
          createdAt: now,
        };
        const events = [...existing.events, row];
        if (events.length > MAX_EVENTS_PER_SUBAGENT) {
          events.splice(0, events.length - MAX_EVENTS_PER_SUBAGENT);
        }
        const child: SubagentChild = {
          ...existing,
          threadId: input.threadId,
          events,
          nextSeq: seq + 1,
        };
        return { subagents: { ...state.subagents, [input.childId]: child } };
      }),

    subagentFinished: (input) =>
      set((state) => {
        const now = new Date().toISOString();
        const questions = withoutChildQuestions(state.questions, input.childId);
        const existing = state.subagents[input.childId];
        if (existing === undefined) {
          // The finished frame can outrun its started frame after a reconnect.
          const child: SubagentChild = {
            ...newSubagentChild(
              { childId: input.childId, threadId: input.threadId, type: 'explorer', model: '' },
              now,
            ),
            status: input.status,
            summary: input.summary ?? null,
            finishedAt: now,
          };
          return { subagents: { ...state.subagents, [input.childId]: child }, questions };
        }
        const child: SubagentChild = {
          ...existing,
          status: input.status,
          summary: input.summary ?? existing.summary,
          finishedAt: existing.finishedAt ?? now,
        };
        return { subagents: { ...state.subagents, [input.childId]: child }, questions };
      }),

    subagentTelemetry: (input) =>
      set((state) => {
        const existing = state.subagents[input.childId];
        if (existing === undefined) return {};
        const child: SubagentChild = {
          ...existing,
          toolCount: input.toolCount,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          activity: input.activity,
        };
        return { subagents: { ...state.subagents, [input.childId]: child } };
      }),

    subagentMessage: (input) =>
      set((state) => {
        const existing = state.subagents[input.childId];
        if (existing === undefined) return {};
        if (existing.messages.some((message) => message.id === input.message.id)) return {};
        const messages = [...existing.messages, input.message].slice(-MAX_MESSAGES_PER_SUBAGENT);
        const toParent = input.message.direction === 'to-parent';
        const child: SubagentChild = {
          ...existing,
          messages,
          unread: toParent ? (existing.unread ?? 0) + 1 : existing.unread,
          awaitingReopen:
            existing.awaitingReopen ||
            (!toParent && isTerminalSubagentStatus(existing.status) && existing.status !== 'cancelled'),
        };
        return { subagents: { ...state.subagents, [input.childId]: child } };
      }),

    subagentQuestion: (input) =>
      set((state) => ({
        questions: {
          ...state.questions,
          [input.questionId]: {
            questionId: input.questionId,
            childId: input.childId,
            threadId: input.threadId,
            text: input.text,
            createdAt: new Date().toISOString(),
          },
        },
      })),

    subagentAnswered: (input) =>
      set((state) => {
        if (state.questions[input.questionId] === undefined) return {};
        const questions = { ...state.questions };
        delete questions[input.questionId];
        return { questions };
      }),

    mergeSubagentQuestions: (incoming) =>
      set((state) => {
        let next: Record<string, SubagentQuestion> | null = null;
        for (const question of incoming) {
          if (state.questions[question.questionId] !== undefined) continue;
          next ??= { ...state.questions };
          next[question.questionId] = question;
        }
        return next === null ? {} : { questions: next };
      }),

    setTodos: (threadId, phases) => set((state) => ({ todos: { ...state.todos, [threadId]: phases } })),

    setPlugins: (plugins) => set({ plugins }),

    mergeSubagentViews: (threadId, views) =>
      set((state) => {
        const subagents = { ...state.subagents };
        for (const view of views) {
          if (view.threadId !== threadId) continue;
          subagents[view.childId] = mergeSubagentView(subagents[view.childId], view);
        }
        return { subagents };
      }),

    openSubagent: (childId) =>
      set((state) => {
        if (state.subagents[childId] === undefined) return {};
        return { subagentPane: { open: true, activeChildId: childId } };
      }),

    closeSubagentPane: () =>
      set((state) => ({
        // The selected child survives so reopening the pane returns to the same tab.
        subagentPane: { open: false, activeChildId: state.subagentPane.activeChildId },
      })),

    selectSubagent: (childId) =>
      set((state) => {
        if (state.subagents[childId] === undefined) return {};
        return { subagentPane: { open: true, activeChildId: childId } };
      }),
  }));
}

export const useAppStore = createAppStore();

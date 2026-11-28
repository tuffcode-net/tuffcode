import type {
  SubagentControlRequest,
  SubagentDepth,
  SubagentMessage,
  AdapterEvent,
  PermissionMode,
  SubagentQuestionView,
  SubagentSpec,
  SubagentStatus,
  SubagentType,
  SubagentView,
  Thread,
} from '@tuffcode/contracts';

/** One child session request, resolved to a concrete provider and model. */
export interface SubagentChildRequest {
  parent: Thread;
  type: SubagentType;
  providerId: string;
  modelId: string;
  permissionMode: PermissionMode;
  /** True only for workers: a fresh `tuffcode/<childId>` worktree. */
  worktree: boolean;
  /** The child's task, which names the child thread. */
  task: string;
  /** quick, normal or thorough; the child's prompt states it. */
  depth?: SubagentDepth;
  /**
   * The type's configured reasoning effort, or null to inherit. Carried on the
   * request because the queued subagent record has no effort column; the child
   * thread row is the only place the value persists.
   */
  effort: string | null;
}

export interface SubagentTurnInput {
  threadId: string;
  text: string;
  signal: AbortSignal;
  /** Every adapter event of the child turn, already ordered. */
  onEvent(event: AdapterEvent): void;
}

export interface SubagentTurnResult {
  status: 'complete' | 'interrupted' | 'error';
  text: string;
  error?: string;
}

/**
 * Side effects the service does not own. Tests replace them to drive a child turn
 * without a process, a network call, or a checkout.
 */
export interface SubagentPorts {
  createChildThread(request: SubagentChildRequest): Promise<Thread>;
  runTurn(input: SubagentTurnInput): Promise<SubagentTurnResult>;
}

/** Where a type's provider and model came from; surfaced in logs and tests. */
export type SubagentTargetSource = 'spec' | 'settings' | 'fallback' | 'thread';

export interface SubagentTarget {
  providerId: string;
  model: string;
  source: SubagentTargetSource;
  /** The type's configured effort, or null to inherit the provider default. */
  effort: string | null;
}

export interface SubagentSpawnInput {
  threadId: string;
  spec: SubagentSpec;
  /** quick, normal or thorough; persisted with the row and stated in the prompt. */
  depth?: SubagentDepth;
}

export interface Subagents {
  /** Persists the child as queued and returns at once; the queue starts it. */
  spawn(input: SubagentSpawnInput): Promise<{ childId: string }>;
  /** Harness-tool entry point: the parent is the turn's thread, else the cwd's owner. */
  spawnFromTool(request: {
    cwd: string;
    threadId?: string;
    type: SubagentType;
    task: string;
    model?: string;
    depth?: SubagentDepth;
  }): Promise<{ childId: string; status: SubagentStatus }>;
  /** Every action of the `subagent` tool: status, wait, message, stop, inbox, report, ask, answer, close and read. */
  control(request: SubagentControlRequest): Promise<string>;
  /** A follow-up: queued while the child runs, a new turn once it settled. */
  message(
    childId: string,
    text: string,
    options?: { rework?: boolean },
  ): Promise<{ delivered: 'queued' | 'started' }>;
  /**
   * A child's blocking question to its parent. Resolves with the answer, with the
   * stopped text when the child is stopped or closed, or with the fallback text after
   * the question times out; the child's turn stays open while it waits.
   */
  ask(childId: string, text: string): Promise<string>;
  /**
   * The parent's or the user's reply to an open question. Writes a `kind: 'answer'`
   * to-child row, emits `subagent.answered` and resolves the waiting child.
   */
  answer(questionId: string, text: string, by?: 'parent' | 'user', threadId?: string): Promise<void>;
  /** Every open question, oldest first; `threadId` limits the list to one parent. */
  openQuestions(threadId?: string): SubagentQuestionView[];
  /**
   * Final: stops a running child, archives it with `closedAt` and keeps every message
   * row. A worktree with commits or uncommitted changes is kept; an empty one is
   * disposed. A closed child refuses message, ask and answer.
   */
  close(childId: string): Promise<SubagentView>;
  /**
   * The latest full report first, then one page of every mailbox row in both directions
   * after `cursor`. A bounded summary always names the report that holds the whole
   * answer, so no text is ever silently lost.
   */
  read(childId: string, cursor?: string): string;
  messages(childId: string): SubagentMessage[];
  get(childId: string): SubagentView;
  /** Cancels a queued child or interrupts a running one; settled children are a no-op. */
  cancel(childId: string): Promise<void>;
  list(threadId: string): SubagentView[];
  /** Every child across threads, so the sidebar maps child thread ids without per-parent calls. */
  listAll(): SubagentView[];
  /** Test and shutdown hook: resolves when the child reaches a terminal status. */
  awaitChild(childId: string): Promise<SubagentView>;
  /** Startup recovery: a queued or running child cannot resume after a restart. */
  recoverOrphaned(): number;
  dispose(): Promise<void>;
}

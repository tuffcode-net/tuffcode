import type { ServerEvent, Thread, ThreadStatus } from '@tuffcode/contracts';
import { DEFAULT_NOTIFICATIONS } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  hasRunningThread,
  keepAwakeFor,
  notificationFor,
  shouldNotify,
  testNotificationRequest,
  trackThreadStatus,
} from './notification-model';

const ISO = '2026-11-26T10:00:00.000Z';

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    parentThreadId: null,
    title: 'Fix login',
    providerId: 'prv',
    modelId: 'm',
    executionMode: 'work',
    permissionMode: 'ask',
    status: 'ready-to-review',
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    reasoningEffort: null,
    lastSeq: 0,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function statusEvent(id: string, status: ThreadStatus, title = 'Fix login'): ServerEvent {
  return {
    kind: 'event',
    type: 'thread.updated',
    threadId: id,
    payload: thread({ id, status, title }),
  };
}

function turnEvent(
  type: 'turn.started' | 'turn.finished',
  reason?: 'complete' | 'error',
): ServerEvent {
  return {
    kind: 'event',
    type: 'thread.event',
    threadId: 't1',
    seq: 1,
    createdAt: ISO,
    payload:
      type === 'turn.started'
        ? { type: 'turn.started', turnId: 'turn-1' }
        : { type: 'turn.finished', turnId: 'turn-1', reason: reason ?? 'complete' },
  };
}

const approvalEvent: ServerEvent = {
  kind: 'event',
  type: 'approval.requested',
  threadId: 't1',
  payload: {
    id: 'a1',
    threadId: 't1',
    toolCallId: 'c1',
    toolName: 'bash',
    input: {},
    decision: 'pending',
    createdAt: ISO,
    resolvedAt: null,
  },
};

function subagentEvent(status: 'done' | 'failed' | 'cancelled'): ServerEvent {
  return {
    kind: 'event',
    type: 'subagent.finished',
    threadId: 't1',
    payload: { childId: 's1', threadId: 't1', status },
  };
}

function councilEvent(
  state: 'reviewing' | 'running' | 'failed',
  taskState?: 'awaiting-captain' | 'passed',
  taskId?: string,
): ServerEvent {
  return {
    kind: 'event',
    type: 'council.updated',
    threadId: 't1',
    payload: {
      goalId: 'g1',
      state,
      ...(taskState === undefined ? {} : { taskState }),
      ...(taskId === undefined ? {} : { taskId }),
    },
  };
}

function context(
  previous: ReadonlyMap<string, ThreadStatus> = new Map([['t1', 'running']]),
  overrides: Partial<typeof DEFAULT_NOTIFICATIONS> = {},
  threads: Record<string, Thread> = { t1: thread() },
) {
  return {
    settings: { ...DEFAULT_NOTIFICATIONS, ...overrides },
    threads,
    previousStatus: previous,
  };
}

describe('notification rule table', () => {
  it('announces a finished turn once, only after the thread was running', () => {
    const done = notificationFor(statusEvent('t1', 'ready-to-review'), context());
    expect(done).toEqual({
      title: 'Turn finished',
      body: 'Fix login',
      route: '/project/p1/thread/t1',
      silent: false,
    });
    expect(
      notificationFor(statusEvent('t1', 'ready-to-review'), context(new Map([['t1', 'idle']]))),
    ).toBeNull();
    expect(
      notificationFor(
        statusEvent('t1', 'ready-to-review'),
        context(new Map([['t1', 'ready-to-review']])),
      ),
    ).toBeNull();
    expect(
      notificationFor(
        statusEvent('t1', 'ready-to-review'),
        context(undefined, { turnFinished: false }),
      ),
    ).toBeNull();
  });

  it('announces a failed turn and accepts a thread that was waiting for approval', () => {
    expect(notificationFor(statusEvent('t1', 'failed'), context())?.title).toBe('Turn failed');
    expect(
      notificationFor(
        statusEvent('t1', 'ready-to-review'),
        context(new Map([['t1', 'needs-approval']])),
      )?.title,
    ).toBe('Turn finished');
  });

  it('announces an approval and names the tool', () => {
    expect(notificationFor(approvalEvent, context(new Map()))).toMatchObject({
      title: 'Approval needed',
      body: 'Fix login: bash',
      route: '/project/p1/thread/t1',
    });
    expect(
      notificationFor(approvalEvent, context(new Map(), { approvalNeeded: false })),
    ).toBeNull();
  });

  it('announces each settled subagent outcome', () => {
    expect(notificationFor(subagentEvent('done'), context(new Map()))?.title).toBe(
      'Subagent finished',
    );
    expect(notificationFor(subagentEvent('failed'), context(new Map()))?.title).toBe(
      'Subagent failed',
    );
    expect(notificationFor(subagentEvent('cancelled'), context(new Map()))?.title).toBe(
      'Subagent was stopped',
    );
    expect(
      notificationFor(subagentEvent('done'), context(new Map(), { subagentFinished: false })),
    ).toBeNull();
  });

  it('announces a council review that needs the captain or failed', () => {
    expect(notificationFor(councilEvent('reviewing'), context(new Map()))).toMatchObject({
      title: 'Council needs you',
      body: 'Fix login',
      route: '/project/p1/thread/t1',
    });
    expect(notificationFor(councilEvent('failed'), context(new Map()))?.title).toBe(
      'Council review failed',
    );
    expect(
      notificationFor(councilEvent('running', 'awaiting-captain', 'tsk1'), context(new Map()))
        ?.title,
    ).toBe('Council needs you');
    expect(
      notificationFor(councilEvent('reviewing', 'passed', 'tsk1'), context(new Map())),
    ).toBeNull();
    expect(
      notificationFor(councilEvent('reviewing'), context(new Map(), { councilEscalation: false })),
    ).toBeNull();
  });

  it('stays silent when the sound setting is off', () => {
    expect(
      notificationFor(statusEvent('t1', 'ready-to-review'), context(undefined, { sound: false }))
        ?.silent,
    ).toBe(true);
    expect(notificationFor(approvalEvent, context(new Map(), { sound: false }))?.silent).toBe(true);
    expect(
      notificationFor(subagentEvent('done'), context(new Map(), { sound: false }))?.silent,
    ).toBe(true);
    expect(
      notificationFor(councilEvent('failed'), context(new Map(), { sound: false }))?.silent,
    ).toBe(true);
  });

  it('suppresses child threads because the subagent rule reports them', () => {
    const child = thread({ parentThreadId: 't1', id: 'child' });
    const event: ServerEvent = {
      kind: 'event',
      type: 'thread.updated',
      threadId: 'child',
      payload: { ...child, status: 'ready-to-review' },
    };
    expect(
      notificationFor(event, context(new Map([['child', 'running']]), {}, { child })),
    ).toBeNull();
  });

  it('never routes to a thread that is not in the store', () => {
    const approval = notificationFor(approvalEvent, context(new Map(), {}, {}));
    expect(approval?.route).toBeUndefined();
  });
});

describe('status tracking', () => {
  it('does not repeat a notification when the same status frame arrives twice', () => {
    const previous = new Map<string, ThreadStatus>([['t1', 'running']]);
    const first = statusEvent('t1', 'ready-to-review');
    expect(notificationFor(first, context(previous))?.title).toBe('Turn finished');
    trackThreadStatus(previous, first);
    expect(notificationFor(statusEvent('t1', 'ready-to-review'), context(previous))).toBeNull();
  });

  it('tracks a turn boundary so a finish after a replayed start still fires once', () => {
    const previous = new Map<string, ThreadStatus>([['t1', 'ready-to-review']]);
    // A reconnect replays the turn start without a thread.updated frame.
    trackThreadStatus(previous, turnEvent('turn.started'));
    expect(previous.get('t1')).toBe('running');
    const finish = statusEvent('t1', 'ready-to-review');
    expect(notificationFor(finish, context(previous))?.title).toBe('Turn finished');
    trackThreadStatus(previous, finish);
    expect(notificationFor(statusEvent('t1', 'ready-to-review'), context(previous))).toBeNull();
  });

  it('tracks approval and turn frames and failed turns', () => {
    const previous = new Map<string, ThreadStatus>();
    trackThreadStatus(previous, approvalEvent);
    expect(previous.get('t1')).toBe('needs-approval');
    trackThreadStatus(previous, turnEvent('turn.finished', 'error'));
    expect(previous.get('t1')).toBe('failed');
    trackThreadStatus(previous, turnEvent('turn.finished', 'complete'));
    expect(previous.get('t1')).toBe('ready-to-review');
  });
});

describe('focus gate and keep-awake', () => {
  it('skips notifications while the window is focused unless the setting allows it', () => {
    expect(shouldNotify(DEFAULT_NOTIFICATIONS, true)).toBe(false);
    expect(shouldNotify(DEFAULT_NOTIFICATIONS, false)).toBe(true);
    expect(shouldNotify({ ...DEFAULT_NOTIFICATIONS, onlyWhenUnfocused: false }, true)).toBe(true);
  });

  it('keeps the machine awake from the first running thread until none run', () => {
    const idle = { t1: thread({ status: 'idle' }) };
    expect(hasRunningThread(idle)).toBe(false);
    expect(keepAwakeFor(true, hasRunningThread(idle))).toBe(false);

    const firstRunning = {
      t1: thread({ status: 'running' }),
      t2: thread({ id: 't2', status: 'idle' }),
    };
    expect(hasRunningThread(firstRunning)).toBe(true);
    expect(keepAwakeFor(true, hasRunningThread(firstRunning))).toBe(true);

    const settled = {
      t1: thread({ status: 'ready-to-review' }),
      t2: thread({ id: 't2', status: 'failed' }),
    };
    expect(hasRunningThread(settled)).toBe(false);
    expect(keepAwakeFor(true, hasRunningThread(settled))).toBe(false);
    expect(keepAwakeFor(false, hasRunningThread(firstRunning))).toBe(false);
  });
});

describe('test notification', () => {
  it('routes to the newest real top-level thread and never fabricates one', () => {
    const threads = {
      old: thread({ id: 'old', updatedAt: '2026-11-20T00:00:00.000Z' }),
      newest: thread({ id: 'newest', updatedAt: '2026-11-26T00:00:00.000Z' }),
      child: thread({ id: 'child', parentThreadId: 'old', updatedAt: '2026-11-27T00:00:00.000Z' }),
    };
    expect(testNotificationRequest(threads, false)).toEqual({
      title: 'Test notification',
      body: 'Tuffcode notifications are working.',
      route: '/project/p1/thread/newest',
      silent: false,
    });
    expect(testNotificationRequest({}, true)).toEqual({
      title: 'Test notification',
      body: 'Tuffcode notifications are working.',
      silent: true,
    });
  });
});

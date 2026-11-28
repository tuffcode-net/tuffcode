import type { Thread } from '@tuffcode/contracts';
import { DEFAULT_NOTIFICATIONS } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import { createAppStore } from '../store/app-store';
import { normalizeBrowserUrl } from './browser/BrowserPane';
import { buildFileTree, matchesFileQuery, toggleExpanded, visibleRows } from './files/files-model';
import { notificationFor } from './notifications/notification-model';

const ISO = '2026-11-25T10:00:00.000Z';

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

describe('files model', () => {
  const root = buildFileTree(['src/b.ts', 'src/a.ts', 'README.md', 'src/lib/deep.ts', 'docs/guide.md']);

  it('sorts directories first and expands on demand', () => {
    expect(visibleRows(root, new Set(), '').map((row) => row.node.path)).toEqual(['docs', 'src', 'README.md']);
    const open = toggleExpanded(new Set(), 'src');
    expect(visibleRows(root, open, '').map((row) => [row.node.path, row.depth])).toEqual([
      ['docs', 0],
      ['src', 0],
      ['src/lib', 1],
      ['src/a.ts', 1],
      ['src/b.ts', 1],
      ['README.md', 0],
    ]);
    expect(toggleExpanded(open, 'src').has('src')).toBe(false);
  });

  it('filters by substring or by ? fuzzy match and keeps the ancestors', () => {
    expect(visibleRows(root, new Set(), 'deep').map((row) => row.node.path)).toEqual(['src', 'src/lib', 'src/lib/deep.ts']);
    expect(matchesFileQuery('src/lib/deep.ts', '?sld')).toBe(true);
    expect(matchesFileQuery('src/lib/deep.ts', '?zz')).toBe(false);
    expect(visibleRows(root, new Set(), 'nothing-here')).toEqual([]);
  });
});

describe('browser urls', () => {
  it('adds a scheme, keeps localhost on http, and refuses other schemes', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserUrl('file:///C:/x')).toBeNull();
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBrowserUrl('   ')).toBeNull();
  });
});

describe('notification rules', () => {
  const base = { settings: DEFAULT_NOTIFICATIONS, threads: { t1: thread() } };

  it('announces a finished or failed turn only after it was running', () => {
    const running = new Map([['t1', 'running' as const]]);
    const done = notificationFor(
      { kind: 'event', type: 'thread.updated', threadId: 't1', payload: thread() },
      { ...base, previousStatus: running },
    );
    expect(done).toEqual({ title: 'Turn finished', body: 'Fix login', route: '/project/p1/thread/t1', silent: false });
    expect(
      notificationFor(
        { kind: 'event', type: 'thread.updated', threadId: 't1', payload: thread({ status: 'failed' }) },
        { ...base, previousStatus: running },
      )?.title,
    ).toBe('Turn failed');
    expect(
      notificationFor(
        { kind: 'event', type: 'thread.updated', threadId: 't1', payload: thread() },
        { ...base, previousStatus: new Map([['t1', 'idle' as const]]) },
      ),
    ).toBeNull();
    expect(
      notificationFor(
        { kind: 'event', type: 'thread.updated', threadId: 't1', payload: thread() },
        { ...base, settings: { ...DEFAULT_NOTIFICATIONS, turnFinished: false, sound: false }, previousStatus: running },
      ),
    ).toBeNull();
  });

  it('announces approvals and subagents, silently when sound is off', () => {
    const approval = notificationFor(
      {
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
      },
      { ...base, settings: { ...DEFAULT_NOTIFICATIONS, sound: false }, previousStatus: new Map() },
    );
    expect(approval).toMatchObject({ title: 'Approval needed', body: 'Fix login: bash', silent: true });
    expect(
      notificationFor(
        { kind: 'event', type: 'subagent.finished', threadId: 't1', payload: { childId: 's1', threadId: 't1', status: 'failed' } },
        { ...base, previousStatus: new Map() },
      )?.title,
    ).toBe('Subagent failed');
  });
});

describe('store subagent reopen', () => {
  it('ignores a late start but reopens after a follow-up to a settled child', () => {
    const store = createAppStore();
    const state = store.getState();
    state.subagentStarted({ childId: 'c1', threadId: 't1', type: 'worker', model: 'm' });
    state.subagentFinished({ childId: 'c1', threadId: 't1', status: 'done', summary: 'ok' });
    store.getState().subagentStarted({ childId: 'c1', threadId: 't1', type: 'worker', model: 'm' });
    expect(store.getState().subagents.c1?.status).toBe('done');
    store.getState().subagentMessage({
      childId: 'c1',
      threadId: 't1',
      message: { id: 'm1', childId: 'c1', direction: 'to-child', kind: 'message', text: 'add tests', createdAt: ISO },
    });
    store.getState().subagentStarted({ childId: 'c1', threadId: 't1', type: 'worker', model: 'm' });
    expect(store.getState().subagents.c1?.status).toBe('running');
    store.getState().subagentTelemetry({
      childId: 'c1',
      threadId: 't1',
      toolCount: 5,
      inputTokens: 10,
      outputTokens: 2,
      activity: 'bash: pnpm test',
    });
    expect(store.getState().subagents.c1).toMatchObject({ toolCount: 5, activity: 'bash: pnpm test' });
    store.getState().subagentMessage({
      childId: 'c1',
      threadId: 't1',
      message: { id: 'm2', childId: 'c1', direction: 'to-parent', kind: 'message', text: 'tests added', createdAt: ISO },
    });
    expect(store.getState().subagents.c1?.unread).toBe(1);
  });
});

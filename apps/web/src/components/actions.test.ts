import type { Attachment, Thread } from '@tuffcode/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { RpcRequester } from '../store/app-store';
import {
  ACTIONS,
  ASSISTANT_MESSAGE_MENU,
  DIFF_FILE_MENU,
  DIFF_LINE_MENU,
  PALETTE_ACTIONS,
  TERMINAL_MENU,
  THREAD_MENU,
  USER_MESSAGE_MENU,
  actionUnavailableReason,
  messageMarkdown,
  runAction,
  type ActionContext,
  type ActionId,
} from './actions';
import type { AssistantItem, UserItem } from './thread/grouping';

const THREAD: Thread = {
  id: 'thr_actions',
  projectId: 'prj_actions',
  parentThreadId: null,
  title: 'Menu work',
  providerId: 'prov_1',
  modelId: 'model-1',
  executionMode: 'work',
  permissionMode: 'ask',
  status: 'idle',
  worktreePath: 'D:/worktrees/menu',
  branch: 'feat/menus',
  baseBranch: 'main',
  prUrl: null,
  reasoningEffort: null,
  lastSeq: 4,
  createdAt: '2026-11-24T10:00:00.000Z',
  updatedAt: '2026-11-24T10:00:00.000Z',
};

const ATTACHMENT: Attachment = { name: 'notes.txt', path: 'D:/notes.txt' };

function userItem(messageId: string): UserItem {
  return {
    kind: 'user',
    key: `user-${messageId}`,
    messageId,
    turnId: 'turn_1',
    text: 'Ship the menus',
    attachments: [ATTACHMENT],
    status: 'sent',
  };
}

const ASSISTANT_ITEM: AssistantItem = {
  kind: 'assistant',
  key: 'assistant-1',
  turnId: 'turn_1',
  text: 'Done.',
  streaming: false,
};

interface Harness {
  context: ActionContext;
  calls: { method: string; params: unknown }[];
  clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };
  notify: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  store: {
    upsertThread: ReturnType<typeof vi.fn>;
    removeThread: ReturnType<typeof vi.fn>;
    removeMessage: ReturnType<typeof vi.fn>;
  };
  ui: {
    openThread: ReturnType<typeof vi.fn>;
    renameThread: ReturnType<typeof vi.fn>;
    deleteThread: ReturnType<typeof vi.fn>;
    editUserMessage: ReturnType<typeof vi.fn>;
    addDiffComment: ReturnType<typeof vi.fn>;
    openInTerminal: ReturnType<typeof vi.fn>;
  };
}

function harness(overrides: Partial<ActionContext> = {}, responses: Record<string, unknown> = {}) {
  const calls: Harness['calls'] = [];
  const rpc = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return responses[method] ?? {};
    }),
  } as unknown as RpcRequester;
  const clipboard = {
    writeText: vi.fn(async () => undefined),
    readText: vi.fn(async () => 'pasted text'),
  };
  const notify = { success: vi.fn(), error: vi.fn() };
  const store = {
    upsertThread: vi.fn(),
    removeThread: vi.fn(),
    removeMessage: vi.fn(),
  };
  const ui = {
    openThread: vi.fn(),
    renameThread: vi.fn(),
    deleteThread: vi.fn(),
    editUserMessage: vi.fn(),
    addDiffComment: vi.fn(),
    openInTerminal: vi.fn(),
  };
  const context: ActionContext = {
    rpc,
    clipboard,
    notify,
    store,
    ui,
    ...overrides,
  };
  return { context, calls, clipboard, notify, store, ui } satisfies Harness;
}

function menuIds(): ActionId[] {
  return [
    ...THREAD_MENU,
    ...USER_MESSAGE_MENU,
    ...ASSISTANT_MESSAGE_MENU,
    ...DIFF_FILE_MENU,
    ...DIFF_LINE_MENU,
    ...TERMINAL_MENU,
    ...PALETTE_ACTIONS,
  ];
}

describe('action registry shape', () => {
  it('gives every action a label, an icon, and a handler', () => {
    for (const [id, action] of Object.entries(ACTIONS)) {
      expect(action.id, id).toBe(id);
      expect(action.label.trim(), id).not.toBe('');
      expect(action.icon, id).toBeDefined();
      expect(typeof action.run, id).toBe('function');
    }
  });

  it('only marks the delete action destructive', () => {
    const destructive = Object.values(ACTIONS)
      .filter((action) => action.destructive === true)
      .map((action) => action.id)
      .toSorted();

    // Hiding a message is reversible, so only a real delete keeps the red styling.
    expect(destructive).toEqual(['thread.delete']);
  });

  it('points every menu entry at a registered action', () => {
    for (const id of menuIds()) {
      expect(ACTIONS[id], id).toBeDefined();
    }
  });

  it('keeps the thread menu in the documented order', () => {
    expect(THREAD_MENU).toEqual([
      'thread.open',
      'thread.rename',
      'thread.copyPath',
      'thread.delete',
    ]);
    expect(USER_MESSAGE_MENU).toEqual([
      'message.copy',
      'message.copyMarkdown',
      'message.edit',
      'message.delete',
    ]);
    expect(ASSISTANT_MESSAGE_MENU).toEqual([
      'message.copy',
      'message.copyMarkdown',
      'message.retry',
    ]);
  });

  it('hints a shortcut on the copy and retry rows', () => {
    expect(ACTIONS['message.copy'].shortcut).toBe('Ctrl+C');
    expect(ACTIONS['message.copyMarkdown'].shortcut).toBe('Ctrl+Shift+C');
    expect(ACTIONS['message.retry'].shortcut).toBe('R');
  });
});

describe('thread actions', () => {
  it('renames through threads.update and stores the returned thread', async () => {
    const updated = { ...THREAD, title: 'Renamed' };
    const h = harness({ thread: THREAD }, { 'threads.update': updated });

    await runAction('thread.rename', { ...h.context, input: { title: '  Renamed  ' } });

    expect(h.calls).toEqual([
      { method: 'threads.update', params: { id: THREAD.id, title: 'Renamed' } },
    ]);
    expect(h.store.upsertThread).toHaveBeenCalledWith(updated);
    expect(h.notify.success).toHaveBeenCalledWith('Thread renamed');
  });

  it('opens the rename dialog when no title was collected', async () => {
    const h = harness({ thread: THREAD });

    await runAction('thread.rename', h.context);

    expect(h.ui.renameThread).toHaveBeenCalledWith(THREAD);
    expect(h.calls).toEqual([]);
  });

  it('copies the worktree path, falling back to the project root', async () => {
    const h = harness({ thread: THREAD });
    await runAction('thread.copyPath', h.context);
    expect(h.clipboard.writeText).toHaveBeenCalledWith('D:/worktrees/menu');

    const noWorktree = harness({
      thread: { ...THREAD, worktreePath: null },
      projectPath: 'D:/repo',
    });
    await runAction('thread.copyPath', noWorktree.context);
    expect(noWorktree.clipboard.writeText).toHaveBeenCalledWith('D:/repo');
  });

  it('asks for confirmation before deleting, then calls threads.delete', async () => {
    const h = harness({ thread: THREAD });

    await runAction('thread.delete', h.context);
    expect(h.ui.deleteThread).toHaveBeenCalledWith(THREAD);
    expect(h.calls).toEqual([]);

    await runAction('thread.delete', { ...h.context, input: { confirmed: true } });
    expect(h.calls).toEqual([
      { method: 'threads.delete', params: { id: THREAD.id, removeWorktree: false } },
    ]);
    expect(h.store.removeThread).toHaveBeenCalledWith(THREAD.id);
  });
});

describe('message actions', () => {
  it('copies plain text and markdown', async () => {
    const h = harness({ threadId: THREAD.id, userMessage: userItem('msg_copy_user') });

    await runAction('message.copy', h.context);
    expect(h.clipboard.writeText).toHaveBeenCalledWith('Ship the menus');

    await runAction('message.copyMarkdown', h.context);
    expect(h.clipboard.writeText).toHaveBeenLastCalledWith('**You**\n\nShip the menus');
    expect(messageMarkdown(h.context)).toBe('**You**\n\nShip the menus');
  });

  it('resends a user message with its attachments', async () => {
    const h = harness(
      { threadId: THREAD.id, userMessage: userItem('msg_retry_user') },
      { 'threads.send': { turnId: 'turn_2' } },
    );

    await runAction('message.retry', h.context);

    expect(h.calls).toEqual([
      {
        method: 'threads.send',
        params: { id: THREAD.id, text: 'Ship the menus', attachments: [ATTACHMENT] },
      },
    ]);
  });

  it('resends the prompt an assistant reply answered', async () => {
    const h = harness(
      {
        threadId: THREAD.id,
        assistantMessage: ASSISTANT_ITEM,
        retryPrompt: { text: 'Ship the menus', attachments: [] },
      },
      { 'threads.send': { turnId: 'turn_3' } },
    );

    await runAction('message.retry', h.context);

    expect(h.calls).toEqual([
      { method: 'threads.send', params: { id: THREAD.id, text: 'Ship the menus' } },
    ]);
  });

  it('sends edited text and opens the editor when no text was collected', async () => {
    const item = userItem('msg_edit_user');
    const h = harness(
      { threadId: THREAD.id, userMessage: item },
      { 'threads.send': { turnId: 'turn_4' } },
    );

    await runAction('message.edit', h.context);
    expect(h.ui.editUserMessage).toHaveBeenCalledWith(item);
    expect(h.calls).toEqual([]);

    await runAction('message.edit', { ...h.context, input: { text: 'Ship it faster' } });
    expect(h.calls).toEqual([
      {
        method: 'threads.send',
        params: { id: THREAD.id, text: 'Ship it faster', attachments: [ATTACHMENT] },
      },
    ]);
  });

  it('hides a message from this session in both stores', async () => {
    const item = userItem('msg_delete_user');
    const h = harness({ threadId: THREAD.id, userMessage: item });

    await runAction('message.delete', h.context);

    expect(h.store.removeMessage).toHaveBeenCalledWith(THREAD.id, item.messageId);
    expect(h.notify.success).toHaveBeenCalledWith('Hidden from this session');
  });
});

describe('diff and terminal actions', () => {
  it('opens a diff file in the terminal through the ui port', async () => {
    const h = harness({ diffFile: { path: 'apps/web/src/app.tsx' } });

    await runAction('file.copyPath', h.context);
    expect(h.clipboard.writeText).toHaveBeenCalledWith('apps/web/src/app.tsx');

    await runAction('file.openInTerminal', h.context);
    expect(h.ui.openInTerminal).toHaveBeenCalledWith('apps/web/src/app.tsx');
  });

  it('adds a comment for the selected diff line and copies its text', async () => {
    const line = { path: 'src/a.ts', line: 12, side: 'new' as const, text: 'const a = 1;' };
    const h = harness({ diffLine: line });

    await runAction('diffLine.addComment', h.context);
    expect(h.ui.addDiffComment).toHaveBeenCalledWith(line);

    await runAction('diffLine.copy', h.context);
    expect(h.clipboard.writeText).toHaveBeenCalledWith('const a = 1;');
  });

  it('copies the terminal selection, pastes, and clears', async () => {
    const write = vi.fn();
    const clear = vi.fn();
    const h = harness({
      terminal: { getSelection: () => 'selected output', write, clear },
    });

    await runAction('terminal.copy', h.context);
    expect(h.clipboard.writeText).toHaveBeenCalledWith('selected output');

    await runAction('terminal.paste', h.context);
    expect(write).toHaveBeenCalledWith('pasted text');

    await runAction('terminal.clear', h.context);
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe('availability', () => {
  it('reports why a target is missing', () => {
    const h = harness({ thread: THREAD });

    expect(actionUnavailableReason('message.edit', h.context)).toBe('Not a user message');
    expect(actionUnavailableReason('message.retry', h.context)).toBe('No message');
    expect(actionUnavailableReason('diffLine.copy', h.context)).toBe('No line');
    expect(actionUnavailableReason('thread.copyPath', h.context)).toBeNull();
  });

  it('disables terminal copy until something is selected', () => {
    const empty = harness({
      terminal: { getSelection: () => '   ', write: vi.fn(), clear: vi.fn() },
    });
    expect(actionUnavailableReason('terminal.copy', empty.context)).toBe('Nothing selected');

    const selected = harness({
      terminal: { getSelection: () => 'text', write: vi.fn(), clear: vi.fn() },
    });
    expect(actionUnavailableReason('terminal.copy', selected.context)).toBeNull();
  });

  it('needs a prompt before an assistant retry is available', () => {
    const h = harness({ assistantMessage: ASSISTANT_ITEM });
    expect(actionUnavailableReason('message.retry', h.context)).toBe('No prompt to resend');

    const withPrompt = harness({
      assistantMessage: ASSISTANT_ITEM,
      retryPrompt: { text: 'Ship the menus', attachments: [] },
    });
    expect(actionUnavailableReason('message.retry', withPrompt.context)).toBeNull();
  });
});

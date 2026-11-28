import type { Attachment, Thread } from '@tuffcode/contracts';
import {
  ArrowUpRight,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Eraser,
  EyeOff,
  MessageSquarePlus,
  PencilLine,
  RotateCcw,
  SquarePen,
  Terminal,
  Trash,
  type LucideIcon,
} from 'lucide-react';
import type { RpcRequester } from '../store/app-store';
import type { AssistantItem, UserItem } from './thread/grouping';
import {
  addLocalUserMessage,
  failLocalUserMessage,
  hideLocalUserMessage,
  nextLocalUserMessageId,
  removeLocalUserMessage,
  resolveLocalUserMessage,
  retryLocalUserMessage,
  supersedeTurn,
  updateLocalUserMessageText,
} from './thread/local-messages';

/**
 * Every user-triggered command in one table. Context menus and the command
 * palette read the same entries, so a label, shortcut, icon or handler never
 * has to be written twice.
 */
export type ActionId =
  | 'thread.open'
  | 'thread.rename'
  | 'thread.copyPath'
  | 'thread.delete'
  | 'message.copy'
  | 'message.copyMarkdown'
  | 'message.edit'
  | 'message.delete'
  | 'message.retry'
  | 'file.copyPath'
  | 'file.openInTerminal'
  | 'diffLine.addComment'
  | 'diffLine.copy'
  | 'terminal.copy'
  | 'terminal.paste'
  | 'terminal.clear';

export interface DiffLineTarget {
  path: string;
  /** 1-based line number on the requested side. */
  line: number;
  side: 'old' | 'new';
  /** The line's code without its gutter, as rendered in the diff. */
  text: string;
}

export interface TerminalTarget {
  /** The xterm selection at the moment the action runs. */
  getSelection(): string;
  /** Writes text to the pty as if the user typed it. */
  write(data: string): void;
  /** Clears the viewport; scrollback is kept. */
  clear(): void;
}

export interface ActionStore {
  upsertThread(thread: Thread): void;
  removeThread(threadId: string): void;
  removeMessage(threadId: string, messageId: string): void;
}

export interface ActionUi {
  openThread?(thread: Thread): void;
  /** Opens the rename dialog; the dialog calls the action again with a title. */
  renameThread?(thread: Thread): void;
  /** Opens the delete confirmation; the dialog calls the action again confirmed. */
  deleteThread?(thread: Thread): void;
  /** Opens the inline editor on a user message. */
  editUserMessage?(item: UserItem): void;
  addDiffComment?(line: DiffLineTarget): void;
  openInTerminal?(path: string): void;
}

export interface ActionInput {
  /** Collected by the rename dialog. */
  title?: string;
  /** Collected by the inline message editor. */
  text?: string;
  /** Set by the delete confirmation. */
  confirmed?: boolean;
}

export interface ActionContext {
  rpc: RpcRequester;
  clipboard: {
    writeText(text: string): Promise<void>;
    readText?(): Promise<string>;
  };
  notify: {
    success(message: string): void;
    error(message: string): void;
  };
  store: ActionStore;
  ui?: ActionUi;
  thread?: Thread;
  threadId?: string;
  /** The project root, used when a thread has no worktree of its own. */
  projectPath?: string;
  userMessage?: UserItem;
  assistantMessage?: AssistantItem;
  /** The prompt an assistant reply answered, so retry can resend it. */
  retryPrompt?: { text: string; attachments: readonly Attachment[] };
  diffFile?: { path: string };
  diffLine?: DiffLineTarget;
  terminal?: TerminalTarget;
  input?: ActionInput;
}

export interface ActionDefinition {
  id: ActionId;
  label: string;
  /** Display-only hint; the menu shows it on the right of the row. */
  shortcut?: string;
  destructive?: boolean;
  icon: LucideIcon;
  run(ctx: ActionContext): void | Promise<void>;
}

/** Why an action cannot run against this context, or null when it can. */
export function actionUnavailableReason(id: ActionId, ctx: ActionContext): string | null {
  switch (id) {
    case 'thread.open':
    case 'thread.rename':
    case 'thread.copyPath':
    case 'thread.delete':
      return ctx.thread === undefined ? 'No thread' : null;
    case 'message.copy':
    case 'message.copyMarkdown':
      return ctx.userMessage === undefined && ctx.assistantMessage === undefined
        ? 'No message'
        : null;
    case 'message.edit':
    case 'message.delete':
      return ctx.userMessage === undefined ? 'Not a user message' : null;
    case 'message.retry':
      if (ctx.userMessage !== undefined) return null;
      if (ctx.assistantMessage === undefined) return 'No message';
      return ctx.retryPrompt === undefined ? 'No prompt to resend' : null;
    case 'file.copyPath':
    case 'file.openInTerminal':
      return ctx.diffFile === undefined ? 'No file' : null;
    case 'diffLine.addComment':
    case 'diffLine.copy':
      return ctx.diffLine === undefined ? 'No line' : null;
    case 'terminal.copy':
      return ctx.terminal === undefined || ctx.terminal.getSelection().trim() === ''
        ? 'Nothing selected'
        : null;
    case 'terminal.paste':
    case 'terminal.clear':
      return ctx.terminal === undefined ? 'No terminal' : null;
  }
}

export function isActionAvailable(id: ActionId, ctx: ActionContext): boolean {
  return actionUnavailableReason(id, ctx) === null;
}

/** A role header plus the message, so a paste keeps who said what. */
export function messageMarkdown(ctx: ActionContext): string {
  const speaker = ctx.userMessage === undefined ? 'Assistant' : 'You';
  const text = ctx.userMessage?.text ?? ctx.assistantMessage?.text ?? '';
  return `**${speaker}**\n\n${text}`;
}

async function sendPrompt(
  ctx: ActionContext,
  messageId: string | null,
  text: string,
  attachments: readonly Attachment[],
): Promise<void> {
  const threadId = ctx.threadId;
  if (threadId === undefined) throw new Error('No thread is open.');

  try {
    const result = await ctx.rpc.request('threads.send', {
      id: threadId,
      text,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    });
    if (messageId !== null) {
      resolveLocalUserMessage(messageId, result.turnId, result.queued === true);
    }
  } catch (error) {
    if (messageId !== null) failLocalUserMessage(messageId);
    throw error;
  }
}

export const ACTIONS: Record<ActionId, ActionDefinition> = {
  'thread.open': {
    id: 'thread.open',
    label: 'Open',
    icon: ArrowUpRight,
    run: (ctx) => {
      if (ctx.thread !== undefined) ctx.ui?.openThread?.(ctx.thread);
    },
  },
  'thread.rename': {
    id: 'thread.rename',
    label: 'Rename',
    shortcut: 'F2',
    icon: PencilLine,
    run: async (ctx) => {
      const thread = ctx.thread;
      if (thread === undefined) return;

      const title = ctx.input?.title?.trim();
      if (title === undefined || title === '') {
        ctx.ui?.renameThread?.(thread);
        return;
      }

      const updated = await ctx.rpc.request('threads.update', { id: thread.id, title });
      ctx.store.upsertThread(updated);
      ctx.notify.success('Thread renamed');
    },
  },
  'thread.copyPath': {
    id: 'thread.copyPath',
    label: 'Copy path',
    shortcut: 'Ctrl+Shift+P',
    icon: Copy,
    run: async (ctx) => {
      const path = ctx.thread?.worktreePath ?? ctx.projectPath;
      if (path === undefined || path === '') throw new Error('This thread has no path yet.');
      await ctx.clipboard.writeText(path);
      ctx.notify.success('Path copied');
    },
  },
  'thread.delete': {
    id: 'thread.delete',
    label: 'Delete thread',
    destructive: true,
    icon: Trash,
    run: async (ctx) => {
      const thread = ctx.thread;
      if (thread === undefined) return;

      if (ctx.input?.confirmed !== true) {
        ctx.ui?.deleteThread?.(thread);
        return;
      }

      await ctx.rpc.request('threads.delete', { id: thread.id, removeWorktree: false });
      ctx.store.removeThread(thread.id);
      ctx.notify.success('Thread deleted');
    },
  },
  'message.copy': {
    id: 'message.copy',
    label: 'Copy',
    shortcut: 'Ctrl+C',
    icon: Copy,
    run: async (ctx) => {
      await ctx.clipboard.writeText(ctx.userMessage?.text ?? ctx.assistantMessage?.text ?? '');
      ctx.notify.success('Message copied');
    },
  },
  'message.copyMarkdown': {
    id: 'message.copyMarkdown',
    label: 'Copy as markdown',
    shortcut: 'Ctrl+Shift+C',
    icon: ClipboardCopy,
    run: async (ctx) => {
      await ctx.clipboard.writeText(messageMarkdown(ctx));
      ctx.notify.success('Markdown copied');
    },
  },
  'message.edit': {
    id: 'message.edit',
    label: 'Edit and resend',
    shortcut: 'E',
    icon: SquarePen,
    run: async (ctx) => {
      const item = ctx.userMessage;
      if (item === undefined) return;

      const text = ctx.input?.text?.trim();
      if (text === undefined || text === '') {
        ctx.ui?.editUserMessage?.(item);
        return;
      }

      const threadId = ctx.threadId;
      if (threadId === undefined) throw new Error('No thread is open.');

      // An unsent echo is edited in place. A persisted prompt cannot be rewritten
      // on the server, so its turn is hidden for this session and the edited text
      // is sent as a fresh turn.
      let messageId = item.messageId;
      if (item.turnId === null && updateLocalUserMessageText(item.messageId, text)) {
        retryLocalUserMessage(messageId);
      } else {
        if (item.turnId !== null) supersedeTurn(threadId, item.turnId);
        messageId = nextLocalUserMessageId(threadId);
        addLocalUserMessage({
          id: messageId,
          threadId,
          turnId: null,
          text,
          attachments: [...item.attachments],
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
      }

      await sendPrompt(ctx, messageId, text, item.attachments);
      ctx.notify.success('Message resent');
    },
  },
  'message.delete': {
    id: 'message.delete',
    label: 'Hide from this session',
    shortcut: 'Del',
    // Hiding is reversible: a reload brings the row back, so it is not destructive.
    destructive: false,
    icon: EyeOff,
    run: (ctx) => {
      const item = ctx.userMessage;
      const threadId = ctx.threadId;
      if (item === undefined || threadId === undefined) return;

      // There is no server-side message delete yet, so this hides the row for the
      // rest of the session. The hidden id survives transcript refetches.
      hideLocalUserMessage(threadId, item.messageId);
      removeLocalUserMessage(item.messageId);
      ctx.store.removeMessage(threadId, item.messageId);
      ctx.notify.success('Hidden from this session');
    },
  },
  'message.retry': {
    id: 'message.retry',
    label: 'Retry',
    shortcut: 'R',
    icon: RotateCcw,
    run: async (ctx) => {
      const item = ctx.userMessage;
      if (item !== undefined) {
        retryLocalUserMessage(item.messageId);
        await sendPrompt(ctx, item.messageId, item.text, item.attachments);
        return;
      }

      const prompt = ctx.retryPrompt;
      if (ctx.assistantMessage === undefined || prompt === undefined) return;

      const threadId = ctx.threadId;
      if (threadId === undefined) throw new Error('No thread is open.');
      const messageId = nextLocalUserMessageId(threadId);
      addLocalUserMessage({
        id: messageId,
        threadId,
        turnId: null,
        text: prompt.text,
        attachments: [...prompt.attachments],
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      await sendPrompt(ctx, messageId, prompt.text, prompt.attachments);
    },
  },
  'file.copyPath': {
    id: 'file.copyPath',
    label: 'Copy path',
    icon: Copy,
    run: async (ctx) => {
      const path = ctx.diffFile?.path;
      if (path === undefined) return;
      await ctx.clipboard.writeText(path);
      ctx.notify.success('Path copied');
    },
  },
  'file.openInTerminal': {
    id: 'file.openInTerminal',
    label: 'Open in terminal',
    icon: Terminal,
    run: (ctx) => {
      const path = ctx.diffFile?.path;
      if (path === undefined) return;
      ctx.ui?.openInTerminal?.(path);
    },
  },
  'diffLine.addComment': {
    id: 'diffLine.addComment',
    label: 'Add comment',
    shortcut: 'C',
    icon: MessageSquarePlus,
    run: (ctx) => {
      if (ctx.diffLine !== undefined) ctx.ui?.addDiffComment?.(ctx.diffLine);
    },
  },
  'diffLine.copy': {
    id: 'diffLine.copy',
    label: 'Copy line',
    shortcut: 'Ctrl+C',
    icon: Copy,
    run: async (ctx) => {
      const line = ctx.diffLine;
      if (line === undefined) return;
      await ctx.clipboard.writeText(line.text);
      ctx.notify.success('Line copied');
    },
  },
  'terminal.copy': {
    id: 'terminal.copy',
    label: 'Copy',
    shortcut: 'Ctrl+Shift+C',
    icon: Copy,
    run: async (ctx) => {
      const terminal = ctx.terminal;
      if (terminal === undefined) return;
      const selection = terminal.getSelection();
      if (selection === '') throw new Error('Select some terminal output first.');
      await ctx.clipboard.writeText(selection);
      ctx.notify.success('Selection copied');
    },
  },
  'terminal.paste': {
    id: 'terminal.paste',
    label: 'Paste',
    shortcut: 'Ctrl+Shift+V',
    icon: ClipboardPaste,
    run: async (ctx) => {
      const terminal = ctx.terminal;
      if (terminal === undefined) return;
      if (ctx.clipboard.readText === undefined) {
        throw new Error('Paste is not available in this build.');
      }
      const text = await ctx.clipboard.readText();
      if (text === '') {
        ctx.notify.error('The clipboard is empty.');
        return;
      }
      terminal.write(text);
    },
  },
  'terminal.clear': {
    id: 'terminal.clear',
    label: 'Clear',
    shortcut: 'Ctrl+L',
    icon: Eraser,
    run: (ctx) => {
      ctx.terminal?.clear();
    },
  },
};

export function runAction(id: ActionId, ctx: ActionContext): void | Promise<void> {
  return ACTIONS[id].run(ctx);
}

/** The thread row menu, in display order. */
export const THREAD_MENU: readonly ActionId[] = [
  'thread.open',
  'thread.rename',
  'thread.copyPath',
  'thread.delete',
];

export const USER_MESSAGE_MENU: readonly ActionId[] = [
  'message.copy',
  'message.copyMarkdown',
  'message.edit',
  'message.delete',
];

export const ASSISTANT_MESSAGE_MENU: readonly ActionId[] = [
  'message.copy',
  'message.copyMarkdown',
  'message.retry',
];

/** Hover buttons on a user message. */
export const USER_MESSAGE_HOVER: readonly ActionId[] = [
  'message.copy',
  'message.retry',
  'message.edit',
];

/** Hover buttons on an assistant message. */
export const ASSISTANT_MESSAGE_HOVER: readonly ActionId[] = ['message.copy', 'message.retry'];

export const DIFF_FILE_MENU: readonly ActionId[] = ['file.copyPath', 'file.openInTerminal'];

export const DIFF_LINE_MENU: readonly ActionId[] = ['diffLine.addComment', 'diffLine.copy'];

export const TERMINAL_MENU: readonly ActionId[] = [
  'terminal.copy',
  'terminal.paste',
  'terminal.clear',
];

/** Actions the command palette offers without a hovered target. */
export const PALETTE_ACTIONS: readonly ActionId[] = THREAD_MENU;

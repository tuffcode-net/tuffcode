import type { NotificationSettings, ServerEvent, Thread, ThreadStatus } from '@tuffcode/contracts';
import type { NotifyRequest } from '../../types';

/**
 * Which server events become a desktop notification. Pure, so the rules are tested
 * without a bridge: a turn that finished or failed, an approval waiting, a subagent
 * that settled, and a council review that needs the captain or failed.
 */
export interface NotificationContext {
  settings: NotificationSettings;
  threads: Readonly<Record<string, Thread>>;
  /** The status each thread had before this event, kept by the caller. */
  previousStatus: ReadonlyMap<string, ThreadStatus>;
}

/** The desktop bridge drops a title over 120 characters and a body over 400. */
const TITLE_LIMIT = 120;
const BODY_LIMIT = 400;

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/** Route for a thread's chat; a notification click never navigates anywhere else. */
export function threadNotificationRoute(thread: Thread): string {
  return `/project/${thread.projectId}/thread/${thread.id}`;
}

function shortTitle(thread: Thread | undefined): string {
  const title = thread?.title.trim() ?? '';
  return clip(title.length > 0 ? title : 'A chat', TITLE_LIMIT);
}

/** True when the focused-window rule still allows a notification. */
export function shouldNotify(settings: NotificationSettings, focused: boolean): boolean {
  return !(settings.onlyWhenUnfocused && focused);
}

/** True while any thread runs, which is what the keep-awake blocker follows. */
export function hasRunningThread(threads: Readonly<Record<string, Thread>>): boolean {
  return Object.values(threads).some((thread) => thread.status === 'running');
}

/** Keep the machine awake only when the setting is on and an agent is running. */
export function keepAwakeFor(enabled: boolean, anyRunning: boolean): boolean {
  return enabled && anyRunning;
}

/**
 * Advances the tracked status after an event is judged. Turn boundaries and approval
 * frames move the status too, so a finish that follows a replayed turn still fires
 * once even when no `thread.updated` frame announced the start.
 */
export function trackThreadStatus(
  previousStatus: Map<string, ThreadStatus>,
  event: ServerEvent,
): void {
  switch (event.type) {
    case 'thread.updated':
      previousStatus.set(event.payload.id, event.payload.status);
      return;
    case 'approval.requested':
      previousStatus.set(event.payload.threadId, 'needs-approval');
      return;
    case 'thread.event':
      if (event.payload.type === 'turn.started') {
        previousStatus.set(event.threadId, 'running');
      } else if (event.payload.type === 'turn.finished') {
        previousStatus.set(
          event.threadId,
          event.payload.reason === 'error' ? 'failed' : 'ready-to-review',
        );
      }
      return;
    default:
      return;
  }
}

/**
 * A test notification for the Settings button. It points at a thread that already
 * exists (the newest top-level one) and never invents a route of its own.
 */
export function testNotificationRequest(
  threads: Readonly<Record<string, Thread>>,
  silent: boolean,
): NotifyRequest {
  const thread = Object.values(threads)
    .filter((candidate) => candidate.parentThreadId === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    title: 'Test notification',
    body: 'Tuffcode notifications are working.',
    ...(thread === undefined ? {} : { route: threadNotificationRoute(thread) }),
    silent,
  };
}

export function notificationFor(event: ServerEvent, context: NotificationContext): NotifyRequest | null {
  const { settings } = context;
  const silent = !settings.sound;
  switch (event.type) {
    case 'thread.updated': {
      const thread = event.payload;
      // Child threads report through their parent's subagent notification instead.
      if (thread.parentThreadId !== null) return null;
      const before = context.previousStatus.get(thread.id);
      if (before !== 'running' && before !== 'needs-approval') return null;
      if (!settings.turnFinished) return null;
      if (thread.status === 'ready-to-review' || thread.status === 'idle') {
        return {
          title: 'Turn finished',
          body: shortTitle(thread),
          route: threadNotificationRoute(thread),
          silent,
        };
      }
      if (thread.status === 'failed') {
        return {
          title: 'Turn failed',
          body: shortTitle(thread),
          route: threadNotificationRoute(thread),
          silent,
        };
      }
      return null;
    }
    case 'approval.requested': {
      if (!settings.approvalNeeded) return null;
      const thread = context.threads[event.payload.threadId];
      return {
        title: 'Approval needed',
        body: clip(`${shortTitle(thread)}: ${event.payload.toolName}`, BODY_LIMIT),
        ...(thread === undefined ? {} : { route: threadNotificationRoute(thread) }),
        silent,
      };
    }
    case 'subagent.finished': {
      if (!settings.subagentFinished) return null;
      const thread = context.threads[event.payload.threadId];
      const outcome =
        event.payload.status === 'done' ? 'finished' : event.payload.status === 'cancelled' ? 'was stopped' : 'failed';
      return {
        title: `Subagent ${outcome}`,
        body: shortTitle(thread),
        ...(thread === undefined ? {} : { route: threadNotificationRoute(thread) }),
        silent,
      };
    }
    case 'council.updated': {
      if (!settings.councilEscalation) return null;
      // A task that awaits the captain is the exact signal. Any other task change stays
      // silent, and the goal state alone only speaks when no task rides along, so a
      // review that is still moving does not notify on every task transition.
      const awaitingCaptain = event.payload.taskState === 'awaiting-captain';
      const taskChange = event.payload.taskId !== undefined;
      if (!awaitingCaptain) {
        if (taskChange) return null;
        if (event.payload.state !== 'reviewing' && event.payload.state !== 'failed') return null;
      }
      const thread = event.threadId === undefined ? undefined : context.threads[event.threadId];
      const failed = !awaitingCaptain && event.payload.state === 'failed';
      return {
        title: failed ? 'Council review failed' : 'Council needs you',
        body: shortTitle(thread),
        ...(thread === undefined ? {} : { route: threadNotificationRoute(thread) }),
        silent,
      };
    }
    default:
      return null;
  }
}

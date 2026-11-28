import { Link } from '@tanstack/react-router';
import type { ApprovalChoice, DashboardThread } from '@tuffcode/contracts';
import { Button, EmptyState, Spinner, cn } from '@tuffcode/ui';
import { Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { formatRelativeTime } from '../sidebar/sidebar-model';
import { StatusChip } from '../thread/status-chip';
import {
  attentionCount,
  groupInboxThreads,
  inboxActivityAt,
  inboxReason,
  inboxReasonLine,
} from './inbox-model';
import { refreshInbox, useInbox } from './use-inbox';

/**
 * One cross-project answer to "which agent is blocked on me, and which one quietly
 * died". The server sorts, this page groups, and a row's Allow/Deny resolves the
 * approval in place before the thread opens.
 */
export function InboxPage() {
  const inbox = useInbox({ live: true });
  const groups = useMemo(() => groupInboxThreads(inbox.threads), [inbox.threads]);
  const attention = attentionCount(inbox.threads);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="inbox-page">
      <div className="mx-auto flex w-full max-w-[880px] shrink-0 flex-col gap-1 px-6 pt-6 pb-3">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Needs you</h1>
        <p className="text-xs text-muted-foreground">
          {inbox.threads.length === 0
            ? 'Every project in one list.'
            : attention === 0
              ? `${inbox.threads.length} threads, nothing waiting on you.`
              : `${attention} of ${inbox.threads.length} threads need attention.`}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5">
          {inbox.error !== null ? (
            <div
              data-testid="inbox-error"
              className="flex items-center gap-2 rounded-md border border-error/40 bg-error-surface px-3 py-2 text-xs text-error-foreground"
            >
              <span className="min-w-0 flex-1">{inbox.error}</span>
              <Button size="sm" variant="outline" onClick={() => void refreshInbox()}>
                Retry
              </Button>
            </div>
          ) : null}

          {groups.map((group) => (
            <section
              key={group.reason}
              data-testid={'inbox-group-' + group.reason}
              aria-label={group.label}
            >
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <h2 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </h2>
                <span className="text-2xs tabular-nums text-muted-foreground/70">
                  {group.threads.length}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {group.threads.map((thread) => (
                  <InboxRow key={thread.threadId} thread={thread} />
                ))}
              </div>
            </section>
          ))}

          {inbox.threads.length === 0 ? (
            inbox.loading ? (
              <div className="flex justify-center py-10">
                <Spinner size="sm" label="Loading threads" />
              </div>
            ) : (
              <EmptyState
                icon={Inbox}
                title="Nothing needs you"
                description="Running agents will appear here when they need input, fail, or go quiet."
              />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function InboxRow({ thread }: { thread: DashboardThread }) {
  const rpc = useRpc();
  const [resolving, setResolving] = useState<string | null>(null);
  const reason = inboxReason(thread);
  const approval = thread.pendingApprovals[0];

  async function decide(approvalId: string, choice: ApprovalChoice): Promise<void> {
    if (resolving !== null) return;
    setResolving(approvalId);
    try {
      await rpc.request('threads.approve', {
        threadId: thread.threadId,
        approvalId,
        decision: choice,
      });
      await refreshInbox();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send the approval decision.');
      // The server may have moved the thread anyway (a dead run is marked failed).
      await refreshInbox();
    } finally {
      setResolving(null);
    }
  }

  return (
    <div
      data-testid="inbox-row"
      data-thread-id={thread.threadId}
      data-reason={reason}
      className={cn(
        'flex items-center gap-2 rounded-md border border-transparent pr-2',
        'transition-colors duration-150 hover:border-border hover:bg-muted/40',
      )}
    >
      <Link
        to="/project/$projectId/thread/$threadId"
        params={{ projectId: thread.projectId, threadId: thread.threadId }}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-md px-3 py-2 focus-visible:outline-none"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            data-testid="inbox-project"
            className="shrink-0 text-2xs tracking-wide text-muted-foreground uppercase"
          >
            {thread.projectName}
          </span>
          <StatusChip status={thread.status} />
          <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">
            {formatRelativeTime(inboxActivityAt(thread))}
          </span>
        </div>
        <p data-testid="inbox-title" className="truncate text-sm text-foreground">
          {thread.title}
        </p>
        <p data-testid="inbox-reason" className="truncate text-xs text-muted-foreground">
          {inboxReasonLine(thread)}
        </p>
      </Link>

      {approval === undefined ? null : (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            data-testid="inbox-allow"
            size="sm"
            variant="primary"
            disabled={resolving !== null}
            onClick={() => void decide(approval.approvalId, 'allow')}
          >
            Allow
          </Button>
          <Button
            data-testid="inbox-deny"
            size="sm"
            variant="outline"
            disabled={resolving !== null}
            onClick={() => void decide(approval.approvalId, 'deny')}
          >
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

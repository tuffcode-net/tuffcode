import type { DiffFile, Thread } from '@tuffcode/contracts';
import { Button } from '@tuffcode/ui';
import { FileDiff, GitPullRequest } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { requestInspectorTab } from '../inspector/panel-requests';

export interface DiffTotals {
  files: number;
  additions: number;
  deletions: number;
}

export function diffTotals(files: readonly DiffFile[]): DiffTotals {
  return files.reduce(
    (totals, file) => ({
      files: totals.files + 1,
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

/**
 * The card under a finished turn: how much the thread changed, with Review changes
 * and Create PR. Counts come from one `diff.get` after the turn settles, so they are
 * the real working-tree numbers, not a sum of tool calls.
 */
export function TurnSummary({ thread }: { thread: Thread }) {
  const rpc = useRpc();
  const [totals, setTotals] = useState<DiffTotals | null>(null);
  const [creating, setCreating] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const settled = thread.status !== 'running' && thread.status !== 'needs-approval';

  useEffect(() => {
    if (!settled || thread.worktreePath === null) return;
    let cancelled = false;
    void rpc.request('diff.get', { threadId: thread.id }).then(
      (result) => {
        if (!cancelled) setTotals(diffTotals(result.files));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, settled, thread.id, thread.lastSeq, thread.worktreePath]);

  if (!settled || totals === null || totals.files === 0) return null;

  async function createPr(): Promise<void> {
    setCreating(true);
    setPrError(null);
    try {
      const result = await rpc.request('git.pr', {
        threadId: thread.id,
        title: thread.title,
        body: `Changes from the Tuffcode chat "${thread.title}".`,
        draft: true,
      });
      toast.success(`Draft pull request #${result.number} opened.`);
      window.tuffcode?.openExternal?.(result.url);
    } catch (error) {
      setPrError(error instanceof Error ? error.message : 'Could not open the pull request.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      data-testid="turn-summary"
      className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1 rounded-lg border border-border bg-card/60 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <FileDiff aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 text-xs text-foreground">
          {totals.files} {totals.files === 1 ? 'file' : 'files'} changed{' '}
          <span className="tabular-nums text-success-foreground">+{totals.additions}</span>{' '}
          <span className="tabular-nums text-error-foreground">-{totals.deletions}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => requestInspectorTab('diff')} data-testid="turn-summary-review">
          Review changes
        </Button>
        {thread.prUrl === null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={creating || thread.branch === null}
            title={thread.branch === null ? 'Pull requests need a worktree branch.' : undefined}
            onClick={() => void createPr()}
            data-testid="turn-summary-pr"
          >
            <GitPullRequest className="size-3.5" strokeWidth={1.75} />
            Create PR
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => window.tuffcode?.openExternal?.(thread.prUrl ?? '')}>
            <GitPullRequest className="size-3.5" strokeWidth={1.75} />
            View PR
          </Button>
        )}
      </div>
      {prError === null ? null : (
        <p role="alert" data-testid="turn-summary-error" className="px-7 text-2xs text-error">
          {prError}
        </p>
      )}
    </div>
  );
}

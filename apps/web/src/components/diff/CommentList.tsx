import type { ReviewComment } from '@tuffcode/contracts';
import { IconButton, cn } from '@tuffcode/ui';
import { Check, Undo2 } from 'lucide-react';

export interface CommentListProps {
  comments: readonly ReviewComment[];
  /** Files present in the current diff; only those can be jumped to. */
  knownPaths: ReadonlySet<string>;
  busyId: string | null;
  onResolve: (comment: ReviewComment) => void;
  onSelectFile: (path: string) => void;
  className?: string;
}

function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return comments.toSorted((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    const byPath = a.filePath.localeCompare(b.filePath);
    if (byPath !== 0) return byPath;
    if (a.line !== b.line) return a.line - b.line;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Thread review comments, newest first per file, with a resolve toggle. */
export function CommentList({
  comments,
  knownPaths,
  busyId,
  onResolve,
  onSelectFile,
  className,
}: CommentListProps) {
  if (comments.length === 0) {
    return (
      <p className={cn('px-3 py-3 text-xs leading-5 text-muted-foreground', className)}>
        No comments yet. Hover a line in the diff and press the comment button to add one.
      </p>
    );
  }

  return (
    <ul aria-label="Review comments" className={cn('divide-y divide-border', className)}>
      {sortComments(comments).map((comment) => {
        const jumpable = knownPaths.has(comment.filePath);
        const anchor = (
          <>
            <span className="truncate font-mono">{comment.filePath}</span>
            <span className="shrink-0 tabular-nums">:{comment.line}</span>
            <span className="shrink-0">{comment.side === 'old' ? 'old' : 'new'}</span>
          </>
        );
        const anchorClassName =
          'flex min-w-0 items-center gap-1 self-start rounded-sm text-2xs text-muted-foreground';
        return (
          <li key={comment.id} className="flex items-start gap-2 px-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {jumpable ? (
                <button
                  type="button"
                  title={comment.filePath}
                  onClick={() => onSelectFile(comment.filePath)}
                  className={cn(
                    anchorClassName,
                    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    'hover:text-foreground',
                  )}
                >
                  {anchor}
                </button>
              ) : (
                <span className={anchorClassName} title={`${comment.filePath} is not in this diff`}>
                  {anchor}
                </span>
              )}
              <p
                className={cn(
                  'text-xs leading-5 break-words whitespace-pre-wrap',
                  comment.resolved ? 'text-muted-foreground line-through' : 'text-foreground',
                )}
              >
                {comment.body}
              </p>
              {!comment.resolved && comment.deliveredAt !== null ? (
                <span
                  className="self-start rounded-sm border border-border px-1 text-2xs text-muted-foreground"
                  title="A turn already carried this comment to the agent. It is not repeated."
                >
                  Sent
                </span>
              ) : null}
            </div>
            <IconButton
              icon={comment.resolved ? Undo2 : Check}
              label={comment.resolved ? 'Reopen comment' : 'Resolve comment'}
              size="sm"
              disabled={busyId === comment.id}
              onClick={() => onResolve(comment)}
            />
          </li>
        );
      })}
    </ul>
  );
}

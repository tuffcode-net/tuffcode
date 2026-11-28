import type { Checkpoint, DiffFile, ReviewComment, ReviewCommentSide } from '@tuffcode/contracts';
import {
  Button,
  DiffViewer,
  EmptyState,
  IconButton,
  Select,
  Spinner,
  Textarea,
  cn,
  type DiffLineComment,
  type DiffLineContext,
} from '@tuffcode/ui';
import {
  FileDiff,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import { DIFF_LINE_MENU, type ActionContext } from '../actions';
import { useActionPorts } from '../menu/action-context';
import { useMenu } from '../menu/Menu';
import { CommentList } from './CommentList';
import { FileTree } from './FileTree';
import {
  DIFF_STATUS_META,
  WORKING_TREE_CHECKPOINT,
  buildDiffTree,
  checkpointIdFromValue,
  checkpointValue,
  diffRequestKey,
  readFileTreeCollapsed,
  shouldApplyDiffResponse,
  summarizeDiff,
  validateCommentDraft,
  writeFileTreeCollapsed,
} from './diff-model';

export interface DiffPanelProps {
  threadId: string;
  /** Switches to the terminal tab and cds to the file's directory. */
  onOpenInTerminal?: (path: string) => void;
}

interface CommentAnchor {
  path: string;
  line: number;
  side: ReviewCommentSide;
}

function noPreviewDescription(file: DiffFile): string {
  if (file.binary) return 'This file is binary, so there is no text diff to render.';
  if (file.patch === null) {
    return 'This patch is too large to render. Open the file in the editor instead.';
  }
  return 'This change has no text hunks to render.';
}

/**
 * Review panel for one thread: changed files grouped by directory, the selected
 * file through the design system diff viewer, inline comments, and a checkpoint
 * selector that rebases the diff.
 */
export function DiffPanel({ threadId, onOpenInTerminal }: DiffPanelProps) {
  return <DiffPanelBody key={threadId} threadId={threadId} onOpenInTerminal={onOpenInTerminal} />;
}

function DiffPanelBody({ threadId, onOpenInTerminal }: DiffPanelProps) {
  const rpc = useRpc();
  const menu = useMenu();
  const ports = useActionPorts();
  const theme = useAppStore((state) => state.settings?.theme);

  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [savingCheckpoint, setSavingCheckpoint] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState(() =>
    readFileTreeCollapsed(typeof window === 'undefined' ? null : window.localStorage),
  );

  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);

  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const [draft, setDraft] = useState<CommentAnchor | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savingComment, setSavingComment] = useState(false);

  const activeKeyRef = useRef('');

  useEffect(() => {
    const key = diffRequestKey(threadId, checkpointId);
    activeKeyRef.current = key;
    let cancelled = false;
    setLoading(true);
    setError(null);

    rpc
      .request('diff.get', checkpointId === null ? { threadId } : { threadId, checkpointId })
      .then((result) => {
        if (cancelled || !shouldApplyDiffResponse(activeKeyRef.current, key)) return;
        setFiles(result.files);
      })
      .catch((caught: unknown) => {
        if (cancelled || !shouldApplyDiffResponse(activeKeyRef.current, key)) return;
        setError(caught instanceof Error ? caught.message : 'Could not load the diff.');
      })
      .finally(() => {
        if (cancelled || !shouldApplyDiffResponse(activeKeyRef.current, key)) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, checkpointId, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    setCheckpointError(null);

    rpc
      .request('checkpoints.list', { threadId })
      .then((result) => {
        if (!cancelled) setCheckpoints(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setCheckpoints([]);
        setCheckpointError(
          caught instanceof Error ? caught.message : 'Could not load the checkpoints.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    setCommentsError(null);

    rpc
      .request('comments.list', { threadId })
      .then((result) => {
        if (cancelled) return;
        setComments((previous) => {
          const byId = new Map(previous.map((comment) => [comment.id, comment]));
          for (const comment of result) byId.set(comment.id, comment);
          return [...byId.values()];
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setComments([]);
        setCommentsError(caught instanceof Error ? caught.message : 'Could not load the comments.');
      });

    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, reloadToken]);

  const directories = useMemo(() => buildDiffTree(files), [files]);
  const knownPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const summary = summarizeDiff(files);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const selectedMeta = selectedFile ? DIFF_STATUS_META[selectedFile.status] : null;

  function reload(): void {
    setReloadToken((token) => token + 1);
  }

  async function saveCheckpoint(): Promise<void> {
    if (savingCheckpoint) return;
    setSavingCheckpoint(true);
    setCheckpointError(null);
    try {
      const label = `Checkpoint · ${new Date().toLocaleString()}`;
      await rpc.request('checkpoints.create', { threadId, label });
      toast.success('Checkpoint saved.');
      reload();
    } catch (caught) {
      setCheckpointError(
        caught instanceof Error ? caught.message : 'Could not save the checkpoint.',
      );
    } finally {
      setSavingCheckpoint(false);
    }
  }

  function toggleTree(): void {
    const next = !treeCollapsed;
    setTreeCollapsed(next);
    writeFileTreeCollapsed(window.localStorage, next);
  }

  function handleCheckpointChange(value: string | null): void {
    const next = checkpointIdFromValue(value);
    if (next === checkpointId) return;
    setCheckpointId(next);
    setFiles([]);
    setSelectedPath(null);
    setDraft(null);
    setError(null);
    setLoading(true);
  }

  function handleLineComment(comment: DiffLineComment): void {
    // The viewer reads the gutter from the patch's hunk headers, so the line it
    // reports is already the file's line.
    setDraft({ path: comment.path, line: comment.line, side: comment.side });
    setDraftBody('');
    setDraftError(null);
  }

  function handleLineMenu(line: DiffLineContext, point: { x: number; y: number }): void {
    const context: ActionContext = {
      ...ports,
      diffLine: line,
      ui: { addDiffComment: handleLineComment },
    };
    menu.open({
      point,
      items: DIFF_LINE_MENU,
      context,
      label: `Line ${line.line} actions`,
    });
  }

  async function handleAddComment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft) return;

    const errors = validateCommentDraft(draftBody);
    if (errors.body) {
      setDraftError(errors.body);
      return;
    }

    setSavingComment(true);
    setDraftError(null);
    try {
      const created = await rpc.request('comments.add', {
        threadId,
        filePath: draft.path,
        line: draft.line,
        side: draft.side,
        body: draftBody.trim(),
      });
      setComments((previous) => [...previous, created]);
      setDraft(null);
      setDraftBody('');
    } catch (caught) {
      setDraftError(caught instanceof Error ? caught.message : 'Could not add the comment.');
    } finally {
      setSavingComment(false);
    }
  }

  async function handleResolve(comment: ReviewComment): Promise<void> {
    setResolvingId(comment.id);
    setCommentsError(null);
    try {
      const updated = await rpc.request('comments.resolve', {
        id: comment.id,
        resolved: !comment.resolved,
      });
      setComments((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setCommentsError(caught instanceof Error ? caught.message : 'Could not resolve the comment.');
    } finally {
      setResolvingId(null);
    }
  }

  const checkpointOptions = [
    { value: WORKING_TREE_CHECKPOINT, label: 'Working tree' },
    ...checkpoints.map((checkpoint) => ({ value: checkpoint.id, label: checkpoint.label })),
  ];

  return (
    <section
      aria-label="Changes"
      data-testid="diff-panel"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <header className="flex h-[var(--row-height)] shrink-0 items-center gap-2 border-b border-border px-3">
        <FileDiff
          aria-hidden="true"
          strokeWidth={1.75}
          className="size-3.5 text-muted-foreground"
        />
        <span className="text-xs font-medium">Changes</span>
        {files.length > 0 ? (
          <span className="text-2xs tabular-nums text-muted-foreground">
            {summary.fileCount} {summary.fileCount === 1 ? 'file' : 'files'}
          </span>
        ) : null}
        {loading ? <Spinner size="sm" label="Loading diff" /> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {directories.length > 0 ? (
            <IconButton
              icon={treeCollapsed ? PanelLeftOpen : PanelLeftClose}
              label={treeCollapsed ? 'Show file list' : 'Hide file list'}
              size="sm"
              aria-pressed={!treeCollapsed}
              data-testid="diff-tree-toggle"
              onClick={toggleTree}
            />
          ) : null}
          <IconButton
            icon={RefreshCw}
            label="Refresh diff"
            size="sm"
            disabled={loading}
            onClick={reload}
          />
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-2xs text-muted-foreground">Base</span>
        <div className="w-48">
          <Select
            aria-label="Diff base"
            className="h-8 text-xs"
            options={checkpointOptions}
            value={checkpointValue(checkpointId)}
            onValueChange={handleCheckpointChange}
          />
        </div>
        <Button
          size="sm"
          variant="ghost"
          data-testid="diff-save-checkpoint"
          disabled={savingCheckpoint}
          onClick={() => void saveCheckpoint()}
        >
          Save checkpoint
        </Button>
        {files.length > 0 ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs tabular-nums">
            <span className="text-success-foreground">+{summary.additions}</span>
            <span className="text-error-foreground">-{summary.deletions}</span>
          </span>
        ) : null}
      </div>

      {checkpointError ? (
        <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-2xs text-error">
          {checkpointError}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-xs text-error">
          {error}
        </p>
      ) : null}

      {draft ? (
        <form
          onSubmit={handleAddComment}
          className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface-raised px-3 py-2"
        >
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="truncate font-mono" title={draft.path}>
              {draft.path}
            </span>
            <span className="shrink-0 tabular-nums">:{draft.line}</span>
            <span className="shrink-0">{draft.side === 'old' ? 'old line' : 'new line'}</span>
            <IconButton
              icon={X}
              label="Cancel comment"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setDraft(null);
                setDraftError(null);
              }}
            />
          </div>
          <Textarea
            id="diff-comment-body"
            rows={2}
            autoFocus
            aria-label="Review comment"
            value={draftBody}
            onChange={(event) => {
              setDraftBody(event.target.value);
              setDraftError(null);
            }}
            aria-invalid={Boolean(draftError)}
            aria-describedby={draftError ? 'diff-comment-body-error' : undefined}
            placeholder="Leave a review comment"
            className="min-h-16"
          />
          {draftError ? (
            <p id="diff-comment-body-error" role="alert" className="text-2xs text-error">
              {draftError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={savingComment}
              onClick={() => {
                setDraft(null);
                setDraftError(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={savingComment}>
              {savingComment ? 'Adding' : 'Add comment'}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {directories.length > 0 && !treeCollapsed ? (
          <FileTree
            directories={directories}
            selectedPath={selectedFile?.path ?? null}
            onSelect={setSelectedPath}
            onOpenInTerminal={onOpenInTerminal}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selectedFile ? (
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
              <span
                className="truncate font-mono text-xs text-foreground"
                title={selectedFile.path}
              >
                {selectedFile.path}
              </span>
              {selectedFile.oldPath ? (
                <span
                  className="shrink-0 truncate font-mono text-2xs text-muted-foreground"
                  title={selectedFile.oldPath}
                >
                  from {selectedFile.oldPath}
                </span>
              ) : null}
              {selectedMeta ? (
                <span className={cn('shrink-0 text-2xs', selectedMeta.className)}>
                  {selectedMeta.label}
                </span>
              ) : null}
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs tabular-nums">
                <span className="text-success-foreground">+{selectedFile.additions}</span>
                <span className="text-error-foreground">-{selectedFile.deletions}</span>
              </span>
            </div>
          ) : null}

          {selectedFile && selectedFile.patch ? (
            <div
              className="min-h-0 flex-1 overflow-y-auto p-3"
              style={
                {
                  // Long lines scroll inside the code block; the pane owns the
                  // vertical scroll so the card can size to its content.
                  '--diffs-overflow-override': 'auto',
                  '--diffs-scrollbar-gutter-override': '0px',
                } as CSSProperties
              }
            >
              <DiffViewer
                className="[&>div]:min-h-20"
                theme={theme}
                hideFileHeader
                overflow="scroll"
                files={[{ path: selectedFile.path, patch: selectedFile.patch }]}
                onLineComment={handleLineComment}
                onLineContextMenu={handleLineMenu}
              />
            </div>
          ) : selectedFile ? (
            <div className="flex min-h-0 flex-1 items-center px-3">
              <EmptyState
                variant="inline"
                title={noPreviewDescription(selectedFile)}
                className="w-full"
              />
            </div>
          ) : loading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Spinner label="Loading diff" />
            </div>
          ) : error ? null : (
            <div className="flex min-h-0 flex-1 items-center px-3">
              <EmptyState
                variant="inline"
                title={
                  checkpointId === null
                    ? 'No changes; the worktree matches HEAD.'
                    : 'Nothing changed since this checkpoint.'
                }
                action={
                  <Button size="sm" variant="secondary" onClick={reload}>
                    Refresh
                  </Button>
                }
                className="w-full"
              />
            </div>
          )}
        </div>
      </div>

      <section
        aria-label="Review comments"
        className="flex shrink-0 flex-col border-t border-border"
      >
        <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-2xs text-muted-foreground">
          <MessageSquarePlus aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
          <span>{comments.length === 1 ? '1 comment' : `${comments.length} comments`}</span>
          {commentsError ? (
            <span role="alert" className="ml-auto truncate text-error" title={commentsError}>
              {commentsError}
            </span>
          ) : null}
        </div>
        <div className="max-h-48 overflow-y-auto">
          <CommentList
            comments={comments}
            knownPaths={knownPaths}
            busyId={resolvingId}
            onResolve={(comment) => {
              void handleResolve(comment);
            }}
            onSelectFile={setSelectedPath}
          />
        </div>
      </section>
    </section>
  );
}

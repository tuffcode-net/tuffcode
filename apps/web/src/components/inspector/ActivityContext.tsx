import { Button, cn } from '@tuffcode/ui';
import { ChevronRight, FolderGit2, GitBranch, HardDrive, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import {
  CONTEXT_BAR_TONE_CLASS,
  contextBarTone,
  formatPercent,
  formatTokenCount,
  limitSourceLabel,
  usagePercent,
  type ContextUsage,
} from '../thread/context-meter';
import { ContextPanel } from './ContextPanel';

/** One hue per prompt segment, cycling through the status palette. */
const SEGMENT_TONES = ['bg-info', 'bg-warning', 'bg-success', 'bg-primary', 'bg-error', 'bg-muted-foreground'] as const;

const PERMISSION_LABEL = {
  'read-only': 'Read only',
  ask: 'Ask first',
  'accept-edits': 'Accept edits',
  'full-auto': 'Full auto',
} as const;

function useContextUsage(threadId: string): ContextUsage | null {
  const rpc = useRpc();
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  useEffect(() => {
    let disposed = false;
    setUsage(null);
    function load(): void {
      void rpc.request('threads.context', { threadId }).then(
        (result) => {
          if (disposed) return;
          setUsage({
            usedTokens: result.usedTokens,
            maxTokens: result.maxTokens,
            percent: result.percent,
            limitSource: result.limitSource,
            segments: result.segments,
          });
        },
        () => undefined,
      );
    }
    load();
    const unsubscribe = rpc.onEvent((event) => {
      if (event.type === 'context.updated' && event.payload.threadId === threadId) load();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [rpc, threadId]);
  return usage;
}

/**
 * The top of the Activity panel: where the thread runs and how full its context is.
 * The colored rows split the window by prompt segment, the same numbers the composer
 * meter shows, and the prompt sections expand in place instead of a separate tab.
 */
export function ActivityContext({ threadId, showPrompt }: { threadId: string; showPrompt: boolean }) {
  const rpc = useRpc();
  const thread = useAppStore((state) => state.threads[threadId]);
  const project = useAppStore((state) => state.projects.find((entry) => entry.id === thread?.projectId));
  const provider = useAppStore((state) => state.providers.find((entry) => entry.id === thread?.providerId));
  const threshold = useAppStore((state) => state.settings?.contextWarningThreshold ?? 0.8);
  const usage = useContextUsage(threadId);
  const [promptOpen, setPromptOpen] = useState(showPrompt);
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    if (showPrompt) setPromptOpen(true);
  }, [showPrompt]);

  if (thread === undefined) return null;
  const percent = usage === null ? 0 : usagePercent(usage);
  const segments = usage?.segments.filter((segment) => segment.tokens > 0) ?? [];
  const free = usage === null ? 0 : Math.max(0, usage.maxTokens - usage.usedTokens);

  async function compact(): Promise<void> {
    setCompacting(true);
    try {
      await rpc.request('threads.send', { id: threadId, text: '/compact' });
      toast.success('Compacting the conversation.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not compact the conversation.');
    } finally {
      setCompacting(false);
    }
  }

  const rows: { icon: typeof HardDrive; label: string; value: string; title?: string }[] = [
    { icon: FolderGit2, label: 'Project', value: project?.name ?? 'Unknown', title: project?.path },
    {
      icon: HardDrive,
      label: 'Worktree',
      value: thread.worktreePath === null ? 'None' : (thread.worktreePath.split(/[\\/]/).at(-1) ?? thread.worktreePath),
      ...(thread.worktreePath === null ? {} : { title: thread.worktreePath }),
    },
    { icon: GitBranch, label: 'Branch', value: thread.branch ?? 'Project checkout' },
    { icon: ShieldCheck, label: 'Permissions', value: PERMISSION_LABEL[thread.permissionMode] },
    {
      icon: Sparkles,
      label: 'Model',
      value: `${provider?.label ?? 'Provider'} / ${thread.modelId}${thread.reasoningEffort === null ? '' : ` (${thread.reasoningEffort === 'none' ? 'off' : thread.reasoningEffort})`}`,
    },
  ];

  return (
    <div data-testid="activity-context" className="flex flex-col gap-2">
      <section aria-label="Environment" className="flex flex-col gap-0.5">
        <h3 className="px-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">Environment</h3>
        {rows.map((row) => (
          <div key={row.label} className="flex h-7 min-w-0 items-center gap-2 px-1.5 text-xs">
            <row.icon aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="w-20 shrink-0 text-muted-foreground">{row.label}</span>
            <span className="min-w-0 flex-1 truncate text-foreground" title={row.title ?? row.value}>
              {row.value}
            </span>
          </div>
        ))}
      </section>

      {usage === null ? null : (
        <section aria-label="Context" data-testid="activity-context-usage" className="flex flex-col gap-1 px-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">Context</h3>
            <span className="text-2xs tabular-nums text-muted-foreground" title={limitSourceLabel(usage.limitSource)}>
              {formatTokenCount(usage.usedTokens)} / {formatTokenCount(usage.maxTokens)}
            </span>
          </div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium text-foreground">{formatPercent(percent)} used</span>
            <span className="text-2xs text-muted-foreground">{formatTokenCount(free)} free</span>
          </div>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${formatPercent(percent)} of the context window used`}>
            {segments.map((segment, index) => (
              <span
                key={segment.name}
                className={cn('h-full', SEGMENT_TONES[index % SEGMENT_TONES.length])}
                style={{ width: `${Math.min(100, (segment.tokens / usage.maxTokens) * 100)}%` }}
              />
            ))}
            {segments.length === 0 ? (
              <span
                className={cn('h-full', CONTEXT_BAR_TONE_CLASS[contextBarTone(percent, threshold)])}
                style={{ width: `${Math.min(100, percent * 100)}%` }}
              />
            ) : null}
          </div>
          <ul className="mt-1 flex flex-col">
            {segments.map((segment, index) => (
              <li key={segment.name} className="flex h-6 items-center gap-2 text-2xs">
                <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-sm', SEGMENT_TONES[index % SEGMENT_TONES.length])} />
                <span className="min-w-0 flex-1 truncate text-foreground">{segment.name}</span>
                <span className="tabular-nums text-muted-foreground">{formatTokenCount(segment.tokens)}</span>
                <span className="w-10 text-right tabular-nums text-muted-foreground">
                  {formatPercent(segment.tokens / usage.maxTokens)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              aria-expanded={promptOpen}
              data-testid="activity-prompt-toggle"
              onClick={() => setPromptOpen((open) => !open)}
              className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn('size-3 transition-transform', promptOpen ? 'rotate-90' : '')} strokeWidth={1.75} />
              Prompt sections
            </button>
            <Button size="sm" variant="outline" disabled={compacting || thread.status === 'running'} onClick={() => void compact()}>
              Compact session
            </Button>
          </div>
        </section>
      )}

      {promptOpen ? (
        <div className="max-h-96 overflow-hidden rounded-md border border-border">
          <ContextPanel threadId={threadId} />
        </div>
      ) : null}
    </div>
  );
}

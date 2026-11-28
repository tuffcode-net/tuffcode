import { useNavigate } from '@tanstack/react-router';
import type { Project, RpcResult, Thread } from '@tuffcode/contracts';
import { Button, DialogContent, DialogRoot, DialogTitle, Input, Kbd, cn } from '@tuffcode/ui';
import { FolderGit2, MessageSquare, Search, TextSearch } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';

export interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SearchHit =
  | { kind: 'chat'; key: string; thread: Thread; project: Project | undefined }
  | { kind: 'project'; key: string; project: Project; firstThread: Thread | undefined }
  | { kind: 'message'; key: string; hit: RpcResult<'threads.search'>[number] };

const LOCAL_LIMIT = 8;
const DEBOUNCE_MS = 200;

/**
 * The sidebar's Search: chats and projects match locally as you type, and message
 * text is searched on the server after a short pause. Arrow keys move, Enter opens,
 * Escape closes.
 */
export function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const rpc = useRpc();
  const navigate = useNavigate();
  const projects = useAppStore((state) => state.projects);
  const threads = useAppStore((state) => state.threads);
  const setActiveThread = useAppStore((state) => state.setActiveThread);
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<RpcResult<'threads.search'>>([]);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setRemote([]);
      setRemoteError(null);
      setSearchAttempt(0);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const needle = query.trim();
    setRemoteError(null);
    // The next query's hits replace the previous ones instead of describing them.
    setRemote([]);
    if (needle.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void rpc.request('threads.search', { query: needle, limit: 20 }).then(
        (hits) => {
          if (!cancelled) setRemote(hits);
        },
        (caught: unknown) => {
          if (cancelled) return;
          setRemote([]);
          setRemoteError(
            caught instanceof Error ? caught.message : 'Could not search messages.',
          );
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, rpc, searchAttempt]);

  const hits = useMemo<SearchHit[]>(() => {
    const needle = query.trim().toLowerCase();
    const all = Object.values(threads)
      .filter((thread) => thread.parentThreadId === null)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const byProject = new Map(projects.map((project) => [project.id, project]));
    const chats = all
      .filter((thread) => needle.length === 0 || thread.title.toLowerCase().includes(needle))
      .slice(0, LOCAL_LIMIT)
      .map((thread): SearchHit => ({ kind: 'chat', key: `chat:${thread.id}`, thread, project: byProject.get(thread.projectId) }));
    const projectHits =
      needle.length === 0
        ? []
        : projects
            .filter((project) => project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle))
            .slice(0, 5)
            .map(
              (project): SearchHit => ({
                kind: 'project',
                key: `project:${project.id}`,
                project,
                firstThread: all.find((thread) => thread.projectId === project.id),
              }),
            );
    const shown = new Set(chats.map((hit) => (hit.kind === 'chat' ? hit.thread.id : '')));
    const messages = remote
      .filter((hit) => hit.matchedIn === 'message' && !shown.has(hit.threadId))
      .map((hit): SearchHit => ({ kind: 'message', key: `message:${hit.threadId}`, hit }));
    return [...chats, ...projectHits, ...messages];
  }, [projects, query, remote, threads]);

  useEffect(() => {
    setActive((index) => Math.min(index, Math.max(0, hits.length - 1)));
  }, [hits.length]);

  function openThread(projectId: string, threadId: string): void {
    setActiveThread(threadId);
    onOpenChange(false);
    void navigate({ to: '/project/$projectId/thread/$threadId', params: { projectId, threadId } });
  }

  function choose(hit: SearchHit | undefined): void {
    if (hit === undefined) return;
    if (hit.kind === 'chat') openThread(hit.thread.projectId, hit.thread.id);
    else if (hit.kind === 'message') openThread(hit.hit.projectId, hit.hit.threadId);
    else if (hit.firstThread !== undefined) openThread(hit.project.id, hit.firstThread.id);
    else onOpenChange(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length === 0) return;
      setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(hits[active]);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(36rem,92vw)] gap-0 p-0" data-testid="search-dialog">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search chats, projects and messages"
            aria-label="Search"
            spellCheck={false}
            data-testid="search-input"
            className="h-11 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-1">
          {remoteError !== null ? (
            <div className="flex flex-col items-center gap-2 px-3 py-3">
              <p role="alert" className="text-center text-xs text-error-foreground">
                Message search unavailable: {remoteError}
              </p>
              <Button
                size="sm"
                variant="outline"
                data-testid="search-retry"
                onClick={() => setSearchAttempt((attempt) => attempt + 1)}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {hits.length === 0 ? (
            remoteError === null ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {query.trim().length === 0 ? 'No chats yet.' : 'No matches.'}
              </p>
            ) : null
          ) : (
            <div role="listbox" aria-label="Results">
              {hits.map((hit, index) => {
                const selected = index === active;
                const Icon = hit.kind === 'chat' ? MessageSquare : hit.kind === 'project' ? FolderGit2 : TextSearch;
                const title = hit.kind === 'chat' ? hit.thread.title : hit.kind === 'project' ? hit.project.name : hit.hit.title;
                const detail =
                  hit.kind === 'chat' ? (hit.project?.name ?? '') : hit.kind === 'project' ? hit.project.path : hit.hit.snippet;
                return (
                  <button
                    key={hit.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    data-testid={`search-hit-${hit.kind}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(hit)}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left',
                      selected ? 'bg-accent' : 'hover:bg-accent/60',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-foreground" title={title}>
                        {title}
                      </span>
                      {detail.length > 0 ? (
                        <span className="truncate text-2xs text-muted-foreground" title={detail}>
                          {detail}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

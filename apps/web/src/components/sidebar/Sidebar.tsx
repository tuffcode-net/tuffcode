import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import type { Project, SubagentView, Thread } from '@tuffcode/contracts';
import { Badge, Button, Kbd, cn } from '@tuffcode/ui';
import { FolderPlus, Inbox, Plug, Plus, Search, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAddProject } from '../../hooks/use-add-project';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import { attentionCount } from '../inbox/inbox-model';
import { useInbox } from '../inbox/use-inbox';
import { requestInspectorTab } from '../inspector/panel-requests';
import { childForThread } from '../subagents/subagent-model';
import { requestThreadDelete, requestThreadRename } from '../thread/thread-dialogs';
import { NewThreadDialog } from './NewThreadDialog';
import { RemoveProjectDialog } from './RemoveProjectDialog';
import { SearchDialog } from './SearchDialog';
import { SidebarList, type SidebarItemActions } from './SidebarList';
import {
  buildSidebarItems,
  groupThreadsByProject,
  isCouncilChild,
  needsVirtualization,
  readCollapsedProjects,
  writeCollapsedProjects,
} from './sidebar-model';

export function Sidebar({ phone = false }: { phone?: boolean }) {
  const projects = useAppStore((state) => state.projects);
  const threadsById = useAppStore((state) => state.threads);
  const activeThreadId = useAppStore((state) => state.activeThreadId);
  const upsertThread = useAppStore((state) => state.upsertThread);
  const setActiveThread = useAppStore((state) => state.setActiveThread);
  const openSubagent = useAppStore((state) => state.openSubagent);

  const rpc = useRpc();
  const navigate = useNavigate();
  const router = useRouter();
  const { addProject, adding } = useAddProject();
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onPlugins = pathname === '/plugins' || pathname.startsWith('/plugins/');
  const onNeeds = pathname === '/needs' || pathname.startsWith('/needs/');
  const inbox = useInbox();
  const needsCount = attentionCount(inbox.threads);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    readCollapsedProjects(typeof window === 'undefined' ? null : window.localStorage),
  );
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [newThreadProjectId, setNewThreadProjectId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Project | null>(null);

  const groups = useMemo(
    () => groupThreadsByProject(projects, Object.values(threadsById)),
    [projects, threadsById],
  );
  const isCollapsed = useCallback((projectId: string) => collapsed.has(projectId), [collapsed]);
  const items = useMemo(() => buildSidebarItems(groups, isCollapsed), [groups, isCollapsed]);
  // The virtualizer positions rows from the desktop row heights, so the phone
  // drawer renders the whole list instead of misplacing taller rows.
  const virtual = !phone && needsVirtualization(groups);
  /** New chat preselects the project of the open thread, else the most recent project. */
  const newChatProjectId =
    (activeThreadId === null ? undefined : threadsById[activeThreadId]?.projectId) ?? projects[0]?.id ?? null;

  /** New chat opens the workspace dialog; no thread exists until the user starts one. */
  const openNewThread = useCallback((projectId: string | null) => {
    setNewThreadProjectId(projectId);
    setNewThreadOpen(true);
  }, []);

  const handleThreadCreated = useCallback(
    (thread: Thread) => {
      upsertThread(thread);
      setActiveThread(thread.id);
      void navigate({
        to: '/project/$projectId/thread/$threadId',
        params: { projectId: thread.projectId, threadId: thread.id },
      });
    },
    [navigate, setActiveThread, upsertThread],
  );

  const handleToggleProject = useCallback((projectId: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      writeCollapsedProjects(typeof window === 'undefined' ? null : window.localStorage, next);
      return next;
    });
  }, []);

  const handleSelectThread = useCallback(
    (threadId: string) => setActiveThread(threadId),
    [setActiveThread],
  );

  const handleOpenThread = useCallback(
    (thread: Thread) => {
      setActiveThread(thread.id);
      void navigate({
        to: '/project/$projectId/thread/$threadId',
        params: { projectId: thread.projectId, threadId: thread.id },
      });
    },
    [navigate, setActiveThread],
  );

  const projectPathFor = useCallback(
    (projectId: string) => projects.find((project) => project.id === projectId)?.path,
    [projects],
  );

  /**
   * A child row opens its parent thread. A live subagent also opens the child
   * pane; a council child with no live subagent shows the council board instead.
   */
  const handleOpenChild = useCallback(
    (thread: Thread, parentId: string) => {
      setActiveThread(parentId);
      void navigate({
        to: '/project/$projectId/thread/$threadId',
        params: { projectId: thread.projectId, threadId: parentId },
      });

      // Read the live children without subscribing: child frames mutate the map
      // on every token and the sidebar must not re-render for them.
      const live = childForThread(useAppStore.getState().subagents, thread.id);
      if (live !== undefined) {
        openSubagent(live.childId);
        return;
      }
      if (isCouncilChild(thread)) {
        // The inspector subscribes per thread, so let the new active thread land
        // before asking for the council tab.
        queueMicrotask(() => requestInspectorTab('council'));
      }
    },
    [navigate, openSubagent, setActiveThread],
  );

  const handleNewThread = useCallback(
    (projectId: string) => openNewThread(projectId),
    [openNewThread],
  );

  const handleRemoveProject = useCallback((project: Project) => setRemoveTarget(project), []);

  const handleProjectRemoved = useCallback(
    (project: Project) => {
      if (router.state.location.pathname.startsWith(`/project/${project.id}/`)) {
        void navigate({ to: '/' });
      }
    },
    [navigate, router],
  );

  const closeRemoveDialog = useCallback(() => setRemoveTarget(null), []);

  const actions = useMemo<SidebarItemActions>(
    () => ({
      activeThreadId,
      projectPathFor,
      onSelectThread: handleSelectThread,
      onOpenThread: handleOpenThread,
      onOpenChild: handleOpenChild,
      onRenameThread: requestThreadRename,
      onDeleteThread: requestThreadDelete,
      onToggleProject: handleToggleProject,
      onNewThread: handleNewThread,
      onRemoveProject: handleRemoveProject,
    }),
    [
      activeThreadId,
      handleNewThread,
      handleOpenChild,
      handleOpenThread,
      handleRemoveProject,
      handleSelectThread,
      handleToggleProject,
      projectPathFor,
    ],
  );

  /**
   * After a reload the store has no live child frames, so a child row could not
   * open its pane. One list of every persisted child restores the thread id to
   * child id mapping; a failed call leaves the sidebar working without panes.
   */
  useEffect(() => {
    let disposed = false;
    void rpc.request('subagents.listAll', {}).then(
      (views) => {
        if (disposed) return;
        const byThread = new Map<string, SubagentView[]>();
        for (const view of views) {
          const siblings = byThread.get(view.threadId);
          if (siblings === undefined) byThread.set(view.threadId, [view]);
          else siblings.push(view);
        }
        const { mergeSubagentViews } = useAppStore.getState();
        for (const [threadId, threadViews] of byThread) {
          mergeSubagentViews(threadId, threadViews);
        }
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [rpc]);

  // "/" outside a text field, or Ctrl+Shift+F anywhere, opens Search.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const chord = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f';
      if (!chord) {
        if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target;
        if (target instanceof HTMLElement) {
          if (target.isContentEditable) return;
          if (target.closest('input, textarea, select, [role="dialog"], .xterm')) return;
        }
      }
      event.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  const removeThreadCount = removeTarget
    ? (groups.find((group) => group.project.id === removeTarget.id)?.threads.length ?? 0)
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Workspace" data-testid="sidebar-nav" className="flex flex-col gap-0.5 px-2 pt-2 pb-1">
        <NavButton
          icon={Plus}
          label="New chat"
          testId="sidebar-new-chat"
          onClick={() => openNewThread(newChatProjectId)}
        />
        <Link
          to="/needs"
          data-testid="sidebar-needs"
          aria-current={onNeeds ? 'page' : undefined}
          className={cn(
            'flex h-11 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-150 md:h-8',
            onNeeds
              ? 'bg-sidebar-row-selected text-sidebar-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-row-hover',
          )}
        >
          <Inbox aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-sidebar-muted-foreground" />
          <span className="flex-1">Needs you</span>
          {needsCount > 0 ? (
            <Badge
              data-testid="sidebar-needs-badge"
              variant="warning"
              size="sm"
              className="min-w-4 justify-center px-1"
            >
              {needsCount}
            </Badge>
          ) : null}
        </Link>
        <NavButton
          icon={Search}
          label="Search"
          testId="sidebar-search"
          onClick={() => setSearchOpen(true)}
          trailing={<Kbd className="h-4 min-w-4 text-2xs">/</Kbd>}
        />
        <Link
          to="/plugins"
          data-testid="sidebar-plugins"
          aria-current={onPlugins ? 'page' : undefined}
          className={cn(
            'flex h-11 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-150 md:h-8',
            onPlugins
              ? 'bg-sidebar-row-selected text-sidebar-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-row-hover',
          )}
        >
          <Plug aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-sidebar-muted-foreground" />
          Plugins
        </Link>
      </nav>

      {projects.length === 0 ? <div className="min-h-0 flex-1" /> : <SidebarList items={items} virtual={virtual} actions={actions} />}

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <Button
          data-testid="sidebar-add-project"
          variant="ghost"
          size="sm"
          className="h-11 w-full justify-start text-sidebar-muted-foreground md:h-8"
          disabled={adding}
          onClick={addProject}
        >
          <FolderPlus strokeWidth={1.75} />
          Add project
        </Button>
      </div>

      <NewThreadDialog
        open={newThreadOpen}
        onOpenChange={setNewThreadOpen}
        preferredProjectId={newThreadProjectId}
        onAddProject={() => void addProject()}
        onCreated={handleThreadCreated}
      />
      <RemoveProjectDialog
        project={removeTarget}
        threadCount={removeThreadCount}
        onClose={closeRemoveDialog}
        onRemoved={handleProjectRemoved}
      />
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

function NavButton({
  icon: Icon,
  label,
  testId,
  onClick,
  disabled = false,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex h-11 items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-row-hover disabled:opacity-50 md:h-8"
    >
      <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-sidebar-muted-foreground" />
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

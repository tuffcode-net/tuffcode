import { Link, Outlet, useMatchRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Button,
  IconButton,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  buttonVariants,
  cn,
} from '@tuffcode/ui';
import { ArrowLeft, PanelLeft, Settings } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useAppStore } from '../store/app-store';
import type { ConnectionStatus } from '../types';
import { InspectorPanel } from './inspector/InspectorPanel';
import {
  EMPTY_DOCK,
  activeDockTab,
  clampDockWidth,
  closeDock,
  closeDockTab,
  loadDockState,
  openDockTab,
  saveDockWidth,
  toggleDockTab,
  visibleDockTabs,
  type DockState,
  type InspectorTab,
} from './inspector/inspector-tabs';
import { hasContextPreview, subscribePanelRequests, takeInspectorTab } from './inspector/panel-requests';
import { CommandPalette } from './menu/CommandPalette';
import { MenuProvider } from './menu/Menu';
import { useNotifications } from './notifications/use-notifications';
import { DockToolbar } from './shell/DockToolbar';
import { Sidebar } from './sidebar/Sidebar';
import { ThreadActionDialogs } from './thread/thread-action-dialogs';
import { ThreadModeSwitch } from './thread/ThreadModeSwitch';
import { shellVisibility, windowControlsInset } from './shell-layout';

const CONNECTION_META: Record<ConnectionStatus, { dot: string; label: string }> = {
  connecting: { dot: 'bg-warning', label: 'Connecting' },
  open: { dot: 'bg-success', label: 'Connected' },
  closed: { dot: 'bg-error', label: 'Disconnected' },
  'protocol-error': { dot: 'bg-error', label: 'Protocol error' },
};

/** Below this window width an open dock pushes the sidebar out instead of squeezing the chat. */
const COMPACT_WINDOW_PX = 900;

function windowWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dock, setDock] = useState<DockState>(() => loadDockState());
  const [promptRequest, setPromptRequest] = useState(0);
  const [width, setWidth] = useState(windowWidth);
  const connection = useAppStore((state) => state.connection);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const meta = CONNECTION_META[connection];
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const visibility = shellVisibility(pathname);
  const threadMatch = matchRoute({ to: '/project/$projectId/thread/$threadId' });
  const threadId = threadMatch === false ? null : threadMatch.threadId;
  const thread = useAppStore((state) => (threadId === null ? undefined : state.threads[threadId]));
  const hasThread = threadId !== null;
  const showModeSwitch = hasThread && !visibility.backToWorkspace;
  const dockTabs = visibleDockTabs(dock, thread);
  const dockActive = activeDockTab(dock, thread);
  const dockVisible = hasThread && visibility.inspector && dockTabs.length > 0;
  const dockWidth = clampDockWidth(dock.width, width);
  const compactWindow = width < COMPACT_WINDOW_PX;
  const sidebarShown = visibility.sidebar && sidebarOpen && !(compactWindow && dockVisible);

  useNotifications();

  useLayoutEffect(() => {
    const element = document.documentElement;
    const applyPlatform = (platform: string | undefined): void => {
      if (!platform) return;
      element.dataset.platform = platform;
      element.style.setProperty('--window-controls-inset', `${windowControlsInset(platform)}px`);
    };
    if (bootstrap?.platform) {
      applyPlatform(bootstrap.platform);
      return;
    }
    let cancelled = false;
    void window.tuffcode
      ?.getBootstrap()
      .then((info) => {
        if (!cancelled) applyPlatform(info.platform);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bootstrap?.platform]);

  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // A slash command or a sidebar row can ask for a panel; it opens in the dock.
  useEffect(
    () =>
      subscribePanelRequests(() => {
        const preview = hasContextPreview();
        const tab = takeInspectorTab();
        if (tab === null) return;
        setDock((current) => openDockTab(current, tab));
        if (tab === 'activity' && preview) setPromptRequest((count) => count + 1);
      }),
    [],
  );

  // A notification click asks the window to show the thread it was about.
  useEffect(() => {
    const unsubscribe = window.tuffcode?.onMenuAction?.((action) => {
      if (!action.startsWith('navigate:')) return;
      const route = action.slice('navigate:'.length);
      const match = /^\/project\/([^/]+)\/thread\/([^/]+)$/.exec(route);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        void navigate({ to: '/project/$projectId/thread/$threadId', params: { projectId: match[1], threadId: match[2] } });
      }
    });
    return () => unsubscribe?.();
  }, [navigate]);

  const toggleTab = useCallback((tab: InspectorTab) => setDock((current) => toggleDockTab(current, tab)), []);
  const openTab = useCallback((tab: InspectorTab) => setDock((current) => openDockTab(current, tab)), []);
  const closeTab = useCallback((tab: InspectorTab) => setDock((current) => closeDockTab(current, tab)), []);

  const resize = useRef<{ startX: number; startWidth: number } | null>(null);
  function startResize(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { startX: event.clientX, startWidth: dockWidth };
  }
  function moveResize(event: PointerEvent<HTMLDivElement>): void {
    const drag = resize.current;
    if (drag === null) return;
    const next = clampDockWidth(drag.startWidth + (drag.startX - event.clientX), width);
    setDock((current) => (current.width === next ? current : { ...current, width: next }));
  }
  function endResize(event: PointerEvent<HTMLDivElement>): void {
    if (resize.current === null) return;
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    saveDockWidth(dockWidth);
  }

  return (
    <MenuProvider>
      <div data-testid="app-shell" className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header
          data-testid="topbar"
          className="drag-region grid h-[var(--topbar-height)] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border"
        >
          <div className="flex min-w-0 items-center gap-2 pl-2">
            {visibility.backToWorkspace ? (
              <Link
                to="/"
                aria-label="Back to workspace"
                title="Back to workspace"
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'no-drag shrink-0')}
              >
                <ArrowLeft strokeWidth={1.75} />
              </Link>
            ) : (
              <IconButton
                icon={PanelLeft}
                label={sidebarShown ? 'Hide sidebar' : 'Show sidebar'}
                size="sm"
                aria-pressed={sidebarShown}
                className="no-drag shrink-0"
                onClick={() => {
                  if (compactWindow && dockVisible && !sidebarShown) {
                    setDock((current) => closeDock(current));
                    setSidebarOpen(true);
                    return;
                  }
                  setSidebarOpen((open) => !open);
                }}
              />
            )}
            <span className="shrink-0 text-sm font-semibold tracking-tight">Tuffcode</span>
            {visibility.backToWorkspace ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">Settings</span>
            ) : null}
          </div>

          {/* Always rendered so the three tracks never shift. The switch must stay in normal
              flow: `no-drag` is only subtracted from the draggable region for in-flow boxes, so
              an absolutely positioned wrapper leaves the topbar a caption area where a real
              click drags the window instead of pressing the control. A grid item takes z-index
              without positioning, so the cell stays above the side clusters without going
              relative. */}
          <div className="no-drag z-10 flex justify-center">
            {showModeSwitch && threadId !== null ? (
              <div className="hidden min-[900px]:flex">
                <ThreadModeSwitch threadId={threadId} />
              </div>
            ) : null}
          </div>

          <div
            className="no-drag flex min-w-0 items-center justify-end gap-1"
            style={{ paddingRight: 'calc(var(--window-controls-inset, 0px) + 1rem)' }}
          >
            {hasThread && visibility.inspector && threadId !== null ? (
              <DockToolbar
                threadId={threadId}
                activeTab={dockVisible ? dockActive : null}
                openTabs={dockTabs}
                onToggle={toggleTab}
                onOpen={openTab}
              />
            ) : null}

            <PopoverRoot>
              <PopoverTrigger
                data-testid="connection-status"
                data-status={connection}
                title={meta.label}
                aria-label={`Connection: ${meta.label}`}
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-1.5 px-2 text-2xs')}
              >
                <span aria-hidden="true" className={cn('size-2 rounded-full', meta.dot)} />
                <span className="hidden lg:inline">{meta.label}</span>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-3">
                <div className="flex flex-col gap-2" data-testid="connection-popover">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-2xs text-muted-foreground">Status</span>
                    <span className="flex items-center gap-1.5 text-xs text-foreground">
                      <span aria-hidden="true" className={cn('size-2 rounded-full', meta.dot)} />
                      {meta.label}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-2xs text-muted-foreground">Port</span>
                    <span className="text-xs tabular-nums text-foreground" data-testid="connection-port">
                      {bootstrap?.port ?? 'unknown'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-2xs text-muted-foreground">Version</span>
                    <span className="text-xs tabular-nums text-foreground" data-testid="connection-version">
                      {bootstrap?.version ?? 'unknown'}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 w-full"
                    data-testid="connection-reconnect"
                    onClick={() => window.location.reload()}
                  >
                    Reconnect
                  </Button>
                </div>
              </PopoverContent>
            </PopoverRoot>

            {visibility.backToWorkspace ? null : (
              <Link
                to="/settings/{-$section}"
                params={{}}
                aria-label="Settings"
                title="Settings"
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
              >
                <Settings strokeWidth={1.75} />
              </Link>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {sidebarShown ? (
            <aside
              aria-label="Projects and threads"
              className="flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
            >
              <Sidebar />
            </aside>
          ) : null}

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </main>

          {dockVisible && threadId !== null ? (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panels"
                tabIndex={0}
                data-testid="dock-splitter"
                className="w-1 shrink-0 cursor-col-resize touch-none bg-border transition-colors duration-150 select-none hover:bg-primary/50 focus-visible:bg-primary/40"
                onPointerDown={startResize}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onDoubleClick={() => {
                  setDock((current) => ({ ...current, width: EMPTY_DOCK.width }));
                  saveDockWidth(EMPTY_DOCK.width);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const step = event.shiftKey ? 48 : 16;
                  const next = clampDockWidth(dockWidth + (event.key === 'ArrowLeft' ? step : -step), width);
                  setDock((current) => ({ ...current, width: next }));
                  saveDockWidth(next);
                }}
              />
              <aside
                aria-label="Panels"
                data-panel=""
                data-slot="right-panel"
                data-state="open"
                data-testid="dock"
                className="flex min-h-0 shrink-0 flex-col bg-background"
                style={{ width: dockWidth }}
              >
                <InspectorPanel
                  threadId={threadId}
                  dock={dock}
                  onSelect={openTab}
                  onOpenTab={openTab}
                  onCloseTab={closeTab}
                  onCollapse={() => setDock((current) => closeDock(current))}
                  promptRequest={promptRequest}
                />
              </aside>
            </>
          ) : null}
        </div>
      </div>
      <CommandPalette />
      <ThreadActionDialogs />
    </MenuProvider>
  );
}

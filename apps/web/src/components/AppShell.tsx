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
import { ArrowLeft, PanelLeft, Settings, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
} from 'react';
import { useAppStore } from '../store/app-store';
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
import { PhoneDockMenu } from './inspector/PhoneDockMenu';
import { CommandPalette } from './menu/CommandPalette';
import { MenuProvider } from './menu/Menu';
import { useNotifications } from './notifications/use-notifications';
import { DockToolbar } from './shell/DockToolbar';
import { Sidebar } from './sidebar/Sidebar';
import { ThreadActionDialogs } from './thread/thread-action-dialogs';
import { ThreadModeSwitch } from './thread/ThreadModeSwitch';
import { CONNECTION_META } from './connection-meta';
import { shellVisibility, windowControlsInset } from './shell-layout';
import {
  COMPACT_WINDOW_PX,
  drawerInertsShell,
  isPhoneLayout,
  sidebarPresentation,
} from './sidebar/drawer-state';

function windowWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(() => !isPhoneLayout(windowWidth()));
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
  const phone = isPhoneLayout(width);
  const compactWindow = width < COMPACT_WINDOW_PX;
  const sidebar = sidebarPresentation({
    width,
    visible: visibility.sidebar,
    requestedOpen: sidebarOpen,
    dockVisible,
  });
  const sidebarShown = sidebar.mode === 'column';
  // The drawer is inert only while it is actually open; the phone layout itself must
  // leave the conversation interactive when the drawer is closed.
  const drawerOpen = drawerInertsShell(sidebar);
  const drawerRef = useRef<HTMLElement | null>(null);

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

  // The phone drawer covers the conversation, so a route change dismisses it.
  useEffect(() => {
    if (phone) setSidebarOpen(false);
  }, [pathname, phone]);

  // Escape backs out of the phone overlays: the drawer first, then the dock sheet.
  // A dialog keeps its own Escape handling, so an open one wins.
  useEffect(() => {
    if (!phone) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[role="dialog"]') !== null &&
        target.closest('[data-drawer]') === null
      ) {
        return;
      }
      if (drawerOpen) {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }
      if (dockVisible) {
        event.preventDefault();
        setDock((current) => closeDock(current));
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dockVisible, drawerOpen, phone]);

  // Opening the drawer moves focus into it; closing returns it to the toggle.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.querySelector<HTMLElement>('button, a[href], [tabindex="0"]')?.focus();
    return () => previous?.focus();
  }, [drawerOpen]);

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

  /**
   * One toggle serves both presentations: a phone flips the overlay drawer, while a
   * compact desktop window makes room by closing the dock before showing the column.
   */
  function toggleSidebar(): void {
    if (drawerOpen) {
      setSidebarOpen((open) => !open);
      return;
    }
    if (compactWindow && dockVisible && !sidebarShown) {
      setDock((current) => closeDock(current));
      setSidebarOpen(true);
      return;
    }
    setSidebarOpen((open) => !open);
  }

  /** Keeps Tab inside the modal drawer, as the modal dialog pattern requires. */
  function trapDrawerFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Tab' || drawerRef.current === null) return;
    const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

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
      <div
        data-testid="app-shell"
        className="app-shell-viewport flex flex-col overflow-hidden bg-background text-foreground"
      >
        <header
          data-testid="topbar"
          inert={drawerOpen}
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
                label={sidebar.open ? 'Hide sidebar' : 'Show sidebar'}
                size="sm"
                aria-pressed={sidebar.open}
                aria-expanded={sidebar.mode === 'drawer' ? sidebar.open : undefined}
                aria-controls={sidebar.mode === 'drawer' ? 'sidebar-drawer' : undefined}
                className="no-drag size-11 shrink-0 md:size-8"
                onClick={toggleSidebar}
              />
            )}
            <span className="hidden shrink-0 text-sm font-semibold tracking-tight md:inline">Tuffcode</span>
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
              phone ? (
                <PhoneDockMenu
                  threadId={threadId}
                  activeTab={dockVisible ? dockActive : null}
                  openTabs={dockTabs}
                  onToggle={toggleTab}
                />
              ) : (
                <DockToolbar
                  threadId={threadId}
                  activeTab={dockVisible ? dockActive : null}
                  openTabs={dockTabs}
                  onToggle={toggleTab}
                  onOpen={openTab}
                />
              )
            ) : null}

            <PopoverRoot>
              <PopoverTrigger
                data-testid="connection-status"
                data-status={connection}
                title={meta.label}
                aria-label={`Connection: ${meta.label}`}
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'sm' }),
                  'h-11 gap-1.5 px-2 text-2xs max-md:hidden md:h-8',
                )}
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
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'size-11 md:size-8')}
              >
                <Settings strokeWidth={1.75} />
              </Link>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1" inert={drawerOpen}>
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
            phone ? (
              <div
                data-testid="dock-sheet"
                className="fixed inset-x-0 z-30 flex flex-col border-t border-border bg-background"
                style={{
                  top: 'calc(var(--safe-area-top, 0px) + var(--topbar-height))',
                  bottom: 'var(--safe-area-bottom, 0px)',
                }}
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
              </div>
            ) : (
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
            )
          ) : null}
        </div>

        {drawerOpen ? (
          <div className="fixed inset-0 z-40" data-testid="sidebar-drawer">
            <button
              type="button"
              aria-label="Close sidebar"
              data-testid="sidebar-backdrop"
              className="absolute inset-0 bg-background/60 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
            />
            <aside
              ref={drawerRef}
              id="sidebar-drawer"
              data-drawer=""
              role="dialog"
              aria-modal="true"
              aria-label="Projects and threads"
              className="absolute inset-y-0 left-0 flex w-[min(85vw,20rem)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-xl"
              style={{
                paddingTop: 'var(--safe-area-top, 0px)',
                paddingBottom: 'var(--safe-area-bottom, 0px)',
              }}
              onKeyDown={trapDrawerFocus}
            >
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border px-3">
                <span className="text-sm font-semibold">Workspace</span>
                <IconButton
                  icon={X}
                  label="Close sidebar"
                  className="size-11"
                  onClick={() => setSidebarOpen(false)}
                />
              </div>
              <div className="min-h-0 flex-1">
                <Sidebar phone />
              </div>
            </aside>
          </div>
        ) : null}
      </div>
      <CommandPalette />
      <ThreadActionDialogs />
    </MenuProvider>
  );
}

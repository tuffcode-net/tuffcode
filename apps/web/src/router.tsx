import {
  Navigate,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { EmptyState } from '@tuffcode/ui';
import { useEffect } from 'react';
import { AppShell } from './components/AppShell';
import { EmptyWorkspace } from './components/EmptyWorkspace';
import { PaneWorkspace } from './components/panes/PaneWorkspace';
import { resolveRootView } from './components/shell-layout';
import { lazyRouteComponent } from '@tanstack/react-router';

// Routes the user is not on do not belong in the first chunk.
const InboxPage = lazyRouteComponent(() => import('./components/inbox/InboxPage'), 'InboxPage');
const PluginsPage = lazyRouteComponent(() => import('./routes/plugins/plugins-page'), 'PluginsPage');
const SettingsPage = lazyRouteComponent(
  () => import('./routes/settings/settings-page'),
  'SettingsPage',
);
import { useAppStore } from './store/app-store';

function WorkspaceIndex() {
  const projects = useAppStore((state) => state.projects);
  const threads = useAppStore((state) => state.threads);
  const activeThreadId = useAppStore((state) => state.activeThreadId);
  const view = resolveRootView({ projects, threads, activeThreadId });

  switch (view.kind) {
    case 'empty-workspace':
      return <EmptyWorkspace />;
    case 'redirect':
      return (
        <Navigate
          to="/project/$projectId/thread/$threadId"
          params={{ projectId: view.projectId, threadId: view.threadId }}
          replace
        />
      );
    case 'no-threads':
      return (
        <div className="flex h-full items-center justify-center p-6">
          <EmptyState
            title="No threads yet"
            description="Create a thread from the sidebar to start a conversation."
            className="w-full max-w-md"
          />
        </div>
      );
  }
}

function ThreadRoute() {
  const { projectId, threadId } = threadRoute.useParams();
  const thread = useAppStore((state) => state.threads[threadId]);
  const projectName = useAppStore(
    (state) => state.projects.find((project) => project.id === projectId)?.name,
  );
  const setActiveThread = useAppStore((state) => state.setActiveThread);

  useEffect(() => {
    setActiveThread(threadId);
  }, [setActiveThread, threadId]);

  return (
    <PaneWorkspace key={threadId} threadId={threadId} thread={thread} projectName={projectName} />
  );
}

function SettingsView() {
  const { section } = settingsRoute.useParams();

  return <SettingsPage section={section} />;
}

function NotFound() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState title="Not found" description="That route does not exist." />
    </div>
  );
}

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspaceIndex,
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$projectId/thread/$threadId',
  component: ThreadRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/{-$section}',
  component: SettingsView,
});

const pluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plugins',
  component: PluginsPage,
});

const needsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/needs',
  component: InboxPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  threadRoute,
  settingsRoute,
  pluginsRoute,
  needsRoute,
]);

/**
 * The packaged renderer loads `file:///.../index.html?port=…`, so the browser
 * pathname is the HTML file, never `/`. Hash history keeps the route in the URL
 * fragment and leaves the file path alone; dev builds over http keep real paths.
 */
function shellHistory() {
  if (typeof window === 'undefined') return undefined;
  return window.location.protocol === 'file:' ? createHashHistory() : undefined;
}

const history = shellHistory();

export const router = createRouter({ routeTree, ...(history ? { history } : {}) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

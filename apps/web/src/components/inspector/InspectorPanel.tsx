import { IconButton, cn } from '@tuffcode/ui';
import { PanelRightClose, X } from 'lucide-react';
import { Suspense, lazy, useEffect, useState } from 'react';
import { useAppStore } from '../../store/app-store';
import { requestTerminalAt } from '../terminal/terminal-requests';
import { ActivityPanel } from './ActivityPanel';
import {
  INSPECTOR_TAB_LABEL,
  activeDockTab,
  visibleDockTabs,
  type DockState,
  type InspectorTab,
} from './inspector-tabs';

// The heavy panels load the first time their tab is opened: the diff viewer, the
// terminal and the browser keep their own dependencies out of the initial chunk.
const DiffPanel = lazy(() =>
  import('../diff/DiffPanel').then((module) => ({ default: module.DiffPanel })),
);
const FilesPanel = lazy(() =>
  import('../files/FilesPanel').then((module) => ({ default: module.FilesPanel })),
);
const TerminalPanel = lazy(() =>
  import('../terminal/TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);
const BrowserPane = lazy(() =>
  import('../browser/BrowserPane').then((module) => ({ default: module.BrowserPane })),
);
const BrainPanel = lazy(() =>
  import('./BrainPanel').then((module) => ({ default: module.BrainPanel })),
);
const CouncilPanel = lazy(() =>
  import('./CouncilPanel').then((module) => ({ default: module.CouncilPanel })),
);

/** Keeps the dock from collapsing while a panel chunk loads. */
function PanelFallback() {
  return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading</div>;
}

export interface InspectorPanelProps {
  threadId: string;
  dock: DockState;
  onSelect: (tab: InspectorTab) => void;
  onCloseTab: (tab: InspectorTab) => void;
  onOpenTab: (tab: InspectorTab) => void;
  /** Closes every panel and hides the dock. */
  onCollapse: () => void;
  /** Bumped by `/context` so Activity opens its prompt sections. */
  promptRequest: number;
}

/**
 * The right dock's body: one strip of the panels the user opened, each closable, and
 * the front panel below it. A panel mounts the first time it is shown and stays
 * mounted while its tab is open, so a terminal or an unsaved comment survives a tab
 * switch; closing the tab unmounts it.
 */
export function InspectorPanel({
  threadId,
  dock,
  onSelect,
  onCloseTab,
  onOpenTab,
  onCollapse,
  promptRequest,
}: InspectorPanelProps) {
  const thread = useAppStore((state) => state.threads[threadId]);
  const tabs = visibleDockTabs(dock, thread);
  const active = activeDockTab(dock, thread);
  const [mounted, setMounted] = useState<readonly InspectorTab[]>(() => (active === null ? [] : [active]));

  useEffect(() => {
    setMounted((current) => {
      const kept = current.filter((tab) => tabs.includes(tab));
      if (active !== null && !kept.includes(active)) kept.push(active);
      return kept.length === current.length && kept.every((tab, index) => tab === current[index]) ? current : kept;
    });
  }, [active, tabs]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="inspector">
      <div
        data-testid="inspector-header"
        role="tablist"
        aria-label="Panels"
        className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border pr-1 pl-1.5 md:h-[var(--row-height)]"
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab}
              className={cn(
                'group flex h-11 shrink-0 items-center rounded-md text-xs transition-colors md:h-7',
                tab === active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === active}
                data-testid={`inspector-tab-${tab}`}
                onClick={() => onSelect(tab)}
                className="h-11 pl-2 pr-1 md:h-7"
              >
                {INSPECTOR_TAB_LABEL[tab]}
              </button>
              <button
                type="button"
                aria-label={`Close ${INSPECTOR_TAB_LABEL[tab]}`}
                data-testid={`inspector-tab-close-${tab}`}
                onClick={() => onCloseTab(tab)}
                className="mr-1 flex size-11 items-center justify-center rounded-sm opacity-60 hover:bg-background/60 hover:opacity-100 md:size-4"
              >
                <X className="size-4 md:size-3" strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
        <IconButton
          icon={PanelRightClose}
          label="Close panels"
          size="sm"
          className="size-11 shrink-0 md:size-8"
          data-testid="inspector-collapse"
          onClick={onCollapse}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {mounted.map((tab) => (
          <div key={tab} className={cn('absolute inset-0 flex min-h-0 flex-col', tab === active ? '' : 'hidden')}>
            <Suspense fallback={<PanelFallback />}>
            <DockBody
              tab={tab}
              threadId={threadId}
              projectId={thread?.projectId ?? null}
              promptRequest={promptRequest}
              onOpenInTerminal={(path) => {
                onOpenTab('terminal');
                requestTerminalAt(path);
              }}
            />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}

function DockBody({
  tab,
  threadId,
  projectId,
  promptRequest,
  onOpenInTerminal,
}: {
  tab: InspectorTab;
  threadId: string;
  projectId: string | null;
  promptRequest: number;
  onOpenInTerminal: (path: string) => void;
}) {
  switch (tab) {
    case 'activity':
      return <ActivityPanel key={threadId} threadId={threadId} showPrompt={promptRequest > 0} />;
    case 'files':
      return <FilesPanel key={threadId} threadId={threadId} onOpenInTerminal={onOpenInTerminal} />;
    case 'diff':
      return <DiffPanel key={threadId} threadId={threadId} onOpenInTerminal={onOpenInTerminal} />;
    case 'terminal':
      return <TerminalPanel key={threadId} threadId={threadId} />;
    case 'browser':
      return <BrowserPane />;
    case 'brain':
      return <BrainPanel key={threadId} threadId={threadId} projectId={projectId} />;
    case 'council':
      return <CouncilPanel key={threadId} threadId={threadId} />;
  }
}

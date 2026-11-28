import type { Thread } from '@tuffcode/contracts';
import { EmptyState } from '@tuffcode/ui';
import {
  Bot,
  Brain,
  FileDiff,
  FolderTree,
  Globe,
  MessageSquare,
  MessagesSquare,
  SquareTerminal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Suspense, lazy, useRef, type RefObject } from 'react';
import { BrowserPane } from '../browser/BrowserPane';
import { FilesPanel } from '../files/FilesPanel';
import { useAppStore } from '../../store/app-store';
import { BrainPanel } from '../inspector/BrainPanel';
import { CouncilPanel } from '../inspector/CouncilPanel';
import { SubagentPane } from '../subagents/SubagentPane';
import { ThreadView } from '../thread/ThreadView';
import { sideThreadId, type FixedPaneSurface, type PaneSurface } from './pane-model';

// Surfaces a pane can show but the thread does not need: the diff viewer and the
// terminal load when a pane first shows them, keeping xterm and @pierre/diffs out of
// the initial chunk.
const DiffPanel = lazy(() =>
  import('../diff/DiffPanel').then((module) => ({ default: module.DiffPanel })),
);
const TerminalPanel = lazy(() =>
  import('../terminal/TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);

export const PANE_SURFACE_ICON: Record<FixedPaneSurface, LucideIcon> = {
  thread: MessagesSquare,
  diff: FileDiff,
  files: FolderTree,
  terminal: SquareTerminal,
  browser: Globe,
  brain: Brain,
  council: Users,
  subagent: Bot,
};

export function paneSurfaceIcon(surface: PaneSurface): LucideIcon {
  return sideThreadId(surface) === null ? PANE_SURFACE_ICON[surface as FixedPaneSurface] : MessageSquare;
}

export interface PaneSurfaceViewProps {
  surface: PaneSurface;
  threadId: string;
  thread?: Thread;
  projectName?: string;
  /** Shared with the thread surface so a subagent pane can draw its connector. */
  threadStageRef: RefObject<HTMLDivElement | null>;
  /** The row already hosts a subagent surface, so the thread keeps cards only. */
  externalSubagentPane: boolean;
  onOpenInTerminal(path: string): void;
  onCloseSubagent(): void;
}

/**
 * One pane surface. Every branch is the shipped panel, not a copy: the thread
 * timeline, diff review, terminal, brain graph, council board and subagent pane.
 */
export function PaneSurfaceView({
  surface,
  threadId,
  thread,
  projectName,
  threadStageRef,
  externalSubagentPane,
  onOpenInTerminal,
  onCloseSubagent,
}: PaneSurfaceViewProps) {
  const side = sideThreadId(surface);
  if (side !== null) return <SideChat threadId={side} />;
  switch (surface) {
    case 'thread':
      return (
        <ThreadView
          threadId={threadId}
          thread={thread}
          projectName={projectName}
          stageRef={threadStageRef}
          externalSubagentPane={externalSubagentPane}
        />
      );
    case 'diff':
      return (
        <Suspense fallback={null}>
          <DiffPanel threadId={threadId} onOpenInTerminal={onOpenInTerminal} />
        </Suspense>
      );
    case 'files':
      return <FilesPanel threadId={threadId} onOpenInTerminal={onOpenInTerminal} />;
    case 'browser':
      return <BrowserPane />;
    case 'terminal':
      return (
        <Suspense fallback={null}>
          <TerminalPanel threadId={threadId} />
        </Suspense>
      );
    case 'brain':
      return <BrainPanel threadId={threadId} projectId={thread?.projectId ?? null} />;
    case 'council':
      return <CouncilPanel threadId={threadId} />;
    case 'subagent':
      return <SubagentSurface threadId={threadId} onClose={onCloseSubagent} />;
  }
}

/** Another chat beside the route's thread, with its own timeline and composer. */
function SideChat({ threadId }: { threadId: string }) {
  const thread = useAppStore((state) => state.threads[threadId]);
  const projectName = useAppStore(
    (state) => state.projects.find((project) => project.id === thread?.projectId)?.name,
  );
  const stageRef = useRef<HTMLDivElement | null>(null);
  if (thread === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState title="Chat not found" description="It may have been deleted." className="w-full max-w-sm" />
      </div>
    );
  }
  return (
    <ThreadView
      threadId={threadId}
      thread={thread}
      projectName={projectName}
      stageRef={stageRef}
      externalSubagentPane={false}
    />
  );
}

interface SubagentSurfaceProps {
  threadId: string;
  onClose(): void;
}

/** The subagent pane fills its split pane instead of docking to the thread row. */
function SubagentSurface({ threadId, onClose }: SubagentSurfaceProps) {
  const hasChild = useAppStore((state) =>
    Object.values(state.subagents).some((child) => child.threadId === threadId),
  );
  const theme = useAppStore((state) => state.settings?.theme ?? 'dark');
  const selectSubagent = useAppStore((state) => state.selectSubagent);

  if (!hasChild) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <EmptyState
          title="No subagent yet"
          description="Run /subagent <type> <task> in the composer, or wait for the agent to spawn one, and its timeline appears here."
          className="w-full max-w-sm"
        />
      </div>
    );
  }

  return (
    <SubagentPane
      threadId={threadId}
      theme={theme}
      onSelect={selectSubagent}
      onClose={onClose}
      variant="pane"
    />
  );
}

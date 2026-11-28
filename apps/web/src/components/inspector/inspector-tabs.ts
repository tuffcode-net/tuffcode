import type { Thread } from '@tuffcode/contracts';

/**
 * The right dock: the tool panels the user opened, the one in front, and the dock
 * width. Nothing is open by default, so the conversation owns the window until the
 * user asks for a panel, and closing the last tab hides the dock completely.
 */
export const INSPECTOR_TABS = [
  'activity',
  'files',
  'diff',
  'terminal',
  'browser',
  'brain',
  'council',
] as const;

export type InspectorTab = (typeof INSPECTOR_TABS)[number];

export const INSPECTOR_TAB_LABEL: Record<InspectorTab, string> = {
  activity: 'Activity',
  files: 'Files',
  diff: 'Changes',
  terminal: 'Terminal',
  browser: 'Browser',
  brain: 'Brain',
  council: 'Council',
};

export const DEFAULT_DOCK_WIDTH = 400;
export const MIN_DOCK_WIDTH = 280;
/** The conversation keeps at least this share of the window next to the dock. */
export const MAX_DOCK_RATIO = 0.6;

export interface DockState {
  tabs: InspectorTab[];
  active: InspectorTab | null;
  width: number;
}

export const EMPTY_DOCK: DockState = { tabs: [], active: null, width: DEFAULT_DOCK_WIDTH };

/** The execution mode a thread needs for the council board tab. */
export type InspectorTabThread = Pick<Thread, 'executionMode'>;

export function isInspectorTab(value: unknown): value is InspectorTab {
  return INSPECTOR_TABS.some((tab) => tab === value);
}

/** Tabs a thread may show: council only on a council thread. */
export function tabAllowed(tab: InspectorTab, thread: InspectorTabThread | undefined): boolean {
  return tab !== 'council' || thread?.executionMode === 'council';
}

/** The open tabs this thread can show, in the order they were opened. */
export function visibleDockTabs(
  state: DockState,
  thread: InspectorTabThread | undefined,
): InspectorTab[] {
  return state.tabs.filter((tab) => tabAllowed(tab, thread));
}

/** The front tab for this thread, falling back to the last visible tab. */
export function activeDockTab(
  state: DockState,
  thread: InspectorTabThread | undefined,
): InspectorTab | null {
  const visible = visibleDockTabs(state, thread);
  if (state.active !== null && visible.includes(state.active)) return state.active;
  return visible.at(-1) ?? null;
}

export function openDockTab(state: DockState, tab: InspectorTab): DockState {
  if (state.active === tab && state.tabs.includes(tab)) return state;
  return {
    ...state,
    tabs: state.tabs.includes(tab) ? state.tabs : [...state.tabs, tab],
    active: tab,
  };
}

export function closeDockTab(state: DockState, tab: InspectorTab): DockState {
  if (!state.tabs.includes(tab)) return state;
  const index = state.tabs.indexOf(tab);
  const tabs = state.tabs.filter((entry) => entry !== tab);
  const active = state.active === tab ? (tabs[Math.max(0, index - 1)] ?? null) : state.active;
  return { ...state, tabs, active };
}

/** A toolbar button: brings its panel to the front, or closes it when it already is. */
export function toggleDockTab(state: DockState, tab: InspectorTab): DockState {
  return state.active === tab && state.tabs.includes(tab)
    ? closeDockTab(state, tab)
    : openDockTab(state, tab);
}

export function closeDock(state: DockState): DockState {
  return state.tabs.length === 0 ? state : { ...state, tabs: [], active: null };
}

export function clampDockWidth(width: number, windowWidth: number): number {
  const max = Math.max(MIN_DOCK_WIDTH, Math.floor(windowWidth * MAX_DOCK_RATIO));
  if (!Number.isFinite(width)) return DEFAULT_DOCK_WIDTH;
  return Math.min(Math.max(Math.round(width), MIN_DOCK_WIDTH), max);
}

const STORAGE_KEY = 'tuffcode.dock.v1';

export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): DockStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Only the width survives a restart; panels reopen when the user asks for them. */
export function loadDockState(storage: DockStorage | null = browserStorage()): DockState {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return EMPTY_DOCK;
    const parsed: unknown = JSON.parse(raw);
    const width =
      typeof parsed === 'object' && parsed !== null && 'width' in parsed && typeof parsed.width === 'number'
        ? parsed.width
        : DEFAULT_DOCK_WIDTH;
    return { ...EMPTY_DOCK, width: Math.max(MIN_DOCK_WIDTH, Math.round(width)) };
  } catch {
    return EMPTY_DOCK;
  }
}

export function saveDockWidth(width: number, storage: DockStorage | null = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ width }));
  } catch {
    // Quota and privacy mode failures must not break the dock.
  }
}

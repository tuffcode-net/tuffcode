/**
 * Split-pane layout for the main area: a binary tree of one to four leaves. Each
 * leaf holds a strip of surfaces; the first leaf always hosts the route's thread
 * and can never be closed or moved. Other leaves may host another chat
 * (`thread:<id>`, a side chat) or a tool surface.
 *
 * Everything here is pure, so the split, drop, resize and persistence rules are
 * testable without a DOM. Split sizes are percentages along a split's own axis
 * and always sum to 100; the pixel clamp lives in `resizeSplit`.
 */

export const PANE_SURFACES = [
  'thread',
  'diff',
  'files',
  'terminal',
  'browser',
  'brain',
  'council',
  'subagent',
] as const;

export type FixedPaneSurface = (typeof PANE_SURFACES)[number];

/** A fixed tool surface, or another chat opened beside the route's thread. */
export type PaneSurface = FixedPaneSurface | `thread:${string}`;

export const PANE_SURFACE_LABEL: Record<FixedPaneSurface, string> = {
  thread: 'Thread',
  diff: 'Changes',
  files: 'Files',
  terminal: 'Terminal',
  browser: 'Browser',
  brain: 'Brain',
  council: 'Council',
  subagent: 'Subagent',
};

const SIDE_THREAD = /^thread:[A-Za-z0-9_-]{1,80}$/;

/** The drag payload a sidebar thread row carries; the pane row reads it. */
export const THREAD_DRAG_MIME = 'application/x-tuffcode-thread';

export function threadSurface(threadId: string): PaneSurface {
  return `thread:${threadId}`;
}

/** The thread id of a side-chat surface, or null for a fixed surface. */
export function sideThreadId(surface: PaneSurface): string | null {
  return surface.startsWith('thread:') ? surface.slice('thread:'.length) : null;
}

export function paneSurfaceLabel(
  surface: PaneSurface,
  titleOf: (threadId: string) => string | undefined = () => undefined,
): string {
  const side = sideThreadId(surface);
  if (side === null) return PANE_SURFACE_LABEL[surface as FixedPaneSurface];
  return titleOf(side) ?? 'Chat';
}

export const MAX_PANES = 4;
export const MIN_PANE_WIDTH_PX = 280;
export const MAX_PANE_WIDTH_RATIO = 0.7;
export const SPLITTER_WIDTH_PX = 6;
/** Below this row width the panes collapse into one leaf with tabs. */
export const NARROW_PANE_WIDTH_PX = 1100;

export interface PaneLayoutPane {
  id: string;
  /** Surfaces open in this leaf; the thread surface belongs to the first leaf. */
  tabs: PaneSurface[];
  activeTab: PaneSurface;
}

export type PaneOrientation = 'horizontal' | 'vertical';

/** A side of a leaf a drag can land on; the center drops into the leaf itself. */
export type PaneDirection = 'left' | 'right' | 'top' | 'bottom';
export type PaneDropZone = PaneDirection | 'center';

export interface PaneLeaf {
  kind: 'leaf';
  pane: PaneLayoutPane;
}

export interface PaneSplit {
  kind: 'split';
  id: string;
  orientation: PaneOrientation;
  children: [PaneNode, PaneNode];
  /** Percentages along the split's axis; they sum to 100. */
  sizes: [number, number];
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLayout {
  version: 2;
  root: PaneNode;
  focusedPaneId: string;
}

const LAYOUT_VERSION = 2;

const FIRST_PANE_ID = 'pane-1';
const LEGACY_STORAGE_VERSION = 1;

export function isPaneSurface(value: unknown): value is PaneSurface {
  return (
    typeof value === 'string' &&
    ((PANE_SURFACES as readonly string[]).includes(value) || SIDE_THREAD.test(value))
  );
}

export function leafNode(pane: PaneLayoutPane): PaneLeaf {
  return { kind: 'leaf', pane };
}

/** Every leaf in visual order: left to right, top to bottom. */
export function leavesOf(node: PaneNode): PaneLayoutPane[] {
  if (node.kind === 'leaf') return [node.pane];
  return [...leavesOf(node.children[0]), ...leavesOf(node.children[1])];
}

export function leaves(layout: PaneLayout): PaneLayoutPane[] {
  return leavesOf(layout.root);
}

export function leafCount(node: PaneNode): number {
  return node.kind === 'leaf' ? 1 : leafCount(node.children[0]) + leafCount(node.children[1]);
}

export function findLeafNode(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.pane.id === paneId ? node : null;
  return findLeafNode(node.children[0], paneId) ?? findLeafNode(node.children[1], paneId);
}

export function findPane(node: PaneNode, paneId: string): PaneLayoutPane | null {
  return findLeafNode(node, paneId)?.pane ?? null;
}

export function findSplit(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.kind === 'leaf') return null;
  if (node.id === splitId) return node;
  return findSplit(node.children[0], splitId) ?? findSplit(node.children[1], splitId);
}

export function defaultPaneLayout(): PaneLayout {
  return {
    version: LAYOUT_VERSION,
    root: leafNode({ id: FIRST_PANE_ID, tabs: ['thread'], activeTab: 'thread' }),
    focusedPaneId: FIRST_PANE_ID,
  };
}

export function paneHasSurface(layout: PaneLayout, surface: PaneSurface): boolean {
  return leaves(layout).some((pane) => pane.tabs.includes(surface));
}

export function paneIdOfSurface(layout: PaneLayout, surface: PaneSurface): string | null {
  return leaves(layout).find((pane) => pane.tabs.includes(surface))?.id ?? null;
}

/** Every open surface in visual order, deduplicated. */
export function openSurfaces(layout: PaneLayout): PaneSurface[] {
  const seen: PaneSurface[] = [];
  for (const pane of leaves(layout)) {
    for (const tab of pane.tabs) {
      if (!seen.includes(tab)) seen.push(tab);
    }
  }
  return seen;
}

/** Surfaces that are not open anywhere; the thread is never offered. */
export function availableSurfaces(layout: PaneLayout): PaneSurface[] {
  return PANE_SURFACES.filter(
    (surface) => surface !== 'thread' && !paneHasSurface(layout, surface),
  );
}

export function focusPane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.focusedPaneId === paneId || findPane(layout.root, paneId) === null) return layout;
  return { ...layout, focusedPaneId: paneId };
}

function nextPaneId(node: PaneNode): string {
  let highest = 0;
  for (const pane of leavesOf(node)) {
    const match = /^pane-(\d+)$/.exec(pane.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `pane-${highest + 1}`;
}

function splitIdsOf(node: PaneNode, into: string[] = []): string[] {
  if (node.kind === 'leaf') return into;
  into.push(node.id);
  splitIdsOf(node.children[0], into);
  splitIdsOf(node.children[1], into);
  return into;
}

function nextSplitId(node: PaneNode): string {
  let highest = 0;
  for (const id of splitIdsOf(node)) {
    const match = /^split-(\d+)$/.exec(id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `split-${highest + 1}`;
}

function orientationOf(direction: PaneDirection): PaneOrientation {
  return direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
}

function isBefore(direction: PaneDirection): boolean {
  return direction === 'left' || direction === 'top';
}

function normalizeSizes(raw: readonly unknown[]): [number, number] {
  const first = raw[0];
  const second = raw[1];
  const valid =
    typeof first === 'number' &&
    Number.isFinite(first) &&
    first > 0 &&
    typeof second === 'number' &&
    Number.isFinite(second) &&
    second > 0;
  if (!valid) return [50, 50];
  const total = (first as number) + (second as number);
  if (total <= 0) return [50, 50];
  return [((first as number) / total) * 100, ((second as number) / total) * 100];
}

/** Rebuilds the leaf with `paneId`; returns the same node when nothing changed. */
function mapLeaf(
  node: PaneNode,
  paneId: string,
  fn: (pane: PaneLayoutPane) => PaneLayoutPane,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.pane.id !== paneId) return node;
    const pane = fn(node.pane);
    return pane === node.pane ? node : leafNode(pane);
  }
  const left = mapLeaf(node.children[0], paneId, fn);
  const right = mapLeaf(node.children[1], paneId, fn);
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

/** Replaces the leaf with `paneId` with whatever `fn` builds from it. */
function replaceLeaf(
  node: PaneNode,
  paneId: string,
  fn: (leaf: PaneLeaf) => PaneNode,
): PaneNode {
  if (node.kind === 'leaf') return node.pane.id === paneId ? fn(node) : node;
  const left = replaceLeaf(node.children[0], paneId, fn);
  const right = replaceLeaf(node.children[1], paneId, fn);
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

/** Drops the leaf and promotes its sibling; null when the leaf was the whole tree. */
function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.pane.id === paneId ? null : node;
  const left = removeLeaf(node.children[0], paneId);
  const right = removeLeaf(node.children[1], paneId);
  if (left === node.children[0] && right === node.children[1]) return node;
  if (left === null) return right;
  if (right === null) return left;
  return { ...node, children: [left, right] };
}

function activeAfterRemoval(pane: PaneLayoutPane, surface: PaneSurface, tabs: PaneSurface[]): PaneSurface {
  if (pane.activeTab !== surface) return pane.activeTab;
  const index = pane.tabs.indexOf(surface);
  return tabs[Math.max(0, index - 1)] ?? tabs[0]!;
}

/**
 * Removes one surface from one leaf, closing the leaf when its last tab leaves.
 * The thread surface is refused: it belongs to the first leaf for good.
 */
function removeTabFromTree(root: PaneNode, paneId: string, surface: PaneSurface): PaneNode {
  if (surface === 'thread') return root;
  const pane = findPane(root, paneId);
  if (pane === null || !pane.tabs.includes(surface)) return root;
  const tabs = pane.tabs.filter((tab) => tab !== surface);
  if (tabs.length === 0) return removeLeaf(root, paneId) ?? root;
  const activeTab = activeAfterRemoval(pane, surface, tabs);
  return mapLeaf(root, paneId, (current) => ({ ...current, tabs, activeTab }));
}

function addTabToTree(root: PaneNode, paneId: string, surface: PaneSurface): PaneNode {
  if (surface === 'thread') return root;
  const pane = findPane(root, paneId);
  if (pane === null || pane.tabs.includes(surface)) return root;
  return mapLeaf(root, paneId, (current) => ({
    ...current,
    tabs: [...current.tabs, surface],
    activeTab: surface,
  }));
}

function withFocus(root: PaneNode, focusedPaneId: string): PaneLayout {
  const focused = findPane(root, focusedPaneId) !== null ? focusedPaneId : leavesOf(root)[0]!.id;
  return { version: LAYOUT_VERSION, root, focusedPaneId: focused };
}

/**
 * Creates a sibling leaf on the requested side of `leafId` and puts `surface` in
 * it. The surface leaves wherever it lived; a leaf that loses its last tab is
 * closed. At the four-leaf cap the drop lands as a tab in the target leaf.
 */
export function splitLeaf(
  layout: PaneLayout,
  leafId: string,
  direction: PaneDirection,
  surface: PaneSurface,
): PaneLayout {
  if (surface === 'thread') return layout;
  const target = findPane(layout.root, leafId);
  if (target === null) return layout;

  const owner = paneIdOfSurface(layout, surface);
  if (owner !== null && owner !== leafId) return focusPane(layout, owner);

  if (leafCount(layout.root) >= MAX_PANES) {
    return focusPane(addTab(layout, leafId, surface), leafId);
  }

  const pane: PaneLayoutPane = { id: nextPaneId(layout.root), tabs: [surface], activeTab: surface };
  const sibling = leafNode(pane);
  const targetLeaf = leafNode(target);
  const split: PaneSplit = {
    kind: 'split',
    id: nextSplitId(layout.root),
    orientation: orientationOf(direction),
    children: isBefore(direction) ? [sibling, targetLeaf] : [targetLeaf, sibling],
    sizes: [50, 50],
  };
  let root = replaceLeaf(layout.root, leafId, () => split);
  if (owner === leafId) root = removeTabFromTree(root, owner, surface);
  return withFocus(root, pane.id);
}

export function addTab(layout: PaneLayout, paneId: string, surface: PaneSurface): PaneLayout {
  if (surface === 'thread' || paneHasSurface(layout, surface)) return layout;
  const pane = findPane(layout.root, paneId);
  if (pane === null) return layout;
  const root = addTabToTree(layout.root, paneId, surface);
  return root === layout.root ? layout : withFocus(root, paneId);
}

export function selectTab(layout: PaneLayout, paneId: string, surface: PaneSurface): PaneLayout {
  const pane = findPane(layout.root, paneId);
  if (pane === null || !pane.tabs.includes(surface)) return layout;
  const root = mapLeaf(layout.root, paneId, (current) =>
    current.activeTab === surface ? current : { ...current, activeTab: surface },
  );
  if (root === layout.root && layout.focusedPaneId === paneId) return layout;
  return withFocus(root, paneId);
}

/** Closes a leaf. The leaf that hosts the route's thread never closes. */
export function closeLeaf(layout: PaneLayout, paneId: string): PaneLayout {
  const pane = findPane(layout.root, paneId);
  if (pane === null || pane.tabs.includes('thread')) return layout;
  const root = removeLeaf(layout.root, paneId);
  if (root === null) return defaultPaneLayout();
  return withFocus(root, layout.focusedPaneId);
}

export function closeTab(layout: PaneLayout, paneId: string, surface: PaneSurface): PaneLayout {
  if (surface === 'thread') return layout;
  const pane = findPane(layout.root, paneId);
  if (pane === null || !pane.tabs.includes(surface)) return layout;
  if (pane.tabs.length === 1) return closeLeaf(layout, paneId);
  const root = removeTabFromTree(layout.root, paneId, surface);
  return withFocus(root, layout.focusedPaneId);
}

/** Moves one surface between leaves. Dropping the last tab of a leaf closes it. */
export function moveTab(
  layout: PaneLayout,
  fromPaneId: string,
  surface: PaneSurface,
  toPaneId: string,
  index = -1,
): PaneLayout {
  if (surface === 'thread' || fromPaneId === toPaneId) return layout;
  const from = findPane(layout.root, fromPaneId);
  const to = findPane(layout.root, toPaneId);
  if (from === null || to === null) return layout;
  if (!from.tabs.includes(surface) || to.tabs.includes(surface)) return layout;

  const insertAt = index < 0 || index > to.tabs.length ? to.tabs.length : index;
  const tabs = [...to.tabs.slice(0, insertAt), surface, ...to.tabs.slice(insertAt)];
  let root = mapLeaf(layout.root, toPaneId, (current) => ({
    ...current,
    tabs,
    activeTab: surface,
  }));
  root = removeTabFromTree(root, fromPaneId, surface);
  return withFocus(root, toPaneId);
}

/**
 * Moves a whole leaf beside `targetLeafId` on the requested side, keeping every
 * tab. The leaf that hosts the route's thread never moves; at the cap the pane
 * folds into the target leaf as tabs instead.
 */
export function moveLeaf(
  layout: PaneLayout,
  leafId: string,
  targetLeafId: string,
  direction: PaneDirection,
): PaneLayout {
  if (leafId === targetLeafId) return layout;
  const source = findPane(layout.root, leafId);
  const target = findPane(layout.root, targetLeafId);
  if (source === null || target === null) return layout;
  if (source.tabs.includes('thread')) return layout;

  if (leafCount(layout.root) >= MAX_PANES) {
    let root = layout.root;
    for (const tab of source.tabs) root = addTabToTree(root, targetLeafId, tab);
    root = removeLeaf(root, leafId) ?? root;
    return withFocus(root, targetLeafId);
  }

  const without = removeLeaf(layout.root, leafId);
  if (without === null) return layout;
  const sibling = leafNode(source);
  const split: PaneSplit = {
    kind: 'split',
    id: nextSplitId(without),
    orientation: orientationOf(direction),
    children: isBefore(direction) ? [sibling, leafNode(target)] : [leafNode(target), sibling],
    sizes: [50, 50],
  };
  const root = replaceLeaf(without, targetLeafId, () => split);
  return withFocus(root, leafId);
}

/**
 * Drags a splitter: the two children trade pixels along the split's axis while
 * their combined extent stays fixed. Both clamp to 280px and 70 percent.
 * `extentPx` is the axis length of the split's content box, splitters excluded.
 */
export function resizeSplit(
  layout: PaneLayout,
  splitId: string,
  deltaPx: number,
  extentPx: number,
): PaneLayout {
  const node = findSplit(layout.root, splitId);
  if (node === null || !Number.isFinite(deltaPx) || deltaPx === 0) return layout;
  if (!Number.isFinite(extentPx) || extentPx <= 0) return layout;

  const firstPx = (extentPx * node.sizes[0]) / 100;
  const minPane = Math.min(MIN_PANE_WIDTH_PX, extentPx / 2);
  const maxPane = Math.max(minPane, extentPx * MAX_PANE_WIDTH_RATIO);
  const lower = Math.max(minPane, extentPx - maxPane);
  const upper = Math.min(extentPx - minPane, maxPane);
  const nextFirst =
    lower > upper ? extentPx / 2 : Math.min(Math.max(firstPx + deltaPx, lower), upper);
  const sizes: [number, number] = [(nextFirst / extentPx) * 100, 100 - (nextFirst / extentPx) * 100];
  if (Math.abs(sizes[0] - node.sizes[0]) < 0.01) return layout;
  return withFocus(
    mapSplit(layout.root, splitId, (split) => ({ ...split, sizes })),
    layout.focusedPaneId,
  );
}

function mapSplit(
  node: PaneNode,
  splitId: string,
  fn: (split: PaneSplit) => PaneSplit,
): PaneNode {
  if (node.kind === 'leaf') return node;
  if (node.id === splitId) return fn(node);
  const left = mapSplit(node.children[0], splitId, fn);
  const right = mapSplit(node.children[1], splitId, fn);
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

/** Double-click: the two children beside a splitter go back to an even split. */
export function resetSplit(layout: PaneLayout, splitId: string): PaneLayout {
  const node = findSplit(layout.root, splitId);
  if (node === null) return layout;
  if (Math.abs(node.sizes[0] - 50) < 0.01 && Math.abs(node.sizes[1] - 50) < 0.01) return layout;
  return {
    ...layout,
    root: mapSplit(layout.root, splitId, (split) => ({ ...split, sizes: [50, 50] })),
  };
}

/**
 * The next leaf in a direction, for keyboard focus moves: the nearest sibling
 * subtree on that side, entered from the edge closest to the current leaf.
 */
export function leafNeighbor(
  node: PaneNode,
  paneId: string,
  direction: PaneDirection,
): string | null {
  const orientation = orientationOf(direction);
  const wantSecond = direction === 'right' || direction === 'bottom';

  // The chain of splits between the root and the leaf, outermost first.
  const path: { split: PaneSplit; childIndex: 0 | 1 }[] = [];
  function descend(current: PaneNode): boolean {
    if (current.kind === 'leaf') return current.pane.id === paneId;
    for (const childIndex of [0, 1] as const) {
      if (descend(current.children[childIndex])) {
        path.unshift({ split: current, childIndex });
        return true;
      }
    }
    return false;
  }
  if (!descend(node)) return null;

  // The nearest ancestor split on the matching axis where the leaf sits on the
  // far side; its sibling subtree is entered from the edge we came from.
  for (const step of path) {
    if (step.split.orientation !== orientation) continue;
    if (step.childIndex !== (wantSecond ? 0 : 1)) continue;
    const candidates = leavesOf(step.split.children[wantSecond ? 1 : 0]);
    const nearest = wantSecond ? candidates[0] : candidates.at(-1);
    return nearest?.id ?? null;
  }
  return null;
}

/**
 * The narrow view: one leaf whose tabs are every surface open in the tree, in
 * visual order. The stored tree is untouched, so widening restores the splits.
 */
export function collapseForNarrow(layout: PaneLayout): PaneLayout {
  const first = leaves(layout)[0];
  const tabs = openSurfaces(layout);
  if (!tabs.includes('thread')) tabs.unshift('thread');
  const activeTab =
    first !== undefined && tabs.includes(first.activeTab) ? first.activeTab : tabs[0]!;
  const root = leafNode({ id: first?.id ?? FIRST_PANE_ID, tabs, activeTab });
  return { version: LAYOUT_VERSION, root, focusedPaneId: root.pane.id };
}

interface NormalizeContext {
  used: Set<PaneSurface>;
  ids: Set<string>;
  splitIds: Set<string>;
  count: number;
  overflow: PaneSurface[];
}

function normalizePane(raw: unknown, context: NormalizeContext): PaneLayoutPane | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rawTabs = 'tabs' in raw ? raw.tabs : undefined;
  const rawId = 'id' in raw ? raw.id : undefined;
  const rawActiveTab = 'activeTab' in raw ? raw.activeTab : undefined;

  const tabs: PaneSurface[] = [];
  if (Array.isArray(rawTabs)) {
    for (const tab of rawTabs) {
      if (!isPaneSurface(tab) || context.used.has(tab)) continue;
      context.used.add(tab);
      tabs.push(tab);
    }
  }
  if (tabs.length === 0) return null;

  let id = typeof rawId === 'string' && rawId.length > 0 ? rawId : `pane-${context.count + 1}`;
  while (context.ids.has(id)) id = `${id}-${context.count + 1}`;
  context.ids.add(id);

  const activeTab =
    isPaneSurface(rawActiveTab) && tabs.includes(rawActiveTab) ? rawActiveTab : tabs[0]!;
  return { id, tabs, activeTab };
}

function normalizeNode(raw: unknown, context: NormalizeContext): PaneNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const kind = 'kind' in raw ? raw.kind : undefined;
  const rawChildren = 'children' in raw ? raw.children : undefined;
  const isSplit = kind === 'split' || Array.isArray(rawChildren);
  if (!isSplit) {
    // Version 2 wraps the pane in a leaf node; version 1 stored the pane bare.
    const pane = normalizePane('pane' in raw ? raw.pane : raw, context);
    if (pane === null) return null;
    if (context.count >= MAX_PANES) {
      // Beyond the cap the extra leaf's surfaces become tabs on the last kept leaf.
      context.overflow.push(...pane.tabs);
      return null;
    }
    context.count += 1;
    return leafNode(pane);
  }

  const rawOrientation = 'orientation' in raw ? raw.orientation : undefined;
  const orientation: PaneOrientation =
    rawOrientation === 'vertical' ? 'vertical' : 'horizontal';
  const children = Array.isArray(rawChildren) ? rawChildren : [];
  const kept: PaneNode[] = [];
  for (const child of children.slice(0, 2)) {
    const node = normalizeNode(child, context);
    if (node !== null) kept.push(node);
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;

  const rawSizes = 'sizes' in raw && Array.isArray(raw.sizes) ? raw.sizes : [];
  const sizes = normalizeSizes(rawSizes);
  const rawId = 'id' in raw ? raw.id : undefined;
  let id = typeof rawId === 'string' && rawId.length > 0 ? rawId : `split-${context.splitIds.size + 1}`;
  while (context.splitIds.has(id)) id = `${id}-${context.splitIds.size + 1}`;
  context.splitIds.add(id);

  return { kind: 'split', id, orientation, children: [kept[0]!, kept[1]!], sizes };
}

interface LegacyPane {
  id?: unknown;
  tabs?: unknown;
  activeTab?: unknown;
  width?: unknown;
}

/**
 * Version 1 stored a flat row of panes with pixel-derived widths. It becomes a
 * horizontal chain of splits whose sizes are the panes' widths, so nobody loses
 * their layout on upgrade.
 */
function migrateLegacyPanes(rawPanes: readonly unknown[]): PaneNode | null {
  const context: NormalizeContext = {
    used: new Set<PaneSurface>(),
    ids: new Set<string>(),
    splitIds: new Set<string>(),
    count: 0,
    overflow: [],
  };
  const panes: { pane: PaneLayoutPane; width: number }[] = [];
  for (const raw of rawPanes.slice(0, MAX_PANES)) {
    const pane = normalizePane(raw as LegacyPane, context);
    if (pane === null) continue;
    context.count += 1;
    const width =
      typeof (raw as LegacyPane).width === 'number' &&
      Number.isFinite((raw as LegacyPane).width) &&
      ((raw as LegacyPane).width as number) > 0
        ? ((raw as LegacyPane).width as number)
        : 1;
    panes.push({ pane, width });
  }
  if (panes.length === 0) return null;

  let node: PaneNode = leafNode(panes[panes.length - 1]!.pane);
  for (let index = panes.length - 2; index >= 0; index -= 1) {
    // The left child is one leaf, so it keeps that pane's width; the right child
    // is the chain of everything after it.
    const right = panes.slice(index + 1).reduce((sum, entry) => sum + entry.width, 0);
    node = {
      kind: 'split',
      id: `split-${index + 1}`,
      orientation: 'horizontal',
      children: [leafNode(panes[index]!.pane), node],
      sizes: normalizeSizes([panes[index]!.width, right]),
    };
  }
  return node;
}

/**
 * Repairs a stored layout: one to four leaves, unique surfaces, a valid active
 * tab, the route thread in the first leaf, two-child splits, sizes summing to
 * 100, and a focused leaf that exists.
 */
export function normalizeLayout(input: unknown): PaneLayout | null {
  if (typeof input !== 'object' || input === null) return null;

  const context: NormalizeContext = {
    used: new Set<PaneSurface>(),
    ids: new Set<string>(),
    splitIds: new Set<string>(),
    count: 0,
    overflow: [],
  };

  let root: PaneNode | null = null;
  if ('root' in input) {
    root = normalizeNode(input.root, context);
  } else if ('panes' in input && Array.isArray(input.panes)) {
    root = migrateLegacyPanes(input.panes);
  }
  if (root === null) return null;

  // Overflow surfaces from leaves beyond the cap land on the last kept leaf.
  if (context.overflow.length > 0) {
    const last = leavesOf(root).at(-1);
    if (last !== undefined) {
      for (const surface of context.overflow) {
        if (!paneHasSurface({ version: LAYOUT_VERSION, root, focusedPaneId: last.id }, surface)) {
          last.tabs.push(surface);
        }
      }
    }
  }

  // The thread surface belongs to the first leaf, whatever the stored order.
  const all = leavesOf(root);
  const first = all[0]!;
  if (!first.tabs.includes('thread')) {
    first.tabs.unshift('thread');
    first.activeTab = 'thread';
  }
  for (const pane of all.slice(1)) {
    if (!pane.tabs.includes('thread')) continue;
    pane.tabs = pane.tabs.filter((tab) => tab !== 'thread');
    if (pane.activeTab === 'thread') pane.activeTab = pane.tabs[0] ?? 'thread';
  }
  // A leaf stripped to nothing (it only held the thread) disappears.
  for (const pane of all.slice(1)) {
    if (pane.tabs.length > 0) continue;
    const without = removeLeaf(root, pane.id);
    if (without !== null) root = without;
  }
  if (root === null) return null;

  const rawFocused = 'focusedPaneId' in input ? input.focusedPaneId : undefined;
  const focused =
    typeof rawFocused === 'string' && findPane(root, rawFocused) !== null
      ? rawFocused
      : leavesOf(root)[0]!.id;
  return { version: LAYOUT_VERSION, root, focusedPaneId: focused };
}

export interface PaneStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function paneStorageKey(threadId: string): string {
  return `tuffcode.panes.v2.${threadId}`;
}

/** The pre-tree key; still read so an upgrade keeps the layout. */
export function legacyPaneStorageKey(threadId: string): string {
  return `tuffcode.panes.v1.${threadId}`;
}

function browserStorage(): PaneStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function parsePaneLayout(raw: string | null): PaneLayout | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) return null;
    const version = parsed.version;
    if (version !== LAYOUT_VERSION && version !== LEGACY_STORAGE_VERSION) return null;
    return normalizeLayout(parsed);
  } catch {
    return null;
  }
}

export function loadPaneLayout(
  threadId: string,
  storage: PaneStorage | null = browserStorage(),
): PaneLayout {
  if (storage === null) return defaultPaneLayout();
  try {
    const current = parsePaneLayout(storage.getItem(paneStorageKey(threadId)));
    if (current !== null) return current;
    const legacy = parsePaneLayout(storage.getItem(legacyPaneStorageKey(threadId)));
    if (legacy !== null) return legacy;
    return defaultPaneLayout();
  } catch {
    return defaultPaneLayout();
  }
}

export function savePaneLayout(
  threadId: string,
  layout: PaneLayout,
  storage: PaneStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      paneStorageKey(threadId),
      JSON.stringify({ version: LAYOUT_VERSION, root: layout.root, focusedPaneId: layout.focusedPaneId }),
    );
  } catch {
    // Quota and privacy mode failures must not break the workspace.
  }
}

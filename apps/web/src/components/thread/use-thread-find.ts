import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAppStore } from '../../store/app-store';
import type { TimelineBlock } from './turn-blocks';

/** Every text surface the finder reads. */
export type FindField =
  | 'user'
  | 'final'
  | 'prose'
  | 'reasoning'
  | 'tool-name'
  | 'tool-input'
  | 'tool-output'
  | 'approval'
  | 'notice';

/** One literal occurrence of the query in the timeline model. */
export interface FindMatch {
  /** Stable across block changes: block key, field and offset. */
  id: string;
  /** The rendered top-level block, which is what the virtualizer scrolls to. */
  blockKey: string;
  blockIndex: number;
  field: FindField;
  /** The whole field text, so the active hit can be windowed into view. */
  text: string;
  start: number;
  length: number;
  /** Collapsed rows that must open for the hit to be visible, outermost first. */
  expandKeys: string[];
}

/** A pathological query in a huge tool output must not build an unbounded list. */
export const MAX_FIND_MATCHES = 500;

interface FieldEntry {
  field: FindField;
  text: string;
  expandKeys: string[];
}

function uniqueKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/** Every searchable text of one block, with the rows a hit has to open. */
function fieldsOf(block: TimelineBlock, ancestors: readonly string[] = []): FieldEntry[] {
  switch (block.kind) {
    case 'user':
      return [{ field: 'user', text: block.item.text, expandKeys: uniqueKeys(ancestors) }];
    case 'reasoning':
      return [
        {
          field: 'reasoning',
          text: block.text,
          expandKeys: uniqueKeys([...ancestors, block.key]),
        },
      ];
    case 'prose':
      return [{ field: 'prose', text: block.text, expandKeys: uniqueKeys(ancestors) }];
    case 'final':
      return [{ field: 'final', text: block.text, expandKeys: uniqueKeys(ancestors) }];
    case 'approval':
      return [
        {
          field: 'approval',
          text: [block.item.name, inputText(block.item.input)]
            .filter((part) => part.length > 0)
            .join('\n'),
          expandKeys: uniqueKeys(ancestors),
        },
      ];
    case 'notice':
      return [{ field: 'notice', text: block.item.text, expandKeys: uniqueKeys(ancestors) }];
    case 'tools':
      return block.tools.flatMap((tool) => {
        const keys = uniqueKeys([...ancestors, block.key, tool.key]);
        return [
          { field: 'tool-name' as const, text: tool.name, expandKeys: keys },
          { field: 'tool-input' as const, text: inputText(tool.input), expandKeys: keys },
          { field: 'tool-output' as const, text: tool.output, expandKeys: keys },
        ];
      });
    case 'steps':
      return block.children.flatMap((child) => fieldsOf(child, [...ancestors, block.key]));
  }
}

/**
 * Every literal, case-insensitive occurrence of a query across the whole timeline
 * model, including the children of collapsed steps rows and collapsed tool groups.
 * The virtualizer only mounts a window of rows, so the model, not the DOM, is the
 * match source. An empty query matches nothing.
 */
export function findTimeline(blocks: readonly TimelineBlock[], query: string): FindMatch[] {
  if (query.length === 0) return [];
  const needle = query.toLowerCase();
  const matches: FindMatch[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block === undefined) continue;
    for (const entry of fieldsOf(block)) {
      if (entry.text.length === 0) continue;
      const haystack = entry.text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        matches.push({
          id: `${block.key}|${entry.field}|${at}`,
          blockKey: block.key,
          blockIndex,
          field: entry.field,
          text: entry.text,
          start: at,
          length: needle.length,
          expandKeys: entry.expandKeys,
        });
        if (matches.length >= MAX_FIND_MATCHES) return matches;
        from = at + Math.max(needle.length, 1);
      }
    }
  }

  return matches;
}

/** The expansion map the timeline rows read: one entry per open block key. */
export type ExpansionMap = Readonly<Record<string, boolean>>;

/** A copy of the map with every key of a hit open. */
export function openExpansion(map: ExpansionMap, keys: readonly string[]): ExpansionMap {
  let next: Record<string, boolean> | null = null;
  for (const key of keys) {
    if (map[key] === true) continue;
    next ??= { ...map };
    next[key] = true;
  }
  return next ?? map;
}

/** The row keys a hit opens: its steps row, its tool group and its own row. */
export function expandKeysForMatch(match: FindMatch): string[] {
  return match.expandKeys;
}

interface Cursor {
  /** The hit the user last stepped to, kept across block changes. */
  anchor: string | null;
  /** Fallback position when the anchor no longer exists. */
  index: number;
}

function resolveIndex(matches: readonly FindMatch[], cursor: Cursor): number {
  if (matches.length === 0) return -1;
  if (cursor.anchor !== null) {
    const found = matches.findIndex((match) => match.id === cursor.anchor);
    if (found !== -1) return found;
  }
  return Math.min(Math.max(cursor.index, 0), matches.length - 1);
}

export interface ThreadFindState {
  open: boolean;
  query: string;
  matches: FindMatch[];
  /** Zero based; -1 while nothing matches. */
  index: number;
  active: FindMatch | null;
  /** Bumped on every open, so a second Ctrl+F refocuses an already open bar. */
  focusToken: number;
  openFind(): void;
  closeFind(): void;
  setQuery(query: string): void;
  next(): void;
  previous(): void;
}

/** What one mounted thread tells the shortcut registry about itself. */
interface FindHost {
  threadId: string;
  root(): HTMLElement | null;
  open(): void;
}

const hosts: FindHost[] = [];
let listening = false;

function isDialogFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest('[role="dialog"]') !== null;
}

function pickHost(): FindHost | null {
  if (hosts.length === 0) return null;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const owner = hosts.find((host) => host.root()?.contains(active) === true);
    if (owner !== undefined) return owner;
  }
  // A clicked pane marks itself, which covers a click on its header or its chrome.
  const focusedPane = document.querySelector<HTMLElement>(
    '[data-testid="pane"][data-focused="true"]',
  );
  if (focusedPane !== null) {
    const owner = hosts.find((host) => {
      const root = host.root();
      return root !== null && focusedPane.contains(root);
    });
    if (owner !== undefined) return owner;
  }
  // Otherwise the pane showing the routed thread wins over a side chat.
  const routeThread = useAppStore.getState().activeThreadId;
  const routed = hosts.find((host) => host.threadId === routeThread);
  return routed ?? hosts[0] ?? null;
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (!(event.ctrlKey || event.metaKey)) return;
  // Shift+F and Alt+F belong to the sidebar search and the menu bar.
  if (event.shiftKey || event.altKey) return;
  if (event.key.toLowerCase() !== 'f') return;
  if (isDialogFocused()) return;
  const host = pickHost();
  if (host === null) return;
  event.preventDefault();
  host.open();
}

function registerHost(host: FindHost): () => void {
  hosts.push(host);
  if (!listening) {
    window.addEventListener('keydown', handleKeyDown);
    listening = true;
  }
  return () => {
    const index = hosts.indexOf(host);
    if (index !== -1) hosts.splice(index, 1);
    if (hosts.length === 0 && listening) {
      window.removeEventListener('keydown', handleKeyDown);
      listening = false;
    }
  };
}

/**
 * In-chat search over the timeline model. The hook owns the query, the hit list and
 * the cursor; the caller owns the expansion map and the scroll, so a hit can open
 * its collapsed rows before the virtualizer jumps to it.
 */
export function useThreadFind(options: {
  threadId: string;
  blocks: readonly TimelineBlock[];
  rootRef: RefObject<HTMLElement | null>;
}): ThreadFindState {
  const { threadId, blocks, rootRef } = options;
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [cursor, setCursor] = useState<Cursor>({ anchor: null, index: 0 });
  const [focusToken, setFocusToken] = useState(0);
  const matches = useMemo(() => findTimeline(blocks, query), [blocks, query]);
  const index = resolveIndex(matches, cursor);
  const active = index === -1 ? null : (matches[index] ?? null);

  const openRef = useRef<() => void>(() => undefined);
  openRef.current = () => {
    setOpen(true);
    setFocusToken((token) => token + 1);
  };

  useEffect(() => {
    return registerHost({
      threadId,
      root: () => rootRef.current,
      open: () => openRef.current(),
    });
  }, [rootRef, threadId]);

  const openFind = useCallback(() => {
    setOpen(true);
    setFocusToken((token) => token + 1);
  }, []);

  const closeFind = useCallback(() => {
    setOpen(false);
  }, []);

  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setCursor({ anchor: null, index: 0 });
  }, []);

  const step = useCallback(
    (delta: number) => {
      setCursor((current) => {
        const currentIndex = resolveIndex(matches, current);
        if (matches.length === 0 || currentIndex === -1) return current;
        const target = (currentIndex + delta + matches.length) % matches.length;
        const match = matches[target];
        return match === undefined ? current : { anchor: match.id, index: target };
      });
    },
    [matches],
  );

  const next = useCallback(() => step(1), [step]);
  const previous = useCallback(() => step(-1), [step]);

  return {
    open,
    query,
    matches,
    index,
    active,
    focusToken,
    openFind,
    closeFind,
    setQuery,
    next,
    previous,
  };
}

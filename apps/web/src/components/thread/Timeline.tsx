import { useVirtualizer } from '@tanstack/react-virtual';
import type { MarkdownTheme } from '@tuffcode/ui';
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type Ref,
} from 'react';
import { ApprovalCard } from './ApprovalCard';
import type { UserItem } from './grouping';
import {
  FinalAnswer,
  NoticeRow,
  ProseText,
  ReasoningRow,
  StepsRow,
  TimelineExpansionProvider,
  TimelineFindProvider,
  ToolGroup,
  UserBubble,
  type TimelineExpansion,
} from './timeline-items';
import type { TimelineBlock } from './turn-blocks';

export interface TimelineFindState {
  query: string;
  /** The block holding the active hit, highlighted distinctly. */
  activeBlockKey: string | null;
  /** The tool row whose body holds the active hit, windowed around it. */
  activeToolKey: string | null;
}

export interface TimelineProps {
  blocks: readonly TimelineBlock[];
  theme: MarkdownTheme;
  threadId: string;
  /** The controlled expansion map: a row that scrolls away keeps its state. */
  expansion: TimelineExpansion;
  find?: TimelineFindState;
  onRetryUserMessage?: (item: UserItem) => void;
  onEditUserMessage?: (item: UserItem, text: string) => void;
}

/** The virtualizer is the only scroll owner, so the find bar asks it to jump. */
export interface TimelineHandle {
  scrollToBlock(index: number): void;
}

const BOTTOM_THRESHOLD_PX = 64;

interface HighlightCtor {
  new (...ranges: Range[]): unknown;
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const globals = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistry };
    Highlight?: HighlightCtor;
  };
  const registry = globals.CSS?.highlights;
  const Highlight = globals.Highlight;
  if (registry === undefined || Highlight === undefined) return null;
  return { registry, Highlight };
}

function renderBlock(
  block: TimelineBlock,
  theme: MarkdownTheme,
  threadId: string,
  onRetryUserMessage?: (item: UserItem) => void,
  onEditUserMessage?: (item: UserItem, text: string) => void,
): ReactNode {
  switch (block.kind) {
    case 'user':
      return <UserBubble item={block.item} threadId={threadId} onRetry={onRetryUserMessage} />;
    case 'reasoning':
      return <ReasoningRow block={block} />;
    case 'prose':
      return <ProseText block={block} theme={theme} />;
    case 'tools':
      return <ToolGroup block={block} />;
    case 'steps':
      return <StepsRow block={block} theme={theme} />;
    case 'final':
      return (
        <FinalAnswer
          block={block}
          theme={theme}
          threadId={threadId}
          onRetry={onRetryUserMessage}
          onEdit={onEditUserMessage}
        />
      );
    case 'approval':
      return <ApprovalCard item={block.item} threadId={threadId} />;
    case 'notice':
      return <NoticeRow item={block.item} />;
  }
}

export function Timeline({
  blocks,
  theme,
  threadId,
  expansion,
  find,
  onRetryUserMessage,
  onEditUserMessage,
  ref,
}: TimelineProps & { ref?: Ref<TimelineHandle> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (index) => blocks[index]?.key ?? index,
  });

  const scrollToBlock = useCallback(
    (index: number) => {
      pinnedRef.current = false;
      const jump = () => {
        virtualizer.measure();
        virtualizer.scrollToIndex(index, { align: 'center' });
      };
      jump();
      // The expansion the hit asked for lands after this frame, so re-run the jump
      // once the taller rows are measured instead of scrolling to an estimate.
      requestAnimationFrame(() => {
        jump();
        requestAnimationFrame(jump);
      });
    },
    [virtualizer],
  );

  useImperativeHandle(ref, () => ({ scrollToBlock }), [scrollToBlock]);

  useLayoutEffect(() => {
    if (blocks.length === 0 || !pinnedRef.current) return;
    virtualizer.scrollToIndex(blocks.length - 1, { align: 'end' });
  }, [blocks, virtualizer]);

  const query = find?.query ?? '';
  const activeBlockKey = find?.activeBlockKey ?? null;
  const mountedKey = virtualizer
    .getVirtualItems()
    .map((row) => `${String(row.key)}:${String(row.size)}`)
    .join('|');

  useLayoutEffect(() => {
    const api = highlightApi();
    if (api === null) return;
    api.registry.delete('thread-find');
    api.registry.delete('thread-find-active');
    if (query.length === 0) return;
    const root = scrollRef.current;
    if (root === null) return;

    const needle = query.toLowerCase();
    const all: Range[] = [];
    const active: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.nodeValue ?? '';
      if (text.length === 0) continue;
      const lower = text.toLowerCase();
      const owner =
        node.parentElement?.closest<HTMLElement>('[data-block-key]')?.dataset['blockKey'] ?? null;
      const bucket = owner !== null && owner === activeBlockKey ? active : all;
      let from = 0;
      for (;;) {
        const at = lower.indexOf(needle, from);
        if (at === -1) break;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        bucket.push(range);
        from = at + Math.max(needle.length, 1);
      }
    }

    if (all.length > 0) api.registry.set('thread-find', new api.Highlight(...all));
    if (active.length > 0) api.registry.set('thread-find-active', new api.Highlight(...active));

    return () => {
      api.registry.delete('thread-find');
      api.registry.delete('thread-find-active');
    };
  }, [activeBlockKey, mountedKey, query]);

  const findTarget = useMemo(
    () =>
      query.length === 0 ? null : { needle: query, activeToolKey: find?.activeToolKey ?? null },
    [find?.activeToolKey, query],
  );

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Thread timeline"
      aria-live="polite"
      className="min-h-0 flex-1 scroll-pt-3 overflow-y-auto overscroll-contain py-4"
      onScroll={() => {
        const element = scrollRef.current;
        if (!element) return;
        pinnedRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD_PX;
      }}
    >
      <TimelineExpansionProvider value={expansion}>
        <TimelineFindProvider value={findTarget}>
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const block = blocks[virtualRow.index];
              if (!block) return null;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  data-block-key={block.key}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full py-1.5"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div className="mx-auto w-full max-w-[var(--chat-content-max-width)] px-4">
                    {renderBlock(block, theme, threadId, onRetryUserMessage, onEditUserMessage)}
                  </div>
                </div>
              );
            })}
          </div>
        </TimelineFindProvider>
      </TimelineExpansionProvider>
    </div>
  );
}

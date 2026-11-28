import type { MarkdownTheme } from '@tuffcode/ui';
import { ChevronRight } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { SubagentChild } from '../../store/app-store';
import { groupTimeline } from '../thread/grouping';
import {
  FinalAnswer,
  NoticeRow,
  ProseText,
  ReasoningRow,
  ToolGroup,
} from '../thread/timeline-items';
import { groupTurnBlocks, type TimelineBlock } from '../thread/turn-blocks';
import { SUBAGENT_MESSAGE_KIND_LABEL, subagentMessageDirectionLabel } from './subagent-model';
import { useSubagentEvents, useSubagentMessages } from './use-subagents';

const EMPTY_APPROVALS = {};

/** The same block renderer as the parent timeline, minus user turns and retries. */
function renderBlock(block: TimelineBlock, theme: MarkdownTheme, threadId: string): ReactNode {
  switch (block.kind) {
    case 'reasoning':
      return <ReasoningRow block={block} />;
    case 'prose':
      return <ProseText block={block} theme={theme} />;
    case 'tools':
      return <ToolGroup block={block} />;
    case 'final':
      return <FinalAnswer block={block} theme={theme} threadId={threadId} />;
    case 'notice':
      return <NoticeRow item={block.item} />;
    // A child runs read-only or accept-edits, so it never raises an approval; the
    // task header and the final answer carry everything the pane needs.
    default:
      return null;
  }
}

export interface SubagentTimelineProps {
  child: SubagentChild;
  theme: MarkdownTheme;
}

/** The child's own turn: its task behind a disclosure, then its reasoning, tools and answer. */
export function SubagentTimeline({ child, theme }: SubagentTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const messages = useSubagentMessages(child);
  const events = useSubagentEvents(child);

  const blocks = useMemo(() => {
    const items = groupTimeline({
      events,
      userMessages: [],
      approvals: EMPTY_APPROVALS,
    });
    return groupTurnBlocks(items);
  }, [events]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [blocks, messages]);

  return (
    <div
      ref={scrollRef}
      data-testid="subagent-timeline"
      aria-label="Subagent timeline"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
      onScroll={() => {
        const element = scrollRef.current;
        if (!element) return;
        pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      }}
    >
      <details
        data-testid="subagent-task-disclosure"
        className="group mb-3 rounded-md border border-border bg-muted/30"
      >
        <summary className="flex cursor-pointer list-none items-center gap-1 px-2.5 py-1.5 text-2xs font-medium text-muted-foreground select-none hover:text-foreground">
          <ChevronRight
            aria-hidden="true"
            strokeWidth={1.75}
            className="size-3 shrink-0 transition-transform duration-150 group-open:rotate-90"
          />
          Task brief
        </summary>
        <p
          data-testid="subagent-task"
          className="border-t border-border/60 px-2.5 py-2 text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground"
        >
          {child.task.length > 0 ? child.task : 'No task recorded for this child.'}
        </p>
      </details>

      <div className="flex flex-col gap-2">
        {blocks.map((block) => (
          <div key={block.key}>{renderBlock(block, theme, child.threadId)}</div>
        ))}
      </div>

      {messages.length > 0 ? (
        <div
          data-testid="subagent-messages"
          aria-label="Messages between the parent and this subagent"
          className="mt-3 flex flex-col gap-1.5"
        >
          <div className="text-2xs font-medium text-muted-foreground">Messages</div>
          {messages.map((message) => (
            <div
              key={message.id}
              data-testid="subagent-message"
              data-kind={message.kind}
              data-direction={message.direction}
              className="rounded-md border border-border bg-card px-2.5 py-2"
            >
              <div className="mb-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
                <span className="font-medium">{SUBAGENT_MESSAGE_KIND_LABEL[message.kind]}</span>
                <span>{subagentMessageDirectionLabel(message)}</span>
              </div>
              {/* Plain text, whole: a message row is never truncated in the pane. */}
              <p className="text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
                {message.text}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {child.summary !== null && child.summary.length > 0 ? (
        <div
          data-testid="subagent-summary"
          className="mt-3 rounded-md border border-border bg-card px-2.5 py-2"
        >
          <div className="mb-1 text-2xs font-medium text-muted-foreground">Summary</div>
          <p className="whitespace-pre-wrap text-xs leading-5 text-foreground">{child.summary}</p>
        </div>
      ) : null}
    </div>
  );
}

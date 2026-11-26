import { IconButton, Kbd, cn, focusRing } from '@tuffcode/ui';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';

export interface FindBarProps {
  query: string;
  /** Zero based, -1 while nothing matches. */
  index: number;
  count: number;
  /** Changes on every open, so reopening an open bar puts the caret back. */
  focusToken: number;
  onQueryChange(query: string): void;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
}

/**
 * The in-chat find bar. It sits under the thread header, keeps the count live, and
 * owns only its own keys: Enter and Shift+Enter step, Escape closes and hands the
 * focus back to the composer.
 */
export function FindBar({
  query,
  index,
  count,
  focusToken,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [focusToken]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  }

  const label =
    count === 0 ? (query.length === 0 ? '0 of 0' : 'No matches') : `${index + 1} of ${count}`;

  return (
    <div
      data-testid="find-bar"
      role="search"
      aria-label="Find in conversation"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur"
    >
      <input
        ref={inputRef}
        data-testid="find-input"
        type="text"
        value={query}
        spellCheck={false}
        autoComplete="off"
        aria-label="Find in conversation"
        placeholder="Find in conversation"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className={cn(
          'h-6 min-w-0 flex-1 rounded-sm border border-border bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground/70',
          focusRing,
        )}
      />
      <span
        data-testid="find-count"
        aria-live="polite"
        className="shrink-0 font-mono text-2xs text-muted-foreground"
      >
        {label}
      </span>
      <IconButton
        icon={ChevronUp}
        label="Previous match"
        size="sm"
        data-testid="find-previous"
        disabled={count === 0}
        onClick={onPrevious}
      />
      <IconButton
        icon={ChevronDown}
        label="Next match"
        size="sm"
        data-testid="find-next"
        disabled={count === 0}
        onClick={onNext}
      />
      <span className="hidden shrink-0 items-center gap-1 @min-[40rem]:flex">
        <Kbd>Enter</Kbd>
        <Kbd>Esc</Kbd>
      </span>
      <IconButton
        icon={X}
        label="Close find"
        size="sm"
        data-testid="find-close"
        onClick={onClose}
      />
    </div>
  );
}

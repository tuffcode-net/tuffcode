import type { ThemeId } from '@tuffcode/contracts';
import { THEME_IDS, THEME_LABEL } from '@tuffcode/contracts';
import { Check } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { PALETTES, type ThemePalette } from '@tuffcode/ui';
import { cn } from '@tuffcode/ui';

/** A miniature window painted with the palette's own tokens. */
function ThemePreview({ palette }: { palette: ThemePalette }) {
  const { tokens } = palette;
  return (
    <span
      aria-hidden="true"
      className="block h-20 w-full overflow-hidden rounded-md border"
      style={{ background: tokens.background, borderColor: tokens.border }}
    >
      <span className="flex h-full">
        <span
          className="flex w-1/4 flex-col gap-1 p-1.5"
          style={{
            background: tokens.sidebar,
            borderRight: `1px solid ${tokens['sidebar-border']}`,
          }}
        >
          <span
            className="h-1 w-3/4 rounded-full"
            style={{ background: tokens['sidebar-foreground'] }}
          />
          <span
            className="h-1 w-1/2 rounded-full opacity-60"
            style={{ background: tokens['sidebar-muted-foreground'] }}
          />
          <span
            className="h-1 w-2/3 rounded-full opacity-60"
            style={{ background: tokens['sidebar-muted-foreground'] }}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
          <span className="h-1.5 w-1/2 rounded-full" style={{ background: tokens.foreground }} />
          <span
            className="h-1 w-4/5 rounded-full opacity-60"
            style={{ background: tokens['muted-foreground'] }}
          />
          <span className="mt-auto flex items-center gap-1">
            <span className="h-3 w-3 rounded-sm" style={{ background: tokens.primary }} />
            <span
              className="h-1.5 flex-1 rounded-full"
              style={{
                background: tokens['message-surface'],
                border: `1px solid ${tokens.border}`,
              }}
            />
          </span>
        </span>
      </span>
    </span>
  );
}

export interface ThemePickerProps {
  value: ThemeId | undefined;
  onChange: (id: ThemeId) => void;
  disabled?: boolean;
}

/**
 * Named themes as preview cards. Clicking a card applies it immediately: the section
 * updates the draft (live preview) and persists that one key, so there is no Save step.
 */
export function ThemePicker({ value, onChange, disabled = false }: ThemePickerProps) {
  const cardRefs = useRef(new Map<ThemeId, HTMLButtonElement>());

  // A radiogroup is one Tab stop: arrows move the selection and the focus with it.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = value === undefined ? 0 : THEME_IDS.indexOf(value);
    const next = THEME_IDS[(current + step + THEME_IDS.length) % THEME_IDS.length];
    if (next === undefined) return;
    onChange(next);
    cardRefs.current.get(next)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      data-testid="theme-picker"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      onKeyDown={onKeyDown}
    >
      {THEME_IDS.map((id) => {
        const palette = PALETTES[id];
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={`theme-${id}`}
            disabled={disabled}
            ref={(element) => {
              if (element === null) cardRefs.current.delete(id);
              else cardRefs.current.set(id, element);
            }}
            onClick={() => onChange(id)}
            className={cn(
              'group flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors',
              selected
                ? 'border-primary ring-1 ring-primary/40'
                : 'border-border hover:border-muted-foreground/50',
              disabled && 'opacity-60',
            )}
          >
            <ThemePreview palette={palette} />
            <span className="flex items-center gap-1 px-0.5">
              <span className="min-w-0 flex-1 truncate text-2xs font-medium text-foreground">
                {THEME_LABEL[id]}
              </span>
              {selected ? (
                <Check
                  aria-hidden="true"
                  className="size-3 shrink-0 text-primary"
                  strokeWidth={2.5}
                />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

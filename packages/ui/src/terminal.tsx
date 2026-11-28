import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
// oxlint-disable-next-line import/no-unassigned-import -- xterm ships its own stylesheet
import '@xterm/xterm/css/xterm.css';
import { cn } from './cn';
import { terminalOptions, type TerminalCursorStyle } from './terminal-options';

export interface TerminalHandle {
  /** Write raw terminal data (output from the pty). */
  write(data: string): void;
  /** Recompute rows and columns from the container size. */
  fit(): void;
  focus(): void;
  /** The current selection, or an empty string. */
  getSelection(): string;
  /** Clears the viewport; scrollback stays. */
  clear(): void;
}

export interface TerminalProps {
  /** Fired with user keystrokes; forward to `terminal.input`. */
  onData?: (data: string) => void;
  /** Fired after a fit or a browser resize; forward to `terminal.resize`. */
  onResize?: (size: { cols: number; rows: number }) => void;
  autoFocus?: boolean;
  fontSize?: number;
  /** Lines kept in the renderer's scrollback buffer. The pty never sees this. */
  scrollback?: number;
  cursorStyle?: TerminalCursorStyle;
  /** Palette-derived xterm colors; the CSS variables are the fallback at mount. */
  theme?: ITheme;
  className?: string;
  ref?: Ref<TerminalHandle>;
}

function readVar(styles: CSSStyleDeclaration, name: string): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : undefined;
}

/** Theme comes from the CSS variables in tokens.css, read once at mount. */
function readTheme(): ITheme {
  if (typeof document === 'undefined') return {};
  const styles = getComputedStyle(document.documentElement);
  const theme: ITheme = {};
  const background = readVar(styles, '--terminal-background');
  const foreground = readVar(styles, '--terminal-foreground');
  const cursor = readVar(styles, '--terminal-cursor');
  const selection = readVar(styles, '--terminal-selection');
  if (background) theme.background = background;
  if (foreground) theme.foreground = foreground;
  if (cursor) theme.cursor = cursor;
  if (selection) theme.selectionBackground = selection;
  return theme;
}

export function Terminal({
  onData,
  onResize,
  autoFocus = true,
  fontSize,
  scrollback,
  cursorStyle,
  theme,
  className,
  ref,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  onDataRef.current = onData;
  onResizeRef.current = onResize;

  const appearance = terminalOptions({ scrollback, fontSize, cursorStyle });
  // The mount effect runs once, so it reads the appearance from a ref instead of
  // re-creating the terminal whenever a setting changes.
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const appliedFontSizeRef = useRef(appearance.fontSize);

  useImperativeHandle(
    ref,
    () => ({
      write: (data) => termRef.current?.write(data),
      fit: () => fitRef.current?.fit(),
      focus: () => termRef.current?.focus(),
      getSelection: () => termRef.current?.getSelection() ?? '',
      clear: () => termRef.current?.clear(),
    }),
    [],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const styles = getComputedStyle(document.documentElement);
    const initial = appearanceRef.current;
    const term = new XTerm({
      cursorBlink: initial.cursorBlink,
      cursorStyle: initial.cursorStyle,
      fontSize: initial.fontSize,
      fontFamily: readVar(styles, '--font-mono') ?? 'monospace',
      scrollback: initial.scrollback,
      theme: themeRef.current ?? readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    try {
      fit.fit();
    } catch {
      // The container can be zero-sized on first paint; the observer refits.
    }

    const dataSubscription = term.onData((data) => onDataRef.current?.(data));
    const resizeSubscription = term.onResize((size) => onResizeRef.current?.(size));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Ignore transient zero-size measurements during layout changes.
      }
    });
    observer.observe(element);

    termRef.current = term;
    fitRef.current = fit;
    if (autoFocus) term.focus();

    return () => {
      observer.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // xterm options are mutable, so a settings change applies to the open terminal in place:
  // no new pty, no lost scrollback. Only a font size change needs a refit.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.scrollback = appearance.scrollback;
    term.options.cursorStyle = appearance.cursorStyle;
    term.options.cursorBlink = appearance.cursorBlink;
    if (appliedFontSizeRef.current === appearance.fontSize) return;
    appliedFontSizeRef.current = appearance.fontSize;
    term.options.fontSize = appearance.fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      // Ignore transient zero-size measurements during layout changes.
    }
  }, [appearance.scrollback, appearance.fontSize, appearance.cursorStyle, appearance.cursorBlink]);

  // A palette switch repaints the open terminal in place; the pty and scrollback stay.
  useEffect(() => {
    const term = termRef.current;
    if (!term || theme === undefined) return;
    term.options.theme = theme;
  }, [theme]);

  return (
    <div
      ref={containerRef}
      // The xterm theme is not reachable from the DOM, so expose its background for
      // tests and for anyone inspecting which palette the terminal painted.
      data-terminal-background={theme?.background}
      className={cn('size-full bg-terminal-background', className)}
    />
  );
}

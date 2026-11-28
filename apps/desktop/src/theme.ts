import { DatabaseSync } from 'node:sqlite';
import type { Theme } from './bridge';

export type ResolvedTheme = 'dark' | 'light';

export interface ThemeChrome {
  /** Title bar overlay background. The dark value is fully transparent. */
  overlayColor: string;
  symbolColor: string;
  backgroundColor: string;
}

/** Matches `--topbar-height` in packages/ui/src/tokens.css so the overlay covers the header. */
export const TITLE_BAR_HEIGHT = 52;

const CHROME: Record<ResolvedTheme, ThemeChrome> = {
  dark: {
    overlayColor: '#01000000',
    symbolColor: '#f8fafc',
    backgroundColor: '#000000',
  },
  light: {
    overlayColor: '#f4f4f5',
    symbolColor: '#18181b',
    backgroundColor: '#ffffff',
  },
};

export function themeChrome(theme: ResolvedTheme): ThemeChrome {
  return CHROME[theme];
}

export interface WindowChromeOptions {
  backgroundColor: string;
  titleBarOverlay: { color: string; symbolColor: string; height: number };
}

/** The `BrowserWindow` options that paint the native chrome for a theme. */
export function windowChromeOptions(theme: ResolvedTheme): WindowChromeOptions {
  const chrome = themeChrome(theme);
  return {
    backgroundColor: chrome.backgroundColor,
    titleBarOverlay: {
      color: chrome.overlayColor,
      symbolColor: chrome.symbolColor,
      height: TITLE_BAR_HEIGHT,
    },
  };
}

/** Resolves the `system` preference against the OS, matching the renderer's resolver. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme !== 'system') return theme;
  return prefersDark ? 'dark' : 'light';
}

/** The slice of `BrowserWindow` the chrome application needs, so it stays testable. */
export interface ThemeChromeTarget {
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
  setBackgroundColor(color: string): void;
}

/** Paints the native window chrome (title bar overlay and window background) for a theme. */
export function applyThemeChrome(target: ThemeChromeTarget, theme: ResolvedTheme): void {
  const { backgroundColor, titleBarOverlay } = windowChromeOptions(theme);
  target.setTitleBarOverlay(titleBarOverlay);
  target.setBackgroundColor(backgroundColor);
}

/**
 * Reads the persisted theme straight from the settings table so the first paint already
 * has the right chrome. Anything missing or unreadable falls back to dark.
 */
export function readPersistedTheme(file: string): ResolvedTheme {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get() as
      | { value?: unknown }
      | undefined;
    const raw = row?.value;
    if (typeof raw !== 'string') return 'dark';
    return JSON.parse(raw) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  } finally {
    db?.close();
  }
}

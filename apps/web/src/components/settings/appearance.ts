import type { InterfaceSize, Theme } from '@tuffcode/contracts';
import { themeBase } from '@tuffcode/contracts';
import { applyThemePalette } from '@tuffcode/ui';

/** The window can follow the OS, so the preference is wider than the stored theme. */
export type ThemePreference = Theme | 'system';

const ROOT_FONT_SIZE = 16;
const DEFAULT_FONT_SIZE = 14;

/** Interface size scales the shared row and control tokens. */
export const DENSITY_TOKENS: Record<InterfaceSize, { rowHeight: number; buttonHeight: number }> = {
  compact: { rowHeight: 30, buttonHeight: 28 },
  default: { rowHeight: 36, buttonHeight: 32 },
  comfortable: { rowHeight: 42, buttonHeight: 38 },
};

/**
 * Tailwind's type scale is rem based, so the font-size setting moves the root.
 * 14px is the design baseline and maps to the default 16px root.
 */
export function rootFontSize(fontSize: number): number {
  return (ROOT_FONT_SIZE * fontSize) / DEFAULT_FONT_SIZE;
}

/** The base scheme a named theme paints, used for native chrome and the toast host. */
export function resolveTheme(theme: ThemePreference, prefersLight: boolean): 'dark' | 'light' {
  if (theme === 'system') return prefersLight ? 'light' : 'dark';
  return themeBase(theme);
}

/** Applies the palette to the document and the base scheme to the native window chrome. */
export function applyTheme(
  theme: ThemePreference,
  target: HTMLElement = document.documentElement,
): void {
  const id =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  const palette = applyThemePalette(id, target);
  // The preload resolves the base scheme for the main process, which repaints the
  // native title bar overlay and window background.
  window.tuffcode.setTheme(palette.base);
}

export interface AppearanceValues {
  interfaceSize: InterfaceSize;
  fontSize: number;
  sidebarWidth: number;
  panelAnimation: boolean;
}

/** Applies the cheap appearance settings straight to CSS variables. */
export function applyAppearance(
  values: AppearanceValues,
  target: HTMLElement = document.documentElement,
): void {
  const density = DENSITY_TOKENS[values.interfaceSize];
  target.style.setProperty('--sidebar-width', `${values.sidebarWidth}px`);
  target.style.setProperty('--row-height', `${density.rowHeight}px`);
  target.style.setProperty('--button-height', `${density.buttonHeight}px`);
  target.style.setProperty('--panel-animation-duration', values.panelAnimation ? '160ms' : '0ms');
  target.style.fontSize = `${rootFontSize(values.fontSize)}px`;
  target.dataset.interfaceSize = values.interfaceSize;
  target.dataset.panelAnimation = values.panelAnimation ? 'on' : 'off';
}

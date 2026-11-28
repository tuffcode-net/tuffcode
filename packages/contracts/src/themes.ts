/**
 * Built-in theme ids and their base scheme.
 *
 * The ids live in contracts because three sides need them: the settings schema, the
 * renderer palette registry, and the desktop main process, which paints the native
 * title bar before the renderer boots. The colors themselves live in
 * `@tuffcode/ui/themes` so the contract package stays free of presentation data.
 */
export const THEME_IDS = [
  'dark',
  'light',
  'one-dark-pro',
  'dracula',
  'nord',
  'solarized-dark',
  'solarized-light',
  'github-dark',
  'github-light',
  'monokai',
  'tokyo-night',
  'catppuccin-mocha',
  'catppuccin-latte',
  'gruvbox-dark',
  'material-palenight',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME_ID: ThemeId = 'dark';

export const THEME_BASE: Record<ThemeId, 'dark' | 'light'> = {
  dark: 'dark',
  light: 'light',
  'one-dark-pro': 'dark',
  dracula: 'dark',
  nord: 'dark',
  'solarized-dark': 'dark',
  'solarized-light': 'light',
  'github-dark': 'dark',
  'github-light': 'light',
  monokai: 'dark',
  'tokyo-night': 'dark',
  'catppuccin-mocha': 'dark',
  'catppuccin-latte': 'light',
  'gruvbox-dark': 'dark',
  'material-palenight': 'dark',
};

export const THEME_LABEL: Record<ThemeId, string> = {
  dark: 'Dark',
  light: 'Light',
  'one-dark-pro': 'One Dark Pro',
  dracula: 'Dracula',
  nord: 'Nord',
  'solarized-dark': 'Solarized Dark',
  'solarized-light': 'Solarized Light',
  'github-dark': 'GitHub Dark',
  'github-light': 'GitHub Light',
  monokai: 'Monokai',
  'tokyo-night': 'Tokyo Night',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'catppuccin-latte': 'Catppuccin Latte',
  'gruvbox-dark': 'Gruvbox Dark',
  'material-palenight': 'Material Palenight',
};

export function isThemeId(value: string): value is ThemeId {
  return (THEME_IDS as readonly string[]).includes(value);
}

export function themeBase(id: string): 'dark' | 'light' {
  return isThemeId(id) ? THEME_BASE[id] : 'dark';
}

/** Themes whose chrome and text need the light title bar. */
export function isLightTheme(id: string): boolean {
  return themeBase(id) === 'light';
}

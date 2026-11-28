/**
 * Built-in color palettes.
 *
 * A palette is the 37 design tokens plus a terminal ANSI set and the Shiki theme used
 * for code. Only a handful of colors are authored per theme; the rest are derived so
 * every theme keeps the same contrast relationships. `applyThemePalette` writes the
 * tokens as CSS variables on `<html>`, which is the same surface `tokens.css` uses.
 */
import type { ThemeId } from '@tuffcode/contracts';
import { THEME_LABEL } from '@tuffcode/contracts';
import type { ITheme } from '@xterm/xterm';
import type { BundledTheme } from 'shiki';

/** The color tokens tokens.css maps onto Tailwind utilities. */
export const THEME_TOKEN_NAMES = [
  'background',
  'surface-raised',
  'foreground',
  'card',
  'popover',
  'primary',
  'primary-foreground',
  'primary-soft',
  'secondary',
  'muted',
  'muted-foreground',
  'accent',
  'overlay',
  'message-surface',
  'error',
  'error-foreground',
  'error-surface',
  'border',
  'input',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'warning-surface',
  'info',
  'info-foreground',
  'ring',
  'plan-foreground',
  'sidebar',
  'sidebar-foreground',
  'sidebar-muted-foreground',
  'sidebar-row-hover',
  'sidebar-row-active',
  'sidebar-row-selected',
  'sidebar-border',
  'terminal-background',
  'terminal-foreground',
  'terminal-cursor',
  'terminal-selection',
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

export const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type AnsiName = (typeof ANSI_NAMES)[number];

export interface ThemePalette {
  id: ThemeId;
  label: string;
  base: 'dark' | 'light';
  /** Shiki theme used for markdown code blocks and the diff viewer. */
  syntax: BundledTheme;
  tokens: Record<ThemeTokenName, string>;
  ansi: Record<AnsiName, string>;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function rgbOf(hex: string): Rgb {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function hexOf(rgb: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** `percent` is the share of `b`: 0 returns `a`, 100 returns `b`. */
function mix(a: string, b: string, percent: number): string {
  const t = percent / 100;
  const left = rgbOf(a);
  const right = rgbOf(b);
  return hexOf({
    r: left.r + (right.r - left.r) * t,
    g: left.g + (right.g - left.g) * t,
    b: left.b + (right.b - left.b) * t,
  });
}

function alpha(hex: string, percent: number): string {
  const { r, g, b } = rgbOf(hex);
  return `rgb(${String(r)} ${String(g)} ${String(b)} / ${String(percent)}%)`;
}

/** Black or white, whichever reads better on `hex`. */
function contrast(hex: string): string {
  const { r, g, b } = rgbOf(hex);
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

function luminanceOf(hex: string): number {
  const { r, g, b } = rgbOf(hex);
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const first = luminanceOf(a);
  const second = luminanceOf(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** OKLab coordinates, for perceptual distance between two theme colors. */
function oklabOf(hex: string): { l: number; a: number; b: number } {
  const { r, g, b } = rgbOf(hex);
  const linear = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * Resolves the CSS color syntaxes a palette uses into a hex string, so contrast can be
 * measured for authored values (`oklch`, `rgb`) as well as plain hex.
 */
export function colorToHex(value: string, tokens?: Record<string, string>): string {
  const text = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(text);
  if (short?.[1] !== undefined) {
    const [r, g, b] = short[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(text);
  if (oklch) {
    return hexOfOklch({
      l: Number(oklch[1]),
      c: Number(oklch[2]),
      h: Number(oklch[3]),
    });
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*[\d.]+%?\s*)?\)$/i.exec(text);
  if (rgb) {
    return hexOf({ r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) });
  }
  const reference = /^var\(--([\w-]+)\)$/.exec(text);
  const referenced = reference?.[1] === undefined ? undefined : tokens?.[reference[1]];
  if (referenced !== undefined) return colorToHex(referenced, tokens);
  throw new Error(`cannot resolve the palette color ${text}`);
}

/** Perceptual distance between two colors; 0.12 is clearly apart at chip size. */
export function oklabDistance(first: string, second: string): number {
  const a = oklabOf(first);
  const b = oklabOf(second);
  return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}

interface Oklch {
  l: number;
  c: number;
  h: number;
}

function oklchOf(hex: string): Oklch {
  const { l, a, b } = oklabOf(hex);
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

function hexOfOklch({ l, c, h }: Oklch): string {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (unit: number): number => {
    const clamped = Math.max(0, Math.min(1, unit));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return hexOf({
    r: encode(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3) * 255,
    g: encode(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3) * 255,
    b: encode(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3) * 255,
  });
}

/**
 * Steps a color's lightness, keeping its chroma and hue, until it clears the floor
 * against `background`. Mixing toward white would wash the hue out, which is wrong
 * for a status marker that has to stay recognisable.
 */
function readableLightness(color: string, background: string, floor: number): string {
  const start = oklchOf(color);
  const up = luminanceOf(background) < 0.18;
  for (let step = 0; step < 80; step += 1) {
    const l = Math.max(0, Math.min(1, start.l + (up ? 0.015 : -0.015) * step));
    const candidate = hexOfOklch({ ...start, l });
    if (contrastRatio(candidate, background) >= floor) return candidate;
  }
  return hexOfOklch(start);
}

/**
 * The plan-ready marker's own color: the palette's magenta, its lightness raised until
 * it clears 5:1, and its hue rotated away from the palette's running blue until the two
 * are perceptually apart. Dracula's running color is violet, so a fixed violet plan
 * marker would be the same dot twice.
 */
function planForeground(core: CorePalette, infoForeground: string, background: string): string {
  const start = oklchOf(core.magenta);
  const chroma = Math.min(start.c, 0.16);
  const offsets = [0];
  for (let step = 1; step < 13; step += 1) offsets.push(-15 * step, 15 * step);
  let last = '';
  for (const offset of offsets) {
    last = readableLightness(
      hexOfOklch({ l: start.l, c: chroma, h: (start.h + offset + 360) % 360 }),
      background,
      5,
    );
    if (oklabDistance(last, infoForeground) >= 0.12) return last;
  }
  return last;
}

/** Steps a text color toward the readable extreme until it clears the floor. */
function readable(color: string, background: string, floor = 4.5): string {
  let next = color;
  const target = contrast(background);
  for (let step = 0; step < 12 && contrastRatio(next, background) < floor; step += 1) {
    next = mix(next, target, 15);
  }
  return next;
}

/** One theme's authored colors. Everything else is derived. */
interface CorePalette {
  background: string;
  foreground: string;
  surface: string;
  border: string;
  /** The theme's link/focus color, mapped to `--primary`. */
  accent: string;
  mutedForeground: string;
  green: string;
  red: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  sidebar?: string;
  syntax: BundledTheme;
  base: 'dark' | 'light';
}

const CORE: Record<ThemeId, CorePalette> = {
  dark: {
    background: '#000000',
    foreground: '#f5f5f5',
    surface: '#131313',
    border: '#232323',
    accent: '#635bff',
    mutedForeground: '#a1a1a1',
    green: '#10b981',
    red: '#fb414a',
    yellow: '#fe9a00',
    blue: '#3b82f6',
    magenta: '#c026d3',
    cyan: '#06b6d4',
    sidebar: '#000000',
    syntax: 'github-dark-default',
    base: 'dark',
  },
  light: {
    background: '#ffffff',
    foreground: '#111113',
    surface: '#f7f7f8',
    border: '#e4e4e7',
    accent: '#635bff',
    mutedForeground: '#5f6067',
    green: '#047857',
    red: '#d92d20',
    yellow: '#b45309',
    blue: '#2563eb',
    magenta: '#a21caf',
    cyan: '#0e7490',
    sidebar: '#fafafa',
    syntax: 'github-light-default',
    base: 'light',
  },
  'one-dark-pro': {
    background: '#282c34',
    foreground: '#abb2bf',
    surface: '#21252b',
    border: '#181a1f',
    accent: '#61afef',
    mutedForeground: '#5c6370',
    green: '#8cc265',
    red: '#e05561',
    yellow: '#d18f52',
    blue: '#4aa5f0',
    magenta: '#c162de',
    cyan: '#42b3c2',
    syntax: 'one-dark-pro',
    base: 'dark',
  },
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    surface: '#343746',
    border: '#191a21',
    accent: '#bd93f9',
    mutedForeground: '#6272a4',
    green: '#50fa7b',
    red: '#ff5555',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    sidebar: '#21222c',
    syntax: 'dracula',
    base: 'dark',
  },
  nord: {
    background: '#2e3440',
    foreground: '#d8dee9',
    surface: '#3b4252',
    border: '#434c5e',
    accent: '#88c0d0',
    mutedForeground: '#4c566a',
    green: '#a3be8c',
    red: '#bf616a',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    sidebar: '#2e3440',
    syntax: 'nord',
    base: 'dark',
  },
  'solarized-dark': {
    background: '#002b36',
    foreground: '#839496',
    surface: '#073642',
    border: '#586e75',
    accent: '#268bd2',
    mutedForeground: '#586e75',
    green: '#859900',
    red: '#dc322f',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    syntax: 'solarized-dark',
    base: 'dark',
  },
  'solarized-light': {
    background: '#fdf6e3',
    foreground: '#657b83',
    surface: '#eee8d5',
    border: '#93a1a1',
    accent: '#268bd2',
    mutedForeground: '#93a1a1',
    green: '#859900',
    red: '#dc322f',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    syntax: 'solarized-light',
    base: 'light',
  },
  'github-dark': {
    background: '#0d1117',
    foreground: '#e6edf3',
    surface: '#161b22',
    border: '#30363d',
    accent: '#1f6feb',
    mutedForeground: '#7d8590',
    green: '#3fb950',
    red: '#ff7b72',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    sidebar: '#010409',
    syntax: 'github-dark',
    base: 'dark',
  },
  'github-light': {
    background: '#ffffff',
    foreground: '#1f2328',
    surface: '#f6f8fa',
    border: '#d0d7de',
    accent: '#0969da',
    mutedForeground: '#656d76',
    green: '#116329',
    red: '#cf222e',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    syntax: 'github-light',
    base: 'light',
  },
  monokai: {
    background: '#272822',
    foreground: '#f8f8f2',
    surface: '#1e1f1c',
    border: '#34352f',
    accent: '#99947c',
    mutedForeground: '#75715e',
    green: '#86b42b',
    red: '#c4265e',
    yellow: '#b3b42b',
    blue: '#6a7ec8',
    magenta: '#8c6bc8',
    cyan: '#56adbc',
    syntax: 'monokai',
    base: 'dark',
  },
  'tokyo-night': {
    background: '#1a1b26',
    foreground: '#a9b1d6',
    surface: '#16161e',
    border: '#101014',
    accent: '#7aa2f7',
    mutedForeground: '#565f89',
    green: '#73daca',
    red: '#f7768e',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    syntax: 'tokyo-night',
    base: 'dark',
  },
  'catppuccin-mocha': {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    surface: '#313244',
    border: '#45475a',
    accent: '#cba6f7',
    mutedForeground: '#a6adc8',
    green: '#a6e3a1',
    red: '#f38ba8',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    syntax: 'catppuccin-mocha',
    base: 'dark',
  },
  'catppuccin-latte': {
    background: '#eff1f5',
    foreground: '#4c4f69',
    surface: '#ccd0da',
    border: '#bcc0cc',
    accent: '#8839ef',
    mutedForeground: '#6c6f85',
    green: '#40a02b',
    red: '#d20f39',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    syntax: 'catppuccin-latte',
    base: 'light',
  },
  'gruvbox-dark': {
    background: '#282828',
    foreground: '#ebdbb2',
    surface: '#3c3836',
    border: '#504945',
    accent: '#fabd2f',
    mutedForeground: '#928374',
    green: '#b8bb26',
    red: '#fb4934',
    yellow: '#fabd2f',
    blue: '#83a598',
    magenta: '#d3869b',
    cyan: '#8ec07c',
    syntax: 'gruvbox-dark-medium',
    base: 'dark',
  },
  'material-palenight': {
    background: '#292d3e',
    foreground: '#a6accd',
    surface: '#34324a',
    border: '#2b2a3e',
    accent: '#ab47bc',
    mutedForeground: '#676e95',
    green: '#c3e88d',
    red: '#f07178',
    yellow: '#ffcb6b',
    blue: '#82aaff',
    magenta: '#c792ea',
    cyan: '#89ddff',
    syntax: 'material-theme-palenight',
    base: 'dark',
  },
};

/**
 * The Dark and Light tokens exactly as authored in `tokens.css`. These two themes are
 * copied, not derived: they are what the app shipped before named themes existed, so a
 * user who never opens Appearance must see the same colors after an upgrade.
 * `tokens-css.test.ts` fails when these drift from `tokens.css`.
 */
const DEFAULT_TOKENS: Record<'dark' | 'light', Record<ThemeTokenName, string>> = {
  dark: {
    background: '#000',
    'surface-raised': '#131313',
    foreground: '#f5f5f5',
    card: '#131313',
    popover: '#131313',
    primary: 'oklch(0.571 0.21 264)',
    'primary-foreground': '#ffffff',
    'primary-soft': '#6b63ff',
    secondary: 'rgb(255 255 255 / 3%)',
    muted: 'rgb(255 255 255 / 3%)',
    'muted-foreground': '#a1a1a1',
    accent: 'rgb(255 255 255 / 4%)',
    overlay: 'rgb(0 0 0 / 60%)',
    'message-surface': '#1e1e1e',
    error: '#fb414a',
    'error-foreground': '#ff6467',
    'error-surface': 'color-mix(in srgb, #fb414a 16%, transparent)',
    border: 'rgb(255 255 255 / 8%)',
    input: 'rgb(255 255 255 / 11%)',
    success: '#10b981',
    'success-foreground': '#34d399',
    warning: '#fe9a00',
    'warning-foreground': '#ffb900',
    'warning-surface': 'color-mix(in srgb, #fe9a00 16%, transparent)',
    info: '#3b82f6',
    'info-foreground': '#60a5fa',
    ring: 'var(--primary)',
    'plan-foreground': '#ae5db9',
    sidebar: '#000',
    'sidebar-foreground': '#f1f3f7',
    'sidebar-muted-foreground': '#a3a3a3',
    'sidebar-row-hover': '#131313',
    'sidebar-row-active': '#1a1b1b',
    'sidebar-row-selected': '#111111',
    'sidebar-border': '#141414',
    'terminal-background': '#0a0a0a',
    'terminal-foreground': '#f5f5f5',
    'terminal-cursor': '#b4cbff',
    'terminal-selection': '#343a47',
  },
  light: {
    background: '#ffffff',
    'surface-raised': '#f7f7f8',
    foreground: '#111113',
    card: '#ffffff',
    popover: '#ffffff',
    primary: 'oklch(0.571 0.21 264)',
    'primary-foreground': '#ffffff',
    'primary-soft': '#635bff',
    secondary: 'rgb(0 0 0 / 4%)',
    muted: 'rgb(0 0 0 / 4%)',
    'muted-foreground': '#5f6067',
    accent: 'rgb(0 0 0 / 6%)',
    overlay: 'rgb(0 0 0 / 35%)',
    'message-surface': '#f4f4f5',
    error: '#d92d20',
    'error-foreground': '#b42318',
    'error-surface': 'color-mix(in srgb, #d92d20 10%, transparent)',
    border: 'rgb(0 0 0 / 10%)',
    input: 'rgb(0 0 0 / 14%)',
    success: '#047857',
    'success-foreground': '#059669',
    warning: '#b45309',
    'warning-foreground': '#d97706',
    'warning-surface': 'color-mix(in srgb, #b45309 10%, transparent)',
    info: '#2563eb',
    'info-foreground': '#1d4ed8',
    ring: 'var(--primary)',
    'plan-foreground': '#93419b',
    sidebar: '#fafafa',
    'sidebar-foreground': '#18181b',
    'sidebar-muted-foreground': '#6b7280',
    'sidebar-row-hover': '#f4f4f5',
    'sidebar-row-active': '#ebebed',
    'sidebar-row-selected': '#efeff1',
    'sidebar-border': '#e4e4e7',
    'terminal-background': '#ffffff',
    'terminal-foreground': '#18181b',
    'terminal-cursor': '#3b5bdb',
    'terminal-selection': '#dbe4ff',
  },
};

/**
 * xterm's own ANSI palette. Dark and Light keep it so the terminal looks exactly as it
 * did before named themes existed; the other palettes derive one from their colors.
 */
const XTERM_DEFAULT_ANSI: Record<AnsiName, string> = {
  black: '#000000',
  red: '#cd0000',
  green: '#00cd00',
  yellow: '#cdcd00',
  blue: '#0000ee',
  magenta: '#cd00cd',
  cyan: '#00cdcd',
  white: '#e5e5e5',
  brightBlack: '#7f7f7f',
  brightRed: '#ff0000',
  brightGreen: '#00ff00',
  brightYellow: '#ffff00',
  brightBlue: '#5c5cff',
  brightMagenta: '#ff00ff',
  brightCyan: '#00ffff',
  brightWhite: '#ffffff',
};

function buildPalette(id: ThemeId, core: CorePalette): ThemePalette {
  const { background, foreground, surface, border, accent } = core;
  const dark = core.base === 'dark';
  const sidebar = core.sidebar ?? mix(background, surface, 50);
  const infoForeground = readable(core.blue, background);
  const derived: Record<ThemeTokenName, string> = {
    background,
    'surface-raised': surface,
    foreground,
    card: surface,
    popover: surface,
    primary: accent,
    'primary-foreground': contrast(accent),
    'primary-soft': readableLightness(accent, background, 4.5),
    secondary: alpha(foreground, 6),
    muted: alpha(foreground, 6),
    'muted-foreground': readable(core.mutedForeground, background),
    accent: alpha(foreground, 8),
    overlay: dark ? 'rgb(0 0 0 / 60%)' : 'rgb(0 0 0 / 35%)',
    'message-surface': mix(surface, foreground, 6),
    error: core.red,
    'error-foreground': readable(core.red, background),
    'error-surface': `color-mix(in srgb, ${core.red} 16%, transparent)`,
    border,
    input: alpha(foreground, 18),
    success: core.green,
    'success-foreground': readable(core.green, background),
    warning: core.yellow,
    'warning-foreground': readable(core.yellow, background),
    'warning-surface': `color-mix(in srgb, ${core.yellow} 16%, transparent)`,
    info: core.blue,
    'info-foreground': infoForeground,
    ring: accent,
    'plan-foreground': planForeground(core, infoForeground, background),
    sidebar,
    'sidebar-foreground': foreground,
    'sidebar-muted-foreground': readable(core.mutedForeground, sidebar),
    'sidebar-row-hover': surface,
    'sidebar-row-active': mix(surface, foreground, 12),
    'sidebar-row-selected': mix(surface, foreground, 6),
    'sidebar-border': border,
    'terminal-background': mix(background, surface, 40),
    'terminal-foreground': foreground,
    'terminal-cursor': accent,
    'terminal-selection': mix(surface, accent, 35),
  };

  const exact = id === 'dark' || id === 'light' ? DEFAULT_TOKENS[id] : null;
  const tokens: Record<ThemeTokenName, string> = exact === null ? derived : { ...exact };

  const bright = (color: string): string => mix(color, dark ? '#ffffff' : '#000000', 18);
  const derivedAnsi: Record<AnsiName, string> = {
    black: mix(background, '#000000', 50),
    red: core.red,
    green: core.green,
    yellow: core.yellow,
    blue: core.blue,
    magenta: core.magenta,
    cyan: core.cyan,
    white: foreground,
    brightBlack: core.mutedForeground,
    brightRed: bright(core.red),
    brightGreen: bright(core.green),
    brightYellow: bright(core.yellow),
    brightBlue: bright(core.blue),
    brightMagenta: bright(core.magenta),
    brightCyan: bright(core.cyan),
    brightWhite: mix(foreground, '#ffffff', 25),
  };
  const ansi: Record<AnsiName, string> = exact === null ? derivedAnsi : { ...XTERM_DEFAULT_ANSI };

  return {
    id,
    label: THEME_LABEL[id],
    base: core.base,
    syntax: core.syntax,
    tokens,
    ansi,
  };
}

export const PALETTES: Record<ThemeId, ThemePalette> = Object.fromEntries(
  (Object.keys(CORE) as ThemeId[]).map((id) => [id, buildPalette(id, CORE[id])]),
) as Record<ThemeId, ThemePalette>;

export function paletteFor(id: string | undefined): ThemePalette {
  return id !== undefined && Object.hasOwn(PALETTES, id) ? PALETTES[id as ThemeId] : PALETTES.dark;
}

/** The xterm theme for a palette, including the 16 ANSI colors. */
export function paletteToXterm(palette: ThemePalette): ITheme {
  return {
    background: palette.tokens['terminal-background'],
    foreground: palette.tokens['terminal-foreground'],
    cursor: palette.tokens['terminal-cursor'],
    selectionBackground: palette.tokens['terminal-selection'],
    ...palette.ansi,
  };
}

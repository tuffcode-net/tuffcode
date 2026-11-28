import { THEME_BASE, THEME_IDS } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  ANSI_NAMES,
  PALETTES,
  THEME_TOKEN_NAMES,
  colorToHex,
  oklabDistance,
  paletteFor,
  paletteToXterm,
} from './palettes.js';

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((unit) =>
    unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Resolves a palette value and measures it against another resolved value. */
function contrastOf(palette: (typeof PALETTES)[keyof typeof PALETTES], a: string, b: string): number {
  return contrast(
    colorToHex(palette.tokens[a as keyof typeof palette.tokens], palette.tokens),
    colorToHex(palette.tokens[b as keyof typeof palette.tokens], palette.tokens),
  );
}

/** The 10 percent tint a status chip paints behind its label. */
function tintOf(background: string, color: string): string {
  const value = (hex: string): number[] => {
    const body = hex.replace('#', '');
    return [0, 2, 4].map((offset) => Number.parseInt(body.slice(offset, offset + 2), 16));
  };
  const back = value(background);
  const front = value(color);
  return `#${back
    .map((channel, index) => Math.round(channel + ((front[index] ?? 0) - channel) * 0.1))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  const light = Math.max(first, second);
  const dark = Math.min(first, second);
  return (light + 0.05) / (dark + 0.05);
}

describe('theme palettes', () => {
  it('covers every theme id with every token and ANSI color', () => {
    for (const id of THEME_IDS) {
      const palette = PALETTES[id];
      expect(palette, id).toBeDefined();
      expect(Object.keys(palette.tokens).toSorted(), id).toEqual([...THEME_TOKEN_NAMES].toSorted());
      expect(Object.keys(palette.ansi).toSorted(), id).toEqual([...ANSI_NAMES].toSorted());
      expect(palette.base, id).toBe(THEME_BASE[id]);
      expect(palette.label.length, id).toBeGreaterThan(0);
      expect(palette.syntax.length, id).toBeGreaterThan(0);
    }
  });

  it('keeps body text readable on every background', () => {
    for (const id of THEME_IDS) {
      const palette = PALETTES[id];
      expect(contrastOf(palette, 'foreground', 'background'), id).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps surfaces, secondary text and primary labels readable', () => {
    for (const id of THEME_IDS) {
      const palette = PALETTES[id];
      expect(contrastOf(palette, 'foreground', 'message-surface'), id).toBeGreaterThanOrEqual(3);
      expect(contrastOf(palette, 'muted-foreground', 'background'), id).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(palette, 'primary-foreground', 'primary'), id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps primary-soft readable as text on every palette', () => {
    for (const id of THEME_IDS) {
      const palette = PALETTES[id];
      expect(contrastOf(palette, 'primary-soft', 'background'), id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the plan marker readable and apart from the running marker', () => {
    for (const id of THEME_IDS) {
      const palette = PALETTES[id];
      const plan = colorToHex(palette.tokens['plan-foreground'], palette.tokens);
      const info = colorToHex(palette.tokens['info-foreground'], palette.tokens);
      const background = colorToHex(palette.tokens.background, palette.tokens);
      expect(contrast(plan, background), id).toBeGreaterThanOrEqual(4.5);
      // The chip paints a 10 percent tint of the marker behind its label.
      expect(contrast(plan, tintOf(background, plan)), `${id} chip`).toBeGreaterThanOrEqual(4.2);
      expect(oklabDistance(plan, info), `${id} distance`).toBeGreaterThanOrEqual(0.12);
    }
  });

  it('keeps bright ANSI colors distinct from their normal counterparts', () => {
    for (const id of THEME_IDS) {
      const palette = PALETTES[id];
      expect(palette.ansi.brightRed, id).not.toBe(palette.ansi.red);
      expect(palette.ansi.brightCyan, id).not.toBe(palette.ansi.cyan);
    }
  });

  it('falls back to dark for an unknown or missing id', () => {
    expect(paletteFor(undefined).id).toBe('dark');
    expect(paletteFor('not-a-theme').id).toBe('dark');
    expect(paletteFor('constructor').id).toBe('dark');
  });

  it('builds an xterm theme with all 16 ANSI colors', () => {
    const xterm = paletteToXterm(PALETTES.dracula);
    expect(xterm.background).toBe(PALETTES.dracula.tokens['terminal-background']);
    expect(xterm.red).toBe(PALETTES.dracula.ansi.red);
    expect(xterm.brightCyan).toBe(PALETTES.dracula.ansi.brightCyan);
    expect(Object.keys(xterm)).toEqual(
      expect.arrayContaining(['background', 'foreground', 'cursor', 'selectionBackground']),
    );
  });
});

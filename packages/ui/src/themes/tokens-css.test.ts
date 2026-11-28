import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTES, THEME_TOKEN_NAMES } from './palettes.js';

/**
 * `tokens.css` is what the app paints before the renderer boots and what it painted
 * before named themes existed. The Dark and Light palettes are copied from it, so this
 * test is the contract that keeps them from drifting apart: a token changed in one place
 * and not the other fails here instead of silently repainting every existing user.
 */
function block(source: string, selector: string): Record<string, string> {
  // Match the rule at the start of a line, not the selector named in the file header.
  const start = source.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`tokens.css has no ${selector} block`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  const body = source.slice(open + 1, close);
  const tokens: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      tokens[match[1].slice(2)] = match[2].replaceAll(/\s+/g, ' ').trim();
    }
  }
  return tokens;
}

const css = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
const rootTokens = block(css, ':root');
const lightTokens = block(css, "[data-theme='light']");

describe('tokens.css and the built-in palettes', () => {
  it('defines every palette token in both CSS blocks', () => {
    for (const name of THEME_TOKEN_NAMES) {
      expect(rootTokens[name], `:root --${name}`).toBeDefined();
      expect(lightTokens[name], `light --${name}`).toBeDefined();
    }
  });

  it('keeps the Dark palette identical to the :root block', () => {
    for (const name of THEME_TOKEN_NAMES) {
      expect(PALETTES.dark.tokens[name], `--${name}`).toBe(rootTokens[name]);
    }
  });

  it('keeps the Light palette identical to the light block', () => {
    for (const name of THEME_TOKEN_NAMES) {
      expect(PALETTES.light.tokens[name], `--${name}`).toBe(lightTokens[name]);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { isThemeId, themeBase, THEME_BASE, THEME_IDS, THEME_LABEL } from './themes.js';

describe('theme ids', () => {
  it('lists each id once and gives it a base and a label', () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    for (const id of THEME_IDS) {
      expect(THEME_BASE[id], id).toMatch(/^(dark|light)$/);
      expect(THEME_LABEL[id]?.length, id).toBeGreaterThan(0);
    }
  });

  it('recognises a known id and rejects anything else', () => {
    expect(isThemeId('nord')).toBe(true);
    expect(isThemeId('blue')).toBe(false);
    expect(themeBase('solarized-light')).toBe('light');
    expect(themeBase('unknown')).toBe('dark');
  });
});

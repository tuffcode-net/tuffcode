/**
 * Writes a palette's tokens onto the document. `tokens.css` keeps the dark values as
 * the first-paint fallback; every named theme overrides them inline, so the Tailwind
 * `@theme inline` mapping keeps working without a CSS block per theme.
 */
import type { ThemeId } from '@tuffcode/contracts';
import { paletteFor, type ThemePalette } from './palettes.js';

export function applyThemePalette(
  id: ThemeId,
  target: HTMLElement = document.documentElement,
): ThemePalette {
  const palette = paletteFor(id);
  target.classList.add('no-transitions');
  target.dataset.theme = palette.id;
  target.style.colorScheme = palette.base;
  if (typeof document !== 'undefined') {
    document
      .querySelector('meta[name="color-scheme"]')
      ?.setAttribute('content', palette.base);
  }
  for (const [token, value] of Object.entries(palette.tokens)) {
    target.style.setProperty(`--${token}`, value);
  }
  requestAnimationFrame(() => {
    target.classList.remove('no-transitions');
  });
  return palette;
}

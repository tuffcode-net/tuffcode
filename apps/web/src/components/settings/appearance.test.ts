import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, DENSITY_TOKENS, resolveTheme, rootFontSize } from './appearance';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface ThemeTarget {
  classList: { add(name: string): void; remove(name: string): void };
  dataset: { theme?: string };
  style: { colorScheme: string; setProperty(name: string, value: string): void };
}

function createTarget(): ThemeTarget {
  return {
    classList: { add: () => undefined, remove: () => undefined },
    dataset: {},
    style: { colorScheme: '', setProperty: () => undefined },
  };
}

/** Stubs the renderer globals `applyTheme` touches and records bridge calls. */
function stubWindow(prefersLight: boolean, calls: string[]): void {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: prefersLight }),
    tuffcode: { setTheme: (theme: string) => calls.push(theme) },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
}

describe('appearance values', () => {
  it('keeps the default font size at the design root', () => {
    expect(rootFontSize(14)).toBe(16);
    expect(rootFontSize(16)).toBeCloseTo(18.29, 2);
    expect(rootFontSize(12)).toBeCloseTo(13.71, 2);
  });

  it('scales density from compact to comfortable', () => {
    expect(DENSITY_TOKENS.compact.rowHeight).toBeLessThan(DENSITY_TOKENS.default.rowHeight);
    expect(DENSITY_TOKENS.default.rowHeight).toBeLessThan(DENSITY_TOKENS.comfortable.rowHeight);
    expect(DENSITY_TOKENS.compact.buttonHeight).toBeLessThan(DENSITY_TOKENS.default.buttonHeight);
    expect(DENSITY_TOKENS.default.buttonHeight).toBeLessThan(
      DENSITY_TOKENS.comfortable.buttonHeight,
    );
  });

  it('resolves the system theme against the OS preference', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('notifies the bridge on boot and again when the theme changes', () => {
    const calls: string[] = [];
    stubWindow(false, calls);
    const target = createTarget();

    // Boot applies the stored theme (dark by default), then settings switch to light.
    applyTheme('dark', target as unknown as HTMLElement);
    applyTheme('light', target as unknown as HTMLElement);

    expect(calls).toEqual(['dark', 'light']);
    expect(target.dataset.theme).toBe('light');
  });

  it('resolves system against prefers-color-scheme before notifying the bridge', () => {
    const calls: string[] = [];
    stubWindow(true, calls);
    const target = createTarget();

    applyTheme('system', target as unknown as HTMLElement);

    expect(calls).toEqual(['light']);
    expect(target.dataset.theme).toBe('light');
  });
});

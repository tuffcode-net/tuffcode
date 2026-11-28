import { THEME_BASE, THEME_IDS } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
// The module itself has no node imports; the package index does, and the renderer
// typecheck has no node types, so the test reaches the file directly.
import { LIGHT_THEME_IDS } from '../../../../../packages/shared/src/themes';

/**
 * The desktop main process paints the native chrome from `LIGHT_THEME_IDS` in
 * `@tuffcode/shared`, because it cannot import contracts. This is the one place that can
 * see both, so a light theme added to `THEME_BASE` without the shared list fails here
 * instead of giving that theme a dark title bar until the renderer boots.
 */
describe('light theme ids', () => {
  it('matches the light half of THEME_BASE exactly', () => {
    const fromContracts = THEME_IDS.filter((id) => THEME_BASE[id] === 'light').toSorted();
    expect([...LIGHT_THEME_IDS].toSorted()).toEqual(fromContracts);
  });
});

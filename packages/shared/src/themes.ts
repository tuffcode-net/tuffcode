/**
 * Theme ids whose base scheme is light.
 *
 * The desktop main process paints the native title bar before the renderer boots and
 * cannot import `@tuffcode/contracts`, so it reads this list instead. A test in the web
 * package asserts it matches the light half of `THEME_BASE`; adding a light theme to one
 * without the other fails there instead of painting dark chrome over a light page.
 */
export const LIGHT_THEME_IDS = [
  'light',
  'solarized-light',
  'github-light',
  'catppuccin-latte',
] as const;

export function isLightThemeId(id: string): boolean {
  return (LIGHT_THEME_IDS as readonly string[]).includes(id);
}

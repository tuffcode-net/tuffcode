/**
 * The settings information architecture. The order here is the order of the section
 * nav; every entry is also a route under /settings/<id>.
 */
export const SETTINGS_SECTIONS = [
  'appearance',
  'models',
  'remote',
  'your-tuffcode',
  'capabilities',
  'notifications',
  'plugins',
  'agents',
  'permissions',
  'terminal',
  'updates',
  'diagnostics',
  'keybindings',
  'about',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_SECTION_LABEL: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  models: 'Models',
  remote: 'Remote access',
  'your-tuffcode': 'Your Tuffcode',
  capabilities: 'Capabilities',
  notifications: 'Notifications',
  plugins: 'Plugins',
  agents: 'Agents and tools',
  permissions: 'Permissions',
  terminal: 'Terminal',
  updates: 'Updates',
  diagnostics: 'Diagnostics',
  keybindings: 'Keybindings',
  about: 'About',
};

/**
 * Routes that shipped before this layout. They keep working and render the section
 * they were folded into.
 */
const LEGACY_SECTIONS: Record<string, SettingsSection> = {
  general: 'appearance',
  providers: 'models',
  instructions: 'your-tuffcode',
  brain: 'your-tuffcode',
  mcp: 'plugins',
};

export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'appearance';

export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/** Maps a route segment to a section; unknown segments return null. */
export function parseSettingsSection(value: string | undefined): SettingsSection | null {
  if (value === undefined || value === '') return DEFAULT_SETTINGS_SECTION;
  if (isSettingsSection(value)) return value;
  return LEGACY_SECTIONS[value] ?? null;
}

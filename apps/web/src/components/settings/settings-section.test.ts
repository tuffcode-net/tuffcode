import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTION_LABEL,
  SETTINGS_SECTIONS,
  parseSettingsSection,
} from './settings-section';

describe('settings sections', () => {
  it('keeps the round 4 order', () => {
    expect(SETTINGS_SECTIONS).toEqual([
      'appearance',
      'models',
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
    ]);
  });

  it('labels every section', () => {
    expect(SETTINGS_SECTIONS.map((id) => SETTINGS_SECTION_LABEL[id])).toEqual([
      'Appearance',
      'Models',
      'Your Tuffcode',
      'Capabilities',
      'Notifications',
      'Plugins',
      'Agents and tools',
      'Permissions',
      'Terminal',
      'Updates',
      'Diagnostics',
      'Keybindings',
      'About',
    ]);
    expect(new Set(SETTINGS_SECTIONS.map((id) => SETTINGS_SECTION_LABEL[id])).size).toBe(
      SETTINGS_SECTIONS.length,
    );
  });

  it('folds the retired sections into their new homes', () => {
    expect(parseSettingsSection('providers')).toBe('models');
    expect(parseSettingsSection('instructions')).toBe('your-tuffcode');
    expect(parseSettingsSection('brain')).toBe('your-tuffcode');
    expect(parseSettingsSection('mcp')).toBe('plugins');
  });

  it('defaults to the first section when the route has none', () => {
    expect(parseSettingsSection(undefined)).toBe(DEFAULT_SETTINGS_SECTION);
    expect(parseSettingsSection('')).toBe(DEFAULT_SETTINGS_SECTION);
    expect(DEFAULT_SETTINGS_SECTION).toBe('appearance');
  });

  it('accepts every known section', () => {
    for (const id of SETTINGS_SECTIONS) expect(parseSettingsSection(id)).toBe(id);
  });

  it('maps the retired general route to appearance', () => {
    expect(parseSettingsSection('general')).toBe('appearance');
  });

  it('rejects unknown sections', () => {
    expect(parseSettingsSection('nope')).toBeNull();
    expect(parseSettingsSection('General')).toBeNull();
  });
});

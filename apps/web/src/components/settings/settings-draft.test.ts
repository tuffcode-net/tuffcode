import { DEFAULT_SETTINGS, SettingsPatchSchema, type Settings } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildSettingsPatch,
  changedSettingsKeys,
  isSettingsDraftDirty,
  pickSettings,
  shellFieldError,
  shouldReseedDraft,
} from './settings-draft';

const APPEARANCE_KEYS = ['theme', 'fontSize', 'sidebarWidth', 'panelAnimation'] as const;
const TOOL_KEYS = ['enabledTools', 'shell'] as const;

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('pickSettings', () => {
  it('copies only the requested keys', () => {
    const picked = pickSettings(settings({ theme: 'light', logLevel: 'debug' }), APPEARANCE_KEYS);
    expect(picked).toEqual({
      theme: 'light',
      fontSize: DEFAULT_SETTINGS.fontSize,
      sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
      panelAnimation: DEFAULT_SETTINGS.panelAnimation,
    });
    expect('logLevel' in picked).toBe(false);
  });
});

describe('settings draft dirty state', () => {
  it('is clean against the stored settings', () => {
    const stored = settings();
    expect(
      isSettingsDraftDirty(pickSettings(stored, APPEARANCE_KEYS), stored, APPEARANCE_KEYS),
    ).toBe(false);
    expect(
      changedSettingsKeys(pickSettings(stored, APPEARANCE_KEYS), stored, APPEARANCE_KEYS),
    ).toEqual([]);
  });

  it('reports the keys that changed', () => {
    const stored = settings();
    const draft = { ...pickSettings(stored, APPEARANCE_KEYS), fontSize: 16 };
    expect(changedSettingsKeys(draft, stored, APPEARANCE_KEYS)).toEqual(['fontSize']);
    expect(isSettingsDraftDirty(draft, stored, APPEARANCE_KEYS)).toBe(true);
  });

  it('treats a re-ordered tool list as dirty but an equal copy as clean', () => {
    const stored = settings({ enabledTools: ['bash', 'read', 'edit'] });
    const equal = { ...pickSettings(stored, TOOL_KEYS), enabledTools: ['bash', 'read', 'edit'] };
    const reordered = {
      ...pickSettings(stored, TOOL_KEYS),
      enabledTools: ['read', 'bash', 'edit'],
    };

    expect(isSettingsDraftDirty(equal, stored, TOOL_KEYS)).toBe(false);
    expect(isSettingsDraftDirty(reordered, stored, TOOL_KEYS)).toBe(true);
  });

  it('ignores whitespace around the shell', () => {
    const stored = settings({ shell: 'pwsh.exe' });
    const padded = { ...pickSettings(stored, TOOL_KEYS), shell: '  pwsh.exe  ' };
    const blankStored = settings({ shell: null });
    const blankDraft = { ...pickSettings(blankStored, TOOL_KEYS), shell: '   ' };

    expect(isSettingsDraftDirty(padded, stored, TOOL_KEYS)).toBe(false);
    expect(isSettingsDraftDirty(blankDraft, blankStored, TOOL_KEYS)).toBe(false);
  });
});

describe('buildSettingsPatch', () => {
  it('sends only changed keys', () => {
    const stored = settings({ shell: 'bash' });
    const draft = { ...pickSettings(stored, TOOL_KEYS), enabledTools: ['read'] };
    const patch = buildSettingsPatch(draft, stored, TOOL_KEYS);

    expect(patch).toEqual({ enabledTools: ['read'] });
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('trims the shell and turns a blank shell into null', () => {
    const stored = settings({ shell: null });
    const draft = { ...pickSettings(stored, TOOL_KEYS), shell: '  C:/PowerShell/pwsh.exe ' };
    expect(buildSettingsPatch(draft, stored, TOOL_KEYS)).toEqual({
      shell: 'C:/PowerShell/pwsh.exe',
    });

    const cleared = buildSettingsPatch(
      { ...pickSettings(settings({ shell: 'bash' }), TOOL_KEYS), shell: '' },
      settings({ shell: 'bash' }),
      TOOL_KEYS,
    );
    expect(cleared).toEqual({ shell: null });
  });

  it('is empty when nothing changed', () => {
    const stored = settings();
    const patch = buildSettingsPatch(
      pickSettings(stored, APPEARANCE_KEYS),
      stored,
      APPEARANCE_KEYS,
    );
    expect(patch).toEqual({});
  });

  it('produces patches the wire schema accepts', () => {
    const stored = settings();
    const draft = {
      ...pickSettings(stored, APPEARANCE_KEYS),
      theme: 'light' as const,
      sidebarWidth: 300,
      panelAnimation: true,
    };
    const patch = buildSettingsPatch(draft, stored, APPEARANCE_KEYS);
    expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
    expect(patch).toEqual({ theme: 'light', sidebarWidth: 300, panelAnimation: true });
  });
});

describe('shellFieldError', () => {
  it('accepts blank shells and paths with spaces', () => {
    expect(shellFieldError('')).toBeUndefined();
    expect(shellFieldError('C:/Program Files/PowerShell/7/pwsh.exe')).toBeUndefined();
  });

  it('rejects control characters', () => {
    expect(shellFieldError('pwsh.exe\nwhoami')).toBe('Shell cannot contain control characters.');
    expect(shellFieldError('pwsh.exe\t')).toBeUndefined();
  });
});

describe('shouldReseedDraft', () => {
  it('follows the server when the draft is missing or clean', () => {
    const stored = settings({ theme: 'dark', fontSize: 14 });
    expect(shouldReseedDraft(null, stored, APPEARANCE_KEYS)).toBe(true);
    expect(shouldReseedDraft(pickSettings(stored, APPEARANCE_KEYS), stored, APPEARANCE_KEYS)).toBe(
      true,
    );
  });

  it('keeps unsaved edits when a per-key save updates the server', () => {
    const stored = settings({ theme: 'dark', fontSize: 14 });
    const draft = { ...pickSettings(stored, APPEARANCE_KEYS), fontSize: 18 };

    // The theme picker saved `theme`; the draft's unsaved font size must survive.
    const afterSave = settings({ theme: 'light', fontSize: 14 });
    expect(shouldReseedDraft(draft, afterSave, APPEARANCE_KEYS)).toBe(false);
  });

  it('does nothing before settings arrive', () => {
    expect(shouldReseedDraft(null, null, APPEARANCE_KEYS)).toBe(false);
  });
});

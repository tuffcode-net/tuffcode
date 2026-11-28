import type { Settings } from '@tuffcode/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import {
  buildSettingsPatch,
  isSettingsDraftDirty,
  pickSettings,
  shouldReseedDraft,
  type SettingsKey,
} from './settings-draft';

export interface SettingsDraftController<K extends SettingsKey> {
  draft: Pick<Settings, K> | null;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  update(patch: Partial<Pick<Settings, K>>): void;
  reset(): void;
  submit(): Promise<void>;
  /** Persists one patch immediately, for controls that apply on click. */
  save(patch: Partial<Pick<Settings, K>>): Promise<void>;
}

/**
 * Draft state for one settings section. `keys` must be a module-level constant:
 * it decides which fields the section owns, and the section only ever patches
 * the fields it changed, so two sections cannot overwrite each other.
 */
export function useSettingsDraft<K extends SettingsKey>(
  keys: readonly K[],
): SettingsDraftController<K> {
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const rpc = useRpc();
  const signature = keys.join('|');

  const [draft, setDraft] = useState<Pick<Settings, K> | null>(() =>
    settings ? pickSettings(settings, keys) : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () => (draft && settings ? isSettingsDraftDirty(draft, settings, keys) : false),
    [draft, settings, signature], // oxlint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    // Re-seed on a server change only when the draft has no local edits: a per-key
    // save (the theme picker) must not discard the section's other unsaved fields.
    if (settings !== null && shouldReseedDraft(draft, settings, keys)) {
      setDraft(pickSettings(settings, keys));
    }
    // `keys` is a module constant; the signature tracks its contents.
  }, [settings, signature, dirty]); // oxlint-disable-line react-hooks/exhaustive-deps

  const update = useCallback((patch: Partial<Pick<Settings, K>>) => {
    setDraft((previous) => (previous === null ? previous : { ...previous, ...patch }));
    setError(null);
  }, []);

  const reset = useCallback(() => {
    if (!settings) return;
    setDraft(pickSettings(settings, keys));
    setError(null);
  }, [settings, signature]); // oxlint-disable-line react-hooks/exhaustive-deps

  const submit = useCallback(async () => {
    if (!draft || !settings) return;
    const patch = buildSettingsPatch(draft, settings, keys);
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const next = await rpc.request('settings.set', { patch });
      setSettings(next);
      toast.success('Settings saved.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }, [draft, settings, keys, rpc, setSettings]);

  const save = useCallback(
    async (patch: Partial<Pick<Settings, K>>) => {
      setSaving(true);
      setError(null);
      try {
        const next = await rpc.request('settings.set', { patch });
        setSettings(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not save settings.');
      } finally {
        setSaving(false);
      }
    },
    [rpc, setSettings],
  );

  return { draft, dirty, saving, error, update, reset, submit, save };
}

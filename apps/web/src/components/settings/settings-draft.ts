import type { Settings, SettingsPatch } from '@tuffcode/contracts';

export type SettingsKey = keyof Settings;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Values a section edits, compared by value rather than by reference so an
 * untouched array (enabled tools) or nested choice (subagent models) does not
 * look dirty after a re-render.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }
  return left === right;
}

/** Drops blank fields so a cleared subagent choice compares equal to an empty one. */
function normalizeSubagentModels(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const entries = Object.entries(value).map(([type, choice]) => {
    if (!isPlainObject(choice)) return [type, choice] as const;
    const cleaned: Record<string, string> = {};
    for (const [field, raw] of Object.entries(choice)) {
      if (typeof raw === 'string' && raw.trim().length > 0) cleaned[field] = raw.trim();
    }
    return [type, cleaned] as const;
  });
  return Object.fromEntries(entries);
}

/**
 * The server stores an empty shell as null, and the form edits it as a string,
 * so both sides are normalised before they are compared or patched.
 */
function normalize(key: SettingsKey, value: unknown): unknown {
  if (key === 'shell' && typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (key === 'subagentModels') return normalizeSubagentModels(value);
  return value;
}

/** Copies the settings keys a section edits out of the stored settings. */
export function pickSettings<K extends SettingsKey>(
  settings: Settings,
  keys: readonly K[],
): Pick<Settings, K> {
  const picked = {} as Pick<Settings, K>;
  for (const key of keys) picked[key] = settings[key];
  return picked;
}

/** Keys whose draft value differs from the stored settings. */
export function changedSettingsKeys<K extends SettingsKey>(
  draft: Pick<Settings, K>,
  settings: Settings,
  keys: readonly K[],
): K[] {
  return keys.filter(
    (key) => !sameValue(normalize(key, draft[key]), normalize(key, settings[key])),
  );
}

export function isSettingsDraftDirty<K extends SettingsKey>(
  draft: Pick<Settings, K>,
  settings: Settings,
  keys: readonly K[],
): boolean {
  return changedSettingsKeys(draft, settings, keys).length > 0;
}

/**
 * A `settings.set` patch containing only the keys that changed. Sending just the
 * changed keys keeps two sections editing different fields from overwriting each
 * other with stale values.
 */
/**
 * Whether a server settings change may replace a section's draft.
 *
 * A section that saves one key on click (the theme picker) still has other unsaved
 * fields in its draft; reseeding on every event would silently discard them. So a draft
 * with local edits keeps them, and a clean or missing draft follows the server.
 */
export function shouldReseedDraft<K extends SettingsKey>(
  draft: Pick<Settings, K> | null,
  settings: Settings | null,
  keys: readonly K[],
): boolean {
  if (settings === null) return false;
  if (draft === null) return true;
  return !isSettingsDraftDirty(draft, settings, keys);
}

export function buildSettingsPatch<K extends SettingsKey>(
  draft: Pick<Settings, K>,
  settings: Settings,
  keys: readonly K[],
): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of changedSettingsKeys(draft, settings, keys)) {
    patch[key] = normalize(key, draft[key]);
  }
  return patch as SettingsPatch;
}

/** Rejects control characters, which would break the shell invocation. */
export function shellFieldError(shell: string): string | undefined {
  for (const char of shell.trim()) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return 'Shell cannot contain control characters.';
  }
  return undefined;
}

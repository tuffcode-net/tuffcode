import type { Model, ProviderKind, ProviderView } from '@tuffcode/contracts';

/**
 * Where a provider's model list came from. `list` marks the `models.list`
 * fallback used when the server predates `providers.models`.
 */
export type ModelSource = 'sdk' | 'api' | 'manual' | 'cache' | 'list';

/**
 * Provider kinds get a fixed hue so the dot on the picker trigger and in
 * settings is recognizable at a glance. Hues reuse the status palette rather
 * than introducing new tokens.
 */
export const PROVIDER_DOT_CLASS: Record<ProviderKind, string> = {
  claude: 'bg-orange-400',
  codex: 'bg-emerald-400',
  anthropic: 'bg-violet-400',
  'openai-compatible': 'bg-sky-400',
  acp: 'bg-amber-400',
  opencode: 'bg-teal-400',
};

export function providerDotClass(kind: ProviderKind | undefined): string {
  return kind === undefined ? 'bg-muted-foreground' : PROVIDER_DOT_CLASS[kind];
}

export interface ModelGroup {
  providerId: string;
  label: string;
  models: Model[];
}

/** The label a row shows: the friendly label when it differs, else the id. */
export function modelDisplayLabel(model: Model): string {
  const label = model.label.trim();
  return label.length > 0 && label !== model.modelId ? label : model.modelId;
}

export function matchesModelQuery(model: Model, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return model.modelId.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle);
}

export function filterModels(models: readonly Model[], query: string): Model[] {
  return models.filter((model) => matchesModelQuery(model, query));
}

/**
 * Groups the filtered models by provider, dropping providers with no match so
 * an empty search result reads as an empty picker instead of empty headers.
 */
export function buildModelGroups(
  providers: readonly ProviderView[],
  modelsByProvider: Readonly<Record<string, readonly Model[] | undefined>>,
  query = '',
): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const provider of providers) {
    const models = filterModels(modelsByProvider[provider.id] ?? [], query);
    if (models.length === 0) continue;
    groups.push({ providerId: provider.id, label: provider.label, models });
  }
  return groups;
}

/** Flattens the groups in render order so arrow keys walk the visible rows. */
export function visibleModels(groups: readonly ModelGroup[]): Model[] {
  const models: Model[] = [];
  for (const group of groups) models.push(...group.models);
  return models;
}

export function activeModel(groups: readonly ModelGroup[], index: number): Model | null {
  const models = visibleModels(groups);
  if (models.length === 0) return null;
  const bounded = Math.min(Math.max(index, 0), models.length - 1);
  return models[bounded] ?? null;
}

export function initialActiveIndex(models: readonly Model[], value: string | null): number {
  if (value === null) return 0;
  const index = models.findIndex((model) => model.modelId === value);
  return index === -1 ? 0 : index;
}

/** Wraps at both ends so ArrowUp on the first row lands on the last. */
export function moveActiveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const next = (index + delta) % length;
  return next < 0 ? next + length : next;
}

export type PickerKeyAction =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'select'; index: number }
  | { type: 'manual'; modelId: string }
  | { type: 'close' };

export interface PickerKeyInput {
  key: string;
  query: string;
  activeIndex: number;
  optionCount: number;
}

/**
 * Maps a key press on the search input to a picker action. Enter selects the
 * highlighted row, and falls back to the typed text as a manual model id when
 * nothing is listed.
 */
export function resolvePickerKey(input: PickerKeyInput): PickerKeyAction | null {
  switch (input.key) {
    case 'ArrowDown':
      return { type: 'next' };
    case 'ArrowUp':
      return { type: 'previous' };
    case 'Enter':
      if (input.optionCount > 0) {
        const index = Math.min(Math.max(input.activeIndex, 0), input.optionCount - 1);
        return { type: 'select', index };
      }
      return { type: 'manual', modelId: input.query.trim() };
    case 'Escape':
      return { type: 'close' };
    default:
      return null;
  }
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]*$/;

export const MAX_MODEL_ID_LENGTH = 200;

export type ManualModelCheck = { ok: true; modelId: string } | { ok: false; error: string };

/**
 * Validates a hand-typed model id. Discovery is best-effort, so a gateway that
 * returns nothing must still let the user name the model the provider expects.
 */
export function validateManualModelId(
  raw: string,
  existing: readonly Model[] = [],
): ManualModelCheck {
  const modelId = raw.trim();
  if (modelId.length === 0) return { ok: false, error: 'Enter a model id.' };
  if (modelId.length > MAX_MODEL_ID_LENGTH) {
    return { ok: false, error: `Model ids are limited to ${MAX_MODEL_ID_LENGTH} characters.` };
  }
  if (!MODEL_ID_PATTERN.test(modelId)) {
    return { ok: false, error: 'Use letters, digits, and . _ - : / @ + ~ only.' };
  }
  if (existing.some((model) => model.modelId === modelId)) {
    return { ok: false, error: 'That model is already in the list.' };
  }
  return { ok: true, modelId };
}

export function manualModel(providerId: string, modelId: string, label = modelId): Model {
  return { providerId, modelId, label, contextWindow: null, isDefault: false };
}

/**
 * Keeps the selected model visible even when discovery never reported it, so
 * reopening the picker shows the current choice checked.
 */
export function withCurrentModel(
  models: readonly Model[],
  providerId: string,
  value: string | null,
): Model[] {
  if (value === null || models.some((model) => model.modelId === value)) return models.slice();
  return [manualModel(providerId, value, `${value} (not reported)`), ...models];
}

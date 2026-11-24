import type { Model, ProviderView } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  activeModel,
  buildModelGroups,
  initialActiveIndex,
  modelDisplayLabel,
  moveActiveIndex,
  providerDotClass,
  resolvePickerKey,
  validateManualModelId,
  visibleModels,
  withCurrentModel,
} from './model-picker';
import {
  EMPTY_PROVIDER_MODELS,
  addManualModelToState,
  applyProviderModels,
  beginProviderModelsLoad,
  failProviderModels,
  isModelsMethodUnavailable,
} from './use-provider-models';

const CREATED = '2026-01-01T00:00:00.000Z';

function provider(id: string, label: string, kind: ProviderView['kind'] = 'claude'): ProviderView {
  return {
    id,
    kind,
    label,
    config: {},
    enabled: true,
    hasSecret: false,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function model(providerId: string, modelId: string, patch: Partial<Model> = {}): Model {
  return { providerId, modelId, label: modelId, contextWindow: null, isDefault: false, ...patch };
}

const claude = provider('prv_claude', 'Claude');
const openai = provider('prv_openai', 'OpenAI', 'openai-compatible');

const claudeModels = [
  model('prv_claude', 'claude-opus-4-5', { label: 'Claude Opus 4.5', isDefault: true }),
  model('prv_claude', 'claude-sonnet-4-5', { label: 'Claude Sonnet 4.5' }),
];
const openaiModels = [model('prv_openai', 'gpt-5.1'), model('prv_openai', 'gpt-5-mini')];

describe('buildModelGroups', () => {
  const byProvider = { prv_claude: claudeModels, prv_openai: openaiModels };

  it('groups models under their provider in provider order', () => {
    const groups = buildModelGroups([claude, openai], byProvider);

    expect(groups.map((group) => group.label)).toEqual(['Claude', 'OpenAI']);
    expect(groups.map((group) => group.providerId)).toEqual(['prv_claude', 'prv_openai']);
    expect(groups[0]?.models.map((entry) => entry.modelId)).toEqual([
      'claude-opus-4-5',
      'claude-sonnet-4-5',
    ]);
    expect(visibleModels(groups).map((entry) => entry.modelId)).toEqual([
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'gpt-5.1',
      'gpt-5-mini',
    ]);
  });

  it('filters on both id and label, case-insensitively', () => {
    const groups = buildModelGroups([claude, openai], byProvider, 'SONNET');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.models.map((entry) => entry.modelId)).toEqual(['claude-sonnet-4-5']);
  });

  it('drops a provider when the query matches none of its models', () => {
    const groups = buildModelGroups([claude, openai], byProvider, 'gpt');

    expect(groups.map((group) => group.providerId)).toEqual(['prv_openai']);
  });

  it('drops providers that report no models', () => {
    expect(buildModelGroups([claude, openai], { prv_claude: claudeModels })).toHaveLength(1);
  });

  it('returns no groups for an empty catalog or an unmatched query', () => {
    expect(buildModelGroups([claude, openai], {})).toEqual([]);
    expect(buildModelGroups([claude], byProvider, 'nothing-like-this')).toEqual([]);
    expect(visibleModels(buildModelGroups([claude], {}))).toEqual([]);
    expect(activeModel(buildModelGroups([claude], {}), 0)).toBeNull();
  });
});

describe('keyboard selection', () => {
  it('moves down and wraps at the end', () => {
    expect(moveActiveIndex(0, 1, 3)).toBe(1);
    expect(moveActiveIndex(2, 1, 3)).toBe(0);
  });

  it('moves up and wraps at the start', () => {
    expect(moveActiveIndex(2, -1, 3)).toBe(1);
    expect(moveActiveIndex(0, -1, 3)).toBe(2);
  });

  it('stays at zero with no options', () => {
    expect(moveActiveIndex(0, 1, 0)).toBe(0);
  });

  it('starts on the current model, or the first row when it is missing', () => {
    const models = [...claudeModels, ...openaiModels];
    expect(initialActiveIndex(models, 'gpt-5-mini')).toBe(3);
    expect(initialActiveIndex(models, 'unknown-model')).toBe(0);
    expect(initialActiveIndex(models, null)).toBe(0);
  });

  it('maps arrows, Enter, Escape and typing to picker actions', () => {
    expect(
      resolvePickerKey({ key: 'ArrowDown', query: '', activeIndex: 0, optionCount: 3 }),
    ).toEqual({ type: 'next' });
    expect(resolvePickerKey({ key: 'ArrowUp', query: '', activeIndex: 0, optionCount: 3 })).toEqual(
      {
        type: 'previous',
      },
    );
    expect(resolvePickerKey({ key: 'Enter', query: '', activeIndex: 1, optionCount: 3 })).toEqual({
      type: 'select',
      index: 1,
    });
    expect(resolvePickerKey({ key: 'Escape', query: '', activeIndex: 0, optionCount: 3 })).toEqual({
      type: 'close',
    });
    expect(resolvePickerKey({ key: 'a', query: '', activeIndex: 0, optionCount: 3 })).toBeNull();
  });

  it('clamps Enter to the listed range and falls back to manual entry', () => {
    expect(resolvePickerKey({ key: 'Enter', query: '', activeIndex: 9, optionCount: 2 })).toEqual({
      type: 'select',
      index: 1,
    });
    expect(
      resolvePickerKey({ key: 'Enter', query: ' gpt-5.1 ', activeIndex: 0, optionCount: 0 }),
    ).toEqual({ type: 'manual', modelId: 'gpt-5.1' });
  });
});

describe('validateManualModelId', () => {
  it('rejects an empty id', () => {
    expect(validateManualModelId('')).toEqual({ ok: false, error: 'Enter a model id.' });
    expect(validateManualModelId('   ')).toEqual({ ok: false, error: 'Enter a model id.' });
  });

  it('rejects spaces and markup', () => {
    expect(validateManualModelId('gpt 5').ok).toBe(false);
    expect(validateManualModelId('gpt<script>').ok).toBe(false);
    expect(validateManualModelId('-leading').ok).toBe(false);
  });

  it('rejects ids over the length limit', () => {
    const check = validateManualModelId('a'.repeat(201));
    expect(check.ok).toBe(false);
  });

  it('rejects a model that is already listed', () => {
    expect(validateManualModelId('gpt-5.1', openaiModels)).toEqual({
      ok: false,
      error: 'That model is already in the list.',
    });
  });

  it('accepts provider-style ids and trims surrounding space', () => {
    expect(validateManualModelId('  anthropic/claude-sonnet-4.5  ')).toEqual({
      ok: true,
      modelId: 'anthropic/claude-sonnet-4.5',
    });
    expect(validateManualModelId('openai/gpt-5.1:free')).toEqual({
      ok: true,
      modelId: 'openai/gpt-5.1:free',
    });
    expect(validateManualModelId('meta-llama/Llama-3.3-70B-Instruct@fp8').ok).toBe(true);
  });
});

describe('model presentation', () => {
  it('shows the label only when it differs from the id', () => {
    expect(modelDisplayLabel(model('p', 'gpt-5.1'))).toBe('gpt-5.1');
    expect(modelDisplayLabel(model('p', 'gpt-5.1', { label: '   ' }))).toBe('gpt-5.1');
    expect(modelDisplayLabel(model('p', 'gpt-5.1', { label: 'GPT 5.1' }))).toBe('GPT 5.1');
  });

  it('keeps an unreported current model in the list', () => {
    const withManual = withCurrentModel(claudeModels, 'prv_claude', 'claude-opus-9');
    expect(withManual[0]).toMatchObject({
      modelId: 'claude-opus-9',
      label: 'claude-opus-9 (not reported)',
      isDefault: false,
    });
    expect(withManual).toHaveLength(3);

    const alreadyListed = withCurrentModel(claudeModels, 'prv_claude', 'claude-opus-4-5');
    expect(alreadyListed.map((entry) => entry.modelId)).toEqual([
      'claude-opus-4-5',
      'claude-sonnet-4-5',
    ]);

    expect(withCurrentModel(claudeModels, 'prv_claude', null)).toHaveLength(2);
  });

  it('gives every provider kind a dot and falls back to muted', () => {
    expect(providerDotClass('claude')).toBe('bg-orange-400');
    expect(providerDotClass('openai-compatible')).toBe('bg-sky-400');
    expect(providerDotClass(undefined)).toBe('bg-muted-foreground');
  });
});

describe('provider model state', () => {
  const loaded = applyProviderModels(EMPTY_PROVIDER_MODELS, {
    models: claudeModels,
    source: 'sdk',
  });

  it('starts empty and reports loading on the first request', () => {
    const loading = beginProviderModelsLoad(EMPTY_PROVIDER_MODELS);
    expect(loading.status).toBe('loading');
    expect(loading.refreshing).toBe(false);
    expect(loading.models).toEqual([]);
  });

  it('keeps the old list visible while refreshing', () => {
    const refreshing = beginProviderModelsLoad({ ...loaded, error: 'stale' });
    expect(refreshing.status).toBe('ready');
    expect(refreshing.refreshing).toBe(true);
    expect(refreshing.models).toEqual(claudeModels);
    expect(refreshing.error).toBeNull();
  });

  it('replaces the list when a refresh returns new models', () => {
    const refreshing = beginProviderModelsLoad(loaded);
    const next = applyProviderModels(refreshing, {
      models: [...claudeModels, model('prv_claude', 'claude-haiku-4-5')],
      source: 'api',
    });

    expect(next.status).toBe('ready');
    expect(next.refreshing).toBe(false);
    expect(next.source).toBe('api');
    expect(next.models.map((entry) => entry.modelId)).toEqual([
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]);
  });

  it('carries a discovery warning while keeping the cached list', () => {
    const next = applyProviderModels(loaded, {
      models: claudeModels,
      source: 'cache',
      warning: 'SDK discovery failed',
    });
    expect(next.warning).toBe('SDK discovery failed');
    expect(next.models).toEqual(claudeModels);
  });

  it('keeps cached models on failure but errors when nothing is cached', () => {
    const withCache = failProviderModels(loaded, 'offline');
    expect(withCache.status).toBe('ready');
    expect(withCache.error).toBe('offline');
    expect(withCache.models).toEqual(claudeModels);

    const withoutCache = failProviderModels(EMPTY_PROVIDER_MODELS, 'offline');
    expect(withoutCache.status).toBe('error');
    expect(withoutCache.error).toBe('offline');
  });

  it('appends a manual model once', () => {
    const added = addManualModelToState(loaded, 'prv_claude', 'claude-opus-9');
    expect(added.models.map((entry) => entry.modelId)).toContain('claude-opus-9');
    expect(added.models.at(-1)).toMatchObject({
      providerId: 'prv_claude',
      modelId: 'claude-opus-9',
      label: 'claude-opus-9',
    });

    const duplicate = addManualModelToState(added, 'prv_claude', 'claude-opus-9');
    expect(duplicate).toBe(added);
  });
});

describe('isModelsMethodUnavailable', () => {
  it('treats an unknown method and a not-found code as unavailable', () => {
    expect(isModelsMethodUnavailable(new Error('unknown method: providers.models'))).toBe(true);
    expect(isModelsMethodUnavailable(Object.assign(new Error('nope'), { code: 'not-found' }))).toBe(
      true,
    );
  });

  it('does not hide provider failures behind the fallback', () => {
    expect(isModelsMethodUnavailable(new Error('provider unavailable'))).toBe(false);
    expect(isModelsMethodUnavailable('unknown method')).toBe(false);
  });
});

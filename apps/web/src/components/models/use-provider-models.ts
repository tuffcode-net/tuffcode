import type { Model } from '@tuffcode/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { RpcClient } from '../../rpc/client';
import { useRpc } from '../../rpc/rpc-context';
import { manualModel, type ModelSource } from './model-picker';

export type ProviderModelsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProviderModelsState {
  status: ProviderModelsStatus;
  models: Model[];
  source: ModelSource | null;
  /** A failed request. With models already cached the list stays visible. */
  error: string | null;
  /** Discovery ran but failed; the provider answered from cache or manual entry. */
  warning: string | null;
  refreshing: boolean;
}

export const EMPTY_PROVIDER_MODELS: ProviderModelsState = {
  status: 'idle',
  models: [],
  source: null,
  error: null,
  warning: null,
  refreshing: false,
};

export function beginProviderModelsLoad(state: ProviderModelsState): ProviderModelsState {
  const hasModels = state.models.length > 0;
  return {
    ...state,
    status: hasModels ? 'ready' : 'loading',
    refreshing: hasModels,
    error: null,
  };
}

export interface ProviderModelsPayload {
  models: Model[];
  source: ModelSource;
  warning?: string | null;
}

export function applyProviderModels(
  state: ProviderModelsState,
  payload: ProviderModelsPayload,
): ProviderModelsState {
  return {
    status: 'ready',
    models: payload.models,
    source: payload.source,
    error: null,
    warning: payload.warning ?? null,
    refreshing: false,
  };
}

export function failProviderModels(
  state: ProviderModelsState,
  message: string,
): ProviderModelsState {
  return {
    ...state,
    status: state.models.length > 0 ? 'ready' : 'error',
    error: message,
    refreshing: false,
  };
}

export function addManualModelToState(
  state: ProviderModelsState,
  providerId: string,
  modelId: string,
): ProviderModelsState {
  if (state.models.some((model) => model.modelId === modelId)) return state;
  return { ...state, models: [...state.models, manualModel(providerId, modelId)] };
}

/**
 * A server that predates `providers.models` answers with a `bad-request`
 * "unknown method" error. That is the only case where `models.list` is the
 * right fallback; a provider failure must surface as an error instead.
 */
export function isModelsMethodUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ('code' in error && error.code === 'not-found') return true;
  return /unknown method|not implemented|not found/i.test(error.message);
}

async function requestModels(
  rpc: RpcClient,
  providerId: string,
  refresh: boolean,
): Promise<ProviderModelsPayload> {
  try {
    const result = await rpc.request('providers.models', { providerId, refresh });
    return { models: result.models, source: result.source, warning: result.error ?? null };
  } catch (error) {
    if (!isModelsMethodUnavailable(error)) throw error;
  }
  const models = await rpc.request('models.list', { providerId });
  return { models, source: 'list', warning: null };
}

// Cache shared by every picker and settings card, keyed by provider id. The
// store is module-level so two components showing the same provider stay in
// sync and a reopen never re-runs discovery.
const states = new Map<string, ProviderModelsState>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();
const started = new Set<string>();

function snapshot(providerId: string): ProviderModelsState {
  return states.get(providerId) ?? EMPTY_PROVIDER_MODELS;
}

function emit(providerId: string): void {
  const set = listeners.get(providerId);
  if (!set) return;
  for (const listener of set) listener();
}

function commit(providerId: string, state: ProviderModelsState): void {
  states.set(providerId, state);
  emit(providerId);
}

export function subscribeProviderModels(providerId: string, listener: () => void): () => void {
  let set = listeners.get(providerId);
  if (!set) {
    set = new Set();
    listeners.set(providerId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(providerId);
  };
}

/** Seeds or replaces the cache without a request; used by tests and imports. */
export function setProviderModels(providerId: string, models: readonly Model[]): void {
  commit(
    providerId,
    applyProviderModels(snapshot(providerId), { models: [...models], source: 'cache' }),
  );
}

export function loadProviderModels(
  rpc: RpcClient,
  providerId: string,
  options: { refresh?: boolean } = {},
): Promise<void> {
  const existing = inflight.get(providerId);
  if (existing) return existing;

  started.add(providerId);
  commit(providerId, beginProviderModelsLoad(snapshot(providerId)));

  const task = (async () => {
    try {
      const payload = await requestModels(rpc, providerId, options.refresh === true);
      commit(providerId, applyProviderModels(snapshot(providerId), payload));
    } catch (error) {
      commit(
        providerId,
        failProviderModels(
          snapshot(providerId),
          error instanceof Error ? error.message : 'Could not load models.',
        ),
      );
    } finally {
      inflight.delete(providerId);
    }
  })();

  inflight.set(providerId, task);
  return task;
}

export function addManualProviderModel(providerId: string, modelId: string): void {
  commit(providerId, addManualModelToState(snapshot(providerId), providerId, modelId));
}

export function clearProviderModelsCache(): void {
  states.clear();
  listeners.clear();
  inflight.clear();
  started.clear();
}

export interface UseProviderModelsResult extends ProviderModelsState {
  refresh: () => void;
  addManualModel: (modelId: string) => void;
}

/** Loads and caches one provider's models. Pass `undefined` while unresolved. */
export function useProviderModels(providerId: string | undefined): UseProviderModelsResult {
  const rpc = useRpc();
  const [state, setState] = useState<ProviderModelsState>(() =>
    providerId === undefined ? EMPTY_PROVIDER_MODELS : snapshot(providerId),
  );

  useEffect(() => {
    if (providerId === undefined) {
      setState(EMPTY_PROVIDER_MODELS);
      return;
    }
    setState(snapshot(providerId));
    const unsubscribe = subscribeProviderModels(providerId, () => setState(snapshot(providerId)));
    if (!started.has(providerId)) void loadProviderModels(rpc, providerId);
    return unsubscribe;
  }, [providerId, rpc]);

  const refresh = useCallback(() => {
    if (providerId === undefined) return;
    void loadProviderModels(rpc, providerId, { refresh: true });
  }, [providerId, rpc]);

  const addManualModel = useCallback(
    (modelId: string) => {
      if (providerId === undefined) return;
      addManualProviderModel(providerId, modelId);
    },
    [providerId],
  );

  return { ...state, refresh, addManualModel };
}

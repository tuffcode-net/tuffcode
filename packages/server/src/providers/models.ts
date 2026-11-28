import { spawn } from 'node:child_process';
import type { ClaudeModelQueryFn } from '@tuffcode/adapters';
import {
  DEFAULT_MODEL_CAPABILITIES,
  ReasoningEffortSchema,
  type Model,
  type ModelCapabilities,
  type ReasoningEffort,
} from '@tuffcode/contracts';
import { z } from 'zod';
import type { ProviderRecord, ReplaceModelInput, Repos } from '../db/repos/index.js';
import {
  modelListHookFor,
  type DiscoveredModel,
  type ModelListReport,
} from '../adapters/factory.js';
import type { ResolveCommand } from '../adapters/resolveCommand.js';
import { configuredCommand, resolveCliPath, windowsInvocation } from './command.js';
import { DEFAULT_ANTHROPIC_BASE_URL } from './config.js';
import { enrichModels } from './models-dev.js';

/** Contract `providers.models.source`; `cache` only ever comes from a cache hit. */
export type ModelSource = 'sdk' | 'api' | 'manual' | 'cache';

/** Discovery results are reused for a day before the next automatic refresh. */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** A single vendor call may not block a refresh longer than this. */
export const DISCOVERY_TIMEOUT_MS = 5_000;

const ANTHROPIC_VERSION = '2023-06-01';

/** Test seam: inject the Codex app-server exchange. `null` means it reported nothing. */
export type CodexModelListFn = (
  cliPath: string,
  timeoutMs: number,
) => Promise<DiscoveredModel[] | null>;

export interface ModelDiscoveryDeps {
  /** The provider's API key, already resolved from the secret bridge. */
  secret: string | null;
  fetchFn?: typeof fetch;
  resolveCommand?: ResolveCommand;
  queryFn?: ClaudeModelQueryFn;
  listCodexModels?: CodexModelListFn;
  /** Clock seam for the 24h cache window. */
  now?: () => number;
  timeoutMs?: number;
  /** Where the models.dev index is cached; unset skips that enrichment step. */
  cacheDir?: string;
  /** True on a user-pressed refresh: permits the weekly models.dev download. */
  allowRegistryFetch?: boolean;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  source: ModelSource;
  error?: string;
}

export interface ProviderModelsResult {
  models: Model[];
  source: ModelSource;
  error?: string;
}

const RECORD_SCHEMA = z.record(z.string(), z.unknown());

/** Parses a vendor or app-server payload object once; `null` for anything else. */
function recordOf(value: unknown): Record<string, unknown> | null {
  const parsed = RECORD_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return null;
}

/** The first positive number under a nested object, for payloads like `top_provider`. */
function firstNestedNumber(
  record: Record<string, unknown>,
  parent: string,
  keys: readonly string[],
): number | null {
  const nested = recordOf(record[parent]);
  return nested === null ? null : firstNumber(nested, keys);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high'];

function capabilityFlag(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** An explicit `capabilities` object wins; `null` when the payload carries none. */
function explicitCapabilities(record: Record<string, unknown>): ModelCapabilities | null {
  const parsed = recordOf(record['capabilities']);
  if (parsed === null) return null;
  return {
    tools: capabilityFlag(parsed, 'tools', DEFAULT_MODEL_CAPABILITIES.tools),
    vision: capabilityFlag(parsed, 'vision', DEFAULT_MODEL_CAPABILITIES.vision),
    reasoning: capabilityFlag(parsed, 'reasoning', DEFAULT_MODEL_CAPABILITIES.reasoning),
    reasoningEfforts: stringArray(parsed['reasoningEfforts']),
  };
}

/**
 * Capability hints OpenRouter-style list entries carry beside the id. Returns `null`
 * when the payload declares nothing, so an unknown model stays unknown instead of being
 * recorded as unable to do things nobody said it could not do.
 */
function inferredCapabilities(record: Record<string, unknown>): ModelCapabilities | null {
  const supported = record['supported_parameters'];
  const architecture = recordOf(record['architecture']);
  const modality = record['modality'];
  const architectureModality = architecture?.['modality'];
  const hasHints =
    Array.isArray(supported) ||
    stringArray(architecture?.['input_modalities']).length > 0 ||
    (typeof modality === 'string' && modality.length > 0) ||
    (typeof architectureModality === 'string' && architectureModality.length > 0);
  if (!hasHints) return null;

  const capabilities: ModelCapabilities = { ...DEFAULT_MODEL_CAPABILITIES, reasoningEfforts: [] };
  if (Array.isArray(supported)) {
    const names = stringArray(supported);
    capabilities.tools = names.includes('tools') || names.includes('tool_choice');
    capabilities.reasoning =
      names.includes('reasoning') || names.includes('include_reasoning');
  }
  if (stringArray(architecture?.['input_modalities']).includes('image')) {
    capabilities.vision = true;
  }
  for (const declared of [modality, architectureModality]) {
    if (typeof declared === 'string' && declared.includes('image')) capabilities.vision = true;
  }
  return capabilities;
}

/** The declared capabilities, or `null` when neither the entry nor its hints said anything. */
function capabilitiesOf(record: Record<string, unknown>): ModelCapabilities | null {
  const capabilities = explicitCapabilities(record) ?? inferredCapabilities(record);
  if (capabilities === null) return null;
  if (capabilities.reasoning && capabilities.reasoningEfforts.length === 0) {
    capabilities.reasoningEfforts = [...DEFAULT_REASONING_EFFORTS];
  }
  return capabilities;
}

function reasoningEffortOf(record: Record<string, unknown>): ReasoningEffort | null {
  const parsed = ReasoningEffortSchema.safeParse(
    record['reasoningEffort'] ?? record['reasoning_effort'],
  );
  return parsed.success ? parsed.data : null;
}

/** The entries of a model list body: `{data:[]}`, `{models:[]}`, or a bare array. */
function modelEntries(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  const record = depth > 2 ? null : recordOf(value);
  if (record === null) return [];
  for (const key of ['data', 'models', 'items', 'availableModels']) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
    if (recordOf(nested) !== null) {
      const inner = modelEntries(nested, depth + 1);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

/** Normalizes one entry from any vendor list into the discovery row shape. */
function toDiscovered(entry: unknown): DiscoveredModel | null {
  if (typeof entry === 'string') {
    const id = entry.trim();
    if (id.length === 0) return null;
    return {
      id,
      label: id,
      contextWindow: null,
      maxOutputTokens: null,
      capabilities: null,
      reasoningEffort: null,
    };
  }
  const record = recordOf(entry);
  if (record === null) return null;
  const id = firstString(record, ['id', 'value', 'model', 'slug', 'name']);
  if (id === null) return null;
  const label = firstString(record, ['displayName', 'display_name', 'label', 'name']) ?? id;
  const contextWindow =
    firstNumber(record, [
      'contextWindow',
      'context_window',
      'context_length',
      'maxContextTokens',
      'max_context_tokens',
      'max_model_len',
    ]) ?? firstNestedNumber(record, 'top_provider', ['context_length']);
  const maxOutputTokens =
    firstNumber(record, [
      'maxOutputTokens',
      'max_output_tokens',
      'max_completion_tokens',
      'max_tokens',
    ]) ?? firstNestedNumber(record, 'top_provider', ['max_completion_tokens']);
  return {
    id,
    label,
    contextWindow,
    maxOutputTokens,
    capabilities: capabilitiesOf(record),
    reasoningEffort: reasoningEffortOf(record),
  };
}

function normalize(value: unknown): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of modelEntries(value)) {
    const model = toDiscovered(entry);
    if (model === null || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function configString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringHeaders(value: unknown): Record<string, string> {
  const record = recordOf(value);
  if (record === null) return {};
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') headers[key] = entry;
  }
  return headers;
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'request failed';
  return `request failed: ${message}`;
}

/** The config model list in repo-row shape; `null` when the config declares none. */
function configModelRows(config: Record<string, unknown>): ReplaceModelInput[] {
  const models = config['models'];
  if (!Array.isArray(models)) return [];
  const rows: ReplaceModelInput[] = [];
  for (const entry of models) {
    const record = recordOf(entry);
    if (record === null) continue;
    const id = firstString(record, ['id']);
    if (id === null) continue;
    rows.push({
      modelId: id,
      label: firstString(record, ['label']) ?? id,
      contextWindow: firstNumber(record, ['contextWindow']),
      maxOutputTokens: firstNumber(record, ['maxOutputTokens']),
      capabilities: explicitCapabilities(record),
      reasoningEffort: reasoningEffortOf(record),
      // A capabilities object the user wrote in the config is a declaration, not a guess.
      source: 'manual',
      isDefault: record['isDefault'] === true,
    });
  }
  return rows;
}

/** Models listed in the provider config; manual entry stays the fallback for every kind. */
export function configuredModels(config: Record<string, unknown>): DiscoveredModel[] {
  return configModelRows(config).map(
    ({ modelId, label, contextWindow, maxOutputTokens, capabilities, reasoningEffort }) => ({
      id: modelId,
      label,
      contextWindow,
      maxOutputTokens: maxOutputTokens ?? null,
      capabilities: capabilities ?? null,
      reasoningEffort: reasoningEffort ?? null,
    }),
  );
}

/** The same list as repo rows, so a config edit seeds `provider_models`. */
export function configuredModelInputs(config: Record<string, unknown>): ReplaceModelInput[] | null {
  return Array.isArray(config['models']) ? configModelRows(config) : null;
}

async function discoverClaude(
  provider: ProviderRecord,
  deps: ModelDiscoveryDeps,
): Promise<ModelListReport> {
  const configured = configString(provider.config, 'pathToClaudeCodeExecutable');
  const cliPath =
    deps.resolveCommand === undefined
      ? (configured ?? 'claude')
      : await resolveCliPath(deps.resolveCommand, configured, 'claude');
  if (cliPath === null) {
    const fallback = configuredModels(provider.config);
    return fallback.length > 0
      ? { models: fallback, source: 'manual' }
      : { models: [], source: 'sdk', error: 'claude CLI not found' };
  }

  const { listClaudeModels } = await import('@tuffcode/adapters/claude');
  const rows = await listClaudeModels({
    pathToClaudeCodeExecutable: cliPath,
    ...(deps.queryFn === undefined ? {} : { queryFn: deps.queryFn }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
  if (rows.length > 0) {
    return {
      models: rows.map((row) => ({
        id: row.id,
        label: row.label,
        // The CLI reports ids and labels only; Claude models all accept tools and thinking.
        contextWindow: null,
        maxOutputTokens: null,
        capabilities: {
          tools: true,
          vision: false,
          reasoning: true,
          reasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
        },
        reasoningEffort: null,
      })),
      source: 'sdk',
    };
  }
  const fallback = configuredModels(provider.config);
  return fallback.length > 0
    ? { models: fallback, source: 'manual' }
    : { models: [], source: 'sdk', error: 'claude reported no models' };
}

/** One app-server exchange: initialize, then `model/list`. `null` on any failure. */
async function codexAppServerModels(
  cliPath: string,
  timeoutMs: number,
): Promise<DiscoveredModel[] | null> {
  const invocation = windowsInvocation(cliPath, ['app-server']);
  const child = spawn(invocation.file, invocation.args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim,
  });

  const pending = new Map<
    number,
    { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let buffer = '';
  let settled = false;

  function send(message: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = recordOf(parsed);
    if (message === null) return;
    const id = message['id'];
    if (typeof id !== 'number') return;
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    entry.resolve(message);
  }

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) dispatch(line);
      index = buffer.indexOf('\n');
    }
  };
  child.stdout.on('data', onData);

  function request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    pending.set(id, {
      resolve: (message) => {
        if (message['error'] !== undefined) reject(new Error(`app-server ${method} failed`));
        else resolve(message);
      },
      reject,
    });
    send({ id, method, params });
    return promise;
  }

  const { promise, resolve } = Promise.withResolvers<DiscoveredModel[] | null>();
  const finish = (models: DiscoveredModel[] | null): void => {
    if (settled) return;
    settled = true;
    for (const entry of pending.values()) entry.reject(new Error('codex app-server closed'));
    pending.clear();
    resolve(models);
    child.kill();
  };
  const timer = setTimeout(() => finish(null), timeoutMs);
  child.on('error', () => finish(null));
  child.on('exit', () => finish(null));

  void (async () => {
    try {
      await request('initialize', {
        clientInfo: { name: 'tuffcode', title: 'Tuffcode', version: '0.0.0' },
        capabilities: null,
      });
      send({ method: 'initialized' });
      const response = await request('model/list', {});
      finish(normalize(response['result']));
    } catch {
      finish(null);
    }
  })();

  const models = await promise;
  clearTimeout(timer);
  child.stdout.off('data', onData);
  return models;
}

async function discoverCodex(
  provider: ProviderRecord,
  deps: ModelDiscoveryDeps,
): Promise<ModelListReport> {
  const configured = configuredModels(provider.config);
  const configuredCli = configuredCommand(provider.config['command']);
  const cliPath =
    deps.resolveCommand === undefined
      ? configuredCli
      : await resolveCliPath(deps.resolveCommand, configuredCli, 'codex');
  if (cliPath === null) {
    return configured.length > 0
      ? { models: configured, source: 'manual' }
      : { models: [], source: 'sdk', error: 'codex CLI not found' };
  }

  const lister = deps.listCodexModels ?? codexAppServerModels;
  const listed = await lister(cliPath, deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  if (listed !== null && listed.length > 0) return { models: listed, source: 'sdk' };
  return configured.length > 0
    ? { models: configured, source: 'manual' }
    : { models: [], source: 'sdk', error: 'codex app-server reported no models' };
}

async function requestModels(
  url: string,
  headers: Record<string, string>,
  deps: ModelDiscoveryDeps,
  source: ModelSource,
): Promise<DiscoveryResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  try {
    const response = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { models: [], source, error: `endpoint returned HTTP ${response.status}` };
    }
    const body: unknown = await response.json().catch(() => null);
    return { models: normalize(body), source };
  } catch (error) {
    return { models: [], source, error: failure(error) };
  }
}

async function discoverAnthropic(
  provider: ProviderRecord,
  deps: ModelDiscoveryDeps,
): Promise<DiscoveryResult> {
  if (deps.secret === null) {
    return { models: [], source: 'api', error: 'no API key stored' };
  }
  const baseUrl = configString(provider.config, 'baseUrl') ?? DEFAULT_ANTHROPIC_BASE_URL;
  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-api-key': deps.secret,
    ...stringHeaders(provider.config['headers']),
  };
  return requestModels(url, headers, deps, 'api');
}

async function discoverOpenAi(
  provider: ProviderRecord,
  deps: ModelDiscoveryDeps,
): Promise<DiscoveryResult> {
  const baseUrl = configString(provider.config, 'baseUrl');
  if (baseUrl === null) {
    return { models: [], source: 'api', error: 'config.baseUrl is required' };
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(deps.secret === null ? {} : { authorization: `Bearer ${deps.secret}` }),
    ...stringHeaders(provider.config['headers']),
  };
  return requestModels(`${baseUrl.replace(/\/+$/, '')}/models`, headers, deps, 'api');
}

/**
 * Lists the models one provider advertises. Every failure is a result, never a throw:
 * `error` carries the reason and `models` is empty so the caller can fall back to config.
 */
export async function discoverModels(
  provider: ProviderRecord,
  deps: ModelDiscoveryDeps,
): Promise<DiscoveryResult> {
  try {
    const hook = modelListHookFor(provider.kind, {
      claude: (record) => discoverClaude(record, deps),
      codex: (record) => discoverCodex(record, deps),
    });
    if (hook !== null) {
      const report = await hook(provider, deps.secret);
      if (report !== null) return report;
      return { models: [], source: 'sdk', error: `${provider.kind} reported no models` };
    }
    switch (provider.kind) {
      case 'anthropic':
        return await discoverAnthropic(provider, deps);
      case 'openai-compatible':
        return await discoverOpenAi(provider, deps);
      case 'acp':
      case 'opencode': {
        const models = configuredModels(provider.config);
        return models.length > 0
          ? { models, source: 'manual' }
          : { models: [], source: 'manual', error: 'no models configured for this agent' };
      }
      default:
        return {
          models: [],
          source: 'manual',
          error: `unsupported provider kind: ${String(provider.kind)}`,
        };
    }
  } catch (error) {
    return { models: [], source: 'manual', error: failure(error) };
  }
}

/**
 * Replaces the stored set while keeping the provider default and every model an existing
 * thread already points at, so a refresh never rewrites a thread's model underneath it.
 * `source` records which discovery path wrote the fresh rows; it stays `null` for a row
 * that was carried over, whose provenance the stored columns no longer carry.
 */
export function mergeModels(
  existing: readonly Model[],
  discovered: readonly DiscoveredModel[],
  referenced: ReadonlySet<string>,
  source: ModelSource | null = null,
): ReplaceModelInput[] {
  const rows = new Map<string, ReplaceModelInput>();
  for (const model of discovered) {
    rows.set(model.id, {
      modelId: model.id,
      label: model.label,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
      reasoningEffort: model.reasoningEffort,
      ...(source === null ? {} : { source }),
      isDefault: false,
    });
  }
  for (const model of existing) {
    if (rows.has(model.modelId)) continue;
    if (!model.isDefault && !referenced.has(model.modelId)) continue;
    rows.set(model.modelId, {
      modelId: model.modelId,
      label: model.label,
      contextWindow: model.contextWindow ?? null,
      maxOutputTokens: model.maxOutputTokens ?? null,
      capabilities: model.capabilities ?? null,
      reasoningEffort: model.reasoningEffort ?? null,
      isDefault: model.isDefault,
    });
  }
  for (const model of existing) {
    if (!model.isDefault) continue;
    const row = rows.get(model.modelId);
    if (row !== undefined) row.isDefault = true;
  }
  return [...rows.values()];
}

function referencedModels(repos: Repos, providerId: string): Set<string> {
  const referenced = new Set<string>();
  for (const thread of repos.threads.list()) {
    if (thread.providerId === providerId) referenced.add(thread.modelId);
  }
  return referenced;
}

/**
 * Returns the provider's model list, discovering and caching it when the stored set is
 * missing, stale (older than a day), or `refresh` is set. Failures keep the stored rows.
 */
export async function providerModels(
  repos: Repos,
  provider: ProviderRecord,
  deps: ModelDiscoveryDeps,
  refresh = false,
): Promise<ProviderModelsResult> {
  const now = deps.now ?? Date.now;
  const cached = repos.providers.listModels(provider.id);
  const refreshedAt = repos.providers.modelsRefreshedAt(provider.id);
  const refreshedMs = refreshedAt === null ? Number.NaN : Date.parse(refreshedAt);
  const fresh = Number.isFinite(refreshedMs) && now() - refreshedMs < MODEL_CACHE_TTL_MS;
  if (!refresh && cached.length > 0 && fresh) {
    return { models: cached, source: 'cache' };
  }

  const discovered = await discoverModels(provider, deps);
  const result =
    discovered.models.length === 0 || provider.kind === 'acp' || provider.kind === 'opencode'
      ? discovered
      : {
          ...discovered,
          models: await enrichModels(discovered.models, {
            baseUrl: configString(provider.config, 'baseUrl'),
            flavor: provider.config['flavor'],
            headers: stringHeaders(provider.config['headers']),
            ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
            ...(deps.cacheDir === undefined ? {} : { cacheDir: deps.cacheDir }),
            allowRegistryFetch: deps.allowRegistryFetch === true,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          }).catch(() => discovered.models),
        };
  if (result.models.length === 0) {
    return {
      models: repos.providers.listModels(provider.id),
      source: 'manual',
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  const merged = mergeModels(
    cached,
    result.models,
    referencedModels(repos, provider.id),
    result.source,
  );
  const models = repos.providers.replaceModels(provider.id, merged, new Date(now()).toISOString());
  return {
    models,
    source: result.source,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

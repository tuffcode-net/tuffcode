import type { OpenAIChatAdapterOverrides } from '@tuffcode/adapters';
import {
  AdapterUnavailableError,
  type AdapterDeps,
  type AdapterLogger,
  type AdapterSession,
  type ModelCapabilities,
  type ProviderConfig,
  type ProviderKind,
  type ReasoningEffort,
} from '@tuffcode/contracts';
import type { ProviderRecord } from '../db/repos/index.js';
import { createResolveCommand, type ResolveCommand } from './resolveCommand.js';

/** The fetch signature the OpenAI-compatible adapter accepts. */
export type AdapterFetch = NonNullable<OpenAIChatAdapterOverrides['fetchFn']>;

/** One model row reported by a vendor runtime instead of the provider config. */
export interface DiscoveredModel {
  id: string;
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** `null` when the runtime reported no capability hints at all. */
  capabilities: ModelCapabilities | null;
  reasoningEffort: ReasoningEffort | null;
}

/**
 * Model-list hook: how discovery reaches a runtime that only answers over its own
 * transport (the Claude Agent SDK, the Codex app-server). The implementation lives in
 * the provider discovery module; tests substitute either side. `null` means the runtime
 * was not asked at all, so the caller reports an empty list.
 */
export type ModelListHook = (
  provider: ProviderRecord,
  secret: string | null,
) => Promise<ModelListReport | null>;

/** What one hook reports: the rows plus where they came from. */
export interface ModelListReport {
  models: DiscoveredModel[];
  /** `sdk` when the vendor runtime answered; `manual` when config supplied the rows. */
  source: 'sdk' | 'manual';
  error?: string;
}

export interface ModelListHooks {
  claude?: ModelListHook;
  codex?: ModelListHook;
}

/** The hook for one provider kind; API kinds are listed over HTTP instead. */
export function modelListHookFor(kind: ProviderKind, hooks: ModelListHooks): ModelListHook | null {
  switch (kind) {
    case 'claude':
      return hooks.claude ?? null;
    case 'codex':
      return hooks.codex ?? null;
    default:
      return null;
  }
}

export type AdapterFactory = (
  provider: ProviderConfig,
  deps: AdapterDeps,
) => Promise<AdapterSession>;

export interface AdapterFactoryOverrides {
  /** Test seam: replaces the real factory per kind without spawning anything. */
  factories?: Partial<Record<ProviderKind, AdapterFactory>>;
  fetchFn?: AdapterFetch;
}

export interface AdapterDepsOptions {
  logger: AdapterLogger;
  resolveCommand?: ResolveCommand;
  env?: NodeJS.ProcessEnv;
  /** Late-bound so the subagent service can be created after the runner it needs. */
  spawnSubagent?: AdapterDeps['spawnSubagent'];
  subagentControl?: AdapterDeps['subagentControl'];
  /** Runs the server-owned `mcp`, `memory` and `config` tools for a turn. */
  extraTool?: AdapterDeps['extraTool'];
  /** Enabled stdio MCP servers for vendor CLIs that launch servers themselves. */
  mcpServers?: AdapterDeps['mcpServers'];
}

/** Filters the environment to string values, which is all an adapter may pass on. */
export function adapterEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/** Shared adapter dependencies: one logger, one cached command resolver, the env. */
export function createAdapterDeps(options: AdapterDepsOptions): AdapterDeps {
  return {
    logger: options.logger,
    resolveCommand: options.resolveCommand ?? createResolveCommand(),
    env: adapterEnv(options.env),
    ...(options.spawnSubagent === undefined ? {} : { spawnSubagent: options.spawnSubagent }),
    ...(options.subagentControl === undefined ? {} : { subagentControl: options.subagentControl }),
    ...(options.extraTool === undefined ? {} : { extraTool: options.extraTool }),
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
  };
}

/** `opencode` always speaks ACP through its `acp` subcommand. */
function opencodeConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (config['command'] !== undefined || config['agentCommand'] !== undefined) return config;
  return { ...config, command: 'opencode', args: config['args'] ?? ['acp'] };
}

/**
 * Builds the contract session for one provider row. Every kind maps to a real
 * factory; an unknown kind is `AdapterUnavailableError`, never a bare throw.
 */
export async function createAdapterForProvider(
  provider: ProviderRecord,
  deps: AdapterDeps,
  secret: string | null,
  overrides: AdapterFactoryOverrides = {},
): Promise<AdapterSession> {
  const descriptor: ProviderConfig = {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    config: provider.config,
    secret,
  };
  const factories = overrides.factories ?? {};
  // Each vendor adapter is imported on first use. The Claude Agent SDK and the ACP
  // SDK together are about half of the server bundle, and a thread that never runs a
  // Claude, Codex or ACP provider never needs them: keeping them out of the entry
  // module is what lets the server answer /health without parsing them.
  const openai: AdapterFactory = async (config, adapterDeps) => {
    const { createOpenAIChatAdapter } = await import('@tuffcode/adapters/openai');
    return createOpenAIChatAdapter(
      config,
      adapterDeps,
      overrides.fetchFn === undefined ? {} : { fetchFn: overrides.fetchFn },
    );
  };

  switch (provider.kind) {
    case 'claude':
      return (
        factories.claude ?? (await import('@tuffcode/adapters/claude')).createClaudeAdapter
      )(descriptor, deps);
    case 'codex':
      return (factories.codex ?? (await import('@tuffcode/adapters/codex')).createCodexAdapter)(
        descriptor,
        deps,
      );
    case 'acp':
      return (factories.acp ?? (await import('@tuffcode/adapters/acp')).createAcpAdapter)(
        descriptor,
        deps,
      );
    case 'opencode':
      return (
        factories.opencode ??
        factories.acp ??
        (await import('@tuffcode/adapters/acp')).createAcpAdapter
      )({ ...descriptor, config: opencodeConfig(descriptor.config) }, deps);
    case 'openai-compatible':
      return (factories['openai-compatible'] ?? openai)(descriptor, deps);
    case 'anthropic':
      return (
        factories.anthropic ?? (await import('@tuffcode/adapters/anthropic')).createAnthropicAdapter
      )(descriptor, deps);
    default:
      throw new AdapterUnavailableError(
        provider.id,
        `unsupported provider kind "${String(provider.kind)}". Configure claude, codex, acp, opencode, openai-compatible, or anthropic.`,
      );
  }
}

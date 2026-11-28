import type { ProviderView, SubagentModelChoice } from '@tuffcode/contracts';
import { Card, CardDescription, CardHeader, CardTitle, Input, Select } from '@tuffcode/ui';
import type { FormEvent } from 'react';
import {
  CONTEXT_SETTING_KEYS,
  MAX_OUTPUT_TOKENS_MAX,
  MAX_OUTPUT_TOKENS_MIN,
  maxOutputTokensError,
} from '../../components/settings/context-limits';
import {
  INHERIT_MODEL_VALUE,
  PARENT_PROVIDER_VALUE,
  SUBAGENT_CONCURRENCY_MAX,
  SUBAGENT_CONCURRENCY_MIN,
  SUBAGENT_DESCRIPTION,
  SUBAGENT_EFFORT_LABEL,
  SUBAGENT_EFFORT_VALUES,
  SUBAGENT_LABEL,
  SUBAGENT_TYPES,
  effortFromSelect,
  modelIdFromSelect,
  modelSelectValue,
  providerIdFromSelect,
  providerSelectValue,
  setSubagentChoice,
  setSubagentProvider,
  subagentChoice,
  type SubagentTypeName,
} from '../../components/settings/custom-prompt';
import { modelDisplayLabel, withCurrentModel } from '../../components/models/model-picker';
import { useProviderModels } from '../../components/models/use-provider-models';
import { SaveBar } from '../../components/settings/save-bar';
import { SettingsRow } from '../../components/settings/settings-row';
import { SettingsSectionHeader } from '../../components/settings/settings-section-header';
import { SettingsSlider } from '../../components/settings/settings-slider';
import { shellFieldError } from '../../components/settings/settings-draft';
import { TOOL_CATALOG, toggleEnabledTool } from '../../components/settings/tool-catalog';
import { useSettingsDraft } from '../../components/settings/use-settings-draft';
import { useAppStore } from '../../store/app-store';

const KEYS = [
  'enabledTools',
  'shell',
  'subagentModels',
  'subagentConcurrency',
  ...CONTEXT_SETTING_KEYS,
] as const;

interface SubagentModelRowProps {
  type: SubagentTypeName;
  choice: SubagentModelChoice;
  providers: readonly ProviderView[];
  onProviderChange(providerId: string | undefined): void;
  onChoiceChange(patch: SubagentModelChoice): void;
}

/**
 * One subagent type's routing. The model lists load per provider through the same
 * cached discovery the Models page uses, so a provider is only queried once.
 */
function SubagentModelRow({
  type,
  choice,
  providers,
  onProviderChange,
  onChoiceChange,
}: SubagentModelRowProps) {
  const { models } = useProviderModels(choice.providerId);
  const providerId = choice.providerId ?? '';
  const listed = withCurrentModel(models, providerId, choice.model ?? null);
  const fallbackListed = withCurrentModel(models, providerId, choice.fallbackModel ?? null);

  const providerOptions = [
    { value: PARENT_PROVIDER_VALUE, label: 'Parent thread provider' },
    ...providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({ value: provider.id, label: provider.label })),
  ];
  const modelOptions = [
    { value: INHERIT_MODEL_VALUE, label: 'Inherit from thread' },
    ...listed.map((model) => ({ value: model.modelId, label: modelDisplayLabel(model) })),
  ];
  const fallbackOptions = [
    { value: INHERIT_MODEL_VALUE, label: 'No fallback' },
    ...fallbackListed.map((model) => ({ value: model.modelId, label: modelDisplayLabel(model) })),
  ];
  const effortOptions = [
    { value: INHERIT_MODEL_VALUE, label: 'Inherit from provider' },
    ...SUBAGENT_EFFORT_VALUES.map((value) => ({ value, label: SUBAGENT_EFFORT_LABEL[value] })),
  ];
  const needsProvider = choice.providerId === undefined;

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <span className="text-sm font-medium text-foreground">{SUBAGENT_LABEL[type]}</span>
        <span className="text-2xs text-muted-foreground">{SUBAGENT_DESCRIPTION[type]}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          aria-label={`${SUBAGENT_LABEL[type]} provider`}
          options={providerOptions}
          value={providerSelectValue(choice)}
          onValueChange={(value) => onProviderChange(providerIdFromSelect(value))}
        />
        <Select
          aria-label={`${SUBAGENT_LABEL[type]} model`}
          options={modelOptions}
          value={modelSelectValue(choice.model)}
          onValueChange={(value) => onChoiceChange({ model: modelIdFromSelect(value) })}
          disabled={needsProvider}
        />
        <Select
          aria-label={`${SUBAGENT_LABEL[type]} fallback model`}
          options={fallbackOptions}
          value={modelSelectValue(choice.fallbackModel)}
          onValueChange={(value) => onChoiceChange({ fallbackModel: modelIdFromSelect(value) })}
          disabled={needsProvider}
        />
        <Select
          aria-label={`${SUBAGENT_LABEL[type]} reasoning effort`}
          options={effortOptions}
          value={choice.effort ?? INHERIT_MODEL_VALUE}
          onValueChange={(value) => onChoiceChange({ effort: effortFromSelect(value) })}
        />
      </div>
    </li>
  );
}

export function AgentsSection() {
  const { draft, dirty, saving, error, update, reset, submit } = useSettingsDraft(KEYS);
  const providers = useAppStore((state) => state.providers);

  const enabledTools = draft?.enabledTools ?? [];
  const shellMessage = draft ? shellFieldError(draft.shell ?? '') : undefined;
  const toolsMessage = enabledTools.length === 0 ? 'Enable at least one tool.' : undefined;
  const outputTokensMessage = maxOutputTokensError(draft?.maxOutputTokens ?? 8192);
  const invalid = Boolean(shellMessage ?? toolsMessage ?? outputTokensMessage);
  const subagentModels = draft?.subagentModels;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form className="flex flex-1 flex-col gap-4" onSubmit={handleSubmit}>
      <SettingsSectionHeader
        title="Agents and tools"
        description="What the built-in harness may call in a thread, how long it may keep calling, and the shell it runs commands in. Vendor CLIs keep their own tool sets."
      />

      <Card>
        <CardHeader>
          <CardTitle>Enabled tools</CardTitle>
          <CardDescription>
            Disabled tools are not offered to the model. Reads and searches stay available in
            read-only mode; the permission mode decides what actually runs.
          </CardDescription>
        </CardHeader>

        <ul className="divide-y divide-border border-t border-border">
          {TOOL_CATALOG.map((tool) => {
            const checked = enabledTools.includes(tool.id);
            return (
              <li key={tool.id} className="flex items-start gap-3 px-4 py-2.5">
                <input
                  id={`tool-${tool.id}`}
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 rounded-sm border border-input accent-primary"
                  checked={checked}
                  onChange={(event) =>
                    update({
                      enabledTools: toggleEnabledTool(enabledTools, tool.id, event.target.checked),
                    })
                  }
                />
                <label htmlFor={`tool-${tool.id}`} className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">{tool.label}</span>
                  <span className="text-xs leading-5 text-muted-foreground">
                    {tool.description}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        {toolsMessage ? (
          <p role="alert" className="px-4 pb-3 text-xs leading-5 text-error">
            {toolsMessage}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Limits</CardTitle>
          <CardDescription>How the harness runs its tools and subagents.</CardDescription>
        </CardHeader>

        <div className="divide-y divide-border border-t border-border">
          <SettingsRow
            label="Parallel subagents"
            htmlFor="agents-subagent-concurrency"
            description="How many subagents may run at the same time. Each one is a separate turn with its own worktree and token budget."
          >
            <SettingsSlider
              id="agents-subagent-concurrency"
              value={draft?.subagentConcurrency ?? 4}
              min={SUBAGENT_CONCURRENCY_MIN}
              max={SUBAGENT_CONCURRENCY_MAX}
              unit="agents"
              onChange={(subagentConcurrency) => update({ subagentConcurrency })}
            />
          </SettingsRow>

          <SettingsRow
            label="Shell"
            htmlFor="agents-shell"
            description="Executable used for the bash tool and the terminal. Leave blank for the system default."
            error={shellMessage}
          >
            <Input
              id="agents-shell"
              data-testid="settings-shell"
              value={draft?.shell ?? ''}
              onChange={(event) => update({ shell: event.target.value })}
              placeholder="pwsh.exe"
              spellCheck={false}
              aria-invalid={Boolean(shellMessage)}
              aria-describedby={shellMessage ? 'agents-shell-error' : undefined}
            />
          </SettingsRow>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Subagent models</CardTitle>
          <CardDescription>
            Each subagent type can run on its own provider, model and reasoning effort. The
            fallback runs when the first choice is unavailable; inherit keeps the parent thread's
            provider and model. Pick a provider to choose a model.
          </CardDescription>
        </CardHeader>

        <ul className="divide-y divide-border border-t border-border">
          {subagentModels
            ? SUBAGENT_TYPES.map((type) => (
                <SubagentModelRow
                  key={type}
                  type={type}
                  choice={subagentChoice(subagentModels, type)}
                  providers={providers}
                  onProviderChange={(providerId) =>
                    update({
                      subagentModels: setSubagentProvider(subagentModels, type, providerId),
                    })
                  }
                  onChoiceChange={(patch) =>
                    update({
                      subagentModels: setSubagentChoice(subagentModels, type, patch),
                    })
                  }
                />
              ))
            : null}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Context</CardTitle>
          <CardDescription>
            How much of the model's window the harness may fill before it warns or compacts.
            Per-model overrides live on each provider in Providers.
          </CardDescription>
        </CardHeader>

        <div className="divide-y divide-border border-t border-border">
          <SettingsRow
            label="Max output tokens"
            htmlFor="agents-max-output-tokens"
            description="Answer budget the harness sends when the model has no override of its own. 8192 is the default."
            error={outputTokensMessage}
          >
            <Input
              id="agents-max-output-tokens"
              data-testid="settings-max-output-tokens"
              type="number"
              min={MAX_OUTPUT_TOKENS_MIN}
              max={MAX_OUTPUT_TOKENS_MAX}
              step={256}
              className="w-32 tabular-nums"
              value={draft?.maxOutputTokens ?? 8192}
              onChange={(event) => update({ maxOutputTokens: Number(event.target.value) })}
              aria-invalid={Boolean(outputTokensMessage)}
              aria-describedby={outputTokensMessage ? 'agents-max-output-tokens-error' : undefined}
            />
          </SettingsRow>

          <SettingsRow
            label="Warning threshold"
            htmlFor="agents-context-warning"
            description="The composer meter turns amber at this share of the context window."
          >
            <SettingsSlider
              id="agents-context-warning"
              value={Math.round((draft?.contextWarningThreshold ?? 0.8) * 100)}
              min={50}
              max={95}
              step={5}
              unit="%"
              onChange={(percent) => update({ contextWarningThreshold: percent / 100 })}
            />
          </SettingsRow>

          <SettingsRow
            label="Auto-compact"
            htmlFor="agents-auto-compact"
            description="Before a turn that would pass the threshold, summarize older harness history into one message. Persisted messages stay intact."
          >
            <label
              htmlFor="agents-auto-compact"
              className="flex h-9 items-center gap-2 text-sm text-foreground"
            >
              <input
                id="agents-auto-compact"
                data-testid="settings-auto-compact"
                type="checkbox"
                className="size-4 rounded-sm border border-input accent-primary"
                checked={draft?.autoCompact ?? true}
                onChange={(event) => update({ autoCompact: event.target.checked })}
              />
              <span>Compact automatically</span>
            </label>
          </SettingsRow>

          <SettingsRow
            label="Context meter"
            htmlFor="agents-show-context-meter"
            description="Show the percent-used chip beside the model picker in the composer."
          >
            <label
              htmlFor="agents-show-context-meter"
              className="flex h-9 items-center gap-2 text-sm text-foreground"
            >
              <input
                id="agents-show-context-meter"
                data-testid="settings-show-context-meter"
                type="checkbox"
                className="size-4 rounded-sm border border-input accent-primary"
                checked={draft?.showContextMeter ?? true}
                onChange={(event) => update({ showContextMeter: event.target.checked })}
              />
              <span>Show the meter</span>
            </label>
          </SettingsRow>
        </div>
      </Card>

      <SaveBar dirty={dirty} saving={saving} invalid={invalid} error={error} onReset={reset} />
    </form>
  );
}

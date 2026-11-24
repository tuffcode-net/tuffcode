import type { ProviderView } from '@tuffcode/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  IconButton,
  Input,
  Spinner,
  buttonVariants,
  cn,
} from '@tuffcode/ui';
import { Link } from '@tanstack/react-router';
import { Check, RefreshCw } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import {
  modelDisplayLabel,
  providerDotClass,
  validateManualModelId,
  withCurrentModel,
} from '../../components/models/model-picker';
import { useProviderModels } from '../../components/models/use-provider-models';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import { InlineAlert } from './inline-alert';
import { SettingsSectionHeader } from './settings-section-header';

interface ProviderModelsCardProps {
  provider: ProviderView;
  isDefaultProvider: boolean;
  defaultModelId: string | null;
  pending: boolean;
  error: string | undefined;
  onSaveDefault: (providerId: string, modelId: string | null) => Promise<void>;
}

function ProviderModelsCard({
  provider,
  isDefaultProvider,
  defaultModelId,
  pending,
  error,
  onSaveDefault,
}: ProviderModelsCardProps) {
  const {
    models,
    status,
    error: loadError,
    warning,
    refreshing,
    refresh,
    addManualModel,
  } = useProviderModels(provider.id);
  const [manualDraft, setManualDraft] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const allModels = withCurrentModel(
    models,
    provider.id,
    isDefaultProvider ? defaultModelId : null,
  );
  const selectedModelId = isDefaultProvider ? defaultModelId : null;

  function addManual(): void {
    const check = validateManualModelId(manualDraft, allModels);
    if (!check.ok) {
      setManualError(check.error);
      return;
    }
    addManualModel(check.modelId);
    setManualDraft('');
    setManualError(null);
    void onSaveDefault(provider.id, check.modelId);
  }

  function handleManualKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addManual();
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span
            aria-hidden="true"
            className={cn('mt-1.5 size-2 shrink-0 rounded-full', providerDotClass(provider.kind))}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{provider.label}</CardTitle>
              {isDefaultProvider ? <Badge variant="primary">Default</Badge> : null}
            </div>
            <CardDescription>
              {isDefaultProvider
                ? 'New threads start with this provider and model.'
                : 'Choose a model to make this provider the default.'}
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            icon={RefreshCw}
            label={`Refresh models for ${provider.label}`}
            size="sm"
            onClick={refresh}
            disabled={refreshing}
            className={refreshing ? '[&_svg]:animate-spin' : undefined}
          />
          {isDefaultProvider ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void onSaveDefault(provider.id, null)}
              disabled={pending}
            >
              Clear default
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {status === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" label={`Loading models for ${provider.label}`} />
            Loading models...
          </div>
        ) : null}

        {loadError ? <InlineAlert>{loadError}</InlineAlert> : null}

        {warning && status === 'ready' ? (
          <p className="text-2xs leading-4 text-muted-foreground">{warning}</p>
        ) : null}

        {status === 'ready' && allModels.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No models reported by this provider. Add one below.
          </p>
        ) : null}

        {allModels.length > 0 ? (
          <div
            role="radiogroup"
            aria-label={`Default model for ${provider.label}`}
            className="flex flex-col gap-0.5"
          >
            {allModels.map((model) => {
              const selected = selectedModelId === model.modelId;
              const label = modelDisplayLabel(model);
              return (
                <button
                  key={model.modelId}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => void onSaveDefault(provider.id, model.modelId)}
                  disabled={pending}
                  className={cn(
                    'flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground',
                    'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-64',
                    selected && 'bg-accent',
                  )}
                >
                  <Check
                    aria-hidden="true"
                    strokeWidth={2}
                    className={cn('size-3.5 shrink-0', selected ? 'text-primary' : 'opacity-0')}
                  />
                  <span className="min-w-0 truncate">{label}</span>
                  {label !== model.modelId ? (
                    <span className="min-w-0 truncate text-2xs text-muted-foreground">
                      {model.modelId}
                    </span>
                  ) : null}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {model.isDefault ? (
                      <Badge size="sm" variant="neutral">
                        provider default
                      </Badge>
                    ) : null}
                    {model.contextWindow ? (
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {Math.round(model.contextWindow / 1000)}k ctx
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="flex items-center gap-1.5 pt-1">
          <Input
            value={manualDraft}
            onChange={(event) => {
              setManualDraft(event.target.value);
              setManualError(null);
            }}
            onKeyDown={handleManualKeyDown}
            placeholder="Add a model id"
            aria-label={`Add a model for ${provider.label}`}
            aria-invalid={manualError !== null}
            className="h-8 text-xs"
          />
          <Button size="sm" variant="secondary" onClick={addManual} disabled={pending}>
            Add
          </Button>
        </div>
        <p
          role={manualError ? 'alert' : undefined}
          className={cn('text-2xs leading-4', manualError ? 'text-error' : 'text-muted-foreground')}
        >
          {manualError ?? 'Adding a model also makes it the default for this provider.'}
        </p>

        {error ? <InlineAlert>{error}</InlineAlert> : null}
      </CardContent>
    </Card>
  );
}

export function ModelsSection() {
  const providers = useAppStore((state) => state.providers);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const rpc = useRpc();

  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [errorsByProvider, setErrorsByProvider] = useState<Record<string, string>>({});

  async function saveDefault(providerId: string, modelId: string | null): Promise<void> {
    setPendingProviderId(providerId);
    setErrorsByProvider((previous) => {
      const next = { ...previous };
      delete next[providerId];
      return next;
    });

    try {
      const next = await rpc.request('settings.set', {
        patch:
          modelId === null
            ? { defaultProviderId: null, defaultModelId: null }
            : { defaultProviderId: providerId, defaultModelId: modelId },
      });
      setSettings(next);
    } catch (error) {
      setErrorsByProvider((previous) => ({
        ...previous,
        [providerId]: error instanceof Error ? error.message : 'Could not save the default model.',
      }));
    } finally {
      setPendingProviderId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsSectionHeader
        title="Models"
        description="Pick the model new threads start with. Tuffcode keeps one default provider and model; choosing a model here makes its provider the default. Discovery is cached per provider; refresh to ask the provider again."
      />

      {providers.length === 0 ? (
        <EmptyState
          title="No providers yet"
          description="Add a provider before choosing a default model."
          action={
            <Link
              to="/settings/{-$section}"
              params={{ section: 'providers' }}
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
            >
              Go to Providers
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((provider) => (
            <ProviderModelsCard
              key={provider.id}
              provider={provider}
              isDefaultProvider={settings?.defaultProviderId === provider.id}
              defaultModelId={settings?.defaultModelId ?? null}
              pending={pendingProviderId !== null}
              error={errorsByProvider[provider.id]}
              onSaveDefault={saveDefault}
            />
          ))}
        </div>
      )}
    </div>
  );
}

import type { ProviderView } from '@tuffcode/contracts';
import {
  Badge,
  Button,
  IconButton,
  Input,
  Kbd,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Spinner,
  buttonVariants,
  cn,
} from '@tuffcode/ui';
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { InlineAlert } from '../settings/inline-alert';
import {
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
import { useProviderModels } from './use-provider-models';

export interface ModelPickerProps {
  /** The provider whose models this picker offers; `undefined` disables it. */
  provider: ProviderView | undefined;
  /** Currently selected model id. */
  value: string | null;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
  align?: 'start' | 'end';
  className?: string;
}

/**
 * A compact model picker for one provider: a dot + model name trigger and a
 * searchable popup above it. Discovery is cached per provider; the refresh
 * action re-runs `providers.models` with `refresh: true`. When discovery
 * returns nothing the popup accepts a hand-typed model id.
 */
export function ModelPicker({
  provider,
  value,
  onSelect,
  disabled = false,
  align = 'start',
  className,
}: ModelPickerProps) {
  const { models, status, error, warning, refreshing, refresh, addManualModel } = useProviderModels(
    provider?.id,
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [manualDraft, setManualDraft] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const allModels = useMemo(
    () => (provider ? withCurrentModel(models, provider.id, value) : models),
    [models, provider, value],
  );
  const groups = useMemo(
    () =>
      buildModelGroups(
        provider ? [provider] : [],
        provider ? { [provider.id]: allModels } : {},
        query,
      ),
    [allModels, provider, query],
  );
  const options = useMemo(() => visibleModels(groups), [groups]);
  const indexByModelId = useMemo(
    () => new Map(options.map((model, index) => [model.modelId, index])),
    [options],
  );
  const current = allModels.find((model) => model.modelId === value) ?? null;
  const safeActiveIndex = options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);
  const activeModelId = safeActiveIndex === -1 ? null : options[safeActiveIndex]?.modelId;
  const showManualEntry = options.length === 0 && status !== 'loading';
  const discoveryEmpty = models.length === 0;

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, safeActiveIndex]);

  function optionId(index: number): string {
    return `${listboxId}-option-${index}`;
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) return;
    setQuery('');
    setManualDraft('');
    setManualError(null);
    setActiveIndex(initialActiveIndex(allModels, value));
  }

  function choose(modelId: string): void {
    onSelect(modelId);
    setOpen(false);
  }

  function submitManual(raw: string): void {
    const check = validateManualModelId(raw, allModels);
    if (!check.ok) {
      setManualError(check.error);
      return;
    }
    addManualModel(check.modelId);
    choose(check.modelId);
  }

  function handleQueryChange(event: ChangeEvent<HTMLInputElement>): void {
    setQuery(event.target.value);
    setActiveIndex(0);
    setManualError(null);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const action = resolvePickerKey({
      key: event.key,
      query,
      activeIndex: safeActiveIndex,
      optionCount: options.length,
    });
    if (action === null) return;
    event.preventDefault();
    switch (action.type) {
      case 'next':
        setActiveIndex(moveActiveIndex(safeActiveIndex, 1, options.length));
        break;
      case 'previous':
        setActiveIndex(moveActiveIndex(safeActiveIndex, -1, options.length));
        break;
      case 'select': {
        const model = options[action.index];
        if (model) choose(model.modelId);
        break;
      }
      case 'manual':
        submitManual(action.modelId);
        break;
      case 'close':
        setOpen(false);
        break;
    }
  }

  const triggerLabel = current ? modelDisplayLabel(current) : 'Select model';

  return (
    <PopoverRoot open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        disabled={disabled || provider === undefined}
        aria-label={`Model: ${triggerLabel}`}
        title={current?.modelId ?? triggerLabel}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'max-w-56 gap-1.5 px-2 text-xs',
          className,
        )}
      >
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', providerDotClass(provider?.kind))}
        />
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0" />
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align={align}
        className="w-80 p-0"
        aria-label={`Choose a model${provider ? ` for ${provider.label}` : ''}`}
      >
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5 border-b border-border p-2">
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                strokeWidth={1.75}
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                value={query}
                onChange={handleQueryChange}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search models"
                aria-label="Search models"
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={activeModelId ? optionId(safeActiveIndex) : undefined}
                className="h-8 pl-7 text-xs"
              />
            </div>
            <IconButton
              icon={RefreshCw}
              label="Refresh models"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
              className={refreshing ? '[&_svg]:animate-spin' : undefined}
            />
          </div>

          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={provider ? `Models for ${provider.label}` : 'Models'}
            className="max-h-64 overflow-y-auto p-1"
          >
            {groups.map((group) => (
              <div key={group.providerId} role="group" aria-label={group.label}>
                <div
                  role="presentation"
                  className="px-2 pt-1.5 pb-0.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  {group.label}
                </div>
                {group.models.map((model) => {
                  const index = indexByModelId.get(model.modelId) ?? 0;
                  const selected = model.modelId === value;
                  return (
                    <button
                      key={model.modelId}
                      type="button"
                      role="option"
                      id={optionId(index)}
                      aria-selected={selected}
                      data-active={index === safeActiveIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(model.modelId)}
                      className={cn(
                        'flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground outline-none',
                        'data-[active=true]:bg-accent',
                      )}
                    >
                      <Check
                        aria-hidden="true"
                        strokeWidth={2}
                        className={cn('size-3.5 shrink-0', selected ? 'text-primary' : 'opacity-0')}
                      />
                      <span className="min-w-0 flex-1 truncate">{modelDisplayLabel(model)}</span>
                      {model.isDefault ? (
                        <Badge size="sm" variant="neutral">
                          default
                        </Badge>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {status === 'loading' ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Spinner size="sm" label="Loading models" />
              Loading models...
            </div>
          ) : null}

          {status === 'error' && error ? (
            <div className="px-2 pb-2">
              <InlineAlert>{error}</InlineAlert>
            </div>
          ) : null}

          {warning && status === 'ready' ? (
            <p className="px-3 pb-2 text-2xs leading-4 text-muted-foreground">{warning}</p>
          ) : null}

          {showManualEntry ? (
            <div className="border-t border-border p-2">
              <div className="flex items-center gap-1.5">
                <Input
                  value={manualDraft}
                  onChange={(event) => {
                    setManualDraft(event.target.value);
                    setManualError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    submitManual(manualDraft);
                  }}
                  placeholder="Enter a model id"
                  aria-label="Manual model id"
                  aria-invalid={manualError !== null}
                  className="h-8 text-xs"
                />
                <Button size="sm" variant="secondary" onClick={() => submitManual(manualDraft)}>
                  Use
                </Button>
              </div>
              <p
                role={manualError ? 'alert' : undefined}
                className={cn(
                  'mt-1 text-2xs leading-4',
                  manualError ? 'text-error' : 'text-muted-foreground',
                )}
              >
                {manualError ??
                  (discoveryEmpty
                    ? 'Discovery returned nothing; type the id your provider expects.'
                    : 'No model matches that search; press Enter to use it as a model id.')}
              </p>
            </div>
          ) : null}

          <div className="flex items-center gap-1 border-t border-border px-2 py-1.5 text-2xs text-muted-foreground">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="ml-1">navigate</span>
            <Kbd className="ml-2">↵</Kbd>
            <span className="ml-1">select</span>
          </div>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

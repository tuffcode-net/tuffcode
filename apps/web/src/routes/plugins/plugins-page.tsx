import { useVirtualizer } from '@tanstack/react-virtual';
import type { CatalogEntry, ConnectorEntry, InstalledPlugin } from '@tuffcode/contracts';
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Select,
  Spinner,
  buttonVariants,
  cn,
} from '@tuffcode/ui';
import { BadgeCheck, ExternalLink, Filter, Plug, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AddMenu } from '../../components/plugins/AddMenu';
import {
  DEFAULT_FILTER,
  avatarLetter,
  avatarTone,
  catalogCategories,
  componentLabel,
  filterCatalog,
  filterInstalled,
  splitSections,
  type CatalogFilter,
  type PluginTab,
} from '../../components/plugins/plugins-model';
import { useConnectorSearch, usePlugins } from '../../components/plugins/use-plugins';
import { SegmentedControl } from '../../components/thread/SegmentedControl';
import { useRpc } from '../../rpc/rpc-context';

const PREVIEW_COUNT = 10;
const ROW_HEIGHT = 76;

type Selection = { kind: 'catalog'; entry: CatalogEntry } | { kind: 'installed'; plugin: InstalledPlugin } | null;

/**
 * The Plugins hub: search, All | Connectors | Skills, a Verified or Community filter,
 * the plugins installed here, and the catalogs from the open marketplaces. Details
 * open in a docked panel beside the list, never as an overlay on top of it.
 */
export function PluginsPage() {
  const plugins = usePlugins();
  const [filter, setFilter] = useState<CatalogFilter>(DEFAULT_FILTER);
  const [selection, setSelection] = useState<Selection>(null);
  const [expanded, setExpanded] = useState<'verified' | 'community' | null>(null);

  const filtered = useMemo(() => filterCatalog(plugins.entries, filter), [plugins.entries, filter]);
  const sections = useMemo(() => splitSections(filtered), [filtered]);
  const categories = useMemo(() => catalogCategories(plugins.entries), [plugins.entries]);
  const installed = filterInstalled(plugins.installed, filter);
  const connectorTab = filter.tab === 'connectors';

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col" data-testid="plugins-page">
        <div className="mx-auto flex w-full max-w-[880px] shrink-0 flex-col gap-3 px-6 pt-6 pb-3">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Plugins</h1>
            <IconButton
              icon={RefreshCw}
              label="Refresh catalogs"
              size="sm"
              data-testid="plugins-refresh"
              className={cn(plugins.refreshing ? 'animate-spin' : '')}
              onClick={plugins.refresh}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
              <Input
                value={filter.query}
                onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
                placeholder="Search"
                aria-label="Search plugins"
                data-testid="plugins-search"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <SegmentedControl<PluginTab>
              ariaLabel="Plugin type"
              size="sm"
              testId="plugins-tabs"
              value={filter.tab}
              options={[
                { value: 'all', label: 'All' },
                { value: 'connectors', label: 'Connectors' },
                { value: 'skills', label: 'Skills' },
              ]}
              onValueChange={(tab) => setFilter((current) => ({ ...current, tab }))}
            />
            <PopoverRoot>
              <PopoverTrigger
                aria-label="Filter plugins"
                data-testid="plugins-filter"
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                  filter.source !== 'all' || filter.category !== null ? 'bg-accent text-foreground' : '',
                )}
              >
                <Filter strokeWidth={1.75} />
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-60 flex-col gap-3 p-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-2xs font-medium text-muted-foreground uppercase">Source</span>
                  <SegmentedControl
                    ariaLabel="Source"
                    size="sm"
                    testId="plugins-source"
                    value={filter.source}
                    options={[
                      { value: 'all', label: 'All' },
                      { value: 'verified', label: 'Verified' },
                      { value: 'community', label: 'Community' },
                    ]}
                    onValueChange={(source) => setFilter((current) => ({ ...current, source }))}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-2xs font-medium text-muted-foreground uppercase">Category</span>
                  <Select
                    aria-label="Category"
                    value={filter.category ?? 'all'}
                    options={[
                      { value: 'all', label: 'All categories' },
                      ...categories.map((category) => ({ value: category, label: category.charAt(0).toUpperCase() + category.slice(1) })),
                    ]}
                    onValueChange={(value) =>
                      setFilter((current) => ({ ...current, category: value === null || value === 'all' ? null : value }))
                    }
                  />
                </div>
              </PopoverContent>
            </PopoverRoot>
            <AddMenu onUpload={plugins.upload} onAddMarketplace={plugins.addMarketplace} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" id="plugins-scroll">
          <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-6 pb-10">
            {installed.length > 0 ? (
              <section aria-label="Your plugins" data-testid="plugins-installed" className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-foreground">Your plugins</h2>
                <div className="grid grid-cols-1 gap-x-6 gap-y-1 min-[760px]:grid-cols-2">
                  {installed.map((plugin) => (
                    <InstalledCard
                      key={plugin.id}
                      plugin={plugin}
                      busy={plugins.busy.has(plugin.id)}
                      onOpen={() => setSelection({ kind: 'installed', plugin })}
                      onToggle={(enabled) => void plugins.setEnabled(plugin, enabled)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {connectorTab ? <ConnectorResults query={filter.query} /> : null}

            {plugins.loading ? (
              <div className="flex justify-center py-10">
                <Spinner label="Loading plugins" />
              </div>
            ) : (
              <>
                <CatalogSection
                  title="Verified"
                  testId="plugins-verified"
                  entries={sections.verified}
                  expanded={expanded === 'verified'}
                  onExpand={() => setExpanded((current) => (current === 'verified' ? null : 'verified'))}
                  busy={plugins.busy}
                  onOpen={(entry) => setSelection({ kind: 'catalog', entry })}
                  onInstall={(entry) => void plugins.install(entry)}
                />
                <CatalogSection
                  title="Community"
                  testId="plugins-community"
                  entries={sections.community}
                  expanded={expanded === 'community'}
                  onExpand={() => setExpanded((current) => (current === 'community' ? null : 'community'))}
                  busy={plugins.busy}
                  onOpen={(entry) => setSelection({ kind: 'catalog', entry })}
                  onInstall={(entry) => void plugins.install(entry)}
                />
                {filtered.length === 0 && installed.length === 0 && !connectorTab ? (
                  <EmptyState
                    icon={Plug}
                    title={plugins.entries.length === 0 ? 'Catalogs unavailable' : 'No plugins match'}
                    description={
                      plugins.entries.length === 0
                        ? (plugins.marketplaces.find((entry) => entry.error !== null)?.error ??
                          'Press refresh to load the marketplaces.')
                        : 'Try another search, tab or filter.'
                    }
                  />
                ) : null}
                <MarketplaceFooter marketplaces={plugins.marketplaces} />
              </>
            )}
          </div>
        </div>
      </div>

      {selection === null ? null : (
        <DetailPanel
          selection={selection}
          installed={plugins.installed}
          busy={plugins.busy}
          onClose={() => setSelection(null)}
          onInstall={(entry) => void plugins.install(entry)}
          onRemove={async (plugin) => {
            await plugins.remove(plugin);
            setSelection(null);
          }}
          onToggle={(plugin, enabled) => void plugins.setEnabled(plugin, enabled)}
        />
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold', avatarTone(name))}>
      {avatarLetter(name)}
    </span>
  );
}

function EntryCard({
  entry,
  busy,
  onOpen,
  onInstall,
}: {
  entry: CatalogEntry;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 border-b border-border/60 py-2.5" data-testid="plugin-card">
      <Avatar name={entry.displayName} />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col text-left">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{entry.displayName}</span>
          {entry.verified ? <BadgeCheck aria-label="Verified" className="size-3.5 shrink-0 text-info-foreground" strokeWidth={2} /> : null}
        </span>
        <span className="line-clamp-2 text-xs text-muted-foreground">{entry.description || 'No description.'}</span>
        <span className="mt-0.5 truncate text-2xs text-muted-foreground">
          {componentLabel(entry)}
          {entry.repo === null ? '' : ` · ${entry.repo}`}
        </span>
      </button>
      {entry.installed ? (
        <Badge variant="success" size="sm" className="mt-1 shrink-0">
          Installed
        </Badge>
      ) : (
        <Button size="sm" variant="outline" className="mt-0.5 shrink-0" disabled={busy} onClick={onInstall} data-testid="plugin-install">
          {busy ? 'Installing' : 'Install'}
        </Button>
      )}
    </div>
  );
}

function CatalogSection({
  title,
  testId,
  entries,
  expanded,
  onExpand,
  busy,
  onOpen,
  onInstall,
}: {
  title: string;
  testId: string;
  entries: CatalogEntry[];
  expanded: boolean;
  onExpand: () => void;
  busy: ReadonlySet<string>;
  onOpen: (entry: CatalogEntry) => void;
  onInstall: (entry: CatalogEntry) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: expanded ? entries.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  if (entries.length === 0) return null;
  return (
    <section aria-label={title} data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          {title} <span className="font-normal text-muted-foreground tabular-nums">{entries.length}</span>
        </h2>
        {entries.length > PREVIEW_COUNT ? (
          <button type="button" onClick={onExpand} className="text-xs text-muted-foreground hover:text-foreground" data-testid={`${testId}-toggle`}>
            {expanded ? 'Show less' : 'Show all'}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div ref={scrollRef} className="max-h-[60vh] overflow-y-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = entries[item.index];
              if (entry === undefined) return null;
              return (
                <div key={entry.id} className="absolute left-0 w-full" style={{ top: item.start, height: ROW_HEIGHT }}>
                  <EntryCard entry={entry} busy={busy.has(entry.id)} onOpen={() => onOpen(entry)} onInstall={() => onInstall(entry)} />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-x-6 min-[760px]:grid-cols-2">
          {entries.slice(0, PREVIEW_COUNT).map((entry) => (
            <EntryCard key={entry.id} entry={entry} busy={busy.has(entry.id)} onOpen={() => onOpen(entry)} onInstall={() => onInstall(entry)} />
          ))}
        </div>
      )}
    </section>
  );
}

function InstalledCard({
  plugin,
  busy,
  onOpen,
  onToggle,
}: {
  plugin: InstalledPlugin;
  busy: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-border/60 py-2.5" data-testid="installed-plugin">
      <Avatar name={plugin.displayName} />
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col text-left">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{plugin.displayName}</span>
          <Badge variant="neutral" size="sm">
            {plugin.source === 'upload' ? 'Installed locally' : (plugin.marketplaceId ?? 'custom')}
          </Badge>
        </span>
        <span className="truncate text-2xs text-muted-foreground">{componentLabel(plugin)}</span>
      </button>
      <label className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={plugin.enabled}
          disabled={busy}
          data-testid="installed-plugin-toggle"
          onChange={(event) => onToggle(event.target.checked)}
        />
        {plugin.enabled ? 'On' : 'Off'}
      </label>
    </div>
  );
}

function ConnectorResults({ query }: { query: string }) {
  const rpc = useRpc();
  const search = useConnectorSearch(query, true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [envFor, setEnvFor] = useState<ConnectorEntry | null>(null);
  const [env, setEnv] = useState<Record<string, string>>({});

  async function install(entry: ConnectorEntry, values?: Record<string, string>): Promise<void> {
    if (entry.remoteUrl === null && entry.requiredEnv.length > 0 && values === undefined) {
      setEnvFor(entry);
      setEnv({});
      return;
    }
    setInstalling(entry.name);
    try {
      await rpc.request('connectors.install', { entry, ...(values === undefined ? {} : { env: values }) });
      toast.success(`${entry.title} connected. Its tools are available on the next turn.`);
      setEnvFor(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add the connector.');
    } finally {
      setInstalling(null);
    }
  }

  return (
    <section aria-label="MCP registry" data-testid="connector-results" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">MCP registry</h2>
      {search.error !== null ? <p className="text-xs text-error-foreground">{search.error}</p> : null}
      {search.loading && search.entries.length === 0 ? <Spinner size="sm" label="Searching" /> : null}
      <div className="grid grid-cols-1 gap-x-6 min-[760px]:grid-cols-2">
        {search.entries.map((entry) => (
          <div key={entry.name} className="flex min-w-0 flex-col gap-1 border-b border-border/60 py-2.5" data-testid="connector-card">
            <div className="flex min-w-0 items-start gap-3">
              <Avatar name={entry.title} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{entry.title}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{entry.description || entry.name}</span>
                <span className="truncate text-2xs text-muted-foreground">
                  {entry.remoteUrl !== null ? 'Hosted connector' : `Local · ${entry.npmPackage ?? ''}`}
                </span>
              </div>
              <Button size="sm" variant="outline" disabled={installing === entry.name} onClick={() => void install(entry)}>
                Connect
              </Button>
            </div>
            {envFor?.name === entry.name ? (
              <form
                className="ml-11 flex flex-col gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void install(entry, env);
                }}
              >
                {entry.requiredEnv.map((key) => (
                  <Input
                    key={key}
                    placeholder={key}
                    aria-label={key}
                    type={/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) ? 'password' : 'text'}
                    value={env[key] ?? ''}
                    onChange={(event) => setEnv((current) => ({ ...current, [key]: event.target.value }))}
                    className="h-7 text-xs"
                  />
                ))}
                <Button type="submit" size="sm" className="self-start">
                  Save and connect
                </Button>
              </form>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function MarketplaceFooter({ marketplaces }: { marketplaces: ReturnType<typeof usePlugins>['marketplaces'] }) {
  if (marketplaces.length === 0) return null;
  return (
    <p className="text-2xs text-muted-foreground" data-testid="plugins-marketplaces">
      Marketplaces:{' '}
      {marketplaces
        .map((entry) => `${entry.label}${entry.error !== null ? ' (unavailable)' : ''}${entry.skipped > 0 ? ` (${entry.skipped} skipped)` : ''}`)
        .join(', ')}
    </p>
  );
}

function DetailPanel({
  selection,
  installed,
  busy,
  onClose,
  onInstall,
  onRemove,
  onToggle,
}: {
  selection: NonNullable<Selection>;
  installed: InstalledPlugin[];
  busy: ReadonlySet<string>;
  onClose: () => void;
  onInstall: (entry: CatalogEntry) => void;
  onRemove: (plugin: InstalledPlugin) => Promise<void>;
  onToggle: (plugin: InstalledPlugin, enabled: boolean) => void;
}) {
  const plugin =
    selection.kind === 'installed'
      ? (installed.find((entry) => entry.id === selection.plugin.id) ?? selection.plugin)
      : installed.find(
          (entry) => entry.marketplaceId === selection.entry.marketplaceId && entry.name === selection.entry.name,
        );
  const entry = selection.kind === 'catalog' ? selection.entry : null;
  const name = plugin?.displayName ?? entry?.displayName ?? '';
  const description = plugin?.description || entry?.description || 'No description.';
  const components = plugin?.components ?? null;

  return (
    <aside data-testid="plugin-detail" aria-label={`${name} details`} className="flex w-[min(24rem,40vw)] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-[var(--row-height)] shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <IconButton icon={X} label="Close details" size="sm" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center gap-3">
          <Avatar name={name} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className="truncate text-2xs text-muted-foreground">
              {entry?.author ?? plugin?.marketplaceId ?? 'Local'}
              {entry?.repo ? ` · ${entry.repo}` : ''}
            </span>
          </div>
        </div>
        <p className="text-sm leading-6 text-foreground">{description}</p>
        {components !== null ? (
          <dl className="flex flex-col gap-1.5 text-xs">
            {(
              [
                ['Skills', components.skills],
                ['Commands', components.commands],
                ['Connectors', components.mcpServers],
                ['Agents (not run)', components.agents],
              ] as const
            )
              .filter(([, list]) => list.length > 0)
              .map(([label, list]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 flex-1 text-foreground">{list.join(', ')}</dd>
                </div>
              ))}
            {components.hooks ? (
              <p className="text-2xs text-warning-foreground">This plugin ships hooks. Tuffcode lists them but never runs them.</p>
            ) : null}
          </dl>
        ) : entry !== null ? (
          <p className="text-xs text-muted-foreground">{componentLabel(entry)}</p>
        ) : null}
        {entry?.homepage ? (
          <button
            type="button"
            className="flex items-center gap-1 self-start text-xs text-info-foreground hover:underline"
            onClick={() => window.tuffcode?.openExternal?.(entry.homepage ?? '')}
          >
            <ExternalLink className="size-3" strokeWidth={2} />
            Homepage
          </button>
        ) : null}
        <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
          {plugin === undefined ? (
            entry === null ? null : (
              <Button size="sm" disabled={busy.has(entry.id)} onClick={() => onInstall(entry)} data-testid="plugin-detail-install">
                {busy.has(entry.id) ? 'Installing' : 'Install'}
              </Button>
            )
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={busy.has(plugin.id)} onClick={() => onToggle(plugin, !plugin.enabled)}>
                {plugin.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="sm" variant="danger" disabled={busy.has(plugin.id)} onClick={() => void onRemove(plugin)} data-testid="plugin-detail-remove">
                <Trash2 className="size-3.5" strokeWidth={1.75} />
                Remove
              </Button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

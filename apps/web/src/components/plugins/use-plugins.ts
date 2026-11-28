import type { CatalogEntry, ConnectorEntry, InstalledPlugin, Marketplace } from '@tuffcode/contracts';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';

export interface PluginsState {
  entries: CatalogEntry[];
  marketplaces: Marketplace[];
  loading: boolean;
  refreshing: boolean;
  installed: InstalledPlugin[];
  busy: ReadonlySet<string>;
  refresh(): void;
  install(entry: CatalogEntry): Promise<void>;
  setEnabled(plugin: InstalledPlugin, enabled: boolean): Promise<void>;
  remove(plugin: InstalledPlugin): Promise<boolean>;
  upload(path: string): Promise<void>;
  addMarketplace(url: string): Promise<boolean>;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Catalog, installed list and actions for the Plugins hub. Opening the hub is the user
 * action that reads the catalogs; the server answers from its day-old cache when it
 * can, and Refresh forces a fetch.
 */
export function usePlugins(): PluginsState {
  const rpc = useRpc();
  const installed = useAppStore((state) => state.plugins);
  const setPlugins = useAppStore((state) => state.setPlugins);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  const load = useCallback(
    async (refresh: boolean) => {
      if (refresh) setRefreshing(true);
      try {
        const [catalog, plugins] = await Promise.all([
          rpc.request('plugins.catalog', { refresh }),
          rpc.request('plugins.installed', {}),
        ]);
        setEntries(catalog.entries);
        setMarketplaces(catalog.marketplaces);
        setPlugins(plugins);
        const failed = catalog.marketplaces.filter((entry) => entry.error !== null);
        if (refresh && failed.length > 0) {
          toast.error(`${failed.map((entry) => entry.label).join(', ')}: ${failed[0]?.error ?? 'unavailable'}`);
        }
      } catch (error) {
        toast.error(message(error, 'Could not load plugins.'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [rpc, setPlugins],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const track = useCallback(async function track<T>(
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    setBusy((current) => new Set(current).add(key));
    try {
      return await run();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const markInstalled = useCallback((entryId: string, value: boolean) => {
    setEntries((current) => current.map((entry) => (entry.id === entryId ? { ...entry, installed: value } : entry)));
  }, []);

  return {
    entries,
    marketplaces,
    loading,
    refreshing,
    installed,
    busy,
    refresh: () => void load(true),
    install: (entry) =>
      track(entry.id, async () => {
        try {
          const plugin = await rpc.request('plugins.install', { entryId: entry.id });
          markInstalled(entry.id, true);
          toast.success(`${plugin.displayName} installed.`);
        } catch (error) {
          toast.error(message(error, `Could not install ${entry.displayName}.`));
        }
      }),
    setEnabled: (plugin, enabled) =>
      track(plugin.id, async () => {
        try {
          await rpc.request('plugins.setEnabled', { id: plugin.id, enabled });
        } catch (error) {
          toast.error(message(error, 'Could not update the plugin.'));
        }
      }),
    remove: (plugin) =>
      track(plugin.id, async () => {
        try {
          await rpc.request('plugins.remove', { id: plugin.id });
          if (plugin.marketplaceId !== null) markInstalled(`${plugin.marketplaceId}/${plugin.name}`, false);
          toast.success(`${plugin.displayName} removed.`);
          return true;
        } catch (error) {
          toast.error(message(error, 'Could not remove the plugin.'));
          return false;
        }
      }),
    upload: (path) =>
      track('upload', async () => {
        try {
          const plugin = await rpc.request('plugins.upload', { path });
          toast.success(`${plugin.displayName} installed.`);
        } catch (error) {
          toast.error(message(error, 'Could not install that file.'));
        }
      }),
    addMarketplace: async (url) => {
      try {
        const added = await rpc.request('plugins.addMarketplace', { url });
        toast.success(`${added.label} added.`);
        await load(true);
        return true;
      } catch (error) {
        toast.error(message(error, 'Could not add the marketplace.'));
        return false;
      }
    },
  };
}

export interface ConnectorSearch {
  entries: ConnectorEntry[];
  error: string | null;
  loading: boolean;
}

/** Debounced MCP registry search for the Connectors tab. */
export function useConnectorSearch(query: string, enabled: boolean): ConnectorSearch {
  const rpc = useRpc();
  const [state, setState] = useState<ConnectorSearch>({ entries: [], error: null, loading: false });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    const timer = setTimeout(() => {
      void rpc.request('connectors.search', { query: query.trim() }).then(
        (result) => {
          if (!cancelled) setState({ entries: result.entries, error: result.error, loading: false });
        },
        (error: unknown) => {
          if (!cancelled) setState({ entries: [], error: message(error, 'Search failed.'), loading: false });
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, query, rpc]);
  return state;
}

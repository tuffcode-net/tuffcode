import { Link } from '@tanstack/react-router';
import { Badge, Card, CardDescription, CardHeader, CardTitle, buttonVariants } from '@tuffcode/ui';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { componentLabel } from '../../components/plugins/plugins-model';
import { SettingsSectionHeader } from '../../components/settings/settings-section-header';
import { useRpc } from '../../rpc/rpc-context';
import { useAppStore } from '../../store/app-store';
import { McpSection } from './mcp-section';

/**
 * Settings > Plugins: what is installed and active, with a link to the hub, and the
 * MCP servers (connectors) underneath, including stdio servers added by hand.
 */
export function PluginsSettingsSection() {
  const rpc = useRpc();
  const plugins = useAppStore((state) => state.plugins);
  const setPlugins = useAppStore((state) => state.setPlugins);

  useEffect(() => {
    void rpc.request('plugins.installed', {}).then(setPlugins, () => undefined);
  }, [rpc, setPlugins]);

  async function toggle(id: string, enabled: boolean): Promise<void> {
    try {
      await rpc.request('plugins.setEnabled', { id, enabled });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the plugin.');
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-6" data-testid="plugins-settings-section">
      <SettingsSectionHeader
        title="Plugins"
        description="Skills, commands and connectors you installed. Disabled plugins keep their files but give agents nothing."
        actions={
          <Link to="/plugins" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Browse plugins
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Active</CardTitle>
          <CardDescription>{plugins.length === 0 ? 'Nothing installed yet.' : `${plugins.length} installed`}</CardDescription>
        </CardHeader>
        <div className="divide-y divide-border border-t border-border">
          {plugins.map((plugin) => (
            <div key={plugin.id} className="flex items-center gap-3 px-4 py-3" data-testid="settings-plugin-row">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{plugin.displayName}</span>
                  {plugin.source === 'upload' ? <Badge variant="neutral" size="sm">Installed locally</Badge> : null}
                </span>
                <span className="truncate text-2xs text-muted-foreground">
                  {componentLabel(plugin)} · {plugin.marketplaceId ?? 'local'}
                </span>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={plugin.enabled}
                  onChange={(event) => void toggle(plugin.id, event.target.checked)}
                />
                {plugin.enabled ? 'On' : 'Off'}
              </label>
            </div>
          ))}
        </div>
      </Card>
      <McpSection />
    </div>
  );
}

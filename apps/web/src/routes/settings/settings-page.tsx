import { EmptyState, ScrollArea, buttonVariants, cn } from '@tuffcode/ui';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  Bell,
  Boxes,
  Info,
  Keyboard,
  Palette,
  Plug,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  SETTINGS_SECTION_LABEL,
  SETTINGS_SECTIONS,
  parseSettingsSection,
  type SettingsSection,
} from '../../components/settings/settings-section';
import { SAVE_BAR_CLEARANCE_PX } from '../../components/settings/save-bar';
import { AboutSection } from './about-section';
import { AgentsSection } from './agents-section';
import { AppearanceSection } from './appearance-section';
import { CapabilitiesSection } from './capabilities-section';
import { DiagnosticsSection } from './diagnostics-section';
import { KeybindingsSection } from './keybindings-section';
import { ModelsSection } from '../../components/settings/models-section';
import { NotificationsSection } from './notifications-section';
import { PermissionsSection } from './permissions-section';
import { PluginsSettingsSection } from './plugins-settings-section';
import { ProvidersSection } from './providers-section';
import { RemoteSection } from './remote-section';
import { TerminalSection } from './terminal-section';
import { UpdatesSection } from './updates-section';
import { YourTuffcodeSection } from './your-tuffcode-section';

const SECTION_ICON: Record<SettingsSection, LucideIcon> = {
  appearance: Palette,
  models: Boxes,
  'your-tuffcode': UserRound,
  capabilities: SlidersHorizontal,
  notifications: Bell,
  plugins: Plug,
  agents: Wrench,
  permissions: ShieldCheck,
  remote: Smartphone,
  terminal: SquareTerminal,
  updates: RefreshCw,
  diagnostics: Activity,
  keybindings: Keyboard,
  about: Info,
};

function renderSection(section: SettingsSection) {
  switch (section) {
    case 'appearance':
      return <AppearanceSection />;
    case 'models':
      // Providers and their models live on one page: sign in or add an endpoint, then
      // fetch and pick models from it.
      return (
        <div className="flex flex-col gap-10" data-testid="models-merged-section">
          <ProvidersSection />
          <ModelsSection />
        </div>
      );
    case 'your-tuffcode':
      return <YourTuffcodeSection />;
    case 'notifications':
      return <NotificationsSection />;
    case 'plugins':
      return <PluginsSettingsSection />;
    case 'agents':
      return <AgentsSection />;
    case 'permissions':
      return <PermissionsSection />;
    case 'remote':
      return <RemoteSection />;
    case 'terminal':
      return <TerminalSection />;
    case 'updates':
      return <UpdatesSection />;
    case 'diagnostics':
      return <DiagnosticsSection />;
    case 'keybindings':
      return <KeybindingsSection />;
    case 'capabilities':
      return <CapabilitiesSection />;
    case 'about':
      return <AboutSection />;
  }
}

export interface SettingsPageProps {
  section?: string;
}

export function SettingsPage({ section }: SettingsPageProps) {
  const parsed = parseSettingsSection(section);

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label="Settings sections"
        className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3"
      >
        <h1 className="px-2 pb-2 text-sm font-semibold text-foreground">Settings</h1>
        {SETTINGS_SECTIONS.map((id) => {
          const Icon = SECTION_ICON[id];
          const active = parsed === id;

          return (
            <Link
              key={id}
              to="/settings/{-$section}"
              params={{ section: id }}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-150',
                active
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon strokeWidth={1.75} className="size-4 shrink-0" />
              <span className="truncate">{SETTINGS_SECTION_LABEL[id]}</span>
            </Link>
          );
        })}
      </nav>

      <ScrollArea className="h-full min-w-0 flex-1">
        <div
          className="mx-auto flex min-h-full w-full max-w-[760px] flex-col p-6"
          style={{ paddingBottom: SAVE_BAR_CLEARANCE_PX }}
        >
          {parsed ? (
            renderSection(parsed)
          ) : (
            <EmptyState
              title="Unknown settings section"
              description="That section does not exist."
              action={
                <Link
                  to="/settings/{-$section}"
                  params={{ section: 'appearance' }}
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  Go to Appearance
                </Link>
              }
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

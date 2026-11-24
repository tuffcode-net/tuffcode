import { EmptyState, ScrollArea, buttonVariants, cn } from '@tuffcode/ui';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  Boxes,
  Brain,
  Info,
  Keyboard,
  Palette,
  RefreshCw,
  Server,
  ShieldCheck,
  SquareTerminal,
  Table2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  SETTINGS_SECTION_LABEL,
  SETTINGS_SECTIONS,
  parseSettingsSection,
  type SettingsSection,
} from '../../components/settings/settings-section';
import { AboutSection } from './about-section';
import { AgentsSection } from './agents-section';
import { AppearanceSection } from './appearance-section';
import { BrainSection } from './brain-section';
import { CapabilitiesSection } from './capabilities-section';
import { DiagnosticsSection } from './diagnostics-section';
import { KeybindingsSection } from './keybindings-section';
import { ModelsSection } from '../../components/settings/models-section';
import { PermissionsSection } from './permissions-section';
import { ProvidersSection } from './providers-section';
import { TerminalSection } from './terminal-section';
import { UpdatesSection } from './updates-section';

const SECTION_ICON: Record<SettingsSection, LucideIcon> = {
  appearance: Palette,
  providers: Server,
  models: Boxes,
  agents: Wrench,
  permissions: ShieldCheck,
  terminal: SquareTerminal,
  brain: Brain,
  updates: RefreshCw,
  diagnostics: Activity,
  keybindings: Keyboard,
  capabilities: Table2,
  about: Info,
};

function renderSection(section: SettingsSection) {
  switch (section) {
    case 'appearance':
      return <AppearanceSection />;
    case 'providers':
      return <ProvidersSection />;
    case 'models':
      return <ModelsSection />;
    case 'agents':
      return <AgentsSection />;
    case 'permissions':
      return <PermissionsSection />;
    case 'terminal':
      return <TerminalSection />;
    case 'brain':
      return <BrainSection />;
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
        <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col p-6">
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

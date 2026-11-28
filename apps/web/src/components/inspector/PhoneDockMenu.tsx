import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger, buttonVariants, cn } from '@tuffcode/ui';
import {
  Brain,
  FileDiff,
  FolderTree,
  Globe,
  ListTree,
  PanelRight,
  SquareTerminal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useAppStore } from '../../store/app-store';
import {
  INSPECTOR_TABS,
  INSPECTOR_TAB_LABEL,
  tabAllowed,
  type InspectorTab,
} from './inspector-tabs';

const TAB_ICON: Record<InspectorTab, LucideIcon> = {
  activity: ListTree,
  files: FolderTree,
  diff: FileDiff,
  terminal: SquareTerminal,
  browser: Globe,
  brain: Brain,
  council: Users,
};

export interface PhoneDockMenuProps {
  threadId: string;
  activeTab: InspectorTab | null;
  openTabs: readonly InspectorTab[];
  onToggle: (tab: InspectorTab) => void;
}

/**
 * The phone topbar's single panel control. The desktop toolbar's five toggles do
 * not fit next to the brand and the window controls below 768px, so the phone gets
 * one 44px button whose menu lists every panel this thread may open.
 */
export function PhoneDockMenu({ threadId, activeTab, openTabs, onToggle }: PhoneDockMenuProps) {
  const thread = useAppStore((state) => state.threads[threadId]);
  const browserEnabled = useAppStore((state) => state.settings?.capabilities.browser ?? true);
  const remote = useAppStore((state) => state.bootstrap?.remote === true);
  // A paired device has no shell and no arbitrary file reads, so the panels that need
  // them are not offered rather than opened and denied.
  const tabs = INSPECTOR_TABS.filter(
    (tab) =>
      tabAllowed(tab, thread) &&
      (tab !== 'browser' || browserEnabled) &&
      (!remote || (tab !== 'terminal' && tab !== 'files' && tab !== 'brain')),
  );

  return (
    <PopoverRoot>
      <PopoverTrigger
        aria-label="Panels"
        data-testid="phone-dock-menu"
        className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'no-drag size-11 md:size-8')}
      >
        <PanelRight strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <div data-testid="phone-dock-items" className="flex flex-col">
          {tabs.map((tab) => {
            const Icon = TAB_ICON[tab];
            const front = openTabs.includes(tab) && activeTab === tab;
            return (
              <PopoverClose
                key={tab}
                data-testid={`phone-dock-${tab}`}
                aria-pressed={front}
                onClick={() => onToggle(tab)}
                className={cn(
                  'flex h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                  front ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent',
                )}
              >
                <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">{INSPECTOR_TAB_LABEL[tab]}</span>
                {front ? <span className="text-2xs text-muted-foreground">Open</span> : null}
              </PopoverClose>
            );
          })}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

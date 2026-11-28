import { InterfaceSizeSchema, type Settings } from '@tuffcode/contracts';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  type SelectOption,
} from '@tuffcode/ui';
import { useEffect, useRef, type FormEvent } from 'react';
import { applyAppearance, applyTheme } from '../../components/settings/appearance';
import { SaveBar } from '../../components/settings/save-bar';
import { SettingsRow } from '../../components/settings/settings-row';
import { SettingsSectionHeader } from '../../components/settings/settings-section-header';
import { SettingsSlider } from '../../components/settings/settings-slider';
import { ThemePicker } from '../../components/settings/theme-picker';
import { useSettingsDraft } from '../../components/settings/use-settings-draft';
import { useAppStore } from '../../store/app-store';

const KEYS = ['theme', 'interfaceSize', 'fontSize', 'sidebarWidth', 'panelAnimation'] as const;

const INTERFACE_SIZE_OPTIONS: readonly SelectOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' },
];

export function AppearanceSection() {
  const settings = useAppStore((state) => state.settings);
  const { draft, dirty, saving, error, update, reset, submit, save } = useSettingsDraft(KEYS);

  // Preview while the form is dirty; the stored values win again on unmount.
  useEffect(() => {
    if (!draft) return;
    applyAppearance(draft);
  }, [draft?.interfaceSize, draft?.fontSize, draft?.sidebarWidth, draft?.panelAnimation]); // oxlint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (draft) applyTheme(draft.theme);
  }, [draft?.theme]); // oxlint-disable-line react-hooks/exhaustive-deps

  const storedSettings = useRef<Settings | null>(settings);
  storedSettings.current = settings;
  useEffect(
    () => () => {
      const stored = storedSettings.current;
      if (!stored) return;
      applyAppearance(stored);
      applyTheme(stored.theme);
    },
    [],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form className="flex flex-1 flex-col gap-4" onSubmit={handleSubmit}>
      <SettingsSectionHeader
        title="Appearance"
        description="Theme, text size, and how much room the sidebar takes. Changes apply as you make them and are saved with the rest of settings."
      />

      <Card>
        <CardHeader>
          <CardTitle>Theme and size</CardTitle>
          <CardDescription>The desktop window follows the theme you pick here.</CardDescription>
        </CardHeader>

        <div className="divide-y divide-border border-t border-border">
          <div className="flex flex-col gap-2 p-4">
            <div>
              <p className="text-sm font-medium text-foreground">Theme</p>
              <p className="text-2xs text-muted-foreground">
                Click a palette to apply it immediately. Code blocks, diffs and the terminal
                follow it.
              </p>
            </div>
            <ThemePicker
              value={draft?.theme}
              disabled={!draft || saving}
              onChange={(theme) => {
                update({ theme });
                void save({ theme });
              }}
            />
          </div>

          <SettingsRow
            label="Interface size"
            htmlFor="appearance-interface-size"
            description="Compact tightens rows, buttons, and panel headers. Comfortable gives them more room."
          >
            <Select
              id="appearance-interface-size"
              options={INTERFACE_SIZE_OPTIONS}
              value={draft?.interfaceSize ?? 'default'}
              onValueChange={(value) => {
                const parsed = InterfaceSizeSchema.safeParse(value);
                if (parsed.success) update({ interfaceSize: parsed.data });
              }}
            />
          </SettingsRow>

          <SettingsRow
            label="Font size"
            htmlFor="appearance-font-size"
            description="Scales text across the window. 14 is the default."
          >
            <SettingsSlider
              id="appearance-font-size"
              value={draft?.fontSize ?? 14}
              min={12}
              max={20}
              unit="px"
              onChange={(fontSize) => update({ fontSize })}
            />
          </SettingsRow>

          <SettingsRow
            label="Sidebar width"
            htmlFor="appearance-sidebar-width"
            description="Width of the project and thread sidebar in pixels."
          >
            <SettingsSlider
              id="appearance-sidebar-width"
              value={draft?.sidebarWidth ?? 256}
              min={208}
              max={360}
              step={8}
              unit="px"
              onChange={(sidebarWidth) => update({ sidebarWidth })}
            />
          </SettingsRow>

          <SettingsRow
            label="Panel animation"
            htmlFor="appearance-panel-animation"
            description="Fade the sidebar and inspector in when they open. The window also honours your OS reduce-motion setting."
          >
            <label
              htmlFor="appearance-panel-animation"
              className="flex h-9 items-center gap-2 text-sm text-foreground"
            >
              <input
                id="appearance-panel-animation"
                type="checkbox"
                className="size-4 rounded-sm border border-input accent-primary"
                checked={draft?.panelAnimation ?? false}
                onChange={(event) => update({ panelAnimation: event.target.checked })}
              />
              <span>Animate panels</span>
            </label>
          </SettingsRow>
        </div>
      </Card>

      <SaveBar dirty={dirty} saving={saving} error={error} onReset={reset} />
    </form>
  );
}

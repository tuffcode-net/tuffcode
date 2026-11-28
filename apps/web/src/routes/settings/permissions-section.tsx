import { PermissionModeSchema, type PermissionMode } from '@tuffcode/contracts';
import {
  Badge,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  type SelectOption,
} from '@tuffcode/ui';
import { X } from 'lucide-react';
import type { FormEvent } from 'react';
import { InlineAlert } from '../../components/settings/inline-alert';
import { SaveBar } from '../../components/settings/save-bar';
import { SettingsRow } from '../../components/settings/settings-row';
import { SettingsSectionHeader } from '../../components/settings/settings-section-header';
import { useSettingsDraft } from '../../components/settings/use-settings-draft';

const KEYS = ['defaultPermissionMode'] as const;

interface ModeExample {
  value: PermissionMode;
  label: string;
  summary: string;
  example: string;
}

/** Mirrors the permission policy the adapters apply to each tool kind. */
const MODE_EXAMPLES: readonly ModeExample[] = [
  {
    value: 'read-only',
    label: 'Read only',
    summary:
      'Reads, searches and read-only commands run. Anything that writes, fetches, or runs an arbitrary program is refused.',
    example: 'Read a file or run git log: runs. Run the test suite: refused without asking.',
  },
  {
    value: 'ask',
    label: 'Ask before edits',
    summary: 'Every tool call waits for you, including reads.',
    example: 'Read a file: asks. Edit a file: asks.',
  },
  {
    value: 'accept-edits',
    label: 'Accept edits',
    summary: 'Reads and file edits run. Shell commands and everything else wait for you.',
    example: 'Edit a file: runs. Run the test suite: asks.',
  },
  {
    value: 'full-auto',
    label: 'Full auto',
    summary: 'Every tool call runs without a prompt; a run ends on Stop, an abort, context compaction, or a repeated identical tool call.',
    example: 'Run the test suite: runs. Commit the change: runs.',
  },
];

const MODE_OPTIONS: readonly SelectOption[] = MODE_EXAMPLES.map((mode) => ({
  value: mode.value,
  label: mode.label,
}));

const REFUSED_IN_READ_ONLY = [
  'Shell commands that write or run an arbitrary program (builds, tests, installs)',
  'File edits, moves, renames and deletions',
  'Writes to remote services and anything else the CLI cannot classify',
];

export function PermissionsSection() {
  const { draft, dirty, saving, error, update, reset, submit } = useSettingsDraft(KEYS);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <SettingsSectionHeader
        title="Permissions"
        description="The mode a new thread starts with. Each thread keeps the mode it was created with; the composer can change it per thread."
      />

      <Card>
        <CardHeader>
          <CardTitle>Default mode</CardTitle>
          <CardDescription>Used when a new thread does not pick a mode.</CardDescription>
        </CardHeader>

        <div className="divide-y divide-border border-t border-border">
          <SettingsRow label="Mode" htmlFor="permissions-default-mode">
            <Select
              id="permissions-default-mode"
              options={MODE_OPTIONS}
              value={draft?.defaultPermissionMode ?? 'ask'}
              onValueChange={(value) => {
                const parsed = PermissionModeSchema.safeParse(value);
                if (parsed.success) update({ defaultPermissionMode: parsed.data });
              }}
            />
          </SettingsRow>
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-foreground">What each mode does</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODE_EXAMPLES.map((mode) => (
            <Card key={mode.value} className="p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{mode.label}</span>
                {draft?.defaultPermissionMode === mode.value ? (
                  <Badge variant="primary">Default</Badge>
                ) : null}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{mode.summary}</p>
              <p className="mt-1.5 text-xs leading-5 text-foreground/80">{mode.example}</p>
            </Card>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Refused in read-only mode</CardTitle>
            <CardDescription>
              Read-only mode answers every call itself, so nothing destructive reaches a prompt.
              This list is fixed.
            </CardDescription>
          </div>
          <Badge variant="outline">Read only</Badge>
        </CardHeader>

        <ul className="flex flex-col gap-1.5 border-t border-border px-4 py-3">
          {REFUSED_IN_READ_ONLY.map((item) => (
            <li
              key={item}
              className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
            >
              <X strokeWidth={2} className="mt-0.5 size-3.5 shrink-0 text-error" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      </Card>

      <InlineAlert tone="info">
        Approvals are per call. Allow once covers that one call; Always allow covers that tool for
        the rest of the thread only.
      </InlineAlert>

      <SaveBar dirty={dirty} saving={saving} error={error} onReset={reset} />
    </form>
  );
}

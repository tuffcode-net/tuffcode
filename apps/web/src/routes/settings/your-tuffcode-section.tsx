import type { BrainEntry, ResponseStyle } from '@tuffcode/contracts';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  IconButton,
  Input,
  Select,
  Spinner,
  Textarea,
} from '@tuffcode/ui';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../../components/settings/confirm-dialog';
import { customPromptBudget } from '../../components/settings/custom-prompt';
import { InlineAlert } from '../../components/settings/inline-alert';
import { SaveBar } from '../../components/settings/save-bar';
import { SettingsRow } from '../../components/settings/settings-row';
import { SettingsSectionHeader } from '../../components/settings/settings-section-header';
import { useSettingsDraft } from '../../components/settings/use-settings-draft';
import { useRpc } from '../../rpc/rpc-context';

const KEYS = ['profile', 'responseStyle', 'customInstructions', 'brainEnabled', 'brainCapture'] as const;

const STYLE_OPTIONS: { value: ResponseStyle; label: string }[] = [
  { value: 'default', label: 'Balanced' },
  { value: 'concise', label: 'Concise' },
  { value: 'detailed', label: 'Detailed' },
];

const KIND_LABEL: Record<string, string> = {
  identity: 'About you',
  preference: 'Preference',
  rule: 'Standing rule',
  project: 'Project fact',
  memory: 'Memory',
  'working-note': 'Working note',
};

type MemoryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: BrainEntry[] }
  | { status: 'error'; message: string };

/**
 * "Your Tuffcode": who you are, how you like answers, the instructions every turn
 * carries, and what Tuffcode remembers. Memory is on by default; it can be paused
 * (recall continues, nothing new is written), turned off, or reset.
 */
export function YourTuffcodeSection() {
  const { draft, dirty, saving, error, update, reset, submit } = useSettingsDraft(KEYS);
  const rpc = useRpc();
  const [memory, setMemory] = useState<MemoryState>({ status: 'loading' });
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(() => {
    rpc
      .request('brain.list', { limit: 200 })
      .then((entries) => setMemory({ status: 'ready', entries: entries.filter((entry) => entry.active) }))
      .catch((caught: unknown) =>
        setMemory({ status: 'error', message: caught instanceof Error ? caught.message : 'Could not load memory.' }),
      );
  }, [rpc]);

  useEffect(load, [load]);

  async function remove(id: string): Promise<void> {
    try {
      await rpc.request('brain.delete', { id });
      setMemory((current) =>
        current.status === 'ready' ? { status: 'ready', entries: current.entries.filter((entry) => entry.id !== id) } : current,
      );
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Could not forget that entry.');
    }
  }

  async function resetMemory(): Promise<void> {
    try {
      const { removed } = await rpc.request('brain.reset', {});
      toast.success(`Forgot ${removed} ${removed === 1 ? 'entry' : 'entries'}.`);
      load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Could not reset memory.');
    } finally {
      setConfirmReset(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  const profile = draft?.profile ?? { name: '', role: '', about: '' };
  const budget = customPromptBudget(draft?.customInstructions ?? '');

  return (
    <form className="flex flex-1 flex-col gap-4" onSubmit={handleSubmit} data-testid="your-tuffcode-section">
      <SettingsSectionHeader
        title="Your Tuffcode"
        description="Tell Tuffcode who you are and how you work. This stays on this machine and shapes every chat."
      />

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Added to the prompt as a short About you section. Leave a field empty to skip it.</CardDescription>
        </CardHeader>
        <div className="divide-y divide-border border-t border-border">
          <SettingsRow label="What should Tuffcode call you?" htmlFor="profile-name">
            <Input
              id="profile-name"
              data-testid="profile-name"
              value={profile.name}
              maxLength={80}
              onChange={(event) => update({ profile: { ...profile, name: event.target.value } })}
            />
          </SettingsRow>
          <SettingsRow label="What do you do?" htmlFor="profile-role" description="Your role or the kind of work you do.">
            <Input
              id="profile-role"
              value={profile.role}
              maxLength={120}
              placeholder="Maintainer of a Windows-first Electron app"
              onChange={(event) => update({ profile: { ...profile, role: event.target.value } })}
            />
          </SettingsRow>
          <SettingsRow label="Anything else to know?" htmlFor="profile-about" description="Context that should hold in every chat.">
            <Textarea
              id="profile-about"
              rows={3}
              value={profile.about}
              maxLength={2000}
              onChange={(event) => update({ profile: { ...profile, about: event.target.value } })}
            />
          </SettingsRow>
          <SettingsRow label="Response style" htmlFor="response-style">
            <Select
              id="response-style"
              aria-label="Response style"
              options={STYLE_OPTIONS}
              value={draft?.responseStyle ?? 'default'}
              onValueChange={(value) => update({ responseStyle: (value ?? 'default') as ResponseStyle })}
            />
          </SettingsRow>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Instructions</CardTitle>
          <CardDescription>Standing instructions sent with every turn, after the base prompt.</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-2 border-t border-border p-4">
          <Textarea
            id="custom-instructions"
            data-testid="custom-instructions"
            rows={8}
            value={draft?.customInstructions ?? ''}
            maxLength={budget.characterLimit}
            placeholder="Prefer pnpm. Run the narrowest test first. Explain trade-offs briefly."
            onChange={(event) => update({ customInstructions: event.target.value })}
          />
          <p className={budget.over ? 'text-2xs text-warning-foreground' : 'text-2xs text-muted-foreground'} data-testid="custom-instructions-count">
            About {budget.tokens} tokens
            {budget.over
              ? `. Past ${budget.tokenBudget} tokens the prompt keeps the first complete sentences that fit.`
              : '.'}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Memory</CardTitle>
            <CardDescription>
              Tuffcode remembers standing rules ("always remember that..."), preferences and project facts, and recalls only
              the ones relevant to each message.
            </CardDescription>
          </div>
          {memory.status === 'ready' ? <Badge variant="outline">{memory.entries.length}</Badge> : null}
        </CardHeader>
        <div className="divide-y divide-border border-t border-border">
          <SettingsRow label="Use memory" htmlFor="brain-enabled" description="Off stops both recall and saving.">
            <label htmlFor="brain-enabled" className="flex h-9 items-center gap-2 text-sm">
              <input
                id="brain-enabled"
                type="checkbox"
                data-testid="brain-enabled"
                className="size-4 accent-primary"
                checked={draft?.brainEnabled ?? true}
                onChange={(event) => update({ brainEnabled: event.target.checked })}
              />
              Recall memories in new turns
            </label>
          </SettingsRow>
          <SettingsRow label="Learn from chats" htmlFor="brain-capture" description="Pause to stop saving new memories while recall keeps working.">
            <label htmlFor="brain-capture" className="flex h-9 items-center gap-2 text-sm">
              <input
                id="brain-capture"
                type="checkbox"
                data-testid="brain-capture"
                className="size-4 accent-primary"
                disabled={!(draft?.brainEnabled ?? true)}
                checked={draft?.brainCapture ?? true}
                onChange={(event) => update({ brainCapture: event.target.checked })}
              />
              Save new rules and facts automatically
            </label>
          </SettingsRow>
          <div className="flex flex-col gap-1 px-4 py-3">
            {memory.status === 'loading' ? <Spinner size="sm" label="Loading memory" /> : null}
            {memory.status === 'error' ? <InlineAlert>{memory.message}</InlineAlert> : null}
            {memory.status === 'ready' && memory.entries.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing remembered yet.</p>
            ) : null}
            {memory.status === 'ready'
              ? memory.entries.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2 py-1" data-testid="memory-entry">
                    <Badge variant="neutral" size="sm" className="mt-0.5 shrink-0">
                      {KIND_LABEL[entry.kind] ?? entry.kind}
                    </Badge>
                    <span className="min-w-0 flex-1 text-xs leading-5 text-foreground">{entry.text}</span>
                    <IconButton icon={Trash2} label="Forget this" size="sm" className="size-6" onClick={() => void remove(entry.id)} />
                  </div>
                ))
              : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 self-start"
              data-testid="memory-reset"
              onClick={() => setConfirmReset(true)}
            >
              Reset memory
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmReset}
        title="Reset memory?"
        description="This permanently deletes every remembered rule, preference and fact. It cannot be undone."
        confirmLabel="Reset memory"
        onConfirm={() => void resetMemory()}
        onOpenChange={setConfirmReset}
      />
      <SaveBar dirty={dirty} saving={saving} error={error} onReset={reset} />
    </form>
  );
}

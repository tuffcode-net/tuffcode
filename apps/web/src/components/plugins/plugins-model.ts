import type { CatalogEntry, InstalledPlugin, PluginComponents } from '@tuffcode/contracts';

/** The Plugins hub's pure rules: tabs, filters, labels and grouping. */
export type PluginTab = 'all' | 'connectors' | 'skills';
export type PluginSourceFilter = 'all' | 'verified' | 'community';

export interface CatalogFilter {
  query: string;
  tab: PluginTab;
  source: PluginSourceFilter;
  /** Lowercase category, or null for every category. */
  category: string | null;
}

export const DEFAULT_FILTER: CatalogFilter = { query: '', tab: 'all', source: 'all', category: null };

function hasConnector(entry: CatalogEntry): boolean {
  return entry.kind === 'connector' || (entry.components?.mcpServers?.length ?? 0) > 0;
}

function hasSkills(entry: CatalogEntry): boolean {
  return entry.kind === 'skill' || (entry.components?.skills?.length ?? 0) > 0;
}

export function matchesTab(entry: CatalogEntry, tab: PluginTab): boolean {
  if (tab === 'connectors') return hasConnector(entry);
  if (tab === 'skills') return hasSkills(entry);
  return true;
}

export function matchesQuery(entry: CatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [entry.displayName, entry.name, entry.description, entry.category, entry.author ?? '', entry.repo ?? '']
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function filterCatalog(entries: readonly CatalogEntry[], filter: CatalogFilter): CatalogEntry[] {
  return entries.filter(
    (entry) =>
      matchesTab(entry, filter.tab) &&
      matchesQuery(entry, filter.query) &&
      (filter.source === 'all' || (filter.source === 'verified') === entry.verified) &&
      (filter.category === null || entry.category === filter.category),
  );
}

/** Categories in use, most common first, for the filter popover. */
export function catalogCategories(entries: readonly CatalogEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  return [...counts.entries()]
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category]) => category);
}

/** "Connectors & skills", "Commands & skills", "Skill", from declared or installed parts. */
export function componentLabel(input: {
  kind: CatalogEntry['kind'];
  components: Partial<PluginComponents> | null;
}): string {
  const parts: string[] = [];
  const components = input.components ?? {};
  if ((components.commands?.length ?? 0) > 0) parts.push('commands');
  if ((components.mcpServers?.length ?? 0) > 0 || input.kind === 'connector') parts.push('connector');
  if ((components.skills?.length ?? 0) > 0 || input.kind === 'skill') parts.push('skills');
  if (components.hooks === true) parts.push('hooks');
  if (parts.length === 0) return input.kind === 'skill' ? 'Skills' : input.kind === 'connector' ? 'Connector' : 'Plugin';
  const text = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} & ${parts.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A stable avatar hue per name, so the same plugin always gets the same color. */
const AVATAR_TONES = [
  'bg-info/20 text-info-foreground',
  'bg-success/20 text-success-foreground',
  'bg-warning/20 text-warning-foreground',
  'bg-primary/20 text-primary-soft',
  'bg-error/20 text-error-foreground',
] as const;

export function avatarTone(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0];
}

export function avatarLetter(name: string): string {
  return (name.trim().match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
}

export interface CatalogSections {
  verified: CatalogEntry[];
  community: CatalogEntry[];
}

export function splitSections(entries: readonly CatalogEntry[]): CatalogSections {
  return {
    verified: entries.filter((entry) => entry.verified),
    community: entries.filter((entry) => !entry.verified),
  };
}

export function filterInstalled(plugins: readonly InstalledPlugin[], filter: CatalogFilter): InstalledPlugin[] {
  const needle = filter.query.trim().toLowerCase();
  return plugins.filter((plugin) => {
    if (filter.tab === 'connectors' && plugin.components.mcpServers.length === 0) return false;
    if (filter.tab === 'skills' && plugin.components.skills.length === 0) return false;
    if (needle.length === 0) return true;
    return `${plugin.displayName} ${plugin.name} ${plugin.description}`.toLowerCase().includes(needle);
  });
}

/** A one-skill request the "Create with AI" chat starts from. */
export function createSkillPrompt(): string {
  return [
    'Help me create a new Tuffcode skill.',
    'Ask me what it should do, then write it to `.tuffcode/skills/<name>/SKILL.md` in this project with `name` and `description` frontmatter.',
    'Keep the body short and specific: when to use it, the steps, and the checks that prove it worked.',
  ].join(' ');
}

/**
 * Values behind the Instructions section and the prompt preview.
 *
 * The budget uses the same four-characters-per-token estimate as
 * `@tuffcode/prompt`, so the counter here matches what the server caps.
 */
import type { ReasoningEffort, SubagentModelChoice, SubagentModels } from '@tuffcode/contracts';

export const CUSTOM_INSTRUCTIONS_CHAR_LIMIT = 16000;
export const CUSTOM_INSTRUCTION_TOKEN_BUDGET = 4000;
export const CHARS_PER_TOKEN = 4;

/** Below the cap the textarea still shows a warning, so a cut never surprises. */
export const CUSTOM_INSTRUCTION_NEAR_RATIO = 0.8;

export const SAMPLE_PREVIEW_MESSAGE =
  'Walk through how one thread turn is assembled, then list the files that decide it.';

export const SUBAGENT_TYPES = ['explorer', 'reviewer', 'notetaker', 'worker', 'planner'] as const;
export type SubagentTypeName = (typeof SUBAGENT_TYPES)[number];

export const SUBAGENT_LABEL: Record<SubagentTypeName, string> = {
  explorer: 'Explorer',
  reviewer: 'Reviewer',
  notetaker: 'Notetaker',
  worker: 'Worker',
  planner: 'Planner',
};

export const SUBAGENT_DESCRIPTION: Record<SubagentTypeName, string> = {
  explorer: 'Read-only code mapping.',
  reviewer: 'Read-only change review.',
  notetaker: 'Turns a run into Brain facts.',
  worker: 'Edits files in its own worktree.',
  planner: 'Read-only plan and breakdown.',
};

export const SUBAGENT_CONCURRENCY_MIN = 1;
export const SUBAGENT_CONCURRENCY_MAX = 8;

/** Sentinel option values, so a select can express "inherit" without an empty string. */
export const PARENT_PROVIDER_VALUE = '__parent__';
export const INHERIT_MODEL_VALUE = '__inherit__';

export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.trim().length / CHARS_PER_TOKEN);
}

export interface CustomPromptBudget {
  characters: number;
  tokens: number;
  characterLimit: number;
  tokenBudget: number;
  remainingTokens: number;
  /** Budget used, clamped to 100 so the bar never overflows. */
  percent: number;
  over: boolean;
  near: boolean;
}

export function customPromptBudget(text: string): CustomPromptBudget {
  const tokens = estimatePromptTokens(text);
  const over = tokens > CUSTOM_INSTRUCTION_TOKEN_BUDGET;
  return {
    characters: text.length,
    tokens,
    characterLimit: CUSTOM_INSTRUCTIONS_CHAR_LIMIT,
    tokenBudget: CUSTOM_INSTRUCTION_TOKEN_BUDGET,
    remainingTokens: Math.max(0, CUSTOM_INSTRUCTION_TOKEN_BUDGET - tokens),
    percent: Math.min(100, Math.round((tokens / CUSTOM_INSTRUCTION_TOKEN_BUDGET) * 100)),
    over,
    near: !over && tokens >= CUSTOM_INSTRUCTION_TOKEN_BUDGET * CUSTOM_INSTRUCTION_NEAR_RATIO,
  };
}

/**
 * The order the server assembles sections in. The preview sorts by this list so a
 * server that ever returns sections out of order cannot mislead the reader.
 */
export const PROMPT_SECTION_ORDER = [
  'base',
  'plan-mode',
  'about-user',
  'custom-instructions',
  'project-rules',
  'skills',
  'available-skills',
  'brain-always',
  'retrieved-memory',
  'turn-context',
  'user-message',
] as const;

export type PromptSectionName = (typeof PROMPT_SECTION_ORDER)[number];

export const PROMPT_SECTION_LABEL: Record<PromptSectionName, string> = {
  base: 'Base prompt',
  'plan-mode': 'Plan mode',
  'about-user': 'About you',
  'custom-instructions': 'Custom instructions',
  'project-rules': 'Project rules',
  skills: 'Skills for this message',
  'available-skills': 'Available skills',
  'brain-always': 'Brain always',
  'retrieved-memory': 'Brain retrieved',
  'turn-context': 'Turn context',
  'user-message': 'User message',
};

/** Segment colours for the total bar; each one is a static class for Tailwind. */
const PROMPT_SECTION_BAR: Record<PromptSectionName, string> = {
  base: 'bg-primary',
  'plan-mode': 'bg-warning/60',
  'about-user': 'bg-info/60',
  'custom-instructions': 'bg-info',
  'project-rules': 'bg-info/40',
  skills: 'bg-success/70',
  'available-skills': 'bg-success/40',
  'brain-always': 'bg-success',
  'retrieved-memory': 'bg-warning',
  'turn-context': 'bg-muted-foreground',
  'user-message': 'bg-foreground/50',
};

export function isPromptSectionName(name: string): name is PromptSectionName {
  return (PROMPT_SECTION_ORDER as readonly string[]).includes(name);
}

export function promptSectionLabel(name: string): string {
  return isPromptSectionName(name) ? PROMPT_SECTION_LABEL[name] : name;
}

export function promptSectionBarClass(name: string): string {
  return isPromptSectionName(name) ? PROMPT_SECTION_BAR[name] : 'bg-border';
}

export interface PreviewSection {
  name: string;
  text: string;
  tokens: number;
}

/** Canonical order first; unknown names keep their relative order at the end. */
export function orderPromptSections<T extends { name: string }>(sections: readonly T[]): T[] {
  const known: T[] = [];
  const unknown: T[] = [];
  for (const section of sections) {
    if (isPromptSectionName(section.name)) known.push(section);
    else unknown.push(section);
  }
  known.sort(
    (left, right) =>
      PROMPT_SECTION_ORDER.indexOf(left.name as PromptSectionName) -
      PROMPT_SECTION_ORDER.indexOf(right.name as PromptSectionName),
  );
  return [...known, ...unknown];
}

/** A section's share of the total, rounded but never wider than the bar. */
export function previewSectionPercent(tokens: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (tokens / total) * 100));
}

/** One line of a section, collapsed, for the preview row. */
export function previewExcerpt(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 3).trimEnd()}...`;
}

export function subagentChoice(
  models: SubagentModels,
  type: SubagentTypeName,
): SubagentModelChoice {
  return models[type] ?? {};
}

/** Drops blank and undefined fields so an unset choice stays empty. */
function normalizeChoice(choice: SubagentModelChoice): SubagentModelChoice {
  const next: SubagentModelChoice = {};
  const providerId = choice.providerId?.trim();
  const model = choice.model?.trim();
  const fallbackModel = choice.fallbackModel?.trim();
  if (providerId !== undefined && providerId.length > 0) next.providerId = providerId;
  if (model !== undefined && model.length > 0) next.model = model;
  if (fallbackModel !== undefined && fallbackModel.length > 0) next.fallbackModel = fallbackModel;
  if (choice.effort !== undefined && choice.effort !== null) next.effort = choice.effort;
  return next;
}

export function setSubagentChoice(
  models: SubagentModels,
  type: SubagentTypeName,
  patch: SubagentModelChoice,
): SubagentModels {
  return { ...models, [type]: normalizeChoice({ ...subagentChoice(models, type), ...patch }) };
}

/**
 * Changing the provider invalidates the model ids: they belong to the old
 * provider, so the choice falls back to the new provider's default.
 */
export function setSubagentProvider(
  models: SubagentModels,
  type: SubagentTypeName,
  providerId: string | undefined,
): SubagentModels {
  return setSubagentChoice(models, type, {
    providerId,
    model: undefined,
    fallbackModel: undefined,
  });
}

export function providerSelectValue(choice: SubagentModelChoice): string {
  return choice.providerId ?? PARENT_PROVIDER_VALUE;
}

export function modelSelectValue(model: string | undefined): string {
  return model ?? INHERIT_MODEL_VALUE;
}

export function providerIdFromSelect(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === PARENT_PROVIDER_VALUE) return undefined;
  return trimmed;
}

export function modelIdFromSelect(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === INHERIT_MODEL_VALUE) return undefined;
  return trimmed;
}

/** Effort a subagent type may request; the inherit sentinel keeps the provider default. */
export const SUBAGENT_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export const SUBAGENT_EFFORT_LABEL: Record<(typeof SUBAGENT_EFFORT_VALUES)[number], string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};

export function effortFromSelect(value: string | null): ReasoningEffort | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === INHERIT_MODEL_VALUE) return undefined;
  return SUBAGENT_EFFORT_VALUES.find((level) => level === trimmed);
}

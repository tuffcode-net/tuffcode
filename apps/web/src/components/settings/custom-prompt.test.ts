import { DEFAULT_SETTINGS, emptySubagentModels, type Settings } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_INSTRUCTIONS_CHAR_LIMIT,
  CUSTOM_INSTRUCTION_TOKEN_BUDGET,
  INHERIT_MODEL_VALUE,
  PARENT_PROVIDER_VALUE,
  PROMPT_SECTION_LABEL,
  PROMPT_SECTION_ORDER,
  customPromptBudget,
  estimatePromptTokens,
  modelIdFromSelect,
  modelSelectValue,
  orderPromptSections,
  previewExcerpt,
  previewSectionPercent,
  promptSectionLabel,
  providerIdFromSelect,
  providerSelectValue,
  setSubagentChoice,
  setSubagentProvider,
  subagentChoice,
} from './custom-prompt';
import { buildSettingsPatch, isSettingsDraftDirty, pickSettings } from './settings-draft';

const KEYS = ['customInstructions', 'subagentModels', 'subagentConcurrency'] as const;

type DraftKey = (typeof KEYS)[number];

function draftOf(patch: Partial<Pick<Settings, DraftKey>> = {}): Pick<Settings, DraftKey> {
  return { ...pickSettings(DEFAULT_SETTINGS, KEYS), ...patch };
}

describe('custom instruction budget', () => {
  it('starts empty', () => {
    const budget = customPromptBudget('');
    expect(budget.tokens).toBe(0);
    expect(budget.percent).toBe(0);
    expect(budget.remainingTokens).toBe(CUSTOM_INSTRUCTION_TOKEN_BUDGET);
    expect(budget.over).toBe(false);
    expect(budget.near).toBe(false);
  });

  it('uses four characters per token and trims whitespace', () => {
    expect(estimatePromptTokens('abcd')).toBe(1);
    expect(estimatePromptTokens('abcde')).toBe(2);
    expect(customPromptBudget('   \n  ').tokens).toBe(0);
  });

  it('lands exactly on the budget without flagging it', () => {
    const budget = customPromptBudget('x'.repeat(CUSTOM_INSTRUCTION_TOKEN_BUDGET * 4));
    expect(budget.tokens).toBe(CUSTOM_INSTRUCTION_TOKEN_BUDGET);
    expect(budget.percent).toBe(100);
    expect(budget.over).toBe(false);
    expect(budget.remainingTokens).toBe(0);
  });

  it('flags and clamps anything over the budget', () => {
    const budget = customPromptBudget('x'.repeat(CUSTOM_INSTRUCTION_TOKEN_BUDGET * 4 + 4));
    expect(budget.tokens).toBe(CUSTOM_INSTRUCTION_TOKEN_BUDGET + 1);
    expect(budget.over).toBe(true);
    expect(budget.percent).toBe(100);
    expect(budget.remainingTokens).toBe(0);
  });

  it('warns near the budget before it is exceeded', () => {
    const budget = customPromptBudget('x'.repeat(CUSTOM_INSTRUCTION_TOKEN_BUDGET * 0.8 * 4));
    expect(budget.near).toBe(true);
    expect(budget.over).toBe(false);
  });
});

describe('settings draft for instructions and subagents', () => {
  it('compares rebuilt subagent objects by value', () => {
    const draft = draftOf({
      subagentModels: {
        ...emptySubagentModels(),
        explorer: { providerId: 'prv_1', model: 'fast' },
      },
    });
    expect(isSettingsDraftDirty(draft, DEFAULT_SETTINGS, KEYS)).toBe(true);

    const settings: Settings = { ...DEFAULT_SETTINGS, subagentModels: draft.subagentModels };
    expect(isSettingsDraftDirty(draft, settings, KEYS)).toBe(false);
  });

  it('ignores blank choice fields when comparing', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      subagentModels: { ...emptySubagentModels(), explorer: { providerId: 'prv_1' } },
    };
    const draft = draftOf({
      subagentModels: {
        ...emptySubagentModels(),
        explorer: { providerId: 'prv_1', model: '', fallbackModel: '  ' },
      },
    });
    expect(isSettingsDraftDirty(draft, settings, KEYS)).toBe(false);
  });

  it('reports a changed model and patches only the touched keys', () => {
    const settings = DEFAULT_SETTINGS;
    const draft = draftOf({
      subagentModels: {
        ...emptySubagentModels(),
        worker: { providerId: 'prv_2', model: 'big', fallbackModel: 'small' },
      },
      subagentConcurrency: 6,
    });
    expect(isSettingsDraftDirty(draft, settings, KEYS)).toBe(true);
    expect(buildSettingsPatch(draft, settings, KEYS)).toEqual({
      subagentModels: {
        ...emptySubagentModels(),
        worker: { providerId: 'prv_2', model: 'big', fallbackModel: 'small' },
      },
      subagentConcurrency: 6,
    });
  });

  it('patches custom instructions on their own', () => {
    const settings = DEFAULT_SETTINGS;
    const draft = draftOf({ customInstructions: 'Prefer pnpm.' });
    expect(buildSettingsPatch(draft, settings, KEYS)).toEqual({
      customInstructions: 'Prefer pnpm.',
    });
  });
});

describe('subagent model payload building', () => {
  it('sets a provider without touching the other types', () => {
    const next = setSubagentProvider(emptySubagentModels(), 'worker', 'prv_1');
    expect(next.worker).toEqual({ providerId: 'prv_1' });
    expect(next.explorer).toEqual({});
    expect(next.planner).toEqual({});
  });

  it('merges a model and a fallback into the existing choice', () => {
    let models = setSubagentProvider(emptySubagentModels(), 'worker', 'prv_1');
    models = setSubagentChoice(models, 'worker', { model: 'big' });
    models = setSubagentChoice(models, 'worker', { fallbackModel: 'small' });
    expect(subagentChoice(models, 'worker')).toEqual({
      providerId: 'prv_1',
      model: 'big',
      fallbackModel: 'small',
    });
  });

  it('clears models when the provider changes', () => {
    const current = {
      ...emptySubagentModels(),
      reviewer: { providerId: 'prv_1', model: 'big', fallbackModel: 'small' },
    };
    expect(setSubagentProvider(current, 'reviewer', 'prv_2').reviewer).toEqual({
      providerId: 'prv_2',
    });
  });

  it('clears the choice when the provider is unset', () => {
    const current = {
      ...emptySubagentModels(),
      notetaker: { providerId: 'prv_1', model: 'big' },
    };
    expect(setSubagentProvider(current, 'notetaker', undefined).notetaker).toEqual({});
  });

  it('does not mutate the input', () => {
    const current = emptySubagentModels();
    setSubagentChoice(current, 'explorer', { providerId: 'prv_1' });
    expect(current.explorer).toEqual({});
  });

  it('round-trips the select sentinels', () => {
    expect(providerSelectValue({})).toBe(PARENT_PROVIDER_VALUE);
    expect(providerSelectValue({ providerId: 'prv_1' })).toBe('prv_1');
    expect(providerIdFromSelect(PARENT_PROVIDER_VALUE)).toBeUndefined();
    expect(providerIdFromSelect(null)).toBeUndefined();
    expect(providerIdFromSelect('prv_1')).toBe('prv_1');
    expect(modelSelectValue(undefined)).toBe(INHERIT_MODEL_VALUE);
    expect(modelIdFromSelect(INHERIT_MODEL_VALUE)).toBeUndefined();
    expect(modelIdFromSelect(null)).toBeUndefined();
    expect(modelIdFromSelect('big')).toBe('big');
  });
});

describe('custom instruction budget', () => {
  it('accepts exactly the text the UI limit allows', () => {
    expect(CUSTOM_INSTRUCTIONS_CHAR_LIMIT).toBe(CUSTOM_INSTRUCTION_TOKEN_BUDGET * 4);
  });
});

describe('prompt preview sections', () => {
  it('labels every section the server can return', () => {
    expect(PROMPT_SECTION_ORDER.map((name) => promptSectionLabel(name))).toEqual([
      PROMPT_SECTION_LABEL.base,
      PROMPT_SECTION_LABEL['plan-mode'],
      PROMPT_SECTION_LABEL['about-user'],
      PROMPT_SECTION_LABEL['custom-instructions'],
      PROMPT_SECTION_LABEL['project-rules'],
      PROMPT_SECTION_LABEL.skills,
      PROMPT_SECTION_LABEL['available-skills'],
      PROMPT_SECTION_LABEL['brain-always'],
      PROMPT_SECTION_LABEL['retrieved-memory'],
      PROMPT_SECTION_LABEL['turn-context'],
      PROMPT_SECTION_LABEL['user-message'],
    ]);
  });

  it('sorts a shuffled response into assembly order', () => {
    const sections = [
      { name: 'user-message', tokens: 4 },
      { name: 'turn-context', tokens: 10 },
      { name: 'retrieved-memory', tokens: 20 },
      { name: 'base', tokens: 800 },
      { name: 'brain-always', tokens: 30 },
      { name: 'custom-instructions', tokens: 40 },
    ];
    expect(orderPromptSections(sections).map((section) => section.name)).toEqual([
      'base',
      'custom-instructions',
      'brain-always',
      'retrieved-memory',
      'turn-context',
      'user-message',
    ]);
  });

  it('keeps unknown sections last in their given order', () => {
    const sections = [
      { name: 'mystery-b' },
      { name: 'user-message' },
      { name: 'base' },
      { name: 'mystery-a' },
    ];
    expect(orderPromptSections(sections).map((section) => section.name)).toEqual([
      'base',
      'user-message',
      'mystery-b',
      'mystery-a',
    ]);
  });

  it('sizes bar segments against the total', () => {
    expect(previewSectionPercent(0, 0)).toBe(0);
    expect(previewSectionPercent(50, 100)).toBe(50);
    expect(previewSectionPercent(150, 100)).toBe(100);
  });

  it('collapses and truncates the excerpt', () => {
    expect(previewExcerpt('one\n\n  two')).toBe('one two');
    const long = previewExcerpt('x'.repeat(400), 40);
    expect(long.length).toBe(40);
    expect(long.endsWith('...')).toBe(true);
  });
});

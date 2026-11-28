import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  SettingsSchema,
  SubagentModelChoiceSchema,
  emptySubagentModels,
} from './index.js';

describe('subagent effort setting', () => {
  it('keeps a configured effort through a settings round trip', () => {
    const parsed = SettingsSchema.parse({
      subagentModels: {
        ...emptySubagentModels(),
        worker: { providerId: 'prv_1', model: 'big-model', effort: 'high' },
      },
    });
    expect(parsed.subagentModels.worker.effort).toBe('high');
    expect(parsed.subagentModels.worker).toEqual({
      providerId: 'prv_1',
      model: 'big-model',
      effort: 'high',
    });
  });

  it('parses an older settings object that has no effort key', () => {
    const parsed = SettingsSchema.parse({
      subagentModels: {
        ...emptySubagentModels(),
        explorer: { providerId: 'prv_1', model: 'fast-model' },
      },
    });
    expect(parsed.subagentModels.explorer.effort).toBeUndefined();
    expect(parsed.subagentModels.explorer).toEqual({ providerId: 'prv_1', model: 'fast-model' });
  });

  it('accepts null and rejects an unknown level', () => {
    expect(SubagentModelChoiceSchema.parse({ effort: null }).effort).toBeNull();
    expect(SubagentModelChoiceSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
  });

  it('patches one type effort without disturbing the rest', () => {
    const patch = SettingsPatchSchema.parse({
      subagentModels: {
        ...DEFAULT_SETTINGS.subagentModels,
        reviewer: { effort: 'low' },
      },
    });
    expect(patch.subagentModels?.reviewer).toEqual({ effort: 'low' });
  });
});

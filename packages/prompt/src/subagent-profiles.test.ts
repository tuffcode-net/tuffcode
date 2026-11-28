import { describe, expect, it } from 'vitest';
import { SUBAGENT_TOOL_PROFILES, SUBAGENT_TYPES } from './index';

const DASHES = /[\u2013\u2014]/;

describe('subagent tool profiles', () => {
  it('covers every type exactly once', () => {
    expect(Object.keys(SUBAGENT_TOOL_PROFILES).toSorted()).toEqual([...SUBAGENT_TYPES].toSorted());
    for (const type of SUBAGENT_TYPES) {
      expect(SUBAGENT_TOOL_PROFILES[type].offer.length).toBeGreaterThan(0);
    }
  });

  it('never offers a child the config tool or a way to fan out', () => {
    for (const type of SUBAGENT_TYPES) {
      const offer = SUBAGENT_TOOL_PROFILES[type].offer;
      expect(offer).not.toContain('config');
      for (const action of ['spawn', 'message', 'stop', 'wait', 'inbox']) {
        expect(offer).not.toContain('subagent:' + action);
      }
    }
  });

  it('lets every child ask its parent one blocking question', () => {
    for (const type of SUBAGENT_TYPES) {
      expect(SUBAGENT_TOOL_PROFILES[type].offer).toContain('subagent:ask');
    }
  });

  it('gives the worktree bash rule to the worker alone', () => {
    for (const type of SUBAGENT_TYPES) {
      expect(SUBAGENT_TOOL_PROFILES[type].bash).toBe(type === 'worker' ? 'worktree' : 'read-only');
    }
  });

  it('gives every read-only type a write limit and the worker its whole worktree', () => {
    for (const type of SUBAGENT_TYPES) {
      const profile = SUBAGENT_TOOL_PROFILES[type];
      expect(profile.writeGlobs).toBeDefined();
      if (type === 'worker') {
        expect(profile.writeGlobs).toEqual(['**']);
      } else {
        expect(profile.writeGlobs).toEqual(['**/*.md']);
      }
    }
  });

  it('keeps the memory write for the notetaker and the worker only', () => {
    for (const type of SUBAGENT_TYPES) {
      const offer = SUBAGENT_TOOL_PROFILES[type].offer;
      expect(offer.includes('memory:add')).toBe(type === 'notetaker' || type === 'worker');
    }
  });

  it('writes no em or en dashes in any profile', () => {
    expect(JSON.stringify(SUBAGENT_TOOL_PROFILES)).not.toMatch(DASHES);
  });
});

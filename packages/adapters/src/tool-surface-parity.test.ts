import { describe, expect, it } from 'vitest';
import { assemblePrompt } from '@tuffcode/prompt';
import type {
  AdapterDeps,
  AdapterLogger,
  SubagentType,
  ToolProfile,
  TurnContext,
  TurnToolOptions,
} from '@tuffcode/contracts';
import {
  SUBAGENT_TOOL_PROFILES,
  SUBAGENT_TYPES,
  buildSubagentMessage,
} from '@tuffcode/prompt';
import { allowedToolSchemas, profileOffers } from './tool-policy.js';
import { toOpenAITools } from './openai/client.js';
import { toAnthropicTools } from './anthropic/client.js';
import { tuffcodeToolSpecs } from './claude/tuffcode-tools.js';

/**
 * One role, three promises: the schemas the model is shown, the tools the policy will
 * execute, and the tools the prompt names. They are derived from one table, so a drift
 * between them is a bug in that table or in a surface that bypasses it, and a child
 * either tries a tool it cannot call or fails to learn about one it has.
 */

const ALL_SERVER_TOOLS: TurnToolOptions = {
  subagent: true,
  extra: true,
  todo: true,
  skill: true,
  webFetch: true,
  mcp: true,
};

/** Server tools the claude adapter registers itself; the rest are the vendor's. */
const SERVER_TOOLS: Record<string, true> = {
  todo: true,
  skill: true,
  memory: true,
  config: true,
  mcp: true,
  web_fetch: true,
  subagent: true,
};

/** The adapter builders return the wire shape; this is the one field the test reads. */
type NamedWireTool = { name?: string; function?: { name?: string } };

function wireName(tool: unknown): string {
  const named = tool as NamedWireTool;
  return named.function?.name ?? named.name ?? '';
}

/** The phrase the child prompt must carry for a tool it was offered. */
function promptPhrase(name: string): string | null {
  switch (name) {
    case 'read':
    case 'glob':
    case 'grep':
      return 'read and search';
    case 'bash':
      return 'shell commands';
    case 'edit':
    case 'write':
      return 'you may write';
    case 'memory':
      return 'memory';
    case 'mcp':
      return 'MCP lookups';
    case 'web_fetch':
      return 'web fetch';
    case 'subagent':
      return 'subagent ask';
    default:
      return null;
  }
}

const logger: AdapterLogger = { debug() {}, info() {}, warn() {}, error() {} };

const deps: AdapterDeps = {
  logger,
  env: {},
  resolveCommand: async () => null,
  extraTool: async () => '',
  spawnSubagent: async () => ({ childId: 'c1', status: 'queued' }),
  subagentControl: async () => '',
};

function contextFor(profile: ToolProfile | undefined): TurnContext {
  return {
    turnId: 'turn-1',
    cwd: '/wt',
    systemPrompt: 'sys',
    permissionMode: 'full-auto',
    model: 'mock-model',
    brainSlice: '',
    attachments: [],
    vision: false,
    signal: new AbortController().signal,
    toolOptions: ALL_SERVER_TOOLS,
    ...(profile === undefined ? {} : { toolProfile: profile }),
  };
}

function promptFor(type: SubagentType): string {
  return buildSubagentMessage({ type, task: 'do the thing' });
}

describe('tool surface parity per subagent role', () => {
  for (const type of SUBAGENT_TYPES) {
    const profile = SUBAGENT_TOOL_PROFILES[type];

    it(`${type}: openai and anthropic send the same schemas`, () => {
      const openai = toOpenAITools(undefined, ALL_SERVER_TOOLS, profile).map(wireName);
      const anthropic = toAnthropicTools(undefined, ALL_SERVER_TOOLS, profile).map(wireName);
      expect(anthropic).toEqual(openai);
    });

    it(`${type}: the policy executes exactly the schemas that are sent`, () => {
      const names = allowedToolSchemas(undefined, ALL_SERVER_TOOLS, profile).map(
        (schema) => schema.name,
      );
      for (const name of names) expect(profileOffers(profile, name), name).toBe(true);
      // And nothing the profile names is missing from the request.
      for (const entry of profile.offer) {
        const name = entry.split(':')[0] ?? entry;
        if (SERVER_TOOLS[name] === true || name === 'bash') {
          expect(names, name).toContain(name);
        }
      }
    });

    it(`${type}: the prompt names every tool that is sent`, () => {
      const names = allowedToolSchemas(undefined, ALL_SERVER_TOOLS, profile).map(
        (schema) => schema.name,
      );
      const prompt = promptFor(type);
      for (const name of names) {
        const phrase = promptPhrase(name);
        if (phrase === null) continue;
        expect(prompt, `${type} prompt must name ${name}`).toContain(phrase);
      }
    });

    it(`${type}: the prompt promises no tool the profile does not offer`, () => {
      const prompt = promptFor(type);
      for (const name of ['web_fetch', 'mcp', 'memory', 'bash', 'subagent']) {
        if (profileOffers(profile, name)) continue;
        const phrase = promptPhrase(name);
        if (phrase === null) continue;
        expect(prompt, `${type} prompt must not name ${name}`).not.toContain(phrase);
      }
    });

    it(`${type}: the claude adapter registers the same server tools`, () => {
      const specs = tuffcodeToolSpecs(deps, contextFor(profile)).map((spec) => spec.name);
      const expected = allowedToolSchemas(undefined, ALL_SERVER_TOOLS, profile)
        .map((schema) => schema.name)
        .filter((name) => SERVER_TOOLS[name] === true);
      expect(specs.toSorted()).toEqual(expected.toSorted());
    });
  }
});

/**
 * Main and the three council roles run with no ToolProfile at all: `turnToolPolicy`
 * gives a council thread every tool and no allowlist, and its children are provisioned
 * with the same policy. They must therefore see the full surface on every adapter and
 * keep the main prompt, with the skills sections a child loses.
 */
describe('roles without a profile: main, council planner, task and review', () => {
  it('offers the full tool set on all three adapters', () => {
    const names = allowedToolSchemas(undefined, ALL_SERVER_TOOLS).map((schema) => schema.name);
    expect(names).toContain('config');
    expect(names).toContain('skill');
    expect(toOpenAITools(undefined, ALL_SERVER_TOOLS).map(wireName)).toEqual(names);
    expect(toAnthropicTools(undefined, ALL_SERVER_TOOLS).map(wireName)).toEqual(names);
    const specs = tuffcodeToolSpecs(deps, contextFor(undefined)).map((spec) => spec.name);
    const expected = names.filter((name) => SERVER_TOOLS[name] === true);
    expect(specs.toSorted()).toEqual(expected.toSorted());
  });

  it('keeps the main prompt and its skills for council threads', () => {
    const turnContext = {
      date: '2026-01-01',
      mode: 'work' as const,
      cwd: '/wt',
      projectName: 'project',
      brainSlice: '',
    };
    const main = assemblePrompt({
      role: 'main',
      skills: 'skill body',
      turnContext,
      userMessage: 'go',
    });
    const child = assemblePrompt({
      role: 'child',
      skills: 'skill body',
      turnContext,
      userMessage: 'go',
    });
    expect(main.sections.map((entry) => entry.name)).toContain('skills');
    expect(child.sections.map((entry) => entry.name)).not.toContain('skills');
    expect(child.systemPrompt).toContain('subagent working for a parent agent');
    expect(main.systemPrompt).not.toContain('subagent working for a parent agent');
  });
});

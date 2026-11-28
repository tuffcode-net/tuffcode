import type { ToolProfile } from '@tuffcode/contracts';
import { SUBAGENT_TOOL_PROFILES, TOOL_SCHEMAS } from '@tuffcode/prompt';
import { describe, expect, it } from 'vitest';
import {
  allowedToolSchemas,
  isParallelSafeTool,
  profileAllows,
  RepeatedToolCallGuard,
} from './tool-policy.js';

describe('allowedToolSchemas', () => {
  it('offers the six core tools when the allowlist is unset', () => {
    expect(allowedToolSchemas().map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'edit',
      'write',
      'glob',
      'grep',
    ]);
  });

  it('filters the core tools by the allowlist', () => {
    expect(allowedToolSchemas(['read', 'grep']).map((tool) => tool.name)).toEqual([
      'read',
      'grep',
    ]);
  });

  it('adds the subagent tool outside the allowlist', () => {
    expect(allowedToolSchemas(['read'], { subagent: true }).map((tool) => tool.name)).toEqual([
      'read',
      'subagent',
    ]);
  });

  it('offers the extra tools only when a runner is injected', () => {
    expect(allowedToolSchemas(['read']).map((tool) => tool.name)).not.toContain('mcp');
    expect(allowedToolSchemas(['read'], { extra: true }).map((tool) => tool.name)).toEqual([
      'read',
      'mcp',
      'memory',
      'config',
    ]);
  });

  it('keeps the subagent and extra tools outside a narrowed allowlist', () => {
    expect(
      allowedToolSchemas(['read'], { subagent: true, extra: true }).map((tool) => tool.name),
    ).toEqual(['read', 'subagent', 'mcp', 'memory', 'config']);
  });
});

describe('tool profile', () => {
  const explorer = SUBAGENT_TOOL_PROFILES.explorer;
  const allServerTools = {
    subagent: true,
    extra: true,
    todo: true,
    skill: true,
    webFetch: true,
    mcp: true,
  };

  it('offers only what the profile names, with the write limit spelled out', () => {
    const tools = allowedToolSchemas(undefined, allServerTools, explorer);
    expect(tools.map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'edit',
      'write',
      'glob',
      'grep',
      'subagent',
      'mcp',
      'memory',
      'todo',
      'web_fetch',
    ]);
    expect(tools.map((tool) => tool.name)).not.toContain('config');
    expect(tools.map((tool) => tool.name)).not.toContain('skill');
    const write = tools.find((tool) => tool.name === 'write');
    expect(write?.description).toContain('You may write only these paths: **/*.md.');
    const bash = tools.find((tool) => tool.name === 'bash');
    expect(bash?.description).toContain('Read-only commands only');
    // The shared schemas stay untouched, so the prompt budget test still sees them.
    expect(TOOL_SCHEMAS.find((tool) => tool.name === 'write')?.description).not.toContain(
      'You may write only',
    );
  });

  it('offers the subagent tool only when the profile names an action for it', () => {
    const noDelegation: ToolProfile = { offer: ['read'], bash: 'none' };
    const offered = allowedToolSchemas(undefined, { subagent: true }, noDelegation);
    expect(offered.map((tool) => tool.name)).toEqual(['read']);
  });

  it('judges a write by the profile globs, case-insensitively', () => {
    expect(profileAllows('write', { path: 'docs/notes.md' }, explorer, 'C:/wt')).toEqual({
      allowed: true,
    });
    expect(profileAllows('write', { path: 'README.MD' }, explorer, 'C:/wt')).toEqual({
      allowed: true,
    });
    expect(profileAllows('edit', { path: 'docs/notes.md' }, explorer, 'C:/wt')).toEqual({
      allowed: true,
    });
    const refused = profileAllows('write', { path: 'src/a.ts' }, explorer, 'C:/wt');
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false ? refused.reason : '').toContain(
      'write may touch only these paths: **/*.md',
    );
    expect(refused.allowed === false ? refused.reason : '').toContain('src/a.ts');
    expect(profileAllows('write', { path: '../x.md' }, explorer, 'C:/wt').allowed).toBe(false);
  });

  it('judges bash by the profile rule, not the permission mode', () => {
    const worker = SUBAGENT_TOOL_PROFILES.worker;
    expect(profileAllows('bash', { command: 'rm -rf /' }, worker, 'C:/wt').allowed).toBe(false);
    expect(profileAllows('bash', { command: 'pnpm test' }, worker, 'C:/wt')).toEqual({
      allowed: true,
    });
    expect(profileAllows('bash', { command: 'pnpm test' }, explorer, 'C:/wt').allowed).toBe(false);
    const refused = profileAllows('bash', { command: 'pnpm test' }, explorer, 'C:/wt');
    const reason = refused.allowed === false ? refused.reason : '';
    expect(reason).toContain('git status/log/show');
    // The hint names the null device of the shell this platform spawns, and only that one.
    expect(reason).toContain(process.platform === 'win32' ? '2>NUL' : '2>/dev/null');
    expect(profileAllows('bash', { command: 'git status 2>&1' }, explorer, 'C:/wt')).toEqual({
      allowed: true,
    });
    expect(profileAllows('bash', { command: 'git status' }, explorer, 'C:/wt')).toEqual({
      allowed: true,
    });
    const noBash: ToolProfile = { offer: ['bash'], bash: 'none' };
    expect(profileAllows('bash', { command: 'ls' }, noBash, 'C:/wt').allowed).toBe(false);
  });

  it('names the actions a child may use and refuses the rest', () => {
    const spawn = profileAllows('subagent', { action: 'spawn' }, explorer, 'C:/wt');
    expect(spawn.allowed).toBe(false);
    expect(spawn.allowed === false ? spawn.reason : '').toContain(
      'subagent only offers these actions: status, report, ask',
    );
    expect(profileAllows('subagent', { action: 'report' }, explorer, 'C:/wt')).toEqual({
      allowed: true,
    });
    // No action defaults to spawn, which a child never gets.
    expect(profileAllows('subagent', {}, explorer, 'C:/wt').allowed).toBe(false);
    expect(profileAllows('config', { action: 'settings.set' }, explorer, 'C:/wt').allowed).toBe(
      false,
    );
    expect(profileAllows('memory', { action: 'add', text: 'x' }, explorer, 'C:/wt').allowed).toBe(
      false,
    );
    expect(profileAllows('read', { path: 'a.ts' }, explorer, 'C:/wt')).toEqual({ allowed: true });
  });
});

describe('isParallelSafeTool', () => {
  it('accepts the file tools that only read', () => {
    expect(isParallelSafeTool('read', { path: 'a.ts' })).toBe(true);
    expect(isParallelSafeTool('glob', { pattern: '**/*.ts' })).toBe(true);
    expect(isParallelSafeTool('grep', { pattern: 'needle' })).toBe(true);
  });

  it('accepts the extra tools only for their read actions', () => {
    expect(isParallelSafeTool('memory', { action: 'search', query: 'x' })).toBe(true);
    expect(isParallelSafeTool('memory', { action: 'add', text: 'x' })).toBe(false);
    expect(isParallelSafeTool('todo', { op: 'view' })).toBe(true);
    expect(isParallelSafeTool('todo', { op: 'append', text: 'x' })).toBe(false);
    expect(isParallelSafeTool('todo', { op: 'start', id: 't1' })).toBe(false);
  });

  it('refuses every tool that can write, spawn, or reach the network', () => {
    expect(isParallelSafeTool('write', { path: 'a', content: 'x' })).toBe(false);
    expect(isParallelSafeTool('edit', { path: 'a', old: 'x', new: 'y' })).toBe(false);
    expect(isParallelSafeTool('bash', { command: 'ls' })).toBe(false);
    expect(isParallelSafeTool('mcp', { action: 'call', tool: 'x' })).toBe(false);
    // mcp list looks like a read but spawns the configured binaries.
    expect(isParallelSafeTool('mcp', { action: 'list' })).toBe(false);
    expect(isParallelSafeTool('subagent', { action: 'status' })).toBe(false);
    expect(isParallelSafeTool('config', { action: 'settings.set', key: 'a', value: 1 })).toBe(false);
    expect(isParallelSafeTool('web_fetch', { url: 'https://example.com' })).toBe(false);
    expect(isParallelSafeTool('skill', { name: 'debug' })).toBe(false);
  });

  it('refuses a name it does not know, even one the ladder would allow', () => {
    expect(isParallelSafeTool('read_all', { path: 'a.ts' })).toBe(false);
    expect(isParallelSafeTool('', {})).toBe(false);
  });

  it('treats missing arguments as an empty object', () => {
    expect(isParallelSafeTool('read', null)).toBe(true);
    expect(isParallelSafeTool('memory', undefined)).toBe(false);
  });
});

describe('RepeatedToolCallGuard', () => {
  it('flags the third identical call in a row', () => {
    const guard = new RepeatedToolCallGuard();
    const call = { name: 'read', args: { path: 'a.ts' } };

    expect(guard.observe('', [call])).toBe(false);
    expect(guard.observe('', [call])).toBe(false);
    expect(guard.observe('', [call])).toBe(true);
  });

  it('treats re-ordered argument keys as the same call', () => {
    const guard = new RepeatedToolCallGuard();

    expect(guard.observe('', [{ name: 'write', args: { path: 'a', content: 'x' } }])).toBe(false);
    expect(guard.observe('', [{ name: 'write', args: { content: 'x', path: 'a' } }])).toBe(false);
    expect(guard.observe('', [{ name: 'write', args: { path: 'a', content: 'x' } }])).toBe(true);
  });

  it('resets on new assistant text or a different call', () => {
    const guard = new RepeatedToolCallGuard();
    const call = { name: 'read', args: { path: 'a.ts' } };

    expect(guard.observe('', [call])).toBe(false);
    expect(guard.observe('', [call])).toBe(false);
    expect(guard.observe('trying another file', [call])).toBe(false);
    expect(guard.observe('', [{ name: 'read', args: { path: 'b.ts' } }])).toBe(false);
    expect(guard.observe('', [{ name: 'read', args: { path: 'b.ts' } }])).toBe(false);
    expect(guard.observe('', [{ name: 'read', args: { path: 'b.ts' } }])).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { allowedToolSchemas, isParallelSafeTool, RepeatedToolCallGuard } from './tool-policy.js';

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

describe('allowedToolSchemas with a tool profile', () => {
  it('offers only the core tools the profile names', () => {
    const profile = { offer: ['read', 'grep'], bash: 'none' as const };
    expect(allowedToolSchemas(undefined, {}, profile).map((tool) => tool.name)).toEqual([
      'read',
      'grep',
    ]);
  });

  it('drops a server tool the profile does not offer', () => {
    const profile = { offer: ['read'], bash: 'none' as const };
    expect(
      allowedToolSchemas(['read'], { subagent: true, extra: true }, profile).map(
        (tool) => tool.name,
      ),
    ).toEqual(['read']);
  });

  it('matches an extra tool offered by one of its actions', () => {
    const profile = { offer: ['read', 'subagent:spawn', 'memory:search'], bash: 'none' as const };
    expect(
      allowedToolSchemas(['read'], { subagent: true, extra: true }, profile).map(
        (tool) => tool.name,
      ),
    ).toEqual(['read', 'subagent', 'memory']);
  });

  it('spells the profile limits out without mutating the shared schema', () => {
    const profile = { offer: ['bash', 'write'], bash: 'read-only' as const, writeGlobs: ['src/**'] };
    const offered = allowedToolSchemas(undefined, {}, profile);
    expect(offered.map((tool) => tool.name)).toEqual(['bash', 'write']);
    const write = offered.find((tool) => tool.name === 'write');
    expect(write?.description).toContain('src/**');
    const plain = allowedToolSchemas().find((tool) => tool.name === 'write');
    expect(plain?.description).not.toContain('src/**');
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

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdapterDeps,
  AdapterLogger,
  ExtraToolRunner,
  TurnContext,
} from '@tuffcode/contracts';
import {
  classifyExtraTool,
  classifyTool,
  createToolSessionState,
  executeTool,
  ripgrepArgs,
} from './tools.js';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const logger: AdapterLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const deps: AdapterDeps = {
  logger,
  resolveCommand: async () => null,
  env: {},
};

// The fallback tests force a null resolution; this finds a real ripgrep so the
// end-to-end ripgrep test can be skipped, not failed, on a host without one.
const probe = promisify(execFile);
const rgPath = await probe(process.platform === 'win32' ? 'where' : 'which', ['rg'], {
  windowsHide: true,
  timeout: 10000,
})
  .then(
    ({ stdout }) =>
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null,
  )
  .catch(() => null);

const rgDeps: AdapterDeps = {
  ...deps,
  resolveCommand: async (name) => (name === 'rg' ? rgPath : null),
};

let root: string;

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnId: 'turn_1',
    cwd: root,
    systemPrompt: '',
    permissionMode: 'full-auto',
    model: 'test-model',
    brainSlice: '',
    attachments: [],
    vision: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tuffcode-openai-tools-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('read and edit', () => {
  it('rejects edit before read', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha' + LF);
    const state = createToolSessionState();
    const result = await executeTool(
      'edit',
      { path: 'a.txt', old_string: 'alpha', new_string: 'beta' },
      context(),
      state,
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('read the file first');
  });

  it('rejects paths outside the worktree root', async () => {
    const state = createToolSessionState();
    const result = await executeTool(
      'read',
      { path: '../outside.txt' },
      context(),
      state,
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toBe('path escapes root: ../outside.txt');
  });

  it('round-trips CRLF files and keeps untouched lines', async () => {
    const file = join(root, 'crlf.txt');
    await writeFile(file, 'one' + CRLF + 'alpha' + CRLF + 'three' + CRLF);
    const state = createToolSessionState();
    const read = await executeTool('read', { path: 'crlf.txt' }, context(), state, deps);
    expect(read.isError).toBe(false);
    expect(read.output).toBe('1: one' + LF + '2: alpha' + LF + '3: three');

    const edit = await executeTool(
      'edit',
      { path: 'crlf.txt', old_string: 'alpha', new_string: 'beta' },
      context(),
      state,
      deps,
    );
    expect(edit.isError).toBe(false);
    expect(edit.output).toBe('edited crlf.txt: replaced 1 occurrence(s)');
    const bytes = await readFile(file, 'utf8');
    expect(bytes).toBe('one' + CRLF + 'beta' + CRLF + 'three' + CRLF);
  });

  it('rejects edits after the file changed', async () => {
    const file = join(root, 'changed.txt');
    await writeFile(file, 'alpha' + LF);
    const state = createToolSessionState();
    await executeTool('read', { path: 'changed.txt' }, context(), state, deps);
    await writeFile(file, 'alpha changed' + LF);
    const result = await executeTool(
      'edit',
      { path: 'changed.txt', old_string: 'alpha', new_string: 'beta' },
      context(),
      state,
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('file changed since read');
  });

  it('requires context for ambiguous matches', async () => {
    await writeFile(join(root, 'dup.txt'), 'same' + LF + 'same' + LF);
    const state = createToolSessionState();
    await executeTool('read', { path: 'dup.txt' }, context(), state, deps);
    const result = await executeTool(
      'edit',
      { path: 'dup.txt', old_string: 'same', new_string: 'other' },
      context(),
      state,
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('add surrounding context');
  });
});

describe('write, glob, and grep', () => {
  it('preserves the existing EOL on write', async () => {
    const file = join(root, 'eol.txt');
    await writeFile(file, 'old' + CRLF);
    const result = await executeTool(
      'write',
      { path: 'eol.txt', content: 'a' + LF + 'b' + LF },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('a' + CRLF + 'b' + CRLF);
  });

  it('writes new files with LF', async () => {
    const result = await executeTool(
      'write',
      { path: 'nested/new.txt', content: 'x' + LF },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(await readFile(join(root, 'nested', 'new.txt'), 'utf8')).toBe('x' + LF);
  });

  it('lists files with forward slashes', async () => {
    await writeFile(join(root, 'a.ts'), '');
    await writeFile(join(root, 'b.js'), '');
    const result = await executeTool(
      'glob',
      { pattern: '**/*.ts' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('a.ts');
  });

  it('finds matches with grep and reports line numbers', async () => {
    await writeFile(join(root, 'grep.txt'), 'alpha' + LF + 'beta' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'beta' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('grep.txt:2: beta');
  });

  it('returns an error for an invalid regex', async () => {
    const result = await executeTool(
      'grep',
      { pattern: '(' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('invalid regular expression');
  });
});

describe('grep modes on the Node fallback', () => {
  it('returns one path per matching file in files mode', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha' + LF);
    await writeFile(join(root, 'b.txt'), 'nothing here' + LF);
    await writeFile(join(root, 'c.txt'), 'alpha again' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'files' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output.split(LF).toSorted()).toEqual(['a.txt', 'c.txt']);
  });

  it('returns path:count in count mode', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha' + LF + 'alpha' + LF + 'beta' + LF);
    await writeFile(join(root, 'b.txt'), 'beta' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'count' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('a.txt:2');
  });

  it('honours case_sensitive', async () => {
    await writeFile(join(root, 'case.txt'), 'Beta' + LF);
    const sensitive = await executeTool(
      'grep',
      { pattern: 'beta' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(sensitive.output).toBe('no matches for beta');
    const insensitive = await executeTool(
      'grep',
      { pattern: 'beta', case_sensitive: false },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(insensitive.output).toBe('case.txt:1: Beta');
  });

  it('filters files with glob', async () => {
    await writeFile(join(root, 'a.ts'), 'alpha' + LF);
    await writeFile(join(root, 'a.js'), 'alpha' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'files', glob: '**/*.ts' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('a.ts');
  });

  it('skips ignored directories', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'alpha' + LF);
    await writeFile(join(root, 'keep.txt'), 'alpha' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'files' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('keep.txt');
  });

  it('matches CRLF files without the carriage return', async () => {
    await writeFile(join(root, 'crlf.txt'), 'one' + CRLF + 'alpha' + CRLF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('crlf.txt:2: alpha');
  });

  it('skips binary files', async () => {
    await writeFile(
      join(root, 'blob.dat'),
      Buffer.concat([Buffer.from('alpha'), Buffer.from([0]), Buffer.from('tail' + LF)]),
    );
    await writeFile(join(root, 'text.txt'), 'alpha' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'files' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('text.txt');
  });

  it('stops at max_results', async () => {
    await writeFile(
      join(root, 'many.txt'),
      ['alpha one', 'alpha two', 'alpha three'].join(LF) + LF,
    );
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', max_results: 2 },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output.split(LF)).toEqual(['many.txt:1: alpha one', 'many.txt:2: alpha two']);
  });

  it('searches a single file path', async () => {
    await writeFile(join(root, 'one.txt'), 'alpha' + LF);
    await writeFile(join(root, 'two.txt'), 'alpha' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', path: 'one.txt' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('one.txt:1: alpha');
  });

  it('searches tracked dot directories', async () => {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'run: alpha' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'files' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('.github/workflows/ci.yml');
  });
});

describe('ripgrep args', () => {
  const base = {
    pattern: 'alpha',
    caseSensitive: true,
    glob: null,
    maxResults: 200,
    searchPath: '.',
  };

  it('builds the content flag set', () => {
    expect(ripgrepArgs({ ...base, mode: 'content' })).toEqual([
      '--no-heading',
      '--line-number',
      '--with-filename',
      '--color',
      'never',
      '--path-separator',
      '/',
      '--hidden',
      '--glob',
      '!.git',
      '--max-count',
      '200',
      '--',
      'alpha',
      '.',
    ]);
  });

  it('swaps the mode flag per mode', () => {
    const files = ripgrepArgs({ ...base, mode: 'files' });
    expect(files).toContain('--files-with-matches');
    expect(files).not.toContain('--count');
    expect(files).not.toContain('--max-count');

    const count = ripgrepArgs({ ...base, mode: 'count' });
    expect(count).toContain('--count');
    expect(count).not.toContain('--files-with-matches');
    // A count must stay exact, so it is not capped per file.
    expect(count).not.toContain('--max-count');
  });

  it('adds --ignore-case and --glob only when asked', () => {
    const plain = ripgrepArgs({ ...base, mode: 'content' });
    expect(plain).not.toContain('--ignore-case');

    const insensitive = ripgrepArgs({ ...base, mode: 'content', caseSensitive: false });
    expect(insensitive).toContain('--ignore-case');

    const filtered = ripgrepArgs({ ...base, mode: 'content', glob: '**/*.ts' });
    expect(filtered[filtered.indexOf('--glob') + 1]).toBe('!.git');
    expect(filtered[filtered.indexOf('**/*.ts') - 1]).toBe('--glob');
  });

  it('searches hidden paths but never the VCS directory', () => {
    for (const mode of ['content', 'files', 'count'] as const) {
      const args = ripgrepArgs({ ...base, mode });
      expect(args).toContain('--hidden');
      expect(args[args.indexOf('--glob') + 1]).toBe('!.git');
      expect(args).not.toContain('--no-ignore');
    }
  });
});

describe('grep through ripgrep', () => {
  it.runIf(rgPath !== null)('returns the same shapes as the fallback', async () => {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'a.txt'), 'alpha' + LF + 'beta' + LF);
    const content = await executeTool(
      'grep',
      { pattern: 'beta' },
      context(),
      createToolSessionState(),
      rgDeps,
    );
    expect(content.isError).toBe(false);
    expect(content.output).toBe('nested/a.txt:2: beta');

    const files = await executeTool(
      'grep',
      { pattern: 'beta', mode: 'files' },
      context(),
      createToolSessionState(),
      rgDeps,
    );
    expect(files.isError).toBe(false);
    expect(files.output).toBe('nested/a.txt');

    const count = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'count' },
      context(),
      createToolSessionState(),
      rgDeps,
    );
    expect(count.isError).toBe(false);
    expect(count.output).toBe('nested/a.txt:1');

    const empty = await executeTool(
      'grep',
      { pattern: 'zzz' },
      context(),
      createToolSessionState(),
      rgDeps,
    );
    expect(empty.isError).toBe(false);
    expect(empty.output).toBe('no matches for zzz');
  });

  it.runIf(rgPath !== null)(
    'surfaces the ripgrep error line for a pattern it rejects',
    async () => {
      await writeFile(join(root, 'a.txt'), 'ab' + LF);
      // Valid for the JavaScript engine, unsupported by ripgrep's regex engine.
      const result = await executeTool(
        'grep',
        { pattern: '(?<=a)b' },
        context(),
        createToolSessionState(),
        rgDeps,
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('regex parse error');
    },
  );

  it.runIf(rgPath !== null)('searches tracked dot directories', async () => {
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'run: alpha' + LF);
    const result = await executeTool(
      'grep',
      { pattern: 'alpha', mode: 'files' },
      context(),
      createToolSessionState(),
      rgDeps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('.github/workflows/ci.yml');
  });
});

describe('bash', () => {
  it('runs a command and captures output', async () => {
    const result = await executeTool(
      'bash',
      { command: 'echo hello' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('hello');
  });

  it('kills a command that exceeds the timeout', async () => {
    const command = process.platform === 'win32' ? 'ping -n 6 127.0.0.1 >nul' : 'sleep 5';
    const started = Date.now();
    const result = await executeTool(
      'bash',
      { command, timeout_ms: 1000 },
      context(),
      createToolSessionState(),
      deps,
    );
    const elapsed = Date.now() - started;
    expect(result.isError).toBe(true);
    expect(result.output).toContain('timed out');
    expect(elapsed).toBeLessThan(4000);
  });
});

describe('classifyTool', () => {
  it('allows read tools in every mode', () => {
    expect(classifyTool('read', {}, 'read-only')).toBe('allow');
    expect(classifyTool('glob', {}, 'read-only')).toBe('allow');
    expect(classifyTool('grep', {}, 'read-only')).toBe('allow');
  });

  it('asks for writes in ask mode and allows them in accept-edits', () => {
    expect(classifyTool('write', {}, 'ask')).toBe('approve');
    expect(classifyTool('write', {}, 'accept-edits')).toBe('allow');
    expect(classifyTool('bash', {}, 'accept-edits')).toBe('approve');
    expect(classifyTool('write', {}, 'read-only')).toBe('deny');
  });

  it('asks before destructive commands in full-auto', () => {
    expect(classifyTool('bash', { command: 'rm -rf /' }, 'full-auto')).toBe('approve');
    expect(classifyTool('bash', { command: 'echo hi' }, 'full-auto')).toBe('allow');
  });

  it('routes an extra tool name through the extra classifier', () => {
    expect(classifyTool('memory', { action: 'search' }, 'read-only')).toBe('allow');
    expect(classifyTool('mcp', { action: 'call' }, 'ask')).toBe('approve');
    expect(classifyTool('config', { action: 'settings.set' }, 'read-only')).toBe('deny');
  });
});

describe('classifyExtraTool', () => {
  const MODES = ['read-only', 'ask', 'accept-edits', 'full-auto'] as const;

  function decisions(
    name: Parameters<typeof classifyExtraTool>[0],
    args: Record<string, unknown>,
  ): string[] {
    return MODES.map((mode) => classifyExtraTool(name, args, mode));
  }

  it('allows a memory search in every mode', () => {
    expect(decisions('memory', { action: 'search' })).toEqual([
      'allow',
      'allow',
      'allow',
      'allow',
    ]);
  });

  it('denies an MCP listing in read-only mode because it spawns the servers', () => {
    expect(decisions('mcp', { action: 'list' })).toEqual(['deny', 'allow', 'allow', 'allow']);
  });

  it('classifies the write actions across the four modes', () => {
    expect(decisions('memory', { action: 'add' })).toEqual([
      'deny',
      'approve',
      'allow',
      'allow',
    ]);
    expect(decisions('mcp', { action: 'call' })).toEqual([
      'deny',
      'approve',
      'approve',
      'allow',
    ]);
    expect(decisions('config', { action: 'provider.add' })).toEqual([
      'deny',
      'approve',
      'approve',
      'allow',
    ]);
    expect(decisions('config', { action: 'provider.model.add' })).toEqual([
      'deny',
      'approve',
      'approve',
      'allow',
    ]);
    expect(decisions('config', { action: 'mcp.add' })).toEqual([
      'deny',
      'approve',
      'approve',
      'allow',
    ]);
    expect(decisions('config', { action: 'settings.set' })).toEqual([
      'deny',
      'approve',
      'approve',
      'allow',
    ]);
  });

  it('asks before a config change in accept-edits mode', () => {
    expect(classifyExtraTool('config', { action: 'provider.model.add' }, 'accept-edits')).toBe(
      'approve',
    );
    expect(classifyExtraTool('memory', { action: 'add' }, 'accept-edits')).toBe('allow');
    expect(classifyExtraTool('mcp', { action: 'call' }, 'accept-edits')).toBe('approve');
  });

  it('denies an unknown or missing action in every mode', () => {
    for (const mode of MODES) {
      expect(classifyExtraTool('mcp', { action: 'destroy' }, mode)).toBe('deny');
      expect(classifyExtraTool('memory', {}, mode)).toBe('deny');
      expect(classifyExtraTool('config', { action: 'provider.delete' }, mode)).toBe('deny');
    }
  });
});

describe('extra tool execution', () => {
  it('routes the call through the runner with the turn cwd', async () => {
    const calls: { name: string; args: Record<string, unknown>; cwd: string }[] = [];
    const runner: ExtraToolRunner = async (name, args, ctx) => {
      calls.push({ name, args, cwd: ctx.cwd });
      return 'two entries: build uses pnpm';
    };
    const result = await executeTool(
      'memory',
      { action: 'search', query: 'build' },
      context(),
      createToolSessionState(),
      deps,
      runner,
    );

    expect(result).toEqual({ output: 'two entries: build uses pnpm', isError: false });
    expect(calls).toEqual([
      { name: 'memory', args: { action: 'search', query: 'build' }, cwd: root },
    ]);
  });

  it('caps the runner output at 64 KiB', async () => {
    const runner: ExtraToolRunner = async () => 'x'.repeat(70 * 1024);
    const result = await executeTool(
      'mcp',
      { action: 'list' },
      context(),
      createToolSessionState(),
      deps,
      runner,
    );

    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(result.output.endsWith('[output truncated]')).toBe(true);
  });

  it('reports the tool as unavailable without a runner', async () => {
    const result = await executeTool(
      'mcp',
      { action: 'list' },
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result).toEqual({
      output: 'tool "mcp" is not available in this session',
      isError: true,
    });
  });

  it('reports a runner failure as a tool error', async () => {
    const runner: ExtraToolRunner = async () => {
      throw new Error('mcp server offline');
    };
    const result = await executeTool(
      'config',
      { action: 'settings.set', key: 'theme', value: 'dark' },
      context(),
      createToolSessionState(),
      deps,
      runner,
    );
    expect(result).toEqual({ output: 'mcp server offline', isError: true });
  });

  it('rejects non-object arguments before calling the runner', async () => {
    let called = false;
    const runner: ExtraToolRunner = async () => {
      called = true;
      return 'ok';
    };
    const result = await executeTool(
      'memory',
      'search',
      context(),
      createToolSessionState(),
      deps,
      runner,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('JSON object');
    expect(called).toBe(false);
  });

  it('still rejects an unknown tool name', async () => {
    const result = await executeTool(
      'deploy',
      {},
      context(),
      createToolSessionState(),
      deps,
    );
    expect(result).toEqual({ output: 'unknown tool: deploy', isError: true });
  });
});

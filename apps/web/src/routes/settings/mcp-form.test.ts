import type { McpServer } from '@tuffcode/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildMcpUpsertParams,
  emptyMcpDraft,
  formatMcpArg,
  isMcpHttpUrl,
  mcpAuthSummary,
  mcpDraftFromServer,
  parseMcpArgs,
  parseMcpEnv,
  validateMcpDraft,
  type McpDraft,
} from './mcp-form';

function draft(overrides: Partial<McpDraft> = {}): McpDraft {
  return { ...emptyMcpDraft(), label: 'Filesystem', command: 'npx', ...overrides };
}

const server: McpServer = {
  id: 'mcp-1',
  label: 'Filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work'],
  env: { TOKEN: 'abc' },
  cwd: 'C:/work',
  url: null,
  authMode: 'none',
  authHeader: 'Authorization',
  hasSecret: false,
  pluginId: null,
  enabled: true,
  createdAt: '2026-11-24T10:00:00.000Z',
  updatedAt: '2026-11-24T10:00:00.000Z',
};

describe('validateMcpDraft', () => {
  it('accepts a minimal stdio server', () => {
    expect(validateMcpDraft(draft())).toEqual({});
  });

  it('requires a label and a command', () => {
    expect(validateMcpDraft(draft({ label: '   ', command: '  ' }))).toEqual({
      label: 'Label is required.',
      command: 'Command is required.',
    });
  });

  it('rejects env text that is not JSON', () => {
    expect(validateMcpDraft(draft({ env: 'TOKEN=abc' }))).toEqual({
      env: 'Environment must be valid JSON.',
    });
  });

  it('rejects a relative working directory', () => {
    expect(validateMcpDraft(draft({ cwd: 'work' }))).toEqual({ cwd: 'Enter an absolute path.' });
  });

  it('requires an https URL for an http connector', () => {
    expect(validateMcpDraft(draft({ transport: 'http', command: '', url: '' }))).toEqual({
      url: 'Enter an https URL, or http on localhost.',
    });
    expect(validateMcpDraft(draft({ transport: 'http', command: '', url: 'http://example.com/mcp' })))
      .toEqual({ url: 'Enter an https URL, or http on localhost.' });
  });

  it('accepts a local http URL and an https URL', () => {
    expect(validateMcpDraft(draft({ transport: 'http', command: '', url: 'https://mcp.example.com/mcp' })))
      .toEqual({});
    expect(validateMcpDraft(draft({ transport: 'http', command: '', url: 'http://127.0.0.1:8787/mcp' })))
      .toEqual({});
  });

  it('requires a header value for bearer mode when nothing is stored', () => {
    expect(
      validateMcpDraft(
        draft({ transport: 'http', command: '', url: 'https://mcp.example.com/mcp', authMode: 'bearer' }),
      ),
    ).toEqual({ secret: 'Enter the token or API key.' });
  });

  it('accepts a stored credential without a new value', () => {
    expect(
      validateMcpDraft(
        draft({
          transport: 'http',
          command: '',
          url: 'https://mcp.example.com/mcp',
          authMode: 'bearer',
          hasSecret: true,
        }),
      ),
    ).toEqual({});
  });

  it('rejects an invalid header name', () => {
    expect(
      validateMcpDraft(
        draft({
          transport: 'http',
          command: '',
          url: 'https://mcp.example.com/mcp',
          authMode: 'bearer',
          authHeader: 'Bad Header',
          secret: 'abc',
        }),
      ),
    ).toEqual({ authHeader: 'Enter a valid header name.' });
  });

  it('needs no credential for none or oauth mode', () => {
    for (const authMode of ['none', 'oauth'] as const) {
      expect(
        validateMcpDraft(
          draft({ transport: 'http', command: '', url: 'https://mcp.example.com/mcp', authMode }),
        ),
      ).toEqual({});
    }
  });
});

describe('parseMcpArgs', () => {
  it('splits on whitespace and drops blanks', () => {
    expect(parseMcpArgs(' -y  pkg \n C:/work ')).toEqual(['-y', 'pkg', 'C:/work']);
    expect(parseMcpArgs('   ')).toEqual([]);
  });

  it('keeps a quoted argument with spaces whole', () => {
    expect(parseMcpArgs('-y pkg "C:/Users/me/the code/fixture.mjs"')).toEqual([
      '-y',
      'pkg',
      'C:/Users/me/the code/fixture.mjs',
    ]);
    expect(parseMcpArgs("'C:/a b/c.mjs'")).toEqual(['C:/a b/c.mjs']);
  });

  it('round-trips a stored argument with spaces through the form', () => {
    const args = ['-y', 'pkg', 'C:/Users/me/the code/fixture.mjs'];
    const text = args.map(formatMcpArg).join('\n');
    expect(parseMcpArgs(text)).toEqual(args);
  });
});

describe('parseMcpEnv', () => {
  it('treats blank input as no variables', () => {
    expect(parseMcpEnv('  ')).toEqual({ env: {} });
  });

  it('parses a JSON object of strings', () => {
    expect(parseMcpEnv('{"TOKEN":"abc","ROOT":"C:/work"}')).toEqual({
      env: { TOKEN: 'abc', ROOT: 'C:/work' },
    });
  });

  it('reports invalid JSON and non-object values', () => {
    expect(parseMcpEnv('nope')).toEqual({ error: 'Environment must be valid JSON.' });
    expect(parseMcpEnv('null')).toEqual({ error: 'Environment must be a JSON object.' });
    expect(parseMcpEnv('{"TOKEN": 7}')).toEqual({
      error: 'Environment value for TOKEN must be a string.',
    });
  });
});

describe('buildMcpUpsertParams', () => {
  it('trims fields and builds the args array and env object for stdio', () => {
    expect(
      buildMcpUpsertParams(
        draft({
          label: ' Filesystem ',
          command: ' npx ',
          args: '-y @modelcontextprotocol/server-filesystem C:/work',
          env: '{"TOKEN":"abc"}',
          cwd: ' C:/work ',
        }),
      ),
    ).toEqual({
      label: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work'],
      env: { TOKEN: 'abc' },
      cwd: 'C:/work',
      enabled: true,
    });
  });

  it('carries the id and the disabled state when editing', () => {
    expect(buildMcpUpsertParams(draft({ id: 'mcp-1', enabled: false }))).toMatchObject({
      id: 'mcp-1',
      enabled: false,
    });
  });

  it('sends a null working directory when the field is empty', () => {
    expect(buildMcpUpsertParams(draft({ cwd: '   ' }))).toMatchObject({ cwd: null });
  });

  it('builds an http payload with no auth', () => {
    expect(
      buildMcpUpsertParams(
        draft({ transport: 'http', command: '', url: ' https://mcp.example.com/mcp ', authMode: 'none' }),
      ),
    ).toEqual({
      label: 'Filesystem',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      authMode: 'none',
      enabled: true,
    });
  });

  it('builds a bearer payload with the custom header and prefix', () => {
    expect(
      buildMcpUpsertParams(
        draft({
          transport: 'http',
          command: '',
          url: 'https://mcp.example.com/mcp',
          authMode: 'bearer',
          authHeader: 'X-Api-Key',
          secretPrefix: '',
          secret: ' sk-live ',
        }),
      ),
    ).toEqual({
      label: 'Filesystem',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      authMode: 'bearer',
      authHeader: 'X-Api-Key',
      secret: 'sk-live',
      secretPrefix: '',
      enabled: true,
    });
  });

  it('omits the secret when only the stored one exists', () => {
    expect(
      buildMcpUpsertParams(
        draft({
          id: 'mcp-1',
          transport: 'http',
          command: '',
          url: 'https://mcp.example.com/mcp',
          authMode: 'bearer',
          hasSecret: true,
        }),
      ),
    ).not.toHaveProperty('secret');
  });

  it('builds an oauth payload with no credential fields', () => {
    const params = buildMcpUpsertParams(
      draft({
        transport: 'http',
        command: '',
        url: 'https://mcp.example.com/mcp',
        authMode: 'oauth',
        authHeader: 'Authorization',
        secret: 'ignored',
      }),
    );
    expect(params).toEqual({
      label: 'Filesystem',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      authMode: 'oauth',
      enabled: true,
    });
    expect(params).not.toHaveProperty('secret');
    expect(params).not.toHaveProperty('authHeader');
  });

  it('throws on invalid env JSON instead of dropping it', () => {
    expect(() => buildMcpUpsertParams(draft({ env: '[]' }))).toThrow(
      'Environment must be a JSON object.',
    );
  });
});

describe('mcpDraftFromServer', () => {
  it('formats arguments one per line and the env as JSON', () => {
    expect(mcpDraftFromServer(server)).toEqual({
      id: 'mcp-1',
      label: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: '-y\n@modelcontextprotocol/server-filesystem\nC:/work',
      env: '{\n  "TOKEN": "abc"\n}',
      cwd: 'C:/work',
      url: '',
      authMode: 'none',
      authHeader: 'Authorization',
      secretPrefix: 'Bearer ',
      secret: '',
      hasSecret: false,
      enabled: true,
    });
  });

  it('never copies a stored credential into the draft', () => {
    const saved = mcpDraftFromServer({
      ...server,
      transport: 'http',
      command: '',
      url: 'https://mcp.example.com/mcp',
      authMode: 'bearer',
      authHeader: 'X-Api-Key',
      hasSecret: true,
    });
    expect(saved.secret).toBe('');
    expect(saved.hasSecret).toBe(true);
  });

  it('starts a blank stdio draft for a new server', () => {
    expect(emptyMcpDraft()).toEqual({
      label: '',
      transport: 'stdio',
      command: '',
      args: '',
      env: '',
      cwd: '',
      url: '',
      authMode: 'none',
      authHeader: 'Authorization',
      secretPrefix: 'Bearer ',
      secret: '',
      hasSecret: false,
      enabled: true,
    });
  });
});

describe('helpers', () => {
  it('accepts https and loopback http URLs only', () => {
    expect(isMcpHttpUrl('https://mcp.example.com/mcp')).toBe(true);
    expect(isMcpHttpUrl('http://localhost:8787/mcp')).toBe(true);
    expect(isMcpHttpUrl('http://example.com/mcp')).toBe(false);
    expect(isMcpHttpUrl('ftp://example.com/mcp')).toBe(false);
  });

  it('summarizes each auth mode', () => {
    expect(mcpAuthSummary(server)).toBe('No auth');
    expect(mcpAuthSummary({ ...server, authMode: 'bearer', authHeader: 'X-Api-Key' })).toBe(
      'Header X-Api-Key',
    );
    expect(mcpAuthSummary({ ...server, authMode: 'oauth' })).toBe('Browser OAuth');
  });
});

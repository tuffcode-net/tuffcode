import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readServerConnection,
  resolveServerEntry,
  ServerConnectionError,
  serverBuildCommand,
} from './server';

vi.mock('electron', () => ({
  utilityProcess: { fork: vi.fn() },
}));

const baseEntryOptions = {
  packaged: false,
  resourcesPath: join('C:', 'resources'),
  appPath: join('C:', 'repo', 'apps', 'desktop'),
};

describe('resolveServerEntry', () => {
  it('prefers TUFFCODE_SERVER_ENTRY over every other location', () => {
    expect(
      resolveServerEntry({
        ...baseEntryOptions,
        packaged: true,
        envEntry: 'D:/custom/server.js',
      }),
    ).toBe(resolve('D:/custom/server.js'));
  });

  it('ignores a blank TUFFCODE_SERVER_ENTRY', () => {
    expect(resolveServerEntry({ ...baseEntryOptions, envEntry: '   ' })).toBe(
      resolve(baseEntryOptions.appPath, '../../packages/server/dist/server.js'),
    );
  });

  it('uses the packaged resources directory when packaged', () => {
    expect(resolveServerEntry({ ...baseEntryOptions, packaged: true })).toBe(
      join('C:', 'resources', 'server', 'server.js'),
    );
  });

  it('falls back to the workspace server build during development', () => {
    expect(resolveServerEntry(baseEntryOptions)).toBe(
      resolve('C:/repo', 'packages', 'server', 'dist', 'server.js'),
    );
  });

  it('names the build command for the missing-entry dialog', () => {
    expect(serverBuildCommand()).toBe('pnpm --filter @tuffcode/server build');
  });
});

describe('readServerConnection', () => {
  const directories: string[] = [];

  function connectionFile(contents: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'tuffcode-server-'));
    directories.push(directory);
    const filePath = join(directory, 'server.json');
    writeFileSync(filePath, contents, 'utf8');
    return filePath;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads port and token from the server file', () => {
    const filePath = connectionFile(JSON.stringify({ port: 43111, token: 'secret-token' }));
    expect(readServerConnection(filePath, 43111)).toEqual({ port: 43111, token: 'secret-token' });
  });

  it('fails when the server file is missing', () => {
    const filePath = join(tmpdir(), 'tuffcode-missing-server.json');
    expect(() => readServerConnection(filePath)).toThrow(ServerConnectionError);
    expect(() => readServerConnection(filePath)).toThrow(/Could not read the server connection/);
  });

  it('fails when the server file is not valid JSON', () => {
    const filePath = connectionFile('{not json');
    expect(() => readServerConnection(filePath)).toThrow(/not valid JSON/);
  });

  it('fails when the token is missing', () => {
    const filePath = connectionFile(JSON.stringify({ port: 43111 }));
    expect(() => readServerConnection(filePath)).toThrow(/missing the bearer token/);
  });

  it('fails when the port does not match the ready message', () => {
    const filePath = connectionFile(JSON.stringify({ port: 43111, token: 'secret-token' }));
    expect(() => readServerConnection(filePath, 43112)).toThrow(/reported port 43112/);
  });
});

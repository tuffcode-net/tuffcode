import { homedir } from 'node:os';
import { join } from 'node:path';

function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** User home directory, preferring the same variables Electron and shells use. */
function homeDir(): string {
  return envValue('USERPROFILE') ?? envValue('HOME') ?? homedir();
}

/**
 * Tuffcode's home directory: `TUFFCODE_HOME` when set, otherwise `~/.tuffcode`.
 * Pure: resolves from the environment, never touches the filesystem.
 */
export function tuffcodeHome(): string {
  return envValue('TUFFCODE_HOME') ?? join(homeDir(), '.tuffcode');
}

/**
 * Per-user application data: `%LOCALAPPDATA%/Tuffcode` on win32, the XDG data dir
 * elsewhere. Holds logs, the database, and worktrees (D13, D19).
 */
export function localAppDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData = envValue('LOCALAPPDATA');
    return localAppData === undefined
      ? join(homeDir(), 'AppData', 'Local', 'Tuffcode')
      : join(localAppData, 'Tuffcode');
  }
  const xdg = envValue('XDG_DATA_HOME');
  return xdg === undefined ? join(homeDir(), '.local', 'share', 'Tuffcode') : join(xdg, 'Tuffcode');
}

export function logsDir(): string {
  return join(localAppDataDir(), 'logs');
}

export function dbPath(): string {
  return join(localAppDataDir(), 'tuffcode.db');
}

export function serverJsonPath(): string {
  return join(tuffcodeHome(), 'server.json');
}

export function tokenPath(): string {
  return join(tuffcodeHome(), 'token');
}

export function worktreesRoot(): string {
  return join(localAppDataDir(), 'worktrees');
}

/** Content-addressed bytes for images and files the user attached to a message. */
export function attachmentsDir(): string {
  return join(localAppDataDir(), 'attachments');
}

export function brainDir(): string {
  return join(tuffcodeHome(), 'brain');
}

export function secretsPath(): string {
  return join(tuffcodeHome(), 'secrets.bin');
}

/** Installed plugins, one directory per marketplace and plugin name. */
export function pluginsRoot(): string {
  return join(tuffcodeHome(), 'plugins');
}

/** Disposable caches (marketplace catalogs, the model metadata index); safe to delete. */
export function cacheRoot(): string {
  return join(tuffcodeHome(), 'cache');
}

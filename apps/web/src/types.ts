export interface BootstrapInfo {
  port: number;
  token: string;
  version: string;
  platform: string;
  home: string;
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'protocol-error';

/** Result of one update check, mirrored from the desktop updater. */
export interface UpdateCheckOutcome {
  status: 'available' | 'current' | 'unavailable' | 'error';
  version: string | null;
  detail: string;
  checkedAt: string;
}

export interface NotifyRequest {
  title: string;
  body: string;
  /** Where a click on the notification takes the window. */
  route?: string;
  silent?: boolean;
}

/** Mirrors the desktop bridge's answer to a test notification. */
export interface NotifyTestResult {
  supported: boolean;
  shown: boolean;
  error?: string;
}

export interface TuffcodeBridge {
  getBootstrap(): Promise<BootstrapInfo>;
  pickFolder(): Promise<string | null>;
  onMenuAction(callback: (action: string) => void): () => void;
  setTheme(kind: 'dark' | 'light'): void;
  /** Absent when the preload predates the updater, so callers must guard. */
  checkForUpdates?(): Promise<UpdateCheckOutcome>;
  /** Round 4 additions; absent in a browser test harness, so callers must guard. */
  pickFile?(request: { title?: string; extensions: string[] }): Promise<string | null>;
  notify?(request: NotifyRequest): void;
  notifyTest?(request: NotifyRequest): Promise<NotifyTestResult>;
  setKeepAwake?(on: boolean): void;
  openExternal?(url: string): void;
  /** Absent in a browser test harness and in a preload older than this build. */
  getPathForFile?(file: File): string;
}

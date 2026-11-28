export interface BootstrapInfo {
  port: number;
  /** Bearer token from the desktop preload. Absent in a browser, where the socket
   * authenticates with the session cookie the served origin set. */
  token?: string;
  version: string;
  platform: string;
  /** Desktop home directory. The served bootstrap does not report it. */
  home?: string;
  /** True when a paired device opened this page, so desktop-only surfaces hide. */
  remote?: boolean;
  /** The name the paired device chose, shown in the desktop device list. */
  deviceName?: string;
}

/** The `GET /bootstrap` payload a served origin returns to a browser. */
export interface BootstrapResponse {
  port: number;
  version: string;
  platform: string;
  home?: string;
  /** Socket path on the served origin, so a proxy can move it without a rebuild. */
  wsPath: string;
  token?: string;
  remote?: boolean;
  deviceName?: string;
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
  /** Present only on the shim main.tsx installs in a served page, so bootstrap
   * resolution can tell a browser from the Electron preload. */
  browser?: boolean;
  getBootstrap(): Promise<BootstrapInfo>;
  pickFolder(): Promise<string | null>;
  onMenuAction(callback: (action: string) => void): () => void;
  setTheme(theme: 'dark' | 'light' | 'system'): void;
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

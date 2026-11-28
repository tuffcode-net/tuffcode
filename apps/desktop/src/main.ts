import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  shell,
  type OpenDialogOptions,
} from 'electron';
import { dbPath, serverJsonPath, tuffcodeHome } from '@tuffcode/shared';
import {
  BOOTSTRAP_CHANNEL,
  CHECK_UPDATES_CHANNEL,
  KEEP_AWAKE_CHANNEL,
  MENU_ACTION_CHANNEL,
  NAVIGATE_ACTION_PREFIX,
  NOTIFY_CHANNEL,
  NOTIFY_TEST_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PICK_FILE_CHANNEL,
  PICK_FOLDER_CHANNEL,
  SET_THEME_CHANNEL,
  attachSecretBridge,
  deliverNotification,
  isExternalUrl,
  isTheme,
  parseNotifyRequest,
  parsePickFileRequest,
  type BootstrapInfo,
  type NotificationDelivery,
  type NotifyTestResult,
  type UpdateCheckOutcome,
} from './bridge';
import { createMainLogger } from './logger';
import { createApplicationMenu } from './menu';
import { createSecretStore } from './secrets';
import {
  readServerConnection,
  resolveServerEntry,
  serverBuildCommand,
  startServer,
  stopServer,
  type RunningServer,
} from './server';
import {
  applyThemeChrome,
  readPersistedTheme,
  resolveTheme,
  windowChromeOptions,
  type ResolvedTheme,
} from './theme';
import { checkNow, checkUpdatesOnStart, setupUpdater } from './updater';
import { resolveUserDataPath } from './user-data';

const currentDir = fileURLToPath(new URL('.', import.meta.url));
const logger = createMainLogger();

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let bootstrap: BootstrapInfo | null = null;
let isQuitting = false;

app.setName('Tuffcode');

// The single-instance lock is keyed on `userData`, so an override has to land before
// `requestSingleInstanceLock()` below. Tests and parallel worktrees set this to a temp
// directory to keep their locks and Chromium state apart.
const userDataPath = resolveUserDataPath();
if (userDataPath !== undefined) {
  mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

function rendererIndexFile(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web', 'index.html')
    : resolve(app.getAppPath(), '../web/dist/index.html');
}

function createWindow(theme: ResolvedTheme): BrowserWindow {
  const { backgroundColor, titleBarOverlay } = windowChromeOptions(theme);
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 400,
    minHeight: 360,
    backgroundColor,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay,
    webPreferences: {
      preload: join(currentDir, '../preload/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  return window;
}

/** One blocker for the whole app while any agent runs and the user asked for it. */
let keepAwakeId: number | null = null;

function setKeepAwake(on: boolean): void {
  if (on && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && keepAwakeId !== null) {
    if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

/** A notification click restores the window and lets the renderer route itself. */
function focusForNotification(route: string | undefined): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
  if (route !== undefined) {
    window.webContents.send(MENU_ACTION_CHANNEL, `${NAVIGATE_ACTION_PREFIX}${route}`);
  }
}

const notificationDelivery: NotificationDelivery = {
  isSupported: () => Notification.isSupported(),
  show: (options, route) => {
    const notification = new Notification(options);
    notification.on('click', () => {
      focusForNotification(route);
    });
    notification.show();
  },
};

function registerIpcHandlers(): void {
  ipcMain.handle(BOOTSTRAP_CHANNEL, (): BootstrapInfo => {
    if (bootstrap === null) throw new Error('The Tuffcode server is not ready yet.');
    return bootstrap;
  });

  ipcMain.handle(CHECK_UPDATES_CHANNEL, (): Promise<UpdateCheckOutcome> => checkNow());

  ipcMain.handle(PICK_FOLDER_CHANNEL, async (event): Promise<string | null> => {
    const options: OpenDialogOptions = {
      title: 'Add project',
      properties: ['openDirectory', 'createDirectory'],
    };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    const [folder] = result.filePaths;
    return result.canceled || folder === undefined ? null : folder;
  });

  ipcMain.handle(PICK_FILE_CHANNEL, async (event, raw: unknown): Promise<string | null> => {
    const request = parsePickFileRequest(raw);
    if (request === null) return null;
    const options: OpenDialogOptions = {
      title: request.title ?? 'Choose a file',
      properties: ['openFile'],
      filters: [{ name: request.extensions.join(', '), extensions: request.extensions }],
    };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    const [file] = result.filePaths;
    return result.canceled || file === undefined ? null : file;
  });

  ipcMain.on(NOTIFY_CHANNEL, (_event, raw: unknown) => {
    const request = parseNotifyRequest(raw);
    if (request === null) return;
    const result = deliverNotification(request, notificationDelivery);
    if (result.error !== undefined) {
      logger.warn('notification failed', { reason: result.error });
    }
  });

  // Invoked by the Settings test button so the renderer can report what happened.
  ipcMain.handle(NOTIFY_TEST_CHANNEL, (_event, raw: unknown): NotifyTestResult => {
    const request = parseNotifyRequest(raw);
    if (request === null) {
      return {
        supported: Notification.isSupported(),
        shown: false,
        error: 'The notification request was rejected.',
      };
    }
    const result = deliverNotification(request, notificationDelivery);
    if (result.error !== undefined) {
      logger.warn('test notification failed', { reason: result.error });
    }
    return result;
  });

  ipcMain.on(KEEP_AWAKE_CHANNEL, (_event, on: unknown) => {
    setKeepAwake(on === true);
  });

  ipcMain.on(OPEN_EXTERNAL_CHANNEL, (_event, url: unknown) => {
    if (!isExternalUrl(url)) return;
    void shell.openExternal(url).catch((error: unknown) => {
      logger.warn('open external failed', { reason: error instanceof Error ? error.message : String(error) });
    });
  });

  ipcMain.on(SET_THEME_CHANNEL, (event, theme: unknown) => {
    if (!isTheme(theme)) return;
    // `shouldUseDarkColors` follows `themeSource`, so ask for `system` before resolving.
    nativeTheme.themeSource = theme;
    const resolved = resolveTheme(theme, nativeTheme.shouldUseDarkColors);
    const target =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (target === null || target.isDestroyed()) return;
    applyThemeChrome(target, resolved);
  });
}

async function loadRenderer(window: BrowserWindow, port: number): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl !== undefined && devUrl.length > 0) {
    const url = new URL(devUrl);
    url.searchParams.set('port', String(port));
    await window.loadURL(url.toString());
    return;
  }

  const indexHtml = rendererIndexFile();
  if (!existsSync(indexHtml)) {
    throw new Error(`The renderer build is missing at ${indexHtml}. Run the desktop build first.`);
  }
  await window.loadFile(indexHtml, { query: { port: String(port) } });
}

function showStartupError(title: string, detail: string): void {
  logger.error('startup failed', { title, detail });
  dialog.showErrorBox(title, detail);
}

async function startServerProcess(): Promise<RunningServer | null> {
  const entry = resolveServerEntry({
    envEntry: process.env['TUFFCODE_SERVER_ENTRY'],
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });

  if (!existsSync(entry)) {
    showStartupError(
      'Tuffcode server not found',
      `The server bundle is missing at ${entry}.\n\nBuild it first:\n  ${serverBuildCommand()}`,
    );
    return null;
  }

  try {
    return await startServer({
      entry,
      env: {
        ...process.env,
        TUFFCODE_HOME: tuffcodeHome(),
        TUFFCODE_APP_VERSION: app.getVersion(),
      },
      logger,
    });
  } catch (error) {
    showStartupError(
      'Tuffcode could not start',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function readBootstrap(port: number): BootstrapInfo | null {
  try {
    const connection = readServerConnection(serverJsonPath(), port);
    return {
      port: connection.port,
      token: connection.token,
      version: app.getVersion(),
      platform: process.platform,
      home: tuffcodeHome(),
    };
  } catch (error) {
    showStartupError(
      'Tuffcode could not read the server connection',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function bootstrapApplication(): Promise<void> {
  logger.info('starting main process', { version: app.getVersion(), packaged: app.isPackaged });
  app.setAppUserModelId('net.tuffcode.app');

  registerIpcHandlers();

  // The utility process boots slower than the window (it parses the server bundle,
  // opens the database and runs the migrations), so it starts first and the window is
  // built while it boots. startServerProcess never rejects: it reports a failure by
  // returning null, which the await below turns into the usual error dialog.
  const starting = startServerProcess();

  const window = createWindow(readPersistedTheme(dbPath()));
  mainWindow = window;
  createApplicationMenu(window);

  const running = await starting;
  if (running === null) {
    app.quit();
    return;
  }
  server = running;
  attachSecretBridge(running.child, createSecretStore(), logger);

  const info = readBootstrap(running.port);
  if (info === null) {
    server = null;
    await stopServer(running, logger).catch(() => undefined);
    app.quit();
    return;
  }
  bootstrap = info;

  try {
    await loadRenderer(window, running.port);
  } catch (error) {
    showStartupError(
      'Tuffcode could not load its interface',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  void running.exited.then((code) => {
    if (isQuitting) return;
    logger.warn('server exited unexpectedly', { code });
  });

  setupUpdater(logger, {
    getWindow: () => mainWindow,
    checkOnStart: checkUpdatesOnStart(dbPath()),
  });
  logger.info('main process ready', { port: running.port });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (isQuitting || server === null) return;
    event.preventDefault();
    isQuitting = true;
    const running = server;
    server = null;
    void stopServer(running, logger).finally(() => {
      app.quit();
    });
  });

  void app
    .whenReady()
    .then(bootstrapApplication)
    .catch((error: unknown) => {
      showStartupError(
        'Tuffcode could not start',
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });
}

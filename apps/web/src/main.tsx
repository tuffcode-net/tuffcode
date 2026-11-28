// oxlint-disable-next-line import/no-unassigned-import -- the renderer stylesheet is a global side effect
import './styles/theme.css';
// oxlint-disable-next-line import/no-unassigned-import -- appearance variables and panel motion
import './styles/appearance.css';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
import {
  createBrowserBridge,
  readBridge,
  resolveBootstrap,
  type ResolvedBootstrap,
} from './bootstrap';
import { applyAppearance, applyTheme } from './components/settings/appearance';
import { createRpcClient, type RpcClient } from './rpc/client';
import { RpcProvider } from './rpc/rpc-context';
import { claimPairing, pairingCodeFromLocation } from './pairing';
import { registerPwa } from './pwa';
import { router } from './router';
import { useAppStore } from './store/app-store';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');
const root = createRoot(container);

function wireClient(client: RpcClient): void {
  client.onStatus((status) => {
    useAppStore.getState().setConnection(status);
  });

  client.onEvent((event) => {
    const state = useAppStore.getState();
    if (event.type === 'thread.updated') {
      state.upsertThread(event.payload);
    } else if (event.type === 'settings.updated') {
      state.setSettings(event.payload);
      applyTheme(event.payload.theme);
      applyAppearance(event.payload);
    } else if (event.type === 'providers.updated') {
      useAppStore.setState({ providers: event.payload });
    }
  });
}

function renderFatal(title: string, detail: string): void {
  root.render(
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center">
        <p className="text-sm font-semibold text-error">{title}</p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
    </div>,
  );
}

async function boot(): Promise<void> {
  // A phone opens the one-time link first. Claiming it sets the session cookie,
  // then the address bar returns to the app so the router never sees /pair.
  const code = pairingCodeFromLocation(window.location);
  if (code !== undefined) {
    try {
      await claimPairing(code);
      window.history.replaceState({}, '', '/');
    } catch (error) {
      renderFatal(
        'Pairing failed',
        error instanceof Error ? error.message : 'The pairing code was not accepted.',
      );
      return;
    }
  }

  let resolved: ResolvedBootstrap;
  try {
    resolved = await resolveBootstrap();
  } catch (error) {
    renderFatal(
      'Could not start the Tuffcode server bridge',
      error instanceof Error
        ? error.message
        : 'Open the pairing link from Tuffcode desktop, or run the desktop app.',
    );
    return;
  }

  // A served page has no preload, so the renderer gets a bridge whose native only
  // methods stay absent before any component can call one.
  if (readBridge() === undefined) {
    window.tuffcode = createBrowserBridge(resolved.bootstrap, (message) => {
      toast.error(message);
    });
  }

  useAppStore.getState().setBootstrap(resolved.bootstrap);

  // The phone shell registers its service worker itself. A browser that refuses (an
  // insecure LAN address, for example) stays online only; the boot is never blocked.
  await registerPwa();

  const client = createRpcClient({
    url: resolved.wsUrl,
    token: resolved.bootstrap.token,
  });
  wireClient(client);

  let loadError: unknown = null;
  try {
    await useAppStore.getState().loadInitial(client);
  } catch (error) {
    loadError = error;
  }

  const storedSettings = useAppStore.getState().settings;
  applyTheme(storedSettings?.theme ?? 'dark');
  if (storedSettings) applyAppearance(storedSettings);

  root.render(
    <StrictMode>
      <RpcProvider client={client}>
        <RouterProvider router={router} />
        <Toaster theme="system" position="bottom-right" closeButton />
      </RpcProvider>
    </StrictMode>,
  );

  if (loadError) {
    const message =
      loadError instanceof Error ? loadError.message : 'Could not load projects from the server.';
    setTimeout(() => toast.error(message), 0);
  }
}

void boot();

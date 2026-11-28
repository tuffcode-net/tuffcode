// oxlint-disable-next-line import/no-unassigned-import -- the renderer stylesheet is a global side effect
import './styles/theme.css';
// oxlint-disable-next-line import/no-unassigned-import -- appearance variables and panel motion
import './styles/appearance.css';
import { RouterProvider } from '@tanstack/react-router';
import { themeBase } from '@tuffcode/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
import { applyAppearance, applyTheme } from './components/settings/appearance';
import { createRpcClient, type RpcClient } from './rpc/client';
import { RpcProvider } from './rpc/rpc-context';
import { router } from './router';
import { useAppStore } from './store/app-store';
import type { BootstrapInfo } from './types';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');
const root = createRoot(container);

/** Toasts follow the app palette, not the OS, so they match the window around them. */
function ThemedToaster() {
  const theme = useAppStore((state) => state.settings?.theme);
  return (
    <Toaster theme={themeBase(theme ?? 'dark')} position="bottom-right" closeButton />
  );
}

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

async function boot(): Promise<void> {
  let bootstrap: BootstrapInfo;
  try {
    bootstrap = await window.tuffcode.getBootstrap();
  } catch {
    root.render(
      <div className="flex h-screen items-center justify-center bg-background p-6 text-sm text-error">
        Could not start the Tuffcode server bridge.
      </div>,
    );
    return;
  }

  useAppStore.getState().setBootstrap(bootstrap);

  const client = createRpcClient({
    url: `ws://127.0.0.1:${bootstrap.port}/ws`,
    token: bootstrap.token,
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
        <ThemedToaster />
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

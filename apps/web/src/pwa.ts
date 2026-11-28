/**
 * Registers the mobile shell service worker.
 *
 * Registration needs a secure context. https qualifies, and so does http on localhost,
 * which is why a Tailscale HTTPS address registers while a plain http LAN address does
 * not. The desktop renderer loads from `file://`, where service workers do not exist.
 * Every refusal resolves to null instead of failing the boot; only offline shell caching
 * is lost.
 */
const SERVICE_WORKER_URL = '/sw.js';

export interface RegisterPwaOptions {
  /** Registers against the Vite dev server too, for testing the worker itself. */
  readonly force?: boolean;
}

export async function registerPwa(
  options: RegisterPwaOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  const { protocol } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  if (window.isSecureContext === false) return null;
  if (import.meta.env.DEV && options.force !== true) return null;

  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
  } catch {
    // A browser that refuses the registration leaves the app online-only.
    return null;
  }
}

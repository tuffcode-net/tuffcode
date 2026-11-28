/**
 * Tuffcode mobile shell service worker.
 *
 * It keeps the app shell (index.html, the manifest, the icons) and the hashed build
 * assets so a phone that loses the network still opens the shell instead of a browser
 * error page. Server surfaces are never cached: the websocket, the bootstrap payload,
 * the pairing endpoints and the health probe all answer per session, and a stale copy
 * would either leak a session or break the app.
 *
 * Bump VERSION whenever the shell markup or an icon changes; the install step then
 * refills the new cache and the activate step deletes the old one.
 */
const VERSION = 'tuffcode-shell-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL_URL = '/';
const PRECACHE_URLS = [
  SHELL_URL,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

/** Same-origin paths that must never enter Cache Storage. */
const NEVER_CACHE_PATHS = [/^\/ws(\/|$)/, /^\/bootstrap(\/|$)/, /^\/pair(\/|$)/, /^\/health(\/|$)/];

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE_PATHS.some((pattern) => pattern.test(url.pathname))) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

/** Fills the shell cache entry by entry, so one missing file cannot fail the install. */
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    PRECACHE_URLS.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response.ok) await cache.put(url, response);
      } catch {
        // A partial precache still lets the worker activate; the next navigation refills it.
      }
    }),
  );
}

/**
 * Navigations go to the network first, so a new build is picked up as soon as it is
 * served, and every route's shell is stored under the single `/` key because the server
 * answers all routes with the same index.html.
 */
async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    const contentType = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.includes('text/html')) {
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

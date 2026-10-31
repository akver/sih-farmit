/**
 * Farmit service worker — offline-first shell caching.
 * Bump CACHE_VERSION on every deploy so returning users get the update
 * instead of a stale cached index.html.
 */
const CACHE_VERSION = 'farmit-v2';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Never cache calls to the LLM/maps proxies — those must always hit the
// network so answers/results are live, and a cached POST would be wrong
// anyway. Adjust these paths if you deploy the proxies elsewhere.
const NEVER_CACHE_PATTERNS = [
  '/api/voice-assist',
  '/api/nearby-resources'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // FIX: cache.addAll() is all-or-nothing — if a single precache URL
      // 404s (e.g. an icon file missing from the deploy), the whole
      // install rejects and the app gets NO offline shell at all, silently
      // defeating the "offline-first" goal. Cache each file independently
      // instead, so one bad asset can't take down the rest.
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('Farmit SW: failed to precache', url, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POSTs (proxy calls) pass straight through

  const url = new URL(request.url);
  if (NEVER_CACHE_PATTERNS.some((p) => url.pathname.startsWith(p))) return;

  // Cross-origin (CDN model files for WebLLM, Google fonts, etc.) — let the
  // browser handle it normally; don't try to cache multi-hundred-MB model
  // shards in the Cache Storage precache list.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to cache
      return cached || network;
    })
  );
});

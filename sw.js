/**
 * sw.js — Service worker for Puzzle Explorer.
 *
 * Two cache strategies:
 *   - Same-origin (app shell): cache-first. Works offline once installed.
 *   - puzzle-explorer-data shards (cross-origin to skaeglund.github.io's
 *     other Pages site): network-first, fall back to cache. Fresh data
 *     wins when online; cached shards keep things drillable on flaky
 *     wifi or offline.
 *   - Anything else: pass through unchanged.
 *
 * IndexedDB shard cache (lib/cache.js) sits IN FRONT of fetch() — when
 * a shard is in IDB, the JS layer never calls fetch() and the SW is
 * never consulted. The SW's role is only when JS misses IDB, e.g. a
 * fresh install or after a build-stamp wipe.
 *
 * Versioning: bump VERSION whenever any file in APP_SHELL changes. The
 * activate handler deletes caches whose name doesn't match the current
 * APP_SHELL_CACHE / RUNTIME_CACHE, so a bump cleanly invalidates stale
 * precaches. NO skipWaiting — when a new SW installs, it goes to waiting;
 * the user picks it up on the next page reload. This avoids the "active
 * SW changes mid-fetch" hazard.
 */
const VERSION = 'pwa-v3';
const APP_SHELL_CACHE = `app-shell-${VERSION}`;
const RUNTIME_CACHE   = `runtime-${VERSION}`;

// Everything needed for offline drilling once a shard is in IndexedDB.
// Paths are relative to the SW's scope (./), which on Pages resolves to
// /puzzle-explorer/. Same paths as the index.html script/link tags.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './lib/posKey.js',
  './lib/fsrs.js',
  './lib/drill.js',
  './lib/session.js',
  './lib/progress.js',
  './lib/sync.js',
  './lib/cache.js',
  './lib/vendor/jquery-3.7.1.min.js',
  './lib/vendor/chess-0.10.3.js',
  './lib/vendor/chessboard-1.0.0.min.js',
  './lib/vendor/chessboard-1.0.0.min.css',
  './lib/vendor/pieces/wK.png',
  './lib/vendor/pieces/wQ.png',
  './lib/vendor/pieces/wR.png',
  './lib/vendor/pieces/wB.png',
  './lib/vendor/pieces/wN.png',
  './lib/vendor/pieces/wP.png',
  './lib/vendor/pieces/bK.png',
  './lib/vendor/pieces/bQ.png',
  './lib/vendor/pieces/bR.png',
  './lib/vendor/pieces/bB.png',
  './lib/vendor/pieces/bN.png',
  './lib/vendor/pieces/bP.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

const DATA_HOST = 'skaeglund.github.io';
const DATA_PATH_PREFIX = '/puzzle-explorer-data/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => k !== APP_SHELL_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Don't intercept anything we can't safely serve from a cache.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // App shell + any same-origin asset: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Data shards: network-first, cache fallback.
  if (url.host === DATA_HOST && url.pathname.startsWith(DATA_PATH_PREFIX)) {
    event.respondWith(networkFirst(req));
    return;
  }
  // Anything else (third-party CDNs, analytics, etc.) — pass through.
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      // Fire-and-forget cache update — don't block the response on it.
      caches.open(APP_SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
    }
    return res;
  } catch (e) {
    // Navigation request and we have nothing — return the root index.
    // Covers the "offline + first time hitting a deep link" edge case.
    if (req.mode === 'navigate') {
      const fallback = await caches.match('./');
      if (fallback) return fallback;
    }
    throw e;
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    // Cache successful responses AND 404s (a 404 means "shard not present
    // in dataset" and is a stable answer worth caching offline). Don't
    // cache 5xx or other transient failures.
    if (res && (res.ok || res.status === 404)) {
      caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, res.clone()));
    }
    return res;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw e;
  }
}

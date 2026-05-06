/**
 * sw.js — Service worker for Puzzle Explorer.
 *
 * Two cache strategies:
 *   - Same-origin navigation requests (the page itself): network-first.
 *     Always serves the latest index.html — and therefore the latest
 *     buildVersion — when online; falls back to cache offline. Without
 *     this, a cache-first SW would pin the user to whatever index.html
 *     was cached at install time forever, defeating the whole
 *     buildVersion-driven cache-busting mechanism described below.
 *   - Same-origin static assets (lib/*, icons): cache-first. Works
 *     offline once installed.
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
 * Versioning: the page registers this script as 'sw.js?v=<buildVersion>'.
 * Browsers treat each unique scriptURL as a distinct SW, so a buildVersion
 * bump triggers a fresh install. The new SW reads `?v=` from its own URL
 * and uses it as the cache key suffix; the activate handler then deletes
 * any caches whose names don't include the current buildVersion. Net
 * effect: bumping #buildVersion in index.html — already a per-commit
 * project rule — automatically invalidates SW caches on the user's next
 * launch. No separate VERSION bookkeeping in this file.
 *
 * NO skipWaiting — when a new SW installs, it goes to waiting; the user
 * picks it up on the next page reload. This avoids the "active SW changes
 * mid-fetch" hazard.
 */
// Buildversion comes from the registration URL (sw.js?v=<buildVersion>).
// Pre-buildversion-coupling installs registered as plain 'sw.js' with no
// query — fall back to 'unversioned' there so the SW still installs and
// runs. The next refresh after the new index.html is served will register
// with ?v= and a properly-versioned SW will replace this one.
const VERSION = (function () {
  try {
    return new URL(self.location).searchParams.get('v') || 'unversioned';
  } catch (e) {
    return 'unversioned';
  }
})();
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
  './lib/repertoires.js',
  './lib/lichessStudy.js',
  './lib/lichessAuth.js',
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
  // skipWaiting() lets a fresh SW activate immediately rather than sitting
  // in "waiting" state until every controlled tab closes. The original
  // posture here was the opposite — wait, on the theory that swapping
  // assets under an active drilling session was a worse hazard than
  // serving stale code. A real incident reversed that calculus: a clone-
  // after-await bug in the cache update path silently failed every cache
  // refresh, and lib/sync.js stayed stale for an existing user across
  // deploys; the new index.html (served via hard-refresh) loaded with the
  // old sync.js, whose merge() didn't know about repertoires, and every
  // subsequent sync wrote merged data without the field — wiping local
  // repertoires through setProgressData. Stale code is worse than a mid-
  // session asset swap. With this in place, future buildVersion bumps
  // propagate on the next normal reload without requiring the user to
  // close every tab. Paired with clients.claim() in activate so the new
  // SW takes over already-open pages immediately.
  self.skipWaiting();
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

  // Navigation requests (the user opening / refreshing the app):
  // network-first against APP_SHELL_CACHE. The latest index.html — and
  // therefore the latest buildVersion, which keys the SW registration
  // URL via the page's register('sw.js?v=...') call — is always what
  // the page sees when online. Cache fallback handles offline. Without
  // this branch, a cache-first SW would serve the cached index.html
  // forever, the page would keep registering the same scriptURL, and
  // no buildVersion bump would ever propagate.
  if (url.origin === self.location.origin && req.mode === 'navigate') {
    event.respondWith(networkFirst(req, APP_SHELL_CACHE));
    return;
  }

  // App shell + any other same-origin asset (lib/*, icons): cache-first.
  // These are pre-cached at install time; the activate handler deletes
  // mismatched-VERSION caches when a buildVersion bump installs a new
  // SW, so they stay fresh across deploys without the per-asset
  // round-trip that network-first would impose.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Data shards: network-first, cache fallback.
  if (url.host === DATA_HOST && url.pathname.startsWith(DATA_PATH_PREFIX)) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
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
      // Clone SYNCHRONOUSLY before returning. If the clone is created
      // inside the caches.open .then callback, it runs after `return res`
      // resolves and the page has started reading the body — at which
      // point clone() throws "Response body is already used" and the
      // cache update silently fails. That's how a stale lib/sync.js
      // shipped to an existing user once persisted across deploys: every
      // attempted re-cache failed, so the old SW kept serving the old
      // file from its old cache. Capture the clone first.
      const clone = res.clone();
      caches.open(APP_SHELL_CACHE).then((cache) => cache.put(req, clone));
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

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    // Cache successful responses AND 404s (a 404 means "shard not present
    // in dataset" and is a stable answer worth caching offline). Don't
    // cache 5xx or other transient failures.
    if (res && (res.ok || res.status === 404)) {
      // Synchronous clone — see cacheFirst's comment for why.
      const clone = res.clone();
      caches.open(cacheName).then((cache) => cache.put(req, clone));
    }
    return res;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Navigation request and we have nothing — return the root index.
    // Same fallback shape as cacheFirst, since both paths can serve nav.
    if (req.mode === 'navigate') {
      const fallback = await caches.match('./');
      if (fallback) return fallback;
    }
    throw e;
  }
}

/**
 * cache.js — IndexedDB cache for fetched shards (index/<hex>.json and
 * puzzles/<hex>.ndjson). Best-effort, never breaks the app: every operation
 * silently degrades to no-op + null on any failure path (no IDB, quota
 * exceeded, transaction aborted, schema mismatch, etc.).
 *
 * Invalidation: build-stamp only. `checkBuildVersion(builtAt)` compares the
 * current dataset's `meta.builtAt` against a value stored in our `meta`
 * objectStore. On mismatch, both shard stores are cleared and the new value
 * is written. No clock-based TTL — the dataset only changes when the
 * analyzer re-runs, and `publish-data.js` always rewrites meta.json.
 *
 * LRU bound: 100 entries per shard store. After every successful put we
 * `getAll()` (project rule #3 — never cursor) and delete the oldest entries
 * past the cap. With ~80KB gzipped per index shard and ~7KB per body shard
 * (50K-validation numbers extrapolated to full scale), 100 of each comfortably
 * fits in IDB's quota even on Brave/Safari.
 *
 * Dual-mode load (Node + browser):
 *   Node:    const Cache = require('../lib/cache');
 *   Browser: <script src="lib/cache.js"></script>  (defines window.Cache)
 *
 * In Node there's no IndexedDB, so available() returns false and every
 * operation is a no-op. The pure helpers (selectEvictions, compareBuildVersion)
 * are exposed for unit testing — see analyzer/cache-test.js.
 */
(function (root) {
  'use strict';

  // ─── config ─────────────────────────────────────────────────────────────
  var DB_NAME      = 'puzzle-explorer-cache';
  var DB_VERSION   = 1;
  var INDEX_STORE  = 'indexShards';
  var BODY_STORE   = 'bodyShards';
  var META_STORE   = 'meta';
  // Independent LRU caps: 100 each. Tuned for the full 1.2M dataset where
  // hot shards run ~80KB gzipped (index) / ~7KB (body). 100 × 80KB ≈ 8MB.
  var MAX_SHARDS   = 100;
  // Stable sentinel key for the build-stamp record in META_STORE.
  var BUILT_AT_KEY = 'builtAt';

  // ─── pure helpers (unit-testable in Node) ───────────────────────────────

  /**
   * selectEvictions(entries, max) → keysToEvict
   *
   * Given a list of entries with `{key, lastSeenAt}`, return the keys that
   * must be evicted so that length ≤ max. Oldest lastSeenAt evicted first.
   * Tied lastSeenAt values are evicted in input order (stable sort).
   *
   * Defensive: non-array input → []. Missing/non-numeric lastSeenAt counts
   * as 0 (oldest possible — gets evicted first, which is the safe default
   * since an entry without a timestamp is malformed and we'd rather drop it).
   */
  function selectEvictions(entries, max) {
    if (!Array.isArray(entries)) return [];
    if (entries.length <= max) return [];
    // Index-tagged copy so we can break ties by original position (stable).
    var tagged = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e.key === 'undefined') continue;
      var ts = (typeof e.lastSeenAt === 'number' && isFinite(e.lastSeenAt))
        ? e.lastSeenAt : 0;
      tagged.push({ key: e.key, ts: ts, idx: i });
    }
    tagged.sort(function (a, b) {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return a.idx - b.idx;
    });
    var n = tagged.length - max;
    if (n <= 0) return [];
    var out = [];
    for (var j = 0; j < n; j++) out.push(tagged[j].key);
    return out;
  }

  /**
   * compareBuildVersion(stored, current) → 'match' | 'mismatch' | 'unknown'
   *
   *   match:    both present, equal               → no action needed
   *   mismatch: both present, differ              → wipe shards, write current
   *   unknown:  either missing                    → don't wipe (no signal)
   *
   * Treating "either missing" as unknown is intentional. On first run the
   * stored value is missing; on a transient meta.json fetch failure the
   * current value is missing. In both cases blowing away the cache is wrong.
   */
  function compareBuildVersion(stored, current) {
    if (!stored || !current) return 'unknown';
    if (stored === current) return 'match';
    return 'mismatch';
  }

  // ─── browser environment guard ──────────────────────────────────────────
  function isBrowserAvailable() {
    return typeof indexedDB !== 'undefined'
      && indexedDB !== null
      && typeof indexedDB.open === 'function';
  }

  // ─── DB open (lazy, memoized, never throws) ─────────────────────────────
  // Resolves to a DB handle on success, or to null on any failure path.
  // Memoized: subsequent calls return the same promise. If open fails,
  // dbPromise stays pinned to a Promise<null> — we don't auto-retry, since
  // a failure is usually permanent (private mode, quota, blocked upgrade).
  // This keeps the call site simple: every op begins with `if (!db) return null`.
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    if (!isBrowserAvailable()) {
      dbPromise = Promise.resolve(null);
      return dbPromise;
    }
    dbPromise = new Promise(function (resolve) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        // Some Firefox no-storage modes throw synchronously here.
        resolve(null);
        return;
      }
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(INDEX_STORE)) {
          db.createObjectStore(INDEX_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(BODY_STORE)) {
          db.createObjectStore(BODY_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  // ─── primitive ops (each catches and returns null/no-op on failure) ─────
  function promisifyRequest(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
  }

  function dbGet(storeName, key) {
    return openDb().then(function (db) {
      if (!db) return null;
      try {
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        return promisifyRequest(store.get(key)).then(function (v) {
          return v === undefined ? null : v;
        });
      } catch (e) { return null; }
    }).catch(function () { return null; });
  }

  function dbPut(storeName, value) {
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        store.put(value);
        return new Promise(function (resolve) {
          tx.oncomplete = function () { resolve(); };
          tx.onerror    = function () { resolve(); };
          tx.onabort    = function () { resolve(); };
        });
      } catch (e) {}
    }).catch(function () {});
  }

  function dbGetAll(storeName) {
    return openDb().then(function (db) {
      if (!db) return [];
      try {
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        return promisifyRequest(store.getAll()).then(function (v) {
          return v || [];
        });
      } catch (e) { return []; }
    }).catch(function () { return []; });
  }

  function dbDeleteMany(storeName, keys) {
    if (!keys || !keys.length) return Promise.resolve();
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        for (var i = 0; i < keys.length; i++) store.delete(keys[i]);
        return new Promise(function (resolve) {
          tx.oncomplete = function () { resolve(); };
          tx.onerror    = function () { resolve(); };
          tx.onabort    = function () { resolve(); };
        });
      } catch (e) {}
    }).catch(function () {});
  }

  function dbClear(storeName) {
    return openDb().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        store.clear();
        return new Promise(function (resolve) {
          tx.oncomplete = function () { resolve(); };
          tx.onerror    = function () { resolve(); };
          tx.onabort    = function () { resolve(); };
        });
      } catch (e) {}
    }).catch(function () {});
  }

  // ─── high-level API ─────────────────────────────────────────────────────

  /**
   * getIndex(shard) → Promise<{json, fetchedAt} | null>
   *
   * Hit: returns the cached parsed JSON plus the original fetch timestamp.
   * Miss: returns null. Caller fetches and calls putIndex.
   *
   * Touches lastSeenAt fire-and-forget to avoid blocking the read path.
   * If the touch write fails, the entry just keeps its prior lastSeenAt —
   * eviction order is mildly less accurate but no data is lost.
   */
  function getIndex(shard) {
    return dbGet(INDEX_STORE, shard).then(function (entry) {
      if (!entry) return null;
      // Microtask-deferred touch.
      Promise.resolve().then(function () {
        return dbPut(INDEX_STORE, {
          key: shard,
          json: entry.json,
          fetchedAt: entry.fetchedAt,
          lastSeenAt: Date.now()
        });
      });
      return { json: entry.json, fetchedAt: entry.fetchedAt };
    });
  }

  function putIndex(shard, json) {
    var now = Date.now();
    return dbPut(INDEX_STORE, {
      key: shard, json: json, fetchedAt: now, lastSeenAt: now
    }).then(function () { return evict(INDEX_STORE); });
  }

  function getBody(shard) {
    return dbGet(BODY_STORE, shard).then(function (entry) {
      if (!entry) return null;
      Promise.resolve().then(function () {
        return dbPut(BODY_STORE, {
          key: shard,
          text: entry.text,
          fetchedAt: entry.fetchedAt,
          lastSeenAt: Date.now()
        });
      });
      return { text: entry.text, fetchedAt: entry.fetchedAt };
    });
  }

  function putBody(shard, text) {
    var now = Date.now();
    return dbPut(BODY_STORE, {
      key: shard, text: text, fetchedAt: now, lastSeenAt: now
    }).then(function () { return evict(BODY_STORE); });
  }

  /**
   * evict(storeName) — drop oldest entries until count ≤ MAX_SHARDS.
   * Called after every put. Cheap at small N (always ≤ 101 entries here).
   */
  function evict(storeName) {
    return dbGetAll(storeName).then(function (entries) {
      var keys = selectEvictions(entries, MAX_SHARDS);
      if (!keys.length) return;
      return dbDeleteMany(storeName, keys);
    });
  }

  /**
   * checkBuildVersion(currentBuiltAt) → Promise<{wiped, reason?}>
   *
   * Compare the current dataset's builtAt against the stored one. On mismatch,
   * wipe both shard stores and write the new value. On unknown (either side
   * missing), do nothing destructive — but if stored is missing and current
   * is present, write the current value so subsequent runs can detect drift.
   *
   * Idempotent: calling twice in a row is a no-op the second time.
   *
   * Wrap-and-resolve: never rejects. Callers can `.then` without a catch.
   */
  function checkBuildVersion(currentBuiltAt) {
    return dbGet(META_STORE, BUILT_AT_KEY).then(function (entry) {
      var stored = entry ? entry.value : null;
      var verdict = compareBuildVersion(stored, currentBuiltAt);
      if (verdict === 'mismatch') {
        return Promise.all([dbClear(INDEX_STORE), dbClear(BODY_STORE)])
          .then(function () {
            return dbPut(META_STORE, { key: BUILT_AT_KEY, value: currentBuiltAt });
          })
          .then(function () { return { wiped: true, reason: 'build mismatch' }; });
      }
      // First-run record: no stored value, but we know the current one.
      if (verdict === 'unknown' && currentBuiltAt && !stored) {
        return dbPut(META_STORE, { key: BUILT_AT_KEY, value: currentBuiltAt })
          .then(function () { return { wiped: false }; });
      }
      return { wiped: false };
    });
  }

  function wipe() {
    return Promise.all([dbClear(INDEX_STORE), dbClear(BODY_STORE)])
      .then(function () {});
  }

  function stats() {
    return Promise.all([dbGetAll(INDEX_STORE), dbGetAll(BODY_STORE)])
      .then(function (results) {
        return { indexCount: results[0].length, bodyCount: results[1].length };
      });
  }

  // ─── exports ────────────────────────────────────────────────────────────
  var api = {
    available: isBrowserAvailable,
    getIndex: getIndex,
    putIndex: putIndex,
    getBody: getBody,
    putBody: putBody,
    checkBuildVersion: checkBuildVersion,
    wipe: wipe,
    stats: stats,
    // pure helpers — exposed for unit tests
    _selectEvictions: selectEvictions,
    _compareBuildVersion: compareBuildVersion,
    MAX_SHARDS: MAX_SHARDS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PuzzleExplorerCache = api;
    root.Cache = api;
  }
})(typeof self !== 'undefined' ? self : this);

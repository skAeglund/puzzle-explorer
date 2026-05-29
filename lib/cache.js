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
  // v2 adds the two PERSISTENT offline stores below. The upgrade is purely
  // additive — existing index/body/meta data survives — and onupgradeneeded
  // only creates stores that don't already exist, so it's safe to re-run.
  var DB_VERSION   = 2;
  var INDEX_STORE  = 'indexShards';
  var BODY_STORE   = 'bodyShards';
  var META_STORE   = 'meta';
  // Offline ("Make available offline") stores. Unlike the shard caches above,
  // these are NOT LRU-bounded and NOT wiped by checkBuildVersion — a downloaded
  // repertoire is a deliberate, user-pinned artifact that must survive both
  // cache pressure and dataset rebuilds (orphan-skip handles any ids the new
  // build dropped; a stale-but-valid body still drills correctly). Keyed by
  // puzzle id (bodies, shared across repertoires) and by repertoire id
  // (manifests). Device-local — never synced via the Gist.
  var OFFLINE_BODY_STORE     = 'offlineBodies';
  var OFFLINE_MANIFEST_STORE = 'offlineManifests';
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
  var activeDb = null;
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
        if (!db.objectStoreNames.contains(OFFLINE_BODY_STORE)) {
          db.createObjectStore(OFFLINE_BODY_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(OFFLINE_MANIFEST_STORE)) {
          db.createObjectStore(OFFLINE_MANIFEST_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function (e) {
        var db = e.target.result;
        activeDb = db;
        // Connection-death handling. Without these, a connection closed out
        // from under us — by mobile backgrounding / bfcache / resource
        // reclamation, or by another tab/instance upgrading the DB — leaves the
        // memoized handle dead, and every db.transaction() then throws
        // InvalidStateError for the rest of the session (nothing ever persists,
        // storage shows 0 B). Dropping the memo lets the next op reopen fresh.
        // The activeDb identity check avoids a late close handler from a stale
        // connection nuking a newer, healthy one.
        db.onversionchange = function () {
          try { db.close(); } catch (x) {}
          if (activeDb === db) { dbPromise = null; activeDb = null; }
        };
        db.onclose = function () {
          if (activeDb === db) { dbPromise = null; activeDb = null; }
        };
        resolve(db);
      };
      // Transient failures (a blocked upgrade because another tab/instance holds
      // an older version, or a one-off open error) must NOT poison the whole
      // session — clear the memo so the next op retries. (A blocked upgrade
      // clears as soon as the other connection closes.) Only the hard cases
      // above — no IndexedDB at all, or a synchronous throw (some private modes)
      // — stay pinned to null.
      req.onerror   = function () { dbPromise = null; resolve(null); };
      req.onblocked = function () { dbPromise = null; resolve(null); };
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

  // withDb(fn, fallback): run fn(db), which builds its transaction
  // SYNCHRONOUSLY and returns a Promise/value. If building the transaction
  // throws InvalidStateError — the memoized connection was closed (mobile
  // backgrounding / bfcache / a versionchange) — drop the dead handle, reopen,
  // and retry fn ONCE with a fresh connection, so a stale connection self-heals
  // instead of failing every op until reload. Any other failure → fallback.
  function withDb(fn, fallback) {
    function attempt(db, allowRetry) {
      if (!db) return fallback;
      try {
        return fn(db);
      } catch (e) {
        if (allowRetry && e && e.name === 'InvalidStateError') {
          dbPromise = null;
          return openDb().then(function (db2) { return attempt(db2, false); });
        }
        return fallback;
      }
    }
    return openDb()
      .then(function (db) { return attempt(db, true); })
      .catch(function () { return fallback; });
  }

  function dbGet(storeName, key) {
    return withDb(function (db) {
      var tx = db.transaction(storeName, 'readonly');
      return promisifyRequest(tx.objectStore(storeName).get(key)).then(function (v) {
        return v === undefined ? null : v;
      });
    }, null);
  }

  function dbPut(storeName, value) {
    return withDb(function (db) {
      var tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      return new Promise(function (resolve) {
        tx.oncomplete = function () { resolve(); };
        tx.onerror    = function () { resolve(); };
        tx.onabort    = function () { resolve(); };
      });
    }, undefined);
  }

  function dbGetAll(storeName) {
    return withDb(function (db) {
      var tx = db.transaction(storeName, 'readonly');
      return promisifyRequest(tx.objectStore(storeName).getAll()).then(function (v) {
        return v || [];
      });
    }, []);
  }

  function dbGetAllKeys(storeName) {
    return withDb(function (db) {
      var tx = db.transaction(storeName, 'readonly');
      // getAllKeys (not cursor) per project rule #6 — 50x faster on mobile.
      return promisifyRequest(tx.objectStore(storeName).getAllKeys()).then(function (v) {
        return v || [];
      });
    }, []);
  }

  // dbPutMany — put several records in ONE transaction, REPORTING success.
  // Resolves { ok, error }: ok=true only when the transaction actually
  // COMMITTED (tx.oncomplete). A null db, a thrown transaction (missing store),
  // or an aborted/errored tx (quota) all resolve ok=false with the IDB error
  // name — so the offline-download path can detect a silent persistence
  // failure and report it instead of showing a false success. Never rejects.
  function dbPutMany(storeName, values) {
    if (!values || !values.length) return Promise.resolve({ ok: true, error: null });
    function once() {
      return openDb().then(function (db) {
        if (!db) return { ok: false, error: 'storage-unavailable' };
        var tx, store;
        try {
          tx = db.transaction(storeName, 'readwrite');
          store = tx.objectStore(storeName);
        } catch (e) {
          return { ok: false, error: (e && e.name) ? e.name : 'transaction-error' };
        }
        for (var i = 0; i < values.length; i++) {
          try { store.put(values[i]); } catch (e) { /* tx.onerror will fire */ }
        }
        return new Promise(function (resolve) {
          tx.oncomplete = function () { resolve({ ok: true, error: null }); };
          tx.onerror    = function () { resolve({ ok: false, error: (tx.error && tx.error.name) || 'write-failed' }); };
          tx.onabort    = function () { resolve({ ok: false, error: (tx.error && tx.error.name) || 'aborted' }); };
        });
      }).catch(function (e) { return { ok: false, error: (e && e.name) ? e.name : 'error' }; });
    }
    return once().then(function (res) {
      // A dead memoized connection (closed by mobile backgrounding / bfcache /
      // a versionchange) surfaces as InvalidStateError when building the tx.
      // Drop the handle and retry once with a fresh connection so the write
      // actually lands instead of failing the whole download.
      if (res && !res.ok && res.error === 'InvalidStateError') {
        dbPromise = null;
        return once();
      }
      return res;
    });
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

  // ─── offline ("Make available offline") API ─────────────────────────────
  // Persistent stores: no LRU eviction, untouched by checkBuildVersion/wipe.
  // Every op degrades to null/[]/no-op in Node and on any IDB failure, same
  // posture as the shard cache above.
  //
  // Pluggable backend: on the native Capacitor build, browser IDB is NOT a
  // durable store (the OS can evict it), so index.html installs lib/offlineFs.js
  // — which persists the SAME data to the app's private filesystem — via
  // _setOfflineBackend(). When a backend is installed, the eight offline
  // functions below delegate to it (preserving every call contract: same
  // return shapes, same {ok,error} on writes), and the IDB code path is dead
  // for offline data. On the plain web build no backend is installed and these
  // keep using IDB exactly as before. The runtime shard cache (getIndex/putIndex
  // /getBody/putBody) is never delegated — it's a re-fetchable cache where
  // eviction is harmless, so it stays in IDB on every platform.
  var offlineBackend = null;
  function setOfflineBackend(impl) {
    offlineBackend = (impl && typeof impl.getOfflineBody === 'function') ? impl : null;
  }

  /**
   * getOfflineBody(id) → Promise<body | null>
   * Returns the stored puzzle body object (the same shape parsed from a body
   * shard line: { id, fen, moves, … }), or null on miss/unavailable.
   */
  function getOfflineBody(id) {
    if (offlineBackend) return offlineBackend.getOfflineBody(id);
    return dbGet(OFFLINE_BODY_STORE, id).then(function (entry) {
      return entry ? entry.body : null;
    });
  }

  /**
   * putOfflineBodies(records) → Promise<{ ok, error }>
   * records: [{ id, body }]. Stored as { key:id, body, storedAt }. Batched into
   * a single transaction. Idempotent. Reports whether the write committed.
   */
  function putOfflineBodies(records) {
    if (offlineBackend) return offlineBackend.putOfflineBodies(records);
    if (!records || !records.length) return Promise.resolve({ ok: true, error: null });
    var now = Date.now();
    var values = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r || typeof r.id === 'undefined' || r.id === null) continue;
      values.push({ key: r.id, body: r.body, storedAt: now });
    }
    return dbPutMany(OFFLINE_BODY_STORE, values);
  }

  function deleteOfflineBodies(ids) {
    if (offlineBackend) return offlineBackend.deleteOfflineBodies(ids);
    return dbDeleteMany(OFFLINE_BODY_STORE, ids || []);
  }

  function getOfflineBodyKeys() {
    if (offlineBackend) return offlineBackend.getOfflineBodyKeys();
    return dbGetAllKeys(OFFLINE_BODY_STORE);
  }

  function getOfflineManifest(repId) {
    if (offlineBackend) return offlineBackend.getOfflineManifest(repId);
    return dbGet(OFFLINE_MANIFEST_STORE, repId).then(function (entry) {
      // Stored as { key:repId, ...manifest }. Strip the keyPath field so the
      // caller gets back the manifest shape it handed in.
      if (!entry) return null;
      var out = {};
      for (var k in entry) {
        if (Object.prototype.hasOwnProperty.call(entry, k) && k !== 'key') out[k] = entry[k];
      }
      out.repId = repId;
      return out;
    });
  }

  function putOfflineManifest(repId, manifest) {
    if (offlineBackend) return offlineBackend.putOfflineManifest(repId, manifest);
    if (typeof repId !== 'string' || !repId) return Promise.resolve({ ok: false, error: 'bad-repId' });
    var value = { key: repId };
    if (manifest && typeof manifest === 'object') {
      for (var k in manifest) {
        if (Object.prototype.hasOwnProperty.call(manifest, k) && k !== 'key') value[k] = manifest[k];
      }
    }
    // Routed through dbPutMany (single record) so it reports {ok,error} too.
    return dbPutMany(OFFLINE_MANIFEST_STORE, [value]);
  }

  function deleteOfflineManifest(repId) {
    if (offlineBackend) return offlineBackend.deleteOfflineManifest(repId);
    return dbDeleteMany(OFFLINE_MANIFEST_STORE, [repId]);
  }

  /**
   * listOfflineManifests() → Promise<[manifest, …]>
   * Each manifest carries its repId (from the keyPath). Used for ref-counting
   * body deletion across repertoires and for the offline search fallback.
   */
  function listOfflineManifests() {
    if (offlineBackend) return offlineBackend.listOfflineManifests();
    return dbGetAll(OFFLINE_MANIFEST_STORE).then(function (rows) {
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row) continue;
        var man = {};
        for (var k in row) {
          if (Object.prototype.hasOwnProperty.call(row, k) && k !== 'key') man[k] = row[k];
        }
        man.repId = row.key;
        out.push(man);
      }
      return out;
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
    // offline ("Make available offline") — persistent, eviction-exempt
    getOfflineBody: getOfflineBody,
    putOfflineBodies: putOfflineBodies,
    deleteOfflineBodies: deleteOfflineBodies,
    getOfflineBodyKeys: getOfflineBodyKeys,
    getOfflineManifest: getOfflineManifest,
    putOfflineManifest: putOfflineManifest,
    deleteOfflineManifest: deleteOfflineManifest,
    listOfflineManifests: listOfflineManifests,
    // native-build offline backend installer (see lib/offlineFs.js)
    _setOfflineBackend: setOfflineBackend,
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

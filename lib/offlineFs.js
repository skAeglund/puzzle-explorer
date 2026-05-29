/**
 * offlineFs.js — native-filesystem backend for the "Make available offline"
 * stores, used ONLY inside the Capacitor (Android/iOS) build.
 *
 * WHY THIS EXISTS
 * On mobile, browser-managed storage (IndexedDB / Cache Storage) is not a
 * durable store. Even with navigator.storage.persist() granted, real-world
 * Android can wipe an origin's storage (observed: a 1935-puzzle / 729 KB
 * offline download and the whole SW app-shell cache vanishing between
 * sessions — storage usage dropping from ~580 MB to ~4 KB). A Chrome-installed
 * PWA is a WebAPK whose web data lives in Chrome's profile, so it inherits
 * Chrome's + the OS's storage management and there is nothing the page can do
 * about it. The fix is to put the user-pinned offline bundle somewhere the
 * browser can't evict: the app's OWN private files, via @capacitor/filesystem
 * Directory.Data. That directory is cleared only on uninstall / explicit
 * "clear app data" — never by storage-pressure eviction or app hibernation
 * (hibernation clears cache, not app data).
 *
 * SCOPE
 * This backend implements EXACTLY the 8 persistent-offline functions that
 * lib/cache.js exposes (getOfflineBody / putOfflineBodies / deleteOfflineBodies
 * / getOfflineBodyKeys / getOfflineManifest / putOfflineManifest /
 * deleteOfflineManifest / listOfflineManifests), with the same call contracts
 * (same return shapes, same {ok,error} reporting on writes). It does NOT touch
 * the runtime shard cache (getIndex/putIndex/getBody/putBody) — that stays in
 * IDB, since it's a re-fetchable cache and eviction there is harmless.
 *
 * WIRING
 * On boot, index.html calls Cache._setOfflineBackend(OfflineFs) iff
 * OfflineFs.available() is true (i.e. running as a native Capacitor app with
 * the Filesystem plugin present). On the plain web build Capacitor is absent,
 * available() is false, the backend is never installed, and cache.js keeps
 * using IDB exactly as before. So this is a pure build-variant add — the web
 * app is byte-for-byte unchanged in behaviour.
 *
 * PLUGIN ACCESS WITHOUT A BUNDLER
 * The repo has no JS build step. On a native Capacitor build the installed
 * Filesystem plugin is registered on the global window.Capacitor.Plugins, so
 * we reach it as Capacitor.Plugins.Filesystem with no ES-module import. The
 * Directory / Encoding enums are NOT imported either — their wire values are
 * plain strings ('DATA' / 'utf8'), which the native bridge accepts directly.
 *
 * STORAGE MODEL
 * Two flat JSON files at the root of Directory.Data:
 *   - PE_MANIFESTS_FILE : { repId: manifest }   (manifest carries match ENTRIES)
 *   - PE_BODIES_FILE    : { id:    body     }   (puzzle bodies, shared by id)
 * Both are loaded lazily into memory on first access and cached; reads
 * (getOfflineBody during a drill) hit memory. Writes are wholesale rewrites of
 * the affected file, serialized through a per-file promise chain so concurrent
 * mutations can't clobber each other. Operations that write (download / delete
 * a repertoire) are rare; per-puzzle reads are frequent — so the single-file,
 * load-once-in-memory shape is the right trade. (If offline bundles ever grow
 * to tens of MB, shard PE_BODIES_FILE by id-prefix to bound rewrite cost; not
 * worth it at the current single-digit-MB scale.)
 *
 * Dual-mode load (Node + browser/native), per project convention:
 *   Node:    const OfflineFs = require('../lib/offlineFs');   // available()===false
 *   Browser: <script src="lib/offlineFs.js"></script>         // defines window.OfflineFs
 *
 * In Node (and on the web) there is no Capacitor Filesystem, so available()
 * returns false and the module is inert. analyzer/offlineFs-test.js injects a
 * fake Filesystem via _setFs() to exercise the logic without a device.
 */
(function (root) {
  'use strict';

  var MANIFESTS_FILE = 'pe-offline-manifests.json';
  var BODIES_FILE    = 'pe-offline-bodies.json';
  var DATA_DIR       = 'DATA';   // Capacitor Directory.Data wire value
  var UTF8           = 'utf8';   // Capacitor Encoding.UTF8 wire value

  // Injected Filesystem implementation (defaults to the live plugin). Tests
  // override via _setFs(). Shape: { writeFile, readFile } returning Promises;
  // readFile rejects when the file is absent (first run) — we treat that as an
  // empty store, never an error.
  var fsImpl = null;

  function isNative() {
    return !!(root.Capacitor
      && typeof root.Capacitor.isNativePlatform === 'function'
      && root.Capacitor.isNativePlatform());
  }

  function getFs() {
    if (fsImpl) return fsImpl;
    if (root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.Filesystem) {
      return root.Capacitor.Plugins.Filesystem;
    }
    return null;
  }

  // available(): true only when we're in a native Capacitor app AND a
  // Filesystem implementation is reachable. Tests that inject _setFs() are also
  // reported available so the logic can be exercised off-device.
  function available() {
    if (fsImpl) return true;
    return isNative() && !!getFs();
  }

  // ─── low-level file read/write (whole-file JSON) ────────────────────────

  // readJsonFile(name) → Promise<object>. Missing file (first run) or any
  // parse/read error resolves to {} — an absent store is empty, never fatal.
  function readJsonFile(name) {
    var fs = getFs();
    if (!fs) return Promise.resolve({});
    return Promise.resolve()
      .then(function () {
        return fs.readFile({ path: name, directory: DATA_DIR, encoding: UTF8 });
      })
      .then(function (res) {
        var data = res && typeof res.data !== 'undefined' ? res.data : res;
        if (typeof data !== 'string' || !data) return {};
        try {
          var parsed = JSON.parse(data);
          return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) { return {}; }
      })
      .catch(function () { return {}; });   // file not found etc. → empty
  }

  // writeJsonFile(name, obj) → Promise<{ok,error}>. Never rejects; reports a
  // failed write so the download path can surface it instead of a false
  // success (parity with cache.js's dbPutMany contract).
  function writeJsonFile(name, obj) {
    var fs = getFs();
    if (!fs) return Promise.resolve({ ok: false, error: 'storage-unavailable' });
    var text;
    try { text = JSON.stringify(obj || {}); }
    catch (e) { return Promise.resolve({ ok: false, error: 'serialize-failed' }); }
    return Promise.resolve()
      .then(function () {
        return fs.writeFile({ path: name, directory: DATA_DIR, data: text, encoding: UTF8 });
      })
      .then(function () { return { ok: true, error: null }; })
      .catch(function (e) {
        return { ok: false, error: (e && (e.message || e.name)) ? (e.message || e.name) : 'write-failed' };
      });
  }

  // ─── in-memory caches + write serialization ─────────────────────────────
  var manifests = null;   // repId → manifest (key field stripped)
  var bodies    = null;   // id    → body
  var writeChain = Promise.resolve();   // serializes all file writes

  function loadManifests() {
    if (manifests) return Promise.resolve(manifests);
    return readJsonFile(MANIFESTS_FILE).then(function (obj) {
      if (!manifests) manifests = obj || {};
      return manifests;
    });
  }

  function loadBodies() {
    if (bodies) return Promise.resolve(bodies);
    return readJsonFile(BODIES_FILE).then(function (obj) {
      if (!bodies) bodies = obj || {};
      return bodies;
    });
  }

  // Queue a write of the current in-memory map. Serialized so two rapid
  // mutations can't race two wholesale rewrites. Resolves the write's {ok,error}.
  function persistManifests() {
    var p = writeChain.then(function () { return writeJsonFile(MANIFESTS_FILE, manifests || {}); });
    writeChain = p.catch(function () {});
    return p;
  }
  function persistBodies() {
    var p = writeChain.then(function () { return writeJsonFile(BODIES_FILE, bodies || {}); });
    writeChain = p.catch(function () {});
    return p;
  }

  // ─── offline API (mirrors lib/cache.js) ─────────────────────────────────

  function getOfflineBody(id) {
    if (typeof id === 'undefined' || id === null) return Promise.resolve(null);
    return loadBodies().then(function (map) {
      var b = map[id];
      return (typeof b === 'undefined') ? null : b;
    });
  }

  // records: [{ id, body }]. Merge into the body pool, persist, report {ok,error}.
  function putOfflineBodies(records) {
    if (!records || !records.length) return Promise.resolve({ ok: true, error: null });
    return loadBodies().then(function (map) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (!r || typeof r.id === 'undefined' || r.id === null) continue;
        map[r.id] = r.body;
      }
      return persistBodies();
    });
  }

  function deleteOfflineBodies(ids) {
    if (!ids || !ids.length) return Promise.resolve();
    return loadBodies().then(function (map) {
      var changed = false;
      for (var i = 0; i < ids.length; i++) {
        if (Object.prototype.hasOwnProperty.call(map, ids[i])) { delete map[ids[i]]; changed = true; }
      }
      return changed ? persistBodies().then(function () {}) : undefined;
    });
  }

  function getOfflineBodyKeys() {
    return loadBodies().then(function (map) { return Object.keys(map); });
  }

  // Strip the storage keyPath field defensively and re-attach repId, matching
  // cache.js's getOfflineManifest contract.
  function shapeManifest(repId, man) {
    var out = {};
    if (man && typeof man === 'object') {
      for (var k in man) {
        if (Object.prototype.hasOwnProperty.call(man, k) && k !== 'key') out[k] = man[k];
      }
    }
    out.repId = repId;
    return out;
  }

  function getOfflineManifest(repId) {
    return loadManifests().then(function (map) {
      var man = map[repId];
      if (!man) return null;
      return shapeManifest(repId, man);
    });
  }

  function putOfflineManifest(repId, manifest) {
    if (typeof repId !== 'string' || !repId) {
      return Promise.resolve({ ok: false, error: 'bad-repId' });
    }
    return loadManifests().then(function (map) {
      var stored = {};
      if (manifest && typeof manifest === 'object') {
        for (var k in manifest) {
          if (Object.prototype.hasOwnProperty.call(manifest, k) && k !== 'key') stored[k] = manifest[k];
        }
      }
      map[repId] = stored;
      return persistManifests();
    });
  }

  function deleteOfflineManifest(repId) {
    return loadManifests().then(function (map) {
      if (!Object.prototype.hasOwnProperty.call(map, repId)) return undefined;
      delete map[repId];
      return persistManifests().then(function () {});
    });
  }

  function listOfflineManifests() {
    return loadManifests().then(function (map) {
      var out = [];
      for (var repId in map) {
        if (Object.prototype.hasOwnProperty.call(map, repId)) out.push(shapeManifest(repId, map[repId]));
      }
      return out;
    });
  }

  var api = {
    available: available,
    isNative: isNative,
    getOfflineBody: getOfflineBody,
    putOfflineBodies: putOfflineBodies,
    deleteOfflineBodies: deleteOfflineBodies,
    getOfflineBodyKeys: getOfflineBodyKeys,
    getOfflineManifest: getOfflineManifest,
    putOfflineManifest: putOfflineManifest,
    deleteOfflineManifest: deleteOfflineManifest,
    listOfflineManifests: listOfflineManifests,
    // test seam: inject a fake Filesystem and reset in-memory state
    _setFs: function (impl) { fsImpl = impl || null; manifests = null; bodies = null; writeChain = Promise.resolve(); },
    _reset: function () { manifests = null; bodies = null; writeChain = Promise.resolve(); },
    MANIFESTS_FILE: MANIFESTS_FILE,
    BODIES_FILE: BODIES_FILE
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OfflineFs = api;
  }
})(typeof self !== 'undefined' ? self : this);

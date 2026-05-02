/**
 * repertoires.js — Named groups of FEN positions for multi-position search
 * and training.
 *
 * Schema:
 *   localStorage[<active key>] = JSON.stringify({
 *     <repertoireId>: {
 *       id:        '<repertoireId>',
 *       name:      'Caro-Kann main lines',
 *       items:     [{ fen: '<full FEN>', orientation?: 'white'|'black', label?: '<caption>' }, ...],
 *       createdAt: '<ISO>',
 *       lastSeen:  '<ISO>'
 *     },
 *     // OR a tombstone (after delete):
 *     <repertoireId>: {
 *       id:        '<repertoireId>',
 *       deleted:   true,
 *       lastSeen:  '<ISO>'
 *     }
 *   })
 *
 * Why tombstones: per-entry latest-wins sync (lib/sync.js merge) cannot
 * distinguish "never had this" from "deleted this". Without a tombstone, a
 * delete on device A gets reverted by the next sync from device B. The
 * tombstone carries forward as an ordinary entry through merge, so a
 * delete at T=10:00 wins over a remote edit at T=09:55, but loses to a
 * remote edit at T=10:05 (which correctly resurrects the repertoire).
 *
 * Active storage key matches lib/progress.js's username-aware pattern so a
 * shared browser doesn't cross-contaminate. Two different keys (one for
 * progress, one for repertoires) keeps the responsibilities loosely
 * coupled — the UI composes the sync payload from both at Sync.init time.
 *
 * Item dedup: addItem uses fenPositionKey() (lib/posKey.js) to canonicalize
 * before comparing. Two FENs that normalize to the same key (differing
 * only in halfmove clock, fullmove number, or unreachable EP square) collapse
 * to one item.
 *
 * Dual-mode loading like the rest of lib/:
 *   Node:    const Repertoires = require('../lib/repertoires');
 *   Browser: <script src="lib/repertoires.js"></script>  (defines window.Repertoires)
 *
 * Defensive read pattern matches lib/progress.js: corrupt JSON, bad schema,
 * non-object entries, and quota errors all degrade to safe defaults rather
 * than throwing. importData(data) goes through the same shape check before
 * persisting, so Sync.merge results that include unexpected shapes can't
 * cause silent data wipes on reload.
 */
(function (root) {
  'use strict';

  // posKey.js is loaded ahead of this file in the browser; in Node we
  // require it explicitly. Both expose fenPositionKey.
  var _fenPositionKey;
  if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
    _fenPositionKey = require('./posKey').fenPositionKey;
  } else if (root && typeof root.fenPositionKey === 'function') {
    _fenPositionKey = root.fenPositionKey;
  } else {
    // Last-ditch fallback: byte-equal comparison. Better to dedup
    // imperfectly than to throw at load time. The caller will get
    // duplicate items if they add the same FEN twice with different
    // halfmove counters, but nothing crashes.
    _fenPositionKey = function (fen) { return String(fen); };
  }

  var STORAGE_KEY = 'puzzle_explorer_repertoires';
  var NAME_MAX = 80;
  var LABEL_MAX = 120;
  var MAX_ITEMS_PER_REPERTOIRE = 500;   // soft sanity cap; LS would die long before this

  // ─── username layer (mirrors lib/progress.js) ───────────────────────────
  var _username = '';
  function _normalizeUsername(name) {
    if (typeof name !== 'string') return '';
    return name.trim().toLowerCase();
  }
  function setUsername(name) {
    _username = _normalizeUsername(name);
  }
  function getUsername() { return _username; }
  function getActiveStorageKey() {
    return _username ? (STORAGE_KEY + '_' + _username) : STORAGE_KEY;
  }

  // First-login migration: copy legacy unnamespaced LS into the namespaced
  // slot if the namespaced slot is empty. Mirrors lib/progress.js's
  // migrateLegacyToActive — same rationale (a user who built up state in
  // anonymous mode shouldn't lose it the moment they enable sync). Leaves
  // the legacy key in place as a safety backup. Returns true iff a copy
  // was performed (caller can use this to seed a brand-new gist with the
  // migrated data instead of starting it empty).
  function migrateLegacyToActive() {
    if (!_username) return false; // legacy IS active; nothing to migrate
    var s = getStorage();
    var activeKey = getActiveStorageKey();
    var existing;
    try { existing = s.getItem(activeKey); } catch (e) { return false; }
    if (existing) return false; // already populated; don't overwrite
    var legacy;
    try { legacy = s.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (!legacy) return false;
    try { s.setItem(activeKey, legacy); return true; }
    catch (e) { return false; }
  }

  // ─── storage backend (mirrors lib/progress.js) ──────────────────────────
  var _storage = null;
  function makeMemoryStorage() {
    var d = Object.create(null);
    return {
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null;
      },
      setItem: function (k, v) { d[k] = String(v); },
      removeItem: function (k) { delete d[k]; },
      clear: function () { d = Object.create(null); }
    };
  }
  function getStorage() {
    if (_storage) return _storage;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.getItem(getActiveStorageKey());
        _storage = localStorage;
      } catch (e) {
        _storage = makeMemoryStorage();
      }
    } else {
      _storage = makeMemoryStorage();
    }
    return _storage;
  }
  function setStorage(s) { _storage = s; }

  // ─── ID generation ──────────────────────────────────────────────────────
  // 8 random hex chars (~4.3B space) — collision risk on the order of "user
  // creates 65k repertoires" before approaching 1% via birthday paradox.
  // For a personal tool with single-digit repertoires this is overkill, but
  // it's free.
  function _genId() {
    var bytes;
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
      bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
    } else if (typeof require === 'function') {
      try {
        var nodeCrypto = require('crypto');
        var buf = nodeCrypto.randomBytes(4);
        bytes = [buf[0], buf[1], buf[2], buf[3]];
      } catch (e) {
        bytes = null;
      }
    }
    if (!bytes) {
      // Last-ditch Math.random fallback. Lower-quality entropy but still
      // unique enough for the tiny scale this tool runs at.
      bytes = [
        Math.floor(Math.random() * 256),
        Math.floor(Math.random() * 256),
        Math.floor(Math.random() * 256),
        Math.floor(Math.random() * 256)
      ];
    }
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return 'rep_' + hex;
  }

  // ─── data layer ─────────────────────────────────────────────────────────
  // load() → object map keyed by id, INCLUDING tombstones. Callers that
  // want only live repertoires use list().
  function load() {
    var raw;
    try { raw = getStorage().getItem(getActiveStorageKey()); }
    catch (e) { return {}; }
    if (!raw) return {};
    var parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[repertoires] corrupt JSON in localStorage; resetting in-memory view');
      }
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Normalize each entry through _validateEntry. Drop anything corrupt
    // rather than throwing — surviving partial state is better than a
    // hard-error page on first load.
    var out = {};
    for (var id in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, id)) continue;
      var v = _validateEntry(id, parsed[id]);
      if (v) out[id] = v;
    }
    return out;
  }

  function save(data) {
    try {
      getStorage().setItem(getActiveStorageKey(), JSON.stringify(data));
      return true;
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[repertoires] save failed: ' + (e && e.message ? e.message : e));
      }
      return false;
    }
  }

  // _validateEntry returns a clean entry object (live or tombstone), or
  // null if the input is unrecoverable. Reused by load() and importData().
  function _validateEntry(id, entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    // Per-entry id must be a non-empty string. We accept entries whose
    // stored id disagrees with the map key (just trust the map key) —
    // mismatch indicates a corrupted save but isn't fatal.
    if (typeof id !== 'string' || !id) return null;
    if (typeof entry.lastSeen !== 'string' || !entry.lastSeen) return null;
    if (entry.deleted === true) {
      // Tombstone — minimal shape.
      return { id: id, deleted: true, lastSeen: entry.lastSeen };
    }
    if (typeof entry.name !== 'string' || !entry.name) return null;
    var items = [];
    if (Array.isArray(entry.items)) {
      for (var i = 0; i < entry.items.length; i++) {
        var it = entry.items[i];
        if (!it || typeof it !== 'object') continue;
        if (typeof it.fen !== 'string' || !it.fen) continue;
        var clean = { fen: it.fen };
        if (it.orientation === 'white' || it.orientation === 'black') {
          clean.orientation = it.orientation;
        }
        if (typeof it.label === 'string' && it.label) {
          clean.label = it.label;
        }
        items.push(clean);
      }
    }
    var createdAt = (typeof entry.createdAt === 'string' && entry.createdAt) ? entry.createdAt : entry.lastSeen;
    return {
      id: id,
      name: entry.name,
      items: items,
      createdAt: createdAt,
      lastSeen: entry.lastSeen
    };
  }

  // _now returns an ISO timestamp. Test seam: setNow() overrides for
  // deterministic tests.
  var _nowFn = function () { return new Date().toISOString(); };
  function setNow(fn) { _nowFn = (typeof fn === 'function') ? fn : function () { return new Date().toISOString(); }; }

  // ─── public API ─────────────────────────────────────────────────────────
  // list() returns active (non-tombstoned) repertoires sorted by name. UI
  // consumers should call this; sync export wants the raw map.
  function list() {
    var data = load();
    var out = [];
    for (var id in data) {
      if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
      if (data[id].deleted === true) continue;
      out.push(data[id]);
    }
    out.sort(function (a, b) {
      var an = a.name.toLowerCase();
      var bn = b.name.toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    return out;
  }

  function get(id) {
    if (typeof id !== 'string' || !id) return null;
    var data = load();
    var entry = data[id];
    if (!entry || entry.deleted === true) return null;
    return entry;
  }

  // create(name) → { id, ...} or null on failure. Trim/length-check the
  // name; case-insensitive duplicate detection so "London" and "london"
  // can't both exist (matches the old preset behavior).
  function create(name) {
    if (typeof name !== 'string') return null;
    var trimmed = name.trim();
    if (!trimmed || trimmed.length > NAME_MAX) return null;
    var data = load();
    var lower = trimmed.toLowerCase();
    for (var existingId in data) {
      if (!Object.prototype.hasOwnProperty.call(data, existingId)) continue;
      var e = data[existingId];
      if (e.deleted === true) continue;
      if (e.name.toLowerCase() === lower) return null; // duplicate name
    }
    // Generate a fresh id; collision check (vanishingly unlikely with 4
    // bytes of entropy at single-digit-repertoire scale, but free to
    // verify).
    var id;
    var attempts = 0;
    do {
      id = _genId();
      attempts++;
    } while (data[id] && attempts < 16);
    if (data[id]) return null; // gave up — entropy source must be broken

    var ts = _nowFn();
    var entry = {
      id: id,
      name: trimmed,
      items: [],
      createdAt: ts,
      lastSeen: ts
    };
    data[id] = entry;
    if (!save(data)) return null;
    return entry;
  }

  function rename(id, newName) {
    if (typeof id !== 'string' || typeof newName !== 'string') return false;
    var trimmed = newName.trim();
    if (!trimmed || trimmed.length > NAME_MAX) return false;
    var data = load();
    var entry = data[id];
    if (!entry || entry.deleted === true) return false;
    var lower = trimmed.toLowerCase();
    // No-op rename to same value (case-preserving): allow without
    // duplicate-collision against ourselves.
    if (entry.name.toLowerCase() !== lower) {
      for (var otherId in data) {
        if (!Object.prototype.hasOwnProperty.call(data, otherId)) continue;
        if (otherId === id) continue;
        var other = data[otherId];
        if (other.deleted === true) continue;
        if (other.name.toLowerCase() === lower) return false; // collides
      }
    }
    entry.name = trimmed;
    entry.lastSeen = _nowFn();
    return save(data);
  }

  // addItem(id, fen, opts) — opts: { orientation?, label? }
  // Dedup by fenPositionKey: if any existing item canonicalizes to the
  // same key, return false (no-op). The CALLER is responsible for telling
  // the user "already in the repertoire" — we just refuse silently.
  // Returns true on insert, false on no-op (dup or invalid fen) or save
  // failure (caller can disambiguate via list inspection if needed).
  function addItem(id, fen, opts) {
    if (typeof id !== 'string' || typeof fen !== 'string' || !fen) return false;
    var data = load();
    var entry = data[id];
    if (!entry || entry.deleted === true) return false;
    if (entry.items.length >= MAX_ITEMS_PER_REPERTOIRE) return false;
    var key;
    try { key = _fenPositionKey(fen); } catch (e) { return false; }
    if (!key) return false;
    for (var i = 0; i < entry.items.length; i++) {
      var existingKey;
      try { existingKey = _fenPositionKey(entry.items[i].fen); } catch (e) { existingKey = ''; }
      if (existingKey === key) return false; // duplicate
    }
    var item = { fen: fen };
    if (opts && (opts.orientation === 'white' || opts.orientation === 'black')) {
      item.orientation = opts.orientation;
    }
    if (opts && typeof opts.label === 'string') {
      var lbl = opts.label.trim();
      if (lbl) item.label = lbl.length > LABEL_MAX ? lbl.slice(0, LABEL_MAX) : lbl;
    }
    entry.items.push(item);
    entry.lastSeen = _nowFn();
    return save(data);
  }

  // removeItem(id, fen) — remove by fenPositionKey match (so the caller
  // can pass any FEN that canonicalizes to the same key — typically the
  // FEN of the currently-loaded position).
  function removeItem(id, fen) {
    if (typeof id !== 'string' || typeof fen !== 'string') return false;
    var data = load();
    var entry = data[id];
    if (!entry || entry.deleted === true) return false;
    var key;
    try { key = _fenPositionKey(fen); } catch (e) { return false; }
    if (!key) return false;
    var idx = -1;
    for (var i = 0; i < entry.items.length; i++) {
      var k;
      try { k = _fenPositionKey(entry.items[i].fen); } catch (e) { k = ''; }
      if (k === key) { idx = i; break; }
    }
    if (idx === -1) return false;
    entry.items.splice(idx, 1);
    entry.lastSeen = _nowFn();
    return save(data);
  }

  // del(id) — soft-delete via tombstone. The id stays in the map,
  // marked deleted, with a fresh lastSeen so sync's merge picks it as
  // the winner against any older live entry on another device.
  function del(id) {
    if (typeof id !== 'string') return false;
    var data = load();
    var entry = data[id];
    if (!entry) return false;
    if (entry.deleted === true) return true; // already a tombstone
    data[id] = { id: id, deleted: true, lastSeen: _nowFn() };
    return save(data);
  }

  function clear() { return save({}); }

  function exportData() { return load(); }

  function importData(data) {
    if (data === null || data === undefined) return save({});
    if (typeof data !== 'object' || Array.isArray(data)) return false;
    var clean = {};
    for (var id in data) {
      if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
      var v = _validateEntry(id, data[id]);
      if (v) clean[id] = v;
    }
    return save(clean);
  }

  var api = {
    // Lifecycle / config
    setUsername: setUsername,
    getUsername: getUsername,
    getActiveStorageKey: getActiveStorageKey,
    migrateLegacyToActive: migrateLegacyToActive,
    setStorage: setStorage,
    setNow: setNow,
    makeMemoryStorage: makeMemoryStorage,
    // Read
    list: list,
    get: get,
    load: load,
    // Write
    create: create,
    rename: rename,
    addItem: addItem,
    removeItem: removeItem,
    'delete': del,
    clear: clear,
    // Sync surface
    exportData: exportData,
    importData: importData
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Repertoires = api;
  }
})(typeof self !== 'undefined' ? self : this);

/**
 * progress.js — localStorage wrapper around FSRS scheduling for puzzle progress.
 *
 * Schema (per project plan):
 *   localStorage['puzzle_explorer_progress'] = JSON.stringify({
 *     positions: {
 *       <puzzleId>: { completed: bool, lastSeen: ISO, srs: <FSRS card> }
 *     }
 *   })
 *
 * Dual-mode loading like lib/posKey.js and lib/fsrs.js:
 *   Node:    const Progress = require('../lib/progress');
 *   Browser: <script src="lib/progress.js"></script>  (defines window.Progress)
 *
 * In Node, localStorage is undefined; an in-memory shim takes over. Tests can
 * also override with setStorage() to use a mock that simulates quota errors,
 * pre-populated state, etc.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'puzzle_explorer_progress';

  // FSRS dependency: require() in Node, or read off the global in browser.
  var FSRS = (typeof module !== 'undefined' && module.exports)
    ? require('./fsrs')
    : root.FSRS;

  // ─── storage backend ────────────────────────────────────────────────────
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
        // Probe — some browsers/storage modes throw on access (Safari private,
        // disabled storage). Fall through to memory shim if so.
        localStorage.getItem(STORAGE_KEY);
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

  // ─── data layer ─────────────────────────────────────────────────────────
  function load() {
    var raw;
    try { raw = getStorage().getItem(STORAGE_KEY); } catch (e) { return { positions: {} }; }
    if (!raw) return { positions: {} };
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.positions ||
          typeof parsed.positions !== 'object' || Array.isArray(parsed.positions)) {
        return { positions: {} };
      }
      return parsed;
    } catch (e) {
      // Corrupt JSON — surface and fall back to empty.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[progress] corrupt JSON in localStorage; resetting in-memory view');
      }
      return { positions: {} };
    }
  }

  function save(data) {
    try {
      getStorage().setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      // QuotaExceededError or other persistence failure. Surface, don't crash.
      // Brave silently caps localStorage at ~2.86MB per project conventions —
      // if we ever hit that (long-tailed progress data), a future migration
      // to IndexedDB is the answer.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[progress] save failed: ' + (e && e.message ? e.message : e));
      }
      return false;
    }
  }

  // ─── public API ─────────────────────────────────────────────────────────
  function getEntry(puzzleId) {
    var data = load();
    return data.positions[puzzleId] || null;
  }

  function getCard(puzzleId) {
    var entry = getEntry(puzzleId);
    return FSRS.validateCard(entry && entry.srs);
  }

  // Has this puzzle ever been graded by recordReview? An entry without an
  // `srs` object means it was created by markSeen() — the user touched the
  // puzzle but it isn't in the SRS queue. Used by the UI to decide whether
  // to gate first-attempt clean solves out of SRS.
  function hasSrsCard(puzzleId) {
    var entry = getEntry(puzzleId);
    return !!(entry && entry.srs && typeof entry.srs === 'object');
  }

  function isCompleted(puzzleId) {
    var entry = getEntry(puzzleId);
    return !!(entry && entry.completed);
  }

  function isDue(puzzleId, todayStr) {
    // Entries without an SRS card aren't in the review queue. (A missing
    // card would otherwise be treated as a fresh-new FSRS card and report
    // due=true via FSRS.isDue.)
    if (!hasSrsCard(puzzleId)) return false;
    return FSRS.isDue(getCard(puzzleId), todayStr);
  }

  // markSeen records that the user drilled this puzzle but does NOT
  // schedule it in SRS. Used for clean first-attempt solves where the
  // user demonstrably knew the answer — adding it to the review queue
  // would be noise. If the puzzle later gets a wrong attempt or hint
  // on a subsequent drill, recordReview will create the SRS card then.
  // Idempotent — repeated calls just bump lastSeen.
  function markSeen(puzzleId, now) {
    var data = load();
    var existing = data.positions[puzzleId];
    var entry = (existing && typeof existing === 'object' && !Array.isArray(existing))
      ? existing
      : {};
    var nowDate = (now instanceof Date && Number.isFinite(now.getTime()))
      ? now
      : new Date();
    entry.completed = true;
    entry.lastSeen = nowDate.toISOString();
    // Deliberately do NOT touch entry.srs. If a card already exists from a
    // prior failed attempt, leave it alone (the user just got it right
    // outside the review queue — the queue keeps its own schedule).
    data.positions[puzzleId] = entry;
    save(data);
    return entry;
  }

  // recordReview applies an FSRS grade to the puzzle's card and persists.
  // Caller is responsible for not double-recording within a single drill
  // session — drill.js's state machine handles that via gradeRecorded lock.
  function recordReview(puzzleId, grade, now) {
    var data = load();
    // Defensive: if a corrupt entry isn't a plain object, treat as missing.
    // Strict mode throws on property-set on primitives, so an external editor
    // putting e.g. {positions:{abc:"string"}} into storage would otherwise
    // crash recordReview with a cryptic message.
    var existing = data.positions[puzzleId];
    var entry = (existing && typeof existing === 'object' && !Array.isArray(existing))
      ? existing
      : {};
    var card = FSRS.validateCard(entry.srs);
    // Coerce now to a valid Date — string/null/Invalid-Date all fall back to
    // current time. Otherwise toISOString below would throw on Invalid Date,
    // and FSRS.review with NaN time would persist a NaN-due card.
    var nowDate = (now instanceof Date && Number.isFinite(now.getTime()))
      ? now
      : new Date();
    var updated = FSRS.review(card, grade, nowDate);
    entry.completed = true;
    entry.lastSeen = nowDate.toISOString();
    entry.srs = updated;
    data.positions[puzzleId] = entry;
    save(data);
    return updated;
  }

  function clear() { return save({ positions: {} }); }

  function exportData() { return load(); }

  function importData(data) {
    if (!data || typeof data !== 'object' || !data.positions) return false;
    return save(data);
  }

  // Stats helper for any future "progress dashboard" UI.
  function stats() {
    var data = load();
    var total = 0, completed = 0, due = 0;
    var today = FSRS.localDateString();
    for (var pid in data.positions) {
      if (!Object.prototype.hasOwnProperty.call(data.positions, pid)) continue;
      total++;
      var entry = data.positions[pid];
      if (entry.completed) completed++;
      // markSeen entries have no .srs and aren't in the review queue.
      // Without this guard, validateCard(undefined) would return a fresh
      // new card and isDue(new) → true, falsely inflating the badge.
      if (entry.srs && typeof entry.srs === 'object'
          && FSRS.isDue(FSRS.validateCard(entry.srs), today)) due++;
    }
    return { total: total, completed: completed, due: due };
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    setStorage: setStorage,
    _makeMemoryStorage: makeMemoryStorage,  // exposed for tests
    load: load,
    save: save,
    getEntry: getEntry,
    getCard: getCard,
    isCompleted: isCompleted,
    hasSrsCard: hasSrsCard,
    isDue: isDue,
    markSeen: markSeen,
    recordReview: recordReview,
    clear: clear,
    exportData: exportData,
    importData: importData,
    stats: stats
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Progress = api;
  }
})(typeof self !== 'undefined' ? self : this);

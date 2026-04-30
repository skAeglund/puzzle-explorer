/**
 * progress.js — localStorage wrapper around FSRS scheduling for puzzle progress.
 *
 * Schema:
 *   localStorage[<active key>] = JSON.stringify({
 *     positions: {
 *       <puzzleId>: { completed: bool, lastSeen: ISO, srs: <FSRS card> }
 *     },
 *     meta: {
 *       // Issue #9 streak tracking. lastReviewDay is the local-date string
 *       // (YYYY-MM-DD) of the most recent recordReview call. currentStreak
 *       // is the count of consecutive calendar days ending at lastReviewDay
 *       // with at least one review (markSeen does NOT count). longestStreak
 *       // is the running max ever observed. All optional — old data without
 *       // this field is silently upgraded on the first review.
 *       lastReviewDay: 'YYYY-MM-DD' | null,
 *       currentStreak: number,
 *       longestStreak: number
 *     }
 *   })
 *
 * Active key is username-aware:
 *   - No username set:  'puzzle_explorer_progress'  (legacy / anonymous)
 *   - Username "anders": 'puzzle_explorer_progress_anders'
 * The legacy key remains so users who never enable cloud sync keep working
 * unchanged. setUsername() also migrates legacy data into the namespaced
 * slot the first time a username is set (see migrateLegacyToActive).
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

  // ─── username layer ─────────────────────────────────────────────────────
  // The active storage key is STORAGE_KEY when no username is set, or
  // STORAGE_KEY + '_' + username.toLowerCase() once the user logs in. Two
  // people sharing a browser don't clobber each other's progress this way,
  // and the legacy unnamespaced key stays usable for the never-logged-in
  // case (matches the rest of the codebase's "additive, no breaking changes"
  // discipline — see CLAUDE.md "Backward compatibility" rule #12).
  //
  // Usernames are normalized to lowercase + trimmed everywhere they're
  // touched, so the input field accepts "Anders" / "anders " / "ANDERS" and
  // they all hit the same key. Empty / null clears back to the legacy key.
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
  // slot if the namespaced slot is empty. Leaves the legacy key in place as
  // a safety backup — if the user ever logs out / clears the namespaced
  // entry, the legacy state still exists for recovery. Returns true if a
  // copy was performed (caller can use this to seed a brand-new gist with
  // the migrated data instead of starting it empty).
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

  // FSRS dependency: require() in Node, or read off the global in browser.
  var FSRS = (typeof module !== 'undefined' && module.exports)
    ? require('./fsrs')
    : root.FSRS;

  // ─── streak helpers (issue #9) ──────────────────────────────────────────
  // _dayDelta: calendar-day delta between two YYYY-MM-DD strings. Parses
  // both as UTC midnights and divides by 86_400_000 — calendar arithmetic,
  // not wall-clock seconds, so DST transitions and timezone changes don't
  // skew. Returns 0 for same day, +1 for "to is the day after from", etc.
  // Returns NaN for malformed input; callers treat NaN as "not consecutive"
  // (i.e., resets the streak).
  function _dayDelta(fromYmd, toYmd) {
    if (typeof fromYmd !== 'string' || typeof toYmd !== 'string') return NaN;
    var f = fromYmd.split('-'), t = toYmd.split('-');
    if (f.length !== 3 || t.length !== 3) return NaN;
    var fromMs = Date.UTC(+f[0], +f[1] - 1, +f[2]);
    var toMs   = Date.UTC(+t[0], +t[1] - 1, +t[2]);
    if (!isFinite(fromMs) || !isFinite(toMs)) return NaN;
    return Math.round((toMs - fromMs) / 86400000);
  }

  // _readMeta: pull a defensively-shaped meta object out of the loaded
  // progress data. Old data without `meta` returns the zero state. Bad
  // shapes (non-object, array) coerce to zero state too — same defensive
  // discipline as the per-entry validation in load() and recordReview().
  function _readMeta(data) {
    var m = data ? data.meta : null;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return { lastReviewDay: null, currentStreak: 0, longestStreak: 0 };
    }
    return {
      lastReviewDay: (typeof m.lastReviewDay === 'string') ? m.lastReviewDay : null,
      currentStreak: (typeof m.currentStreak === 'number' && isFinite(m.currentStreak)) ? (m.currentStreak | 0) : 0,
      longestStreak: (typeof m.longestStreak === 'number' && isFinite(m.longestStreak)) ? (m.longestStreak | 0) : 0
    };
  }

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
        // disabled storage). Fall through to memory shim if so. Probe with
        // the active key so a username-prefixed key is exercised when one is
        // set, though both paths hit the same backend.
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

  // ─── data layer ─────────────────────────────────────────────────────────
  function load() {
    // Read from the active key (namespaced when logged in, legacy otherwise).
    // No silent legacy fallback when a username is set: migrateLegacyToActive
    // is the explicit one-shot copy, and falling back here would re-resurrect
    // legacy state if the user deliberately cleared their namespaced slot.
    var raw;
    try { raw = getStorage().getItem(getActiveStorageKey()); } catch (e) { return { positions: {} }; }
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
      getStorage().setItem(getActiveStorageKey(), JSON.stringify(data));
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

    // Streak update (issue #9). Only recordReview moves the streak —
    // markSeen represents a clean first-attempt solve and isn't an active
    // study event per the issue spec.
    var todayYmd = FSRS.localDateString(nowDate);
    var meta = _readMeta(data);
    if (meta.lastReviewDay === todayYmd) {
      // Same calendar day — already counted. No change.
    } else {
      var delta = _dayDelta(meta.lastReviewDay, todayYmd);
      // delta === 1: yesterday → today, streak extends.
      // delta === 0: same day handled above.
      // delta NaN (no prior, or unparseable): treated as "not consecutive".
      // delta < 0 (clock moved backward): treated as "not consecutive".
      // delta > 1 (gap): broken streak, restart at 1.
      if (delta === 1) {
        meta.currentStreak = (meta.currentStreak | 0) + 1;
      } else {
        meta.currentStreak = 1;
      }
      if (meta.currentStreak > meta.longestStreak) {
        meta.longestStreak = meta.currentStreak;
      }
      meta.lastReviewDay = todayYmd;
    }
    data.meta = meta;

    save(data);
    return updated;
  }

  function clear() { return save({ positions: {} }); }

  function exportData() { return load(); }

  function importData(data) {
    // Match load()'s strict shape check — without this, a caller passing
    // {positions: [...]} (array) gets persisted as-is, then the next
    // load() correctly rejects the corrupt shape and returns
    // {positions:{}}. Net effect: silent data wipe on reload. Catch the
    // bad shape at write time instead. Sync's merge() already produces
    // a safe shape, but importData is also a public API surface.
    if (!data || typeof data !== 'object' || !data.positions ||
        typeof data.positions !== 'object' || Array.isArray(data.positions)) {
      return false;
    }
    return save(data);
  }

  // Stats helper for the progress dashboard (issue #9). One pass over
  // positions; streak fields lifted directly from data.meta. `now` accepts
  // a Date for testability — defaults to the current moment.
  //
  // Returns:
  //   total, completed, due           — same as the original stats() shape
  //   states                           — { new, learning, review, relearning }
  //                                      counts of cards by FSRS state. Cards
  //                                      without a card object (markSeen-only
  //                                      entries) are bucketed as 'new' since
  //                                      that's the implicit state of a
  //                                      validateCard(undefined).
  //   totalReps, totalLapses           — raw counters across all SRS cards.
  //                                      lapseRate = lapses / reps, formatted
  //                                      client-side. Returns null when
  //                                      totalReps === 0 (no division-by-zero
  //                                      surprise in the UI).
  //   currentStreak                    — DISPLAYABLE current streak: the stored
  //                                      value if today equals lastReviewDay
  //                                      OR today is the day after, else 0
  //                                      (streak broken by a gap > 1 day).
  //   longestStreak                    — raw stored max; never zeroed.
  //   lastReviewDay                    — stored YYYY-MM-DD or null.
  //   recentActivity                   — length-7 array, oldest day first,
  //                                      ending today: [{date, count}, ...]
  //                                      where `count` is the number of
  //                                      entries whose lastSeen falls on
  //                                      that calendar day. Approximates
  //                                      "reviews per day" — see comment
  //                                      below for the multi-review-per-day
  //                                      caveat.
  function stats(now) {
    var data = load();
    var nowDate = (now instanceof Date && Number.isFinite(now.getTime())) ? now : new Date();
    var todayYmd = FSRS.localDateString(nowDate);

    // Pre-compute the 7 calendar days [today-6 .. today], oldest first.
    // setDate handles month/year rollover and DST in one shot.
    var dayKeys = new Array(7);
    var bucketByDay = Object.create(null);
    for (var i = 0; i < 7; i++) {
      var d = new Date(nowDate);
      d.setDate(d.getDate() - (6 - i));
      var k = FSRS.localDateString(d);
      dayKeys[i] = k;
      bucketByDay[k] = 0;
    }

    var total = 0, completed = 0, due = 0;
    var totalReps = 0, totalLapses = 0;
    var states = { new: 0, learning: 0, review: 0, relearning: 0 };
    for (var pid in data.positions) {
      if (!Object.prototype.hasOwnProperty.call(data.positions, pid)) continue;
      var entry = data.positions[pid];
      if (!entry || typeof entry !== 'object') continue;
      total++;
      if (entry.completed) completed++;

      // FSRS card-derived metrics. markSeen-only entries (no entry.srs) are
      // bucketed as 'new' since FSRS.validateCard(undefined) returns a fresh
      // new-state card. Same defensive shape as the old stats() did before
      // this rewrite — the bucket reflects "the card is implicitly fresh."
      var card = entry.srs;
      if (card && typeof card === 'object') {
        if (FSRS.isDue(FSRS.validateCard(card), todayYmd)) due++;
        var st = card.state | 0;
        if (st === FSRS.STATE.new)            states.new++;
        else if (st === FSRS.STATE.learning)  states.learning++;
        else if (st === FSRS.STATE.review)    states.review++;
        else if (st === FSRS.STATE.relearning) states.relearning++;
        else states.new++;  // unknown / corrupt state buckets to new
        if (typeof card.reps === 'number' && isFinite(card.reps)) totalReps += card.reps | 0;
        if (typeof card.lapses === 'number' && isFinite(card.lapses)) totalLapses += card.lapses | 0;
      } else {
        // markSeen-only or no card at all: counts as a 'new' bucket position.
        states.new++;
      }

      // Recent activity. lastSeen is an ISO timestamp; bucket by local
      // calendar day. NOTE: this counts ENTRIES with lastSeen-in-day-N,
      // not REVIEWS-in-day-N. If a card was reviewed twice on the same
      // day, only the latest lastSeen is preserved (per the schema), so
      // the count is 1 for that card-day. In practice, FSRS scheduling
      // makes same-day re-reviews rare — the approximation is acceptable.
      if (typeof entry.lastSeen === 'string') {
        var ts = Date.parse(entry.lastSeen);
        if (isFinite(ts)) {
          var seenYmd = FSRS.localDateString(new Date(ts));
          if (Object.prototype.hasOwnProperty.call(bucketByDay, seenYmd)) {
            bucketByDay[seenYmd]++;
          }
        }
      }
    }

    var recentActivity = new Array(7);
    for (var j = 0; j < 7; j++) {
      recentActivity[j] = { date: dayKeys[j], count: bucketByDay[dayKeys[j]] };
    }

    // Streak from meta. The stored `currentStreak` is the value at the
    // user's last review. If today is more than one calendar day after
    // that, the streak is broken — display 0. Same-day or yesterday →
    // the streak is still alive and shows the stored value.
    var meta = _readMeta(data);
    var displayCurrent = 0;
    if (meta.lastReviewDay) {
      var streakDelta = _dayDelta(meta.lastReviewDay, todayYmd);
      if (streakDelta === 0 || streakDelta === 1) displayCurrent = meta.currentStreak | 0;
    }

    return {
      total: total,
      completed: completed,
      due: due,
      states: states,
      totalReps: totalReps,
      totalLapses: totalLapses,
      lapseRate: (totalReps > 0) ? (totalLapses / totalReps) : null,
      currentStreak: displayCurrent,
      longestStreak: meta.longestStreak | 0,
      lastReviewDay: meta.lastReviewDay,
      recentActivity: recentActivity
    };
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    setStorage: setStorage,
    _makeMemoryStorage: makeMemoryStorage,  // exposed for tests
    setUsername: setUsername,
    getUsername: getUsername,
    getActiveStorageKey: getActiveStorageKey,
    migrateLegacyToActive: migrateLegacyToActive,
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

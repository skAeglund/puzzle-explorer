/**
 * session.js — Pure queue management for "Start Session" mode.
 *
 * A search returns N matches at a position. The user picks a rating range,
 * presses Start Session; we filter to in-range puzzles, prioritize unsolved
 * (the only ones queued in MVP), shuffle, and walk through them with
 * Next-puzzle clicks. Caller wires puzzleId → drill state.
 *
 * Contract: pure functions. Caller passes `isCompleted` so we don't depend
 * on lib/progress.js — keeps this module testable in isolation and reusable
 * if we later add a "redrill completed" mode.
 *
 * SRS-due drilling is OUT OF SCOPE here. That'll be a separate session source
 * (queue built from Progress.isDue) feeding the same drill machinery.
 *
 * Dual-mode load (Node + browser):
 *   Node:    const Session = require('../lib/session');
 *   Browser: <script src="lib/session.js"></script>  (defines window.Session)
 */
(function (root) {
  'use strict';

  // ─── helpers ────────────────────────────────────────────────────────────
  // Shallow-merge — produces a new object without mutating input.
  // Mirrors lib/drill.js's assign helper. ES5-safe.
  function assign(a, b) {
    var out = {};
    var k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    return out;
  }

  // Fisher-Yates shuffle, non-mutating. Optional rng for deterministic tests.
  function shuffle(arr, rng) {
    rng = (typeof rng === 'function') ? rng : Math.random;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  // Filter [[id, rating], ...] tuples by inclusive rating bounds. Tuples
  // missing a numeric rating pass through (we don't want to silently drop
  // puzzles whose rating wasn't indexed — better to surface them).
  function filterByRating(matches, ratingMin, ratingMax) {
    var min = (ratingMin === null || ratingMin === undefined) ? -Infinity : +ratingMin;
    var max = (ratingMax === null || ratingMax === undefined) ?  Infinity : +ratingMax;
    var out = [];
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (!m || m.length < 2) continue;
      var rating = m[1];
      if (typeof rating === 'number' && isFinite(rating)) {
        if (rating < min || rating > max) continue;
      }
      out.push(m);
    }
    return out;
  }

  // Count how many of an in-range tuple list are unsolved per the caller's
  // `isCompleted(pid)` predicate. Useful for the "X of Y unsolved" label
  // that updates as the user drags the slider.
  function countUnsolved(matches, isCompleted) {
    var fn = (typeof isCompleted === 'function') ? isCompleted : function () { return false; };
    var n = 0;
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (!m || m.length < 1) continue;
      if (!fn(m[0])) n++;
    }
    return n;
  }

  // ─── state factory ──────────────────────────────────────────────────────
  /**
   * create({ matches, ratingMin, ratingMax, isCompleted, rng })
   *   matches:     [[puzzleId, rating], ...] — full match list (uncapped)
   *   ratingMin:   inclusive lower bound (number or null/undefined = -Inf)
   *   ratingMax:   inclusive upper bound (number or null/undefined = +Inf)
   *   isCompleted: function(pid) → bool. Caller-supplied (e.g. Progress.isCompleted).
   *   rng:         optional () → [0,1) for deterministic tests
   *
   * Returns: {
   *   queue:        string[]   — shuffled UNSOLVED ids in range
   *   ratingMin, ratingMax,
   *   inRangeTotal: number     — count in range INCLUDING already solved
   *   total:        number     — queue.length at start (== unsolved in range)
   *   cursor:       -1         — -1 means "before first puzzle"; advance() → 0
   *   complete:     bool       — true iff queue is empty
   * }
   */
  function create(opts) {
    if (!opts) throw new Error('Session.create: opts required');
    var matches = Array.isArray(opts.matches) ? opts.matches : [];
    var inRange = filterByRating(matches, opts.ratingMin, opts.ratingMax);
    var isCompleted = (typeof opts.isCompleted === 'function')
      ? opts.isCompleted
      : function () { return false; };

    var unsolved = [];
    for (var i = 0; i < inRange.length; i++) {
      var m = inRange[i];
      if (!m || m.length < 1) continue;
      if (!isCompleted(m[0])) unsolved.push(m[0]);
    }

    var shuffled = shuffle(unsolved, opts.rng);

    return {
      queue: shuffled,
      ratingMin: (opts.ratingMin === null || opts.ratingMin === undefined) ? null : +opts.ratingMin,
      ratingMax: (opts.ratingMax === null || opts.ratingMax === undefined) ? null : +opts.ratingMax,
      inRangeTotal: inRange.length,
      total: shuffled.length,
      cursor: -1,
      complete: shuffled.length === 0
    };
  }

  /**
   * advance(state) → { state, puzzleId, exhausted }
   *
   * Moves the cursor forward by one. On the first call against a fresh
   * state (cursor === -1), returns queue[0]. Once past the end, state.complete
   * is set true and puzzleId is null. Idempotent: calling advance on a
   * complete state returns null again with cursor pinned at queue.length.
   */
  function advance(state) {
    if (!state) throw new Error('Session.advance: state required');
    var nextCursor = state.cursor + 1;
    if (nextCursor >= state.queue.length) {
      var done = assign(state, { complete: true, cursor: state.queue.length });
      return { state: done, puzzleId: null, exhausted: true };
    }
    var advanced = assign(state, { cursor: nextCursor, complete: false });
    return { state: advanced, puzzleId: state.queue[nextCursor], exhausted: false };
  }

  /**
   * progress(state) → { current, total }
   *
   * `current` is 1-indexed, suitable for "Puzzle 3/24" display. Returns
   * 0/total when no puzzles have been served yet (cursor === -1).
   */
  function progress(state) {
    if (!state) return { current: 0, total: 0 };
    var total = state.total;
    // cursor === -1 → current 0 (not started).
    // cursor 0..total-1 → current 1..total (drilling puzzle k+1 of total).
    // cursor === total → exhausted; clamp current to total (display "N/N").
    var current = Math.max(0, state.cursor + 1);
    if (current > total) current = total;
    return { current: current, total: total };
  }

  // ─── exports ────────────────────────────────────────────────────────────
  var api = {
    create: create,
    advance: advance,
    progress: progress,
    filterByRating: filterByRating,
    countUnsolved: countUnsolved,
    _shuffle: shuffle,    // exposed for test determinism
    _assign: assign       // exposed for test introspection
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Session = api;
  }
})(typeof self !== 'undefined' ? self : this);

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
      kind: 'search',
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
   * createFromIds(ids, opts?) → state
   *
   * Sibling factory for queues built from a pre-sorted id list (e.g. SRS-due
   * puzzles ordered oldest-due first by the caller). Skips rating filtering,
   * skips the unsolved-only filter, skips shuffling — caller already decided
   * the order. Returns the same state shape as `create` so it feeds the same
   * `advance` / `progress` / completion machinery.
   *
   *   ids:  string[]    — puzzle ids in the order they should be drilled
   *   opts: { kind? }   — kind defaults to 'review'; caller can override if a
   *                       future queue source wants a different label
   *
   * `inRangeTotal` is set to ids.length (no filtering happened) so the
   * existing UI bits that read it stay sane. `ratingMin/Max` are null —
   * ranges don't apply to id-list queues.
   */
  function createFromIds(ids, opts) {
    var arr = Array.isArray(ids) ? ids.slice() : [];
    // Defensive: drop anything that isn't a non-empty string. Cheap and keeps
    // a corrupt Progress entry from poisoning the whole queue.
    var clean = [];
    for (var i = 0; i < arr.length; i++) {
      var id = arr[i];
      if (typeof id === 'string' && id.length > 0) clean.push(id);
    }
    var kind = (opts && typeof opts.kind === 'string' && opts.kind) ? opts.kind : 'review';
    return {
      kind: kind,
      queue: clean,
      ratingMin: null,
      ratingMax: null,
      inRangeTotal: clean.length,
      total: clean.length,
      cursor: -1,
      complete: clean.length === 0
    };
  }

  /**
   * createTraining({ matches, rounds, isCompleted, rng }) → state
   *
   * Multi-round queue: chains N rating-bucketed sub-queues into a single
   * flat `queue`, so the existing `advance` / `retreat` / `progress`
   * machinery walks rounds end-to-end without modification.
   *
   * Each rounds[i] = { label, ratingMin, ratingMax, target } produces up
   * to `target` shuffled UNSOLVED puzzles in [ratingMin, ratingMax]. Rounds
   * are concatenated in declaration order (caller decides easy → hard).
   *
   * Dedupe: a puzzleId placed in an earlier round is skipped in later
   * rounds, even if its rating falls into both. Defensive — non-overlapping
   * bounds make this a no-op, but the user-visible spec ("easy 800-1400,
   * medium 1400-2000") is colloquially overlapping; we resolve by binding
   * each id to the earliest matching round.
   *
   * Empty rounds are allowed: if a round has no in-range unsolved puzzles
   * (or target=0), it contributes 0 ids and the queue continues into the
   * next round. The round's metadata still appears in state.rounds with
   * count: 0 so UI can show "skipped: no hard puzzles available".
   *
   * Returns the same state shape as `create`, plus:
   *   kind:    'training'
   *   rounds:  [{ label, ratingMin, ratingMax, target, count, startIndex }, ...]
   *
   * `startIndex` is the queue offset where each round begins. With cursor
   * + startIndex/count, callers can compute "Round X · puzzle Y/Z" via
   * the `trainingRound` helper.
   */
  function createTraining(opts) {
    if (!opts) throw new Error('Session.createTraining: opts required');
    var matches = Array.isArray(opts.matches) ? opts.matches : [];
    var roundsSpec = Array.isArray(opts.rounds) ? opts.rounds : [];
    var isCompleted = (typeof opts.isCompleted === 'function')
      ? opts.isCompleted
      : function () { return false; };

    // Object.create(null) — no prototype, so puzzleIds named "__proto__"
    // or "toString" can't collide with built-ins.
    var seen = Object.create(null);
    var allInRangeIds = Object.create(null);
    var queue = [];
    var rounds = [];

    for (var i = 0; i < roundsSpec.length; i++) {
      var spec = roundsSpec[i] || {};
      var target = (typeof spec.target === 'number' && isFinite(spec.target) && spec.target > 0)
        ? Math.floor(spec.target)
        : 0;
      var inRange = filterByRating(matches, spec.ratingMin, spec.ratingMax);

      var unsolvedIds = [];
      for (var j = 0; j < inRange.length; j++) {
        var m = inRange[j];
        if (!m || m.length < 1) continue;
        var pid = m[0];
        if (typeof pid !== 'string' || pid.length === 0) continue;
        allInRangeIds[pid] = true;
        if (seen[pid]) continue;          // already taken by an earlier round
        if (isCompleted(pid)) continue;
        unsolvedIds.push(pid);
      }

      var shuffled = shuffle(unsolvedIds, opts.rng);
      var taken = (target > 0) ? shuffled.slice(0, target) : [];

      var startIndex = queue.length;
      for (var k = 0; k < taken.length; k++) {
        seen[taken[k]] = true;
        queue.push(taken[k]);
      }

      rounds.push({
        label: (typeof spec.label === 'string' && spec.label) ? spec.label : ('Round ' + (i + 1)),
        ratingMin: (spec.ratingMin === null || spec.ratingMin === undefined) ? null : +spec.ratingMin,
        ratingMax: (spec.ratingMax === null || spec.ratingMax === undefined) ? null : +spec.ratingMax,
        target: target,
        count: taken.length,
        startIndex: startIndex
      });
    }

    // Count of distinct in-range ids across all rounds (solved or not,
    // before target cap). Informational — UI can compute "X already solved
    // across all ranges" as inRangeTotal − total when both are unsolved-only.
    var inRangeTotal = 0;
    for (var p in allInRangeIds) {
      if (Object.prototype.hasOwnProperty.call(allInRangeIds, p)) inRangeTotal++;
    }

    return {
      kind: 'training',
      queue: queue,
      rounds: rounds,
      ratingMin: null,
      ratingMax: null,
      inRangeTotal: inRangeTotal,
      total: queue.length,
      cursor: -1,
      complete: queue.length === 0
    };
  }

  /**
   * trainingRound(state) → { roundIndex, roundNumber, roundCount, label,
   *                          currentInRound, totalInRound, target,
   *                          totalRounds } | null
   *
   * Returns the round metadata corresponding to the visible puzzle —
   * i.e. the round whose `[startIndex, startIndex+count)` slice contains
   * `state.cursor`. Empty rounds (count=0) are skipped over.
   *
   * Visible-cursor convention mirrors `retreat`: when state.complete is
   * true, the user is still looking at queue[length-1], so we report the
   * round of THAT cursor (not the dead cursor=length position).
   *
   * Display fields:
   *   roundNumber  — 1-based position among NON-EMPTY rounds. Skips
   *                  empty buckets so the user doesn't see "Round 1/3"
   *                  jump to "Round 3/3" when the middle round had no
   *                  matches at the searched position.
   *   roundCount   — count of non-empty rounds (the denominator).
   *   roundIndex   — 0-based actual index in state.rounds (the original
   *                  configured order, INCLUDING empty rounds). Useful
   *                  for callers who need to look up state.rounds[i]
   *                  without re-skipping.
   *   totalRounds  — count of CONFIGURED rounds (state.rounds.length).
   *                  Kept for backwards compatibility / debug surfaces.
   *
   * Returns null for non-training states (or malformed input) — callers
   * should fall back to plain `progress(state)` rendering.
   *
   * `currentInRound` is 1-indexed when cursor ≥ 0, and 0 when cursor === -1
   * (matches `progress` convention). totalInRound === count for the round.
   */
  function trainingRound(state) {
    if (!state || state.kind !== 'training' || !Array.isArray(state.rounds)) {
      return null;
    }
    var rounds = state.rounds;
    if (rounds.length === 0) return null;

    var queueLen = Array.isArray(state.queue) ? state.queue.length : 0;
    // Map state.cursor → "the puzzle the user is looking at":
    //   cursor === -1 (not started)  → use 0 for bucket lookup, report current=0
    //   cursor in [0, queueLen)      → use cursor as-is
    //   complete (cursor === queueLen) → use queueLen-1 (last drilled puzzle)
    var lookupCursor;
    var current1Indexed;
    if (state.cursor < 0) {
      lookupCursor = 0;
      current1Indexed = 0;
    } else if (state.complete) {
      lookupCursor = Math.max(0, queueLen - 1);
      current1Indexed = null;     // computed after we know which round
    } else {
      lookupCursor = state.cursor;
      current1Indexed = null;
    }

    // Find the round containing lookupCursor. Walk forward; the last
    // non-empty round whose startIndex ≤ lookupCursor wins. Stop the
    // moment a startIndex exceeds lookupCursor — rounds are in queue order.
    // Simultaneously compute roundCount (non-empty total) and roundNumber
    // (1-based position of the matched round among non-empties).
    var roundIndex = -1;
    var roundCount = 0;          // non-empty rounds total
    var roundNumber = 0;         // 1-based position of matched round; finalized once we know roundIndex
    for (var i = 0; i < rounds.length; i++) {
      if (rounds[i].count === 0) continue;
      roundCount++;
      // While we haven't passed lookupCursor yet, this round is a candidate.
      // The LAST such candidate wins — because rounds are in queue order
      // and a later round with startIndex ≤ lookupCursor strictly contains
      // the earlier-tested ones.
      if (rounds[i].startIndex <= lookupCursor) {
        roundIndex = i;
        roundNumber = roundCount;   // snapshot at the matching round
      }
      // We can't break here yet — we still need to count later non-empty
      // rounds to compute roundCount. So just continue.
    }
    // If no non-empty round was found (e.g. all rounds empty — but then
    // queue would be empty and we'd have returned via the early-exit on
    // an empty queue path; defensive anyway), fall back to round 0 and
    // 1/1 display.
    if (roundIndex < 0) {
      // Find the first round whose count > 0; if all are empty (queue is
      // empty), pin to index 0 with degenerate display.
      for (var fi = 0; fi < rounds.length; fi++) {
        if (rounds[fi].count > 0) { roundIndex = fi; break; }
      }
      if (roundIndex < 0) roundIndex = 0;
      roundNumber = 1;
      if (roundCount === 0) roundCount = 1;
    }

    var r = rounds[roundIndex];
    if (current1Indexed === null) {
      // Position within the round, 1-indexed. Clamp to [1, count] so
      // pathological input (cursor outside the round span — shouldn't
      // happen given the lookup) can't render "0/N" or "N+1/N".
      var inRound = (lookupCursor - r.startIndex) + 1;
      if (inRound < 1) inRound = 1;
      if (inRound > r.count) inRound = r.count;
      current1Indexed = inRound;
    }

    return {
      roundIndex: roundIndex,
      roundNumber: roundNumber,
      roundCount: roundCount,
      label: r.label,
      target: r.target,
      currentInRound: current1Indexed,
      totalInRound: r.count,
      totalRounds: rounds.length
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
   * retreat(state) → { state, puzzleId, atStart }
   *
   * Mirror of advance. Moves the cursor backward by one and returns the
   * puzzleId at the new position. `atStart` is true when the new cursor is
   * 0 (caller can disable the "Previous" button to prevent further retreats)
   * OR when the call was a no-op because there was nowhere left to go.
   *
   * Asymmetry vs advance — the post-completion state. advance() pins the
   * cursor at queue.length (one past the last puzzle) and sets complete=true
   * when the session exhausts. The visible board, however, is still the
   * last drilled puzzle (queue[length-1]). From the user's perspective
   * "Previous" should take them to the puzzle BEFORE the one currently
   * visible, i.e. queue[length-2]. So retreat treats the post-complete
   * state as if cursor were length-1 and steps to length-2 in a single
   * call — skipping the dead "past the end" position. This lets users
   * rewind from the session-complete screen with one click instead of two.
   *
   * Idempotent: retreat from cursor 0 (or empty queue) returns puzzleId
   * null and atStart=true with state unchanged.
   *
   * Sets complete=false when it actually moves — retreating into a
   * completed session re-opens it for re-drilling that puzzle, and the
   * caller's UI (Next-puzzle button visibility, completion strip) gets
   * a sane state to render against.
   */
  function retreat(state) {
    if (!state) throw new Error('Session.retreat: state required');
    // Logical "currently visible" cursor: if complete, the user is looking
    // at queue[length-1] even though state.cursor === queue.length. Treat
    // that case as if cursor were length-1 for retreat purposes.
    var fromCursor = state.complete ? state.queue.length - 1 : state.cursor;
    var prevCursor = fromCursor - 1;
    if (prevCursor < 0) {
      return { state: state, puzzleId: null, atStart: true };
    }
    var retreated = assign(state, { cursor: prevCursor, complete: false });
    return {
      state: retreated,
      puzzleId: state.queue[prevCursor],
      atStart: prevCursor === 0
    };
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
    createFromIds: createFromIds,
    createTraining: createTraining,
    advance: advance,
    retreat: retreat,
    progress: progress,
    trainingRound: trainingRound,
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

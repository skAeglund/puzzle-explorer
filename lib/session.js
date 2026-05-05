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

  // roundRobinDraft — pick up to `target` tuples from `pool`, balancing
  // selection across multiple repertoires. Used by createTraining when 2+
  // repertoires are active.
  //
  // Algorithm: for each repertoire id, build a bucket of all tuples whose
  // pid is contributed by that repertoire (same pid can appear in multiple
  // buckets if it lives in multiple repertoires). Shuffle each bucket so
  // the within-bucket order is random. Then walk the rep cursor in order
  // [r0, r1, ..., rN-1, r0, r1, ...], popping one not-yet-taken tuple from
  // the cursor's bucket each step. Continue until target is met OR every
  // rep has gone idle for one full pass (no more available tuples anywhere).
  //
  // Multi-rep tuples (a pid in both A and B): the first bucket to draft it
  // wins; subsequent buckets skip it on lookup. Since each rep's bucket is
  // shuffled independently, which bucket "wins" a shared puzzle is random,
  // which is what we want — we don't bias either rep's count for shared
  // puzzles.
  //
  // Empty pool, target≤0, missing rep entries in repsByPid → returns [].
  // Pool entries lacking a usable pid silently skipped (matches the
  // permissive posture of the rest of this module).
  function roundRobinDraft(pool, repIds, repsByPid, target, rng) {
    if (!Array.isArray(pool) || pool.length === 0) return [];
    if (!Array.isArray(repIds) || repIds.length === 0) return [];
    if (typeof target !== 'number' || target <= 0) return [];
    repsByPid = repsByPid || {};
    var n = repIds.length;

    // Build per-rep buckets. repIndex map (id → array index) is faster than
    // repeated indexOf during the hot loop.
    var repIndex = Object.create(null);
    var buckets = new Array(n);
    for (var b = 0; b < n; b++) {
      repIndex[repIds[b]] = b;
      buckets[b] = [];
    }
    for (var i = 0; i < pool.length; i++) {
      var m = pool[i];
      if (!m || !m[0]) continue;
      var pid = m[0];
      if (typeof pid !== 'string') continue;
      var ownersList = repsByPid[pid];
      if (!Array.isArray(ownersList) || ownersList.length === 0) continue;
      // Push into every owning bucket. Dedup-on-the-fly via a tiny set so
      // the same (pid, rep) pair can't land in the same bucket twice if a
      // caller sends a duplicated owners list.
      var localOwners = Object.create(null);
      for (var o = 0; o < ownersList.length; o++) {
        var rid = ownersList[o];
        var rIdx = repIndex[rid];
        if (rIdx === undefined) continue;          // rep not in active set
        if (localOwners[rid]) continue;            // already pushed this iter
        localOwners[rid] = true;
        buckets[rIdx].push(m);
      }
    }
    // Shuffle each bucket so within-bucket order is random per draft.
    for (var s = 0; s < n; s++) {
      buckets[s] = shuffle(buckets[s], rng);
    }

    // Round-robin pop. localTaken tracks claimed pids so a multi-rep puzzle
    // claimed by bucket A is skipped in bucket B's later turn.
    var taken = [];
    var localTaken = Object.create(null);
    var cursor = 0;
    var idle = 0;                         // consecutive idle reps; bail at n
    while (taken.length < target && idle < n) {
      var bIdx = cursor % n;
      var bucket = buckets[bIdx];
      var picked = null;
      while (bucket.length) {
        var cand = bucket.pop();
        if (cand && cand[0] && !localTaken[cand[0]]) { picked = cand; break; }
      }
      if (picked) {
        localTaken[picked[0]] = true;
        taken.push(picked);
        idle = 0;
      } else {
        idle++;
      }
      cursor++;
    }
    return taken;
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

  // Filter [id, rating, color, ply, startPly] tuples by inclusive
  // PUZZLE START PLY bounds. Reads m[4] specifically; the tuple position
  // is the contract with build-index.js.
  //
  // Same back-compat contract as filterByRating: missing/non-numeric
  // startPly (m[4]) passes through unfiltered. Older shards built before
  // m[4] was added emit length-3/length-4 entries and we don't silently
  // drop those puzzles — they pass through every filter, the same posture
  // we use for color (m[2]) on legacy length-3 entries.
  //
  // m[4] vs m[3]: don't confuse them. m[3] is the source-game ply at
  // THIS particular search posKey (varies entry-to-entry within one
  // puzzle); m[4] is the source-game ply at which the PUZZLE ITSELF
  // begins (= verbose.length, constant across all of a puzzle's entries).
  // The "show me opening puzzles only" slider wants m[4] — searching at
  // 1.e4 with max-ply 16 should drop a puzzle that begins at ply 50
  // even though m[3]=1 for that puzzle's 1.e4 entry. m[3] alone can't
  // answer this question without a global per-puzzle aggregation.
  function filterByPly(matches, plyMin, plyMax) {
    var min = (plyMin === null || plyMin === undefined) ? -Infinity : +plyMin;
    var max = (plyMax === null || plyMax === undefined) ?  Infinity : +plyMax;
    // Fast path: no-op filter. Same shape as a wide-open call but skips
    // the per-entry numeric-checks-and-comparisons cost on hot shards.
    if (min === -Infinity && max === Infinity) return matches.slice();
    var out = [];
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i];
      if (!m || m.length < 1) continue;
      var startPly = m[4];
      if (typeof startPly === 'number' && isFinite(startPly)) {
        if (startPly < min || startPly > max) continue;
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
    // Apply ply filter first (cheap, often a no-op) then rating. Order
    // doesn't affect correctness — both are independent inclusive filters
    // — but ply-filter-first reduces the work rating-filter has to do
    // when the ply window is narrow.
    var afterPly = filterByPly(matches, opts.plyMin, opts.plyMax);
    var inRange = filterByRating(afterPly, opts.ratingMin, opts.ratingMax);
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
      plyMin: (opts.plyMin === null || opts.plyMin === undefined) ? null : +opts.plyMin,
      plyMax: (opts.plyMax === null || opts.plyMax === undefined) ? null : +opts.plyMax,
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
   * createTrainingRetry(items) → state (kind: 'training')
   *
   * Builds a single-round training-kind state for "retry your failed
   * puzzles" flows. Bypasses rating buckets and shuffling — caller hands
   * us a flat list of [id, rating?] tuples and we drill them in the order
   * given (after a stable sort by rating asc, so the user warms up before
   * harder ones).
   *
   * Why a separate factory instead of reusing createTraining? createTraining
   * shuffles within each round, filters by rating, and dedupes against
   * earlier rounds — none of which apply to a retry queue. Trying to bend
   * createTraining into this shape would mean adding flags that tangle the
   * common path. A dedicated factory keeps both surfaces narrow.
   *
   * Returns the same state shape as createTraining (kind: 'training', a
   * `rounds` array with one synthetic 'Retry' round) so trainingRound +
   * the existing UI render path work unchanged. The single round's rating
   * bounds are null/null since the queue isn't filtered by rating.
   *
   *   items: Array of either:
   *     - string ids (rating treated as null), OR
   *     - [id, rating] tuples — same shape as `matches` elsewhere
   *
   * Defensive against the usual: non-array input, malformed entries, ids
   * that aren't non-empty strings, duplicates (kept once, first occurrence
   * wins). Empty input → state.complete=true (caller should guard, but
   * the state is still well-formed).
   */
  function createTrainingRetry(items) {
    var arr = Array.isArray(items) ? items : [];
    var seen = Object.create(null);
    // Build {id, rating} pairs, dedupe, drop malformed.
    var pairs = [];
    for (var i = 0; i < arr.length; i++) {
      var entry = arr[i];
      var id, rating;
      if (typeof entry === 'string') {
        id = entry; rating = null;
      } else if (Array.isArray(entry) && entry.length >= 1) {
        id = entry[0];
        rating = (typeof entry[1] === 'number' && isFinite(entry[1])) ? entry[1] : null;
      } else {
        continue;
      }
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen[id]) continue;
      seen[id] = true;
      pairs.push({ id: id, rating: rating });
    }
    // Stable sort by rating asc (null/missing ratings last — they're
    // unusual and shouldn't push other puzzles around). Stability matters
    // so callers controlling tie-break order via input ordering get it.
    pairs.sort(function (a, b) {
      var ar = (a.rating === null) ?  Infinity : a.rating;
      var br = (b.rating === null) ?  Infinity : b.rating;
      return ar - br;
    });
    var queue = [];
    for (var k = 0; k < pairs.length; k++) queue.push(pairs[k].id);
    var rounds = [{
      label: 'Retry',
      ratingMin: null,
      ratingMax: null,
      target: queue.length,
      count: queue.length,
      startIndex: 0
    }];
    return {
      kind: 'training',
      queue: queue,
      rounds: rounds,
      ratingMin: null,
      ratingMax: null,
      inRangeTotal: queue.length,
      total: queue.length,
      cursor: -1,
      complete: queue.length === 0
    };
  }

  /**
   * createTraining({ matches, rounds, isCompleted, rng, multiRep }) → state
   *
   * Multi-round queue: chains N rating-bucketed sub-queues into a single
   * flat `queue`, so the existing `advance` / `retreat` / `progress`
   * machinery walks rounds end-to-end without modification.
   *
   * Each rounds[i] = { label, ratingMin, ratingMax, target } produces up
   * to `target` UNSOLVED puzzles in [ratingMin, ratingMax]. Rounds are
   * concatenated in declaration order (caller decides easy → hard).
   *
   * Within-round ordering: a `target`-sized sample is drawn from the
   * in-range pool, then sorted by rating ascending so the user warms up
   * before the round's hardest puzzles. The sort is stable; ties keep
   * the draft order. Tuples without a numeric rating sort to the end of
   * the round so they don't disrupt the warm-up curve.
   *
   * Sample selection — two paths:
   *   - Default (no multiRep, or only 1 rep id): uniform random sample
   *     via Fisher-Yates, slice(0, target).
   *   - Multi-rep round-robin (multiRep.repIds.length ≥ 2): draft from
   *     per-rep buckets in round-robin order so each round draws roughly
   *     equal counts from each repertoire. A puzzle owned by multiple
   *     reps is claimed by whichever bucket drafts it first; subsequent
   *     buckets skip it. Rep order is shuffled once per createTraining
   *     call, so all rounds within one session use the same rep order
   *     (consistent within a session, varies across sessions).
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
   *
   * `multiRep` shape (optional):
   *   {
   *     repIds:    ['rep_abc', 'rep_def', ...],
   *     repsByPid: { 'puzzleA': ['rep_abc'], 'puzzleB': ['rep_abc', 'rep_def'], ... }
   *   }
   * If repIds has fewer than 2 entries, multiRep is ignored.
   */
  function createTraining(opts) {
    if (!opts) throw new Error('Session.createTraining: opts required');
    var matchesRaw = Array.isArray(opts.matches) ? opts.matches : [];
    // Apply ply filter once at the top so every round sees the same
    // ply-bounded pool. Per-round rating filter then narrows further.
    // No-op when plyMin/plyMax are null/undefined (full range).
    var matches = filterByPly(matchesRaw, opts.plyMin, opts.plyMax);
    var roundsSpec = Array.isArray(opts.rounds) ? opts.rounds : [];
    var isCompleted = (typeof opts.isCompleted === 'function')
      ? opts.isCompleted
      : function () { return false; };

    // Multi-rep round-robin opt-in. Active when caller supplies a
    // `multiRep` block with at least 2 rep ids; below that threshold we
    // fall through to the original random-sample-and-slice behavior
    // (which is correct for both 0-rep and 1-rep states — no balancing
    // needed). Rep order is shuffled ONCE per createTraining call so the
    // same order applies across all rounds; this keeps a session feeling
    // consistent (same rep gets first pick across easy/medium/hard) while
    // varying across sessions.
    var multiRepActive = false;
    var shuffledRepIds = null;
    var repsByPid = null;
    if (opts.multiRep && Array.isArray(opts.multiRep.repIds) && opts.multiRep.repIds.length >= 2) {
      multiRepActive = true;
      shuffledRepIds = shuffle(opts.multiRep.repIds, opts.rng);
      repsByPid = opts.multiRep.repsByPid || {};
    }

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

      // Build the unsolved tuple pool for this round. We keep raw tuples
      // (not {id, rating} objects) because the multi-rep round-robin path
      // needs the pid to look up rep ownership — and the non-multiRep path
      // can extract rating from m[1] just as easily.
      var unsolved = [];
      for (var j = 0; j < inRange.length; j++) {
        var m = inRange[j];
        if (!m || m.length < 1) continue;
        var pid = m[0];
        if (typeof pid !== 'string' || pid.length === 0) continue;
        allInRangeIds[pid] = true;
        if (seen[pid]) continue;          // already taken by an earlier round
        if (isCompleted(pid)) continue;
        unsolved.push(m);
      }

      // Selection: round-robin if multi-rep, otherwise random sample.
      // Both paths produce a tuple array of size ≤ target.
      var picked;
      if (multiRepActive && target > 0) {
        picked = roundRobinDraft(unsolved, shuffledRepIds, repsByPid, target, opts.rng);
      } else if (target > 0) {
        picked = shuffle(unsolved, opts.rng).slice(0, target);
      } else {
        picked = [];
      }

      // Random sample drawn — now order it low→high by rating so the round
      // is a warm-up rather than a flat shuffle. Stable sort keeps ties in
      // the shuffle/round-robin order (tie-breaks stay random). Rating-less
      // entries sort to the end; two rating-less entries compare equal so
      // their original order is preserved (Infinity - Infinity is NaN, which
      // makes the sort implementation-defined — guard explicitly).
      picked.sort(function (a, b) {
        var ar = (typeof a[1] === 'number' && isFinite(a[1])) ? a[1] : null;
        var br = (typeof b[1] === 'number' && isFinite(b[1])) ? b[1] : null;
        if (ar === null && br === null) return 0;
        if (ar === null) return 1;
        if (br === null) return -1;
        return ar - br;
      });

      var startIndex = queue.length;
      for (var k = 0; k < picked.length; k++) {
        var takenId = picked[k][0];
        seen[takenId] = true;
        queue.push(takenId);
      }

      rounds.push({
        label: (typeof spec.label === 'string' && spec.label) ? spec.label : ('Round ' + (i + 1)),
        ratingMin: (spec.ratingMin === null || spec.ratingMin === undefined) ? null : +spec.ratingMin,
        ratingMax: (spec.ratingMax === null || spec.ratingMax === undefined) ? null : +spec.ratingMax,
        target: target,
        count: picked.length,
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
      plyMin: (opts.plyMin === null || opts.plyMin === undefined) ? null : +opts.plyMin,
      plyMax: (opts.plyMax === null || opts.plyMax === undefined) ? null : +opts.plyMax,
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

  /**
   * endEarly — collapse a mid-flight training state into a complete
   * state that reflects only what the user actually drilled.
   *
   * UI layer (issue #4): the user clicks "End here" mid-session. They
   * keep their progress so far, see the post-completion banner, and
   * can Retry-failed / Same-again / Back. Without this helper they'd
   * either lose the run (current Back behavior) or get a misleading
   * "30 puzzles cleared" banner that ignores partial completion.
   *
   * Inputs:
   *   state         — a sessionState (any kind, but only meaningful
   *                   for kind:'training'). Must not already be complete.
   *   drilledIds    — { pid: true } map of puzzles the user attempted
   *                   (typically Object.keys(trainingOutcomes)). Drives
   *                   the round-by-round count truncation below.
   *
   * Returns a new state with:
   *   complete: true,  cursor: queue.length  (signals "done" to advance/retreat)
   *   total: <sum of attempted across rounds>  — drives the post-completion
   *           banner so it reads "8 puzzles cleared", not "30".
   *   rounds: copies with each round.count reduced to its attempted
   *           subset. startIndex stays so retreat from complete still
   *           lands on a sensible queue position; queue itself is NOT
   *           truncated (rounds reference its offsets).
   *
   * If the input state is null, not training-shaped, or already complete,
   * returns the input unchanged. drilledIds defaults to {} (= "nothing
   * drilled, total becomes 0"), which is a valid degenerate completion.
   */
  function endEarly(state, drilledIds) {
    if (!state || state.complete) return state;
    var ids = drilledIds || {};
    var rounds = Array.isArray(state.rounds) ? state.rounds : [];
    var newRounds = [];
    var attemptedTotal = 0;
    for (var i = 0; i < rounds.length; i++) {
      var r = rounds[i];
      var attempted = 0;
      var end = r.startIndex + r.count;
      for (var j = r.startIndex; j < end; j++) {
        var pid = state.queue[j];
        if (pid && Object.prototype.hasOwnProperty.call(ids, pid)) {
          attempted++;
        }
      }
      // Shallow-copy the round so we don't mutate the caller's object.
      var nr = {};
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) nr[k] = r[k];
      nr.count = attempted;
      newRounds.push(nr);
      attemptedTotal += attempted;
    }
    return assign(state, {
      cursor: state.queue.length,
      total: attemptedTotal,
      complete: true,
      rounds: newRounds
    });
  }

  // ─── exports ────────────────────────────────────────────────────────────
  var api = {
    create: create,
    createFromIds: createFromIds,
    createTraining: createTraining,
    createTrainingRetry: createTrainingRetry,
    advance: advance,
    retreat: retreat,
    progress: progress,
    trainingRound: trainingRound,
    endEarly: endEarly,
    filterByRating: filterByRating,
    filterByPly: filterByPly,
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

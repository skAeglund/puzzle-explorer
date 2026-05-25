/**
 * repertoireUnion.js — pure match-accumulation for repertoire-union search.
 *
 * The repertoire search in index.html fetches one index shard at a time (in
 * bounded batches, to keep mobile memory tiny) and feeds each shard's parsed
 * JSON here as it arrives. This module owns the *matching* semantics —
 * perspective filtering, cross-position dedup, rep attribution, unique-count
 * tracking — with zero I/O, so it can be exercised exhaustively in Node
 * without a browser, network, or IndexedDB.
 *
 * Streaming contract (how index.html drives it):
 *   var acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: bool });
 *   for each shard that came back with JSON:
 *     acc.ingestShard(parsedShardJson, triplesThatHashedToThatShard);
 *   var out = acc.finalize();   // { matches, rawUniqueCount, pidToReps, anyHit }
 *
 * 404 / missing shards: the caller simply does NOT call ingestShard for them,
 * so they contribute nothing and `anyHit` stays false until a real shard lands.
 *
 * A "triple" is { key, shard, item, repId }:
 *   key    — canonical fenPositionKey for the saved position
 *   shard  — SHA-1-prefix shard the key hashes to (caller computes it)
 *   item   — the repertoire item { fen, orientation?, ... }
 *   repId  — id of the repertoire the item belongs to
 *
 * Index entry shape (per the data layer): [puzzleId, rating, color, ply].
 *   color and ply may be absent on legacy shards — both are handled with the
 *   project's "missing → pass-through / most-permissive" backward-compat
 *   posture (see CONVENTIONS #12).
 *
 * Loaded in Node via:    const RepertoireUnion = require('../lib/repertoireUnion');
 * Loaded in browser via: <script src="lib/repertoireUnion.js"></script>
 */
(function (root) {
  'use strict';

  // Side-to-move from a FEN: the 2nd space-separated field. Returns
  // 'w' | 'b' | null. We deliberately string-split rather than construct a
  // Chess() — this runs in the hot path of repertoire search and a split is
  // far cheaper than a full FEN parse.
  function fenSideToMove(fen) {
    if (typeof fen !== 'string' || !fen) return null;
    var parts = fen.split(/\s+/);
    var stm = parts[1];
    return (stm === 'w' || stm === 'b') ? stm : null;
  }

  // The perspective color to filter an item's matches against. The user's
  // study color is captured in item.orientation at add time (the board flip
  // when they hit "+ Add current"). That — NOT the side-to-move of the saved
  // FEN — is what we filter against. Concrete: a Caro-Kann black-perspective
  // study saves the position after 1.e4 c6 2.d4 d5 with orientation='black'
  // but the FEN itself is white-to-move. Filtering on FEN STM there would
  // surface white-to-move puzzles ("white finds the tactic"), the opposite of
  // what a black-perspective trainee wants. Fall back to FEN STM only when
  // orientation is absent (legacy items pre-dating the orientation field).
  function itemColor(item) {
    if (!item) return null;
    if (item.orientation === 'white') return 'w';
    if (item.orientation === 'black') return 'b';
    return fenSideToMove(item.fen);
  }

  function isMissingPly(p) {
    return p === undefined || p === null;
  }

  function createAccumulator(opts) {
    opts = opts || {};
    var matchOwnColorOnly = !!opts.matchOwnColorOnly;

    // pid → winning index entry (deduped across the whole selection).
    var unioned = Object.create(null);
    // pid → [repId, ...] — every repertoire that can reach this puzzle.
    var pidToReps = Object.create(null);
    // pid → true for every puzzle that surfaced, pre-perspective-filter.
    // Used for the unfiltered-unique count in the status line.
    var rawSeen = Object.create(null);
    // True once any real shard has been ingested (vs. all 404/miss).
    var anyHit = false;

    // Ingest one shard's matches. `idx` is the parsed shard JSON (posKey →
    // [entry, ...]); `shardTriples` are the triples whose key hashes to this
    // shard. Mutates the accumulators above. Safe to call in any shard order:
    // dedup is order-independent (see the min-ply tie-break below).
    function ingestShard(idx, shardTriples) {
      if (!idx || !shardTriples || !shardTriples.length) return;
      anyHit = true;
      for (var p = 0; p < shardTriples.length; p++) {
        var tr = shardTriples[p];
        var raw = idx[tr.key] || [];

        // Perspective filter. Keep an entry if "my color only" is off, or
        // the item has no resolvable color, or the entry's color is absent
        // (legacy) or matches. m[2] === undefined preserves the legacy
        // "missing color → passes" posture.
        var color = itemColor(tr.item);
        var keep;
        if (matchOwnColorOnly && color) {
          keep = raw.filter(function (m) { return m[2] === undefined || m[2] === color; });
        } else {
          keep = raw;
        }

        // Track every pid that surfaced (pre-filter) for the unfiltered
        // unique count.
        for (var qq = 0; qq < raw.length; qq++) {
          var rmm = raw[qq];
          if (rmm && rmm[0]) rawSeen[rmm[0]] = true;
        }

        for (var q = 0; q < keep.length; q++) {
          var mm = keep[q];
          if (!mm || !mm[0]) continue;
          var pid = mm[0];

          // Dedupe across the union. The grouped-by-shard streaming walk
          // visits triples in a different order each run (shard hash order,
          // not save order), so the tie-break MUST be order-independent — a
          // plain "first wins" would make the kept entry depend on fetch
          // order. When a puzzle is reachable from several of the user's
          // saved positions, it carries a different `ply` from each (the
          // position's halfmove depth in the source game); we keep the entry
          // with the SMALLEST ply. That mirrors build-index.js's
          // dedup-keeps-min-ply rule for in-game transpositions and is the
          // correct answer for the session ply-range filter: the puzzle
          // genuinely IS reachable at the earliest ply. A missing ply
          // (legacy shard) is treated as most-permissive — it passes
          // filterByPly unconditionally — so it is never displaced by a
          // numeric ply, preserving the backward-compat posture.
          //
          // Determinism note: when both prev and cur are missing-ply we keep
          // prev (arrival order). That is only order-SAFE because a dataset
          // is built atomically with one uniform entry shape — every entry
          // for a given puzzleId is byte-identical except for ply (rating and
          // color are per-puzzle invariants). So two missing-ply entries for
          // one pid are identical and the choice between them is moot. The
          // randomized suite asserts this determinism across shuffled ingest
          // orders for modern and legacy (no-ply / no-color) dataset shapes.
          var prev = unioned[pid];
          if (!prev) {
            unioned[pid] = mm;
          } else {
            var prevPly = prev[3], curPly = mm[3];
            var prevMissing = isMissingPly(prevPly);
            var curMissing = isMissingPly(curPly);
            if (!prevMissing && (curMissing || curPly < prevPly)) {
              unioned[pid] = mm;
            }
          }

          // Accumulate ALL contributing rep ids (a pid can come from multiple
          // reps via different items). indexOf is fine for small N
          // (single-digit reps in practice).
          var arr = pidToReps[pid];
          if (!arr) { arr = []; pidToReps[pid] = arr; }
          if (arr.indexOf(tr.repId) === -1) arr.push(tr.repId);
        }
      }
    }

    // Collapse the accumulators into the result the UI consumes. Matches are
    // returned UNSORTED — the caller sorts by rating for display. Counts are
    // derived once here rather than maintained incrementally so they can't
    // drift from the maps.
    function finalize() {
      var matches = [];
      for (var pid in unioned) {
        if (Object.prototype.hasOwnProperty.call(unioned, pid)) matches.push(unioned[pid]);
      }
      var rawUniqueCount = 0;
      for (var rid in rawSeen) {
        if (Object.prototype.hasOwnProperty.call(rawSeen, rid)) rawUniqueCount++;
      }
      return {
        matches: matches,
        rawUniqueCount: rawUniqueCount,
        pidToReps: pidToReps,
        anyHit: anyHit
      };
    }

    return {
      ingestShard: ingestShard,
      finalize: finalize
    };
  }

  var api = {
    createAccumulator: createAccumulator,
    fenSideToMove: fenSideToMove,
    itemColor: itemColor
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RepertoireUnion = api;
  }
})(typeof self !== 'undefined' ? self : this);

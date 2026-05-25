/**
 * offline.js — pure helpers for the "Make available offline" feature.
 *
 * This module owns the *logic* of offline-repertoire prefetch — grouping ids
 * by body shard, unioning stored match sets across repertoires (for the
 * offline search fallback), and computing a stable signature of a repertoire's
 * position set (for staleness detection). It does NO I/O: the browser side
 * (index.html) wires these helpers to lib/cache.js (the IndexedDB persistence
 * layer) and to fetch(). That split keeps the branchy set/dedup math
 * unit-testable in Node without a browser — see analyzer/offline-test.js.
 *
 * Storage model (implemented in lib/cache.js, orchestrated by index.html):
 *   - offlineBodies   : id → parsed puzzle body. Persistent (NOT LRU-evicted,
 *                       NOT wiped by checkBuildVersion). Shared by id across
 *                       repertoires; ref-counted at delete time via manifests.
 *   - offlineManifests: repId → { matches, itemSig, builtAt, … }. The match
 *                       ENTRIES (not just ids) are stored so every session
 *                       pre-filter (rating m[1] / perspective m[2] / ply m[4] /
 *                       theme m[5]) still works offline straight off the
 *                       stored set, and so a downloaded repertoire is drillable
 *                       with no network round-trip.
 *
 * Dual-mode load (Node + browser):
 *   Node:    const Offline = require('../lib/offline');
 *   Browser: <script src="lib/offline.js"></script>  (defines window.Offline)
 */
(function (root) {
  'use strict';

  // Body-shard prefetch batch size. Mirrors the index-shard streaming BATCH in
  // index.html's union search: caps in-flight fetches AND peak live shard text
  // so a 1000-match prefetch (~880 distinct body shards) never holds more than
  // a handful of shards in memory at once.
  var OFFLINE_BODY_BATCH = 8;

  // ─── ply tie-break (parity with lib/repertoireUnion.js) ─────────────────
  // A missing ply (legacy shard) is most-permissive — it passes filterByPly
  // unconditionally — so it is never displaced by a numeric ply. Among present
  // plies the SMALLEST wins (the puzzle genuinely IS reachable at the earliest
  // halfmove). This MUST stay identical to the accumulator's rule so an
  // offline-served match set is the same set the online search would produce.
  function isMissingPly(p) {
    return p === undefined || p === null;
  }

  // shouldReplace(prev, cur) → keep `cur` over the already-stored `prev`?
  // Exactly repertoireUnion's `!prevMissing && (curMissing || curPly < prevPly)`.
  function shouldReplace(prevPly, curPly) {
    var prevMissing = isMissingPly(prevPly);
    if (prevMissing) return false;            // missing prev is most-permissive
    var curMissing = isMissingPly(curPly);
    if (curMissing) return true;              // a missing cur displaces a present prev
    return curPly < prevPly;                  // else smaller ply wins
  }

  /**
   * groupByShard(pairs) → { shard: [id, …], … }
   *
   * pairs: [{ id, shard }] — typically every matched puzzle id paired with the
   * SHA-1-prefix shard its BODY lives in (hash(id), computed by the caller via
   * Web Crypto). Groups ids by shard so each body shard is fetched exactly once
   * and the wanted bodies extracted from it before it's discarded.
   *
   * Dedups ids within a shard (a defensive measure; match sets are already
   * pid-unique). Non-array input → {}. Entries missing id or shard are skipped.
   */
  function groupByShard(pairs) {
    var out = Object.create(null);
    if (!Array.isArray(pairs)) return out;
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (!p || typeof p.id === 'undefined' || p.id === null) continue;
      if (typeof p.shard !== 'string' || !p.shard) continue;
      var bucket = out[p.shard] || (out[p.shard] = []);
      if (bucket.indexOf(p.id) === -1) bucket.push(p.id);
    }
    return out;
  }

  /**
   * unionManifests(sources) → { matches, pidToReps }
   *
   * sources: [{ repId, matches }] — the stored match sets of one or more
   * downloaded repertoires. Produces the deduped union (by puzzle id m[0], with
   * the min-ply tie-break above) plus the rep-attribution map (pid → contributing
   * repIds) that the training round-robin draft needs. Order-independent: the
   * tie-break makes the kept entry the same regardless of source/iteration order.
   *
   * Non-array `sources` → empty. A source with a non-array `matches` is skipped.
   * A match with no id (m[0] falsy) is skipped.
   */
  function unionManifests(sources) {
    var unioned = Object.create(null);   // pid → winning entry
    var pidToReps = Object.create(null); // pid → [repId, …]
    if (!Array.isArray(sources)) return { matches: [], pidToReps: pidToReps };
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      if (!src || !Array.isArray(src.matches)) continue;
      var repId = src.repId;
      for (var m = 0; m < src.matches.length; m++) {
        var entry = src.matches[m];
        if (!entry || !entry[0]) continue;
        var pid = entry[0];
        var prev = unioned[pid];
        if (!prev) {
          unioned[pid] = entry;
        } else if (shouldReplace(prev[3], entry[3])) {
          unioned[pid] = entry;
        }
        if (typeof repId !== 'undefined' && repId !== null) {
          var arr = pidToReps[pid] || (pidToReps[pid] = []);
          if (arr.indexOf(repId) === -1) arr.push(repId);
        }
      }
    }
    var matches = [];
    for (var k in unioned) {
      if (Object.prototype.hasOwnProperty.call(unioned, k)) matches.push(unioned[k]);
    }
    return { matches: matches, pidToReps: pidToReps };
  }

  /**
   * dedupMatches(lists) → [entry, …]
   *
   * Convenience wrapper around unionManifests for callers that don't care about
   * attribution. `lists` is an array of match-entry arrays.
   */
  function dedupMatches(lists) {
    if (!Array.isArray(lists)) return [];
    var sources = [];
    for (var i = 0; i < lists.length; i++) sources.push({ matches: lists[i] });
    return unionManifests(sources).matches;
  }

  /**
   * itemSig(keys) → 8-char hex
   *
   * A stable, compact signature of a repertoire's POSITION SET, used to detect
   * "the repertoire changed since it was downloaded" without storing the full
   * key list in the manifest. `keys` are the canonical fenPositionKeys of the
   * repertoire's items (computed by the caller — this module stays free of any
   * posKey dependency). Order-independent (keys are sorted first), so re-adding
   * the same positions in a different order does NOT read as a change.
   *
   * FNV-1a/32. Collisions are astronomically unlikely at single-digit-to-
   * hundreds-of-positions scale, and a missed-staleness worst case is merely a
   * not-offered refresh — never data loss. Non-array → signature of empty set.
   */
  function itemSig(keys) {
    var arr = Array.isArray(keys) ? keys.slice() : [];
    arr.sort();
    var str = arr.join('\n');
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      // FNV prime multiply, kept in 32-bit unsigned via the >>> 0 below.
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    var hex = (h >>> 0).toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex;
  }

  var api = {
    OFFLINE_BODY_BATCH: OFFLINE_BODY_BATCH,
    groupByShard: groupByShard,
    unionManifests: unionManifests,
    dedupMatches: dedupMatches,
    itemSig: itemSig,
    // exposed for unit tests
    _isMissingPly: isMissingPly,
    _shouldReplace: shouldReplace
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Offline = api;
  }
})(typeof self !== 'undefined' ? self : this);

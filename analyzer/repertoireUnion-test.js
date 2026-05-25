#!/usr/bin/env node
/**
 * repertoireUnion-test.js — Test the lib/repertoireUnion accumulator.
 *
 * This is the pure matching core of the repertoire-union search (the streaming
 * fetch/batch loop stays in index.html). Coverage:
 *
 *   helpers
 *     - fenSideToMove: w/b extraction, malformed/empty input
 *     - itemColor: orientation precedence over FEN STM, legacy FEN fallback
 *   ingestShard / finalize
 *     - single shard / single triple → match, rating/color/ply preserved
 *     - perspective filter on vs off; legacy missing-color entry passes
 *     - missing-ply entry passes through and is most-permissive in dedup
 *     - min-ply tie-break across two positions of the same source game
 *     - pidToReps accumulates every contributing repertoire
 *     - rawSeen unfiltered-unique count counts filtered-out pids too
 *     - anyHit: false until a real shard is ingested; true even for an
 *       empty-but-present shard; a 404 (no ingestShard call) leaves it false
 *     - dangling key (triple whose key isn't in the shard) contributes nothing
 *   properties (randomized, realistic index invariants: per-pid fixed
 *   rating+color, only ply varies)
 *     - count-equivalence vs an independent reference (matches, rawUnique,
 *       pidToReps) — proves the streaming walk didn't change user-visible totals
 *     - determinism under shuffled ingest order
 *     - min-ply invariant on the kept entry
 *
 * Run: node analyzer/repertoireUnion-test.js
 */

const RepertoireUnion = require('../lib/repertoireUnion');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── helpers: fenSideToMove / itemColor ──────────────────────────────────
section('fenSideToMove');
check("'... w ...' → 'w'", RepertoireUnion.fenSideToMove('rnbq w - - 0 1') === 'w');
check("'... b ...' → 'b'", RepertoireUnion.fenSideToMove('rnbq b - - 0 1') === 'b');
check('no stm field → null', RepertoireUnion.fenSideToMove('rnbq') === null);
check('empty string → null', RepertoireUnion.fenSideToMove('') === null);
check('non-string → null', RepertoireUnion.fenSideToMove(null) === null);

section('itemColor');
check("orientation 'white' → 'w'", RepertoireUnion.itemColor({ orientation: 'white', fen: '8/8 b - -' }) === 'w');
check("orientation 'black' → 'b'", RepertoireUnion.itemColor({ orientation: 'black', fen: '8/8 w - -' }) === 'b');
check('orientation beats FEN STM', RepertoireUnion.itemColor({ orientation: 'black', fen: '8/8 w - -' }) === 'b');
check('no orientation → FEN STM', RepertoireUnion.itemColor({ fen: '8/8 b - -' }) === 'b');
check('null item → null', RepertoireUnion.itemColor(null) === null);

// ─── ingestShard / finalize: hand-crafted cases ──────────────────────────
// triple factory — keeps the cases terse.
function tri(key, shard, repId, orientation, fen) {
  return { key: key, shard: shard, repId: repId, item: { fen: fen || '8/8 w - -', orientation: orientation } };
}

section('single shard / single triple');
{
  var acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  acc.ingestShard({ K1: [['pA', 1500, 'w', 6]] }, [tri('K1', 's0', 'r1')]);
  var out = acc.finalize();
  check('one match', out.matches.length === 1);
  check('entry preserved verbatim', JSON.stringify(out.matches[0]) === JSON.stringify(['pA', 1500, 'w', 6]));
  check('rawUniqueCount 1', out.rawUniqueCount === 1);
  check('pidToReps maps pA → [r1]', JSON.stringify(out.pidToReps['pA']) === JSON.stringify(['r1']));
  check('anyHit true', out.anyHit === true);
}

section('perspective filter');
{
  // Item is black-perspective; shard has one white-to-move and one black puzzle.
  var shard = { K1: [['pW', 1500, 'w', 6], ['pB', 1600, 'b', 6]] };
  var on = RepertoireUnion.createAccumulator({ matchOwnColorOnly: true });
  on.ingestShard(shard, [tri('K1', 's0', 'r1', 'black')]);
  var onOut = on.finalize();
  check('filter on: only black-to-move kept', onOut.matches.length === 1 && onOut.matches[0][0] === 'pB');
  check('filter on: rawUnique still counts both', onOut.rawUniqueCount === 2);

  var off = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  off.ingestShard(shard, [tri('K1', 's0', 'r1', 'black')]);
  check('filter off: both kept', off.finalize().matches.length === 2);
}

section('legacy missing-color entry passes the perspective filter');
{
  var acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: true });
  // [pid, rating] only — no color/ply (oldest shard shape).
  acc.ingestShard({ K1: [['pLegacy', 1400]] }, [tri('K1', 's0', 'r1', 'white')]);
  check('missing color → kept despite color filter', acc.finalize().matches.length === 1);
}

section('missing-ply entry is most-permissive in dedup');
{
  // Same pid reachable from a numeric-ply position and a legacy missing-ply
  // position. The missing-ply entry must win (it passes any ply filter).
  var acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  acc.ingestShard({ Ka: [['pX', 1500, 'w', 30]] }, [tri('Ka', 's0', 'r1')]);
  acc.ingestShard({ Kb: [['pX', 1500, 'w']] },     [tri('Kb', 's1', 'r1')]); // no ply
  var m = acc.finalize().matches;
  check('one deduped match', m.length === 1);
  check('missing-ply entry kept (ply absent)', m[0][3] === undefined);

  // Reverse ingest order — result must be identical (most-permissive wins).
  var acc2 = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  acc2.ingestShard({ Kb: [['pX', 1500, 'w']] },     [tri('Kb', 's1', 'r1')]);
  acc2.ingestShard({ Ka: [['pX', 1500, 'w', 30]] }, [tri('Ka', 's0', 'r1')]);
  check('order-independent: reverse order also keeps missing-ply', acc2.finalize().matches[0][3] === undefined);
}

section('min-ply tie-break across positions');
{
  // Same source game passes through two of the user's positions at ply 6 and
  // ply 14 → keep ply 6.
  var acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  acc.ingestShard({ Klate:  [['pY', 1700, 'b', 14]] }, [tri('Klate',  's0', 'r1')]);
  acc.ingestShard({ Kearly: [['pY', 1700, 'b', 6]] },  [tri('Kearly', 's1', 'r1')]);
  check('keeps min ply (6)', acc.finalize().matches[0][3] === 6);

  var acc2 = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  acc2.ingestShard({ Kearly: [['pY', 1700, 'b', 6]] },  [tri('Kearly', 's1', 'r1')]);
  acc2.ingestShard({ Klate:  [['pY', 1700, 'b', 14]] }, [tri('Klate',  's0', 'r1')]);
  check('min ply regardless of ingest order', acc2.finalize().matches[0][3] === 6);
}

section('pidToReps accumulation across repertoires');
{
  // pZ reachable from r1 (via K1) and r2 (via K2).
  var acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  acc.ingestShard({ K1: [['pZ', 1500, 'w', 8]] }, [tri('K1', 's0', 'r1')]);
  acc.ingestShard({ K2: [['pZ', 1500, 'w', 8]] }, [tri('K2', 's1', 'r2')]);
  var reps = acc.finalize().pidToReps['pZ'].slice().sort();
  check('pZ attributed to both reps', JSON.stringify(reps) === JSON.stringify(['r1', 'r2']));
  check('no duplicate rep id when same rep hits twice', (function () {
    var a = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
    a.ingestShard({ K1: [['pD', 1, 'w', 1]] }, [tri('K1', 's0', 'r1'), tri('K1', 's0', 'r1')]);
    return a.finalize().pidToReps['pD'].length === 1;
  })());
}

section('anyHit / empty / dangling');
{
  var none = RepertoireUnion.createAccumulator({});
  check('no ingest → anyHit false, no matches', none.finalize().anyHit === false && none.finalize().matches.length === 0);

  var empty = RepertoireUnion.createAccumulator({});
  empty.ingestShard({}, [tri('K1', 's0', 'r1')]); // present but no matching key
  var eo = empty.finalize();
  check('empty-but-present shard → anyHit true', eo.anyHit === true);
  check('empty shard → no matches', eo.matches.length === 0);

  var nullShard = RepertoireUnion.createAccumulator({});
  nullShard.ingestShard(null, [tri('K1', 's0', 'r1')]); // simulate caller passing nothing
  check('null idx → anyHit stays false', nullShard.finalize().anyHit === false);

  var dangle = RepertoireUnion.createAccumulator({});
  dangle.ingestShard({ Kother: [['pP', 1, 'w', 1]] }, [tri('Kmissing', 's0', 'r1')]);
  var dOut = dangle.finalize();
  check('dangling key → anyHit true but no match', dOut.anyHit === true && dOut.matches.length === 0);
}

// ─── properties: randomized vs independent reference ─────────────────────
section('randomized properties (2000 trials)');

function rnd(n) { return Math.floor(Math.random() * n); }
function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// Independent reference — set-based, no shared code with the module.
// Mirrors the module's semantics: rawSeen over all raw entries, matches over
// perspective-kept entries, pidToReps over kept, min-ply (missing-permissive).
function reference(triples, byShard, matchOwnColorOnly) {
  var rawSeen = {}, keptPids = {}, pidToReps = {}, anyHit = false;
  var minPly = {}, missingFlag = {};
  for (var i = 0; i < triples.length; i++) {
    var tr = triples[i], idx = byShard[tr.shard];
    if (idx) anyHit = true; // ANY present shard (matches module: ingest only called for present shards)
    if (!idx) continue;
    var raw = idx[tr.key] || [];
    var color = RepertoireUnion.itemColor(tr.item);
    for (var r = 0; r < raw.length; r++) { if (raw[r] && raw[r][0]) rawSeen[raw[r][0]] = true; }
    for (var k = 0; k < raw.length; k++) {
      var m = raw[k];
      if (!m || !m[0]) continue;
      var passes = !(matchOwnColorOnly && color) || m[2] === undefined || m[2] === color;
      if (!passes) continue;
      var pid = m[0];
      keptPids[pid] = true;
      (pidToReps[pid] || (pidToReps[pid] = {}))[tr.repId] = true;
      var ply = m[3];
      if (ply === undefined || ply === null) missingFlag[pid] = true;
      else if (minPly[pid] === undefined || ply < minPly[pid]) minPly[pid] = ply;
    }
  }
  return { rawSeen: rawSeen, keptPids: keptPids, pidToReps: pidToReps, anyHit: anyHit, minPly: minPly, missingFlag: missingFlag };
}

// NOTE on anyHit: the module only flips anyHit when ingestShard is called with
// a real shard. The driver below ingests every PRESENT shard (skips absent
// ones), exactly as index.html skips 404s — so the reference's "any present
// shard" matches the module's anyHit.

function buildUniverse() {
  // Per-pid invariant rating + color (the real index never gives one puzzleId
  // two different ratings or colors — only its ply varies by position).
  var PID_RATING = {}, PID_COLOR = {};
  for (var p = 0; p < 40; p++) { PID_RATING['p' + p] = 1000 + rnd(1500); PID_COLOR['p' + p] = rnd(2) ? 'w' : 'b'; }
  // A dataset is built atomically with ONE uniform entry shape — you never
  // get a mix of [id,rating] and [id,rating,color,ply] for the same puzzle
  // within a single build. Pick the shape per-universe so the test exercises
  // modern (full) AND legacy (no-ply, no-color) datasets, each internally
  // consistent. shapeMode: 0 → [id,rating] (oldest), 1 → [id,rating,color]
  // (no ply), else → [id,rating,color,ply] (current).
  var shapeMode = rnd(5);
  function entry(id) {
    if (shapeMode === 0) return [id, PID_RATING[id]];
    if (shapeMode === 1) return [id, PID_RATING[id], PID_COLOR[id]];
    return [id, PID_RATING[id], PID_COLOR[id], rnd(80)]; // ply varies by position
  }
  var nShards = rnd(20) + 1, byShard = {}, allKeys = [];
  for (var s = 0; s < nShards; s++) {
    var sh = 'sh' + s, idx = {}, nk = rnd(5) + 1;
    for (var kk = 0; kk < nk; kk++) {
      var key = sh + 'k' + kk, ne = rnd(6), arr = [];
      for (var e = 0; e < ne; e++) { arr.push(entry('p' + rnd(40))); }
      idx[key] = arr;
      allKeys.push({ shard: sh, key: key });
    }
    byShard[sh] = idx;
  }
  var triples = [], nt = rnd(50) + 1;
  for (var i = 0; i < nt; i++) {
    var src = (rnd(3) === 0)
      ? { shard: 'sh' + rnd(nShards), key: 'missing' + rnd(5) }   // dangling key
      : allKeys[rnd(allKeys.length)];
    triples.push({
      shard: src.shard, key: src.key, repId: 'r' + rnd(4),
      item: { fen: rnd(2) ? '8/8 w - -' : '8/8 b - -',
              orientation: (rnd(3) === 0 ? 'white' : (rnd(3) === 0 ? 'black' : undefined)) }
    });
  }
  return { byShard: byShard, triples: triples };
}

// Drive the module the way index.html does: group by shard, ingest present
// shards in batches, in a given order.
function runModule(triples, byShard, matchOwnColorOnly, order) {
  var s2t = {};
  for (var i = 0; i < triples.length; i++) { (s2t[triples[i].shard] || (s2t[triples[i].shard] = [])).push(triples[i]); }
  var shardList = order ? order(Object.keys(s2t)) : Object.keys(s2t);
  var acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: matchOwnColorOnly });
  for (var b = 0; b < shardList.length; b += 8) {
    var batch = shardList.slice(b, b + 8);
    for (var r = 0; r < batch.length; r++) {
      var idx = byShard[batch[r]];
      if (idx) acc.ingestShard(idx, s2t[batch[r]]);
    }
  }
  return acc.finalize();
}

function keyCount(o) { return Object.keys(o).length; }

var pPass = 0, pFail = 0, firstFail = null;
for (var trial = 0; trial < 2000; trial++) {
  var u = buildUniverse();
  var mc = rnd(2) === 1;
  var ref = reference(u.triples, u.byShard, mc);
  var out = runModule(u.triples, u.byShard, mc);
  var shuf = runModule(u.triples, u.byShard, mc, shuffle);

  var ok = true, why = '';
  // (1) match count == distinct kept pids
  if (out.matches.length !== keyCount(ref.keptPids)) { ok = false; why = 'matches ' + out.matches.length + ' vs ' + keyCount(ref.keptPids); }
  // (2) rawUniqueCount
  else if (out.rawUniqueCount !== keyCount(ref.rawSeen)) { ok = false; why = 'rawUnique ' + out.rawUniqueCount + ' vs ' + keyCount(ref.rawSeen); }
  // (3) anyHit
  else if (out.anyHit !== ref.anyHit) { ok = false; why = 'anyHit'; }
  // (4) pidToReps set-equal
  else {
    for (var pid in out.pidToReps) {
      var got = out.pidToReps[pid].slice().sort();
      var exp = Object.keys(ref.pidToReps[pid] || {}).sort();
      if (JSON.stringify(got) !== JSON.stringify(exp)) { ok = false; why = 'pidToReps ' + pid; break; }
    }
  }
  // (5) determinism under shuffle
  if (ok) {
    for (var pid2 in out.unioned) { /* unioned not exposed; compare via matches map */ }
    var byPid = {}, byPidShuf = {};
    out.matches.forEach(function (m) { byPid[m[0]] = JSON.stringify(m); });
    shuf.matches.forEach(function (m) { byPidShuf[m[0]] = JSON.stringify(m); });
    if (keyCount(byPid) !== keyCount(byPidShuf)) { ok = false; why = 'shuffle count'; }
    else for (var pid3 in byPid) { if (byPid[pid3] !== byPidShuf[pid3]) { ok = false; why = 'shuffle entry ' + pid3; break; } }
  }
  // (6) min-ply invariant on kept entry
  if (ok) {
    for (var mi = 0; mi < out.matches.length; mi++) {
      var m2 = out.matches[mi], pid4 = m2[0], kp = m2[3];
      if (ref.missingFlag[pid4]) { if (kp !== undefined && kp !== null) { ok = false; why = 'expected missing ply ' + pid4; break; } }
      else { if (kp !== ref.minPly[pid4]) { ok = false; why = 'min ply ' + pid4 + ' got ' + kp + ' want ' + ref.minPly[pid4]; break; } }
    }
  }

  if (ok) pPass++;
  else { pFail++; if (!firstFail) firstFail = why; }
}
check('2000 randomized trials (count-equiv + determinism + min-ply)', pFail === 0, firstFail ? (pFail + ' failed, first: ' + firstFail) : '');

// ─── summary ──────────────────────────────────────────────────────────────
console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

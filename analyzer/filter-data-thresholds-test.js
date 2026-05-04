#!/usr/bin/env node
/**
 * filter-data-thresholds-test.js — Tests for filter-data.js threshold filters.
 *
 * Coverage:
 *   - --rating-floor: drops index entries below floor; drops bodies below floor
 *   - --max-emission-ply: drops entries with ply > cap; bodies kept iff some
 *     entry survives; legacy length-3 entries (no ply) pass through
 *   - --max-puzzle-ply: pre-pass derives puzzle-start ply per puzzle; drops
 *     whole puzzle when start > cap (body + all index entries)
 *   - Filter composition: rating + emission ply + puzzle ply together
 *   - Empty/identity refusal: runFilter throws when no filter is active
 *   - whitelist optional: threshold-only filters work without a whitelist
 *   - collectMaxPlyPerPuzzle: returns max ply per puzzleId; legacy entries
 *     contribute 0 (= "always kept" semantics for max-puzzle-ply)
 *   - Defense-in-depth: body-shard rating floor catches sub-floor bodies
 *     even if they sneak through the index pass
 *
 * Run: node analyzer/filter-data-thresholds-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./filter-data');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-thresh-'));

// ─── filterIndexShard with rating floor ─────────────────────────────────
section('filterIndexShard: --rating-floor');
{
  const shard = {
    'pos-A': [['p1', 800, 'w', 5], ['p2', 1500, 'w', 5], ['p3', 1200, 'b', 5]],
    'pos-B': [['p4', 600, 'w', 8]],   // ALL below floor → position dropped
    'pos-C': [['p5', 2000, 'b', 12]], // ALL above floor → kept whole
  };
  const r = F.filterIndexShard(shard, { ratingFloor: 1000 });
  check('positionsKept = 2 (A keeps survivors, C kept whole, B dropped)',
    r.positionsKept === 2, 'got ' + r.positionsKept);
  check('positionsDropped = 1 (B emptied)', r.positionsDropped === 1);
  check('pos-A has 2 survivors (p2, p3)',
    r.kept['pos-A'] && r.kept['pos-A'].length === 2);
  check('pos-A dropped p1 (800)',
    !r.kept['pos-A'].find(e => e[0] === 'p1'));
  check('pos-A kept p2 (1500)',
    !!r.kept['pos-A'].find(e => e[0] === 'p2'));
  check('pos-B not in kept', !('pos-B' in r.kept));
  check('pos-C unchanged', r.kept['pos-C'].length === 1);
  check('referencedPuzzleIds = {p2, p3, p5}',
    r.referencedPuzzleIds.size === 3 &&
    !r.referencedPuzzleIds.has('p1') &&
    r.referencedPuzzleIds.has('p2') &&
    r.referencedPuzzleIds.has('p3') &&
    r.referencedPuzzleIds.has('p5'));
  check('entriesKept = 3', r.entriesKept === 3);
  check('entriesDropped = 2 (p1 + p4)', r.entriesDropped === 2);
}

// ─── filterIndexShard with max-emission-ply ─────────────────────────────
section('filterIndexShard: --max-emission-ply');
{
  const shard = {
    'pos-A': [['p1', 1500, 'w', 10], ['p2', 1500, 'w', 30]],
    'pos-B': [['p3', 1500, 'b', 50]], // beyond cap → position dropped
    'pos-C': [['p4', 1500, 'w']],     // legacy length-3 — no ply, passes
  };
  const r = F.filterIndexShard(shard, { maxEmissionPly: 24 });
  check('positionsKept = 2', r.positionsKept === 2);
  check('positionsDropped = 1', r.positionsDropped === 1);
  check('pos-A keeps p1 (ply 10)',
    r.kept['pos-A'] && r.kept['pos-A'].find(e => e[0] === 'p1'));
  check('pos-A drops p2 (ply 30)',
    !r.kept['pos-A'].find(e => e[0] === 'p2'));
  check('pos-B fully dropped', !('pos-B' in r.kept));
  check('pos-C kept (legacy length-3, no ply field, passes filter)',
    'pos-C' in r.kept && r.kept['pos-C'].length === 1);
}

// ─── filterIndexShard with droppedPuzzleIds (max-puzzle-ply driver) ─────
section('filterIndexShard: droppedPuzzleIds');
{
  const shard = {
    'pos-A': [['p1', 1500, 'w', 10], ['p2', 1500, 'w', 5]],
    'pos-B': [['p1', 1500, 'b', 80]],  // p1 is dropped → all its entries gone
  };
  const dropped = new Set(['p1']);
  const r = F.filterIndexShard(shard, { droppedPuzzleIds: dropped });
  check('pos-A keeps only p2', r.kept['pos-A'] && r.kept['pos-A'].length === 1);
  check('pos-A p2 survived',
    r.kept['pos-A'] && r.kept['pos-A'][0][0] === 'p2');
  check('pos-B fully dropped (only had p1)', !('pos-B' in r.kept));
  check('referencedPuzzleIds = {p2} only',
    r.referencedPuzzleIds.size === 1 && r.referencedPuzzleIds.has('p2'));
}

// ─── filterIndexShard with multiple criteria composed ───────────────────
section('filterIndexShard: composed filters (whitelist + rating + ply + dropped)');
{
  const shard = {
    'wl-pos': [
      ['p1', 800, 'w', 10],   // dropped by rating
      ['p2', 1500, 'w', 30],  // dropped by emission ply
      ['p3', 1500, 'w', 10],  // dropped by puzzleId
      ['p4', 1500, 'w', 10],  // SURVIVES all filters
    ],
    'non-wl-pos': [['p5', 1500, 'w', 10]], // dropped by whitelist
  };
  const r = F.filterIndexShard(shard, {
    whitelistSet: new Set(['wl-pos']),
    ratingFloor: 1000,
    maxEmissionPly: 24,
    droppedPuzzleIds: new Set(['p3']),
  });
  check('positionsKept = 1', r.positionsKept === 1);
  check('only p4 survives', r.kept['wl-pos'] && r.kept['wl-pos'].length === 1 &&
    r.kept['wl-pos'][0][0] === 'p4');
  check('non-wl-pos dropped', !('non-wl-pos' in r.kept));
  check('entriesDropped counts 3 from wl-pos + 1 from non-wl-pos = 4',
    r.entriesDropped === 4, 'got ' + r.entriesDropped);
}

// ─── filterIndexShard fast-path: no entry-level filters ─────────────────
section('filterIndexShard: fast-path is array-identity');
{
  const shard = {
    'pos-A': [['p1', 1500, 'w', 10], ['p2', 1500, 'w', 20]],
  };
  const inArr = shard['pos-A'];
  const r = F.filterIndexShard(shard, { whitelistSet: new Set(['pos-A']) });
  // Fast path: entries array passed through by reference (no per-entry copy)
  check('fast-path: entries array is same reference (no copy)',
    r.kept['pos-A'] === inArr);
}

// ─── filterBodyShard with rating floor ──────────────────────────────────
section('filterBodyShard: --rating-floor');
{
  const ndjson = [
    JSON.stringify({ id: 'a', rating: 800,  fen: 'x', moves: '' }),
    JSON.stringify({ id: 'b', rating: 1500, fen: 'x', moves: '' }),
    JSON.stringify({ id: 'c', rating: 1200, fen: 'x', moves: '' }),
  ].join('\n');
  const r = F.filterBodyShard(ndjson, {
    keepIds: new Set(['a', 'b', 'c']),
    ratingFloor: 1000,
  });
  check('rating floor: a (800) dropped',
    !r.text.includes('"id":"a"'));
  check('rating floor: b (1500) kept',
    r.text.includes('"id":"b"'));
  check('rating floor: c (1200) kept',
    r.text.includes('"id":"c"'));
  check('bodiesKept = 2', r.bodiesKept === 2);
  check('bodiesDropped = 1', r.bodiesDropped === 1);
}

section('filterBodyShard: backward-compat (Set as 2nd arg)');
{
  const ndjson = JSON.stringify({ id: 'a', rating: 1500 }) + '\n' +
                 JSON.stringify({ id: 'b', rating: 1500 });
  const r = F.filterBodyShard(ndjson, new Set(['a']));
  check('Set arg: a kept', r.text.includes('"id":"a"'));
  check('Set arg: b dropped', !r.text.includes('"id":"b"'));
  check('Set arg: bodiesKept=1', r.bodiesKept === 1);
}

// ─── collectMaxPlyPerPuzzle ─────────────────────────────────────────────
section('collectMaxPlyPerPuzzle: max(m[3]) approximation for length-4 input');
{
  const shard1 = {
    'pos-A': [['p1', 1500, 'w', 5], ['p2', 1500, 'w', 10]],
    'pos-B': [['p1', 1500, 'b', 25]],
  };
  const shard2 = {
    'pos-C': [['p1', 1500, 'w', 60], ['p3', 1500, 'b', 8]],
  };
  const m = new Map();
  F.collectMaxPlyPerPuzzle(shard1, m);
  F.collectMaxPlyPerPuzzle(shard2, m);
  check('p1 max ply = 60 (length-4: max of 5,25,60)',
    m.get('p1') === 60, 'got ' + m.get('p1'));
  check('p2 max ply = 10', m.get('p2') === 10);
  check('p3 max ply = 8', m.get('p3') === 8);
}

section('collectMaxPlyPerPuzzle: legacy length-3 contributes 0');
{
  const shard = {
    'pos-A': [['p1', 1500, 'w'], ['p2', 1500, 'w', 25]],
  };
  const m = new Map();
  F.collectMaxPlyPerPuzzle(shard, m);
  check('p1 (legacy, no ply) recorded as 0',
    m.get('p1') === 0, 'got ' + m.get('p1'));
  check('p2 unaffected', m.get('p2') === 25);
}

section('collectMaxPlyPerPuzzle: prefers canonical m[4] over m[3] when present');
{
  // For length-5 input, m[4] is the canonical startPly (constant per puzzle,
  // dedup-invariant). Reading m[4] directly gives the exact value; max(m[3])
  // would underestimate for transposing source games. The new logic prefers
  // m[4] whenever the entry is length-5, regardless of m[3].
  const shard = {
    'pos-A': [
      ['p1', 1500, 'w', 3, 22],   // length-5: m[3]=3, m[4]=22 → use 22
      ['p2', 1600, 'b', 4, 15],   // length-5: m[3]=4, m[4]=15 → use 15
    ],
    'pos-B': [
      ['p1', 1500, 'w', 5, 22],   // m[3] varies (5 here, 3 above), m[4]=22 stable
    ],
  };
  const m = new Map();
  F.collectMaxPlyPerPuzzle(shard, m);
  check('p1: m[4]=22 used (max via m[4]=22 across both entries; max via m[3]=5 would be wrong)',
    m.get('p1') === 22, 'got ' + m.get('p1'));
  check('p2: m[4]=15 used (NOT m[3]=4)',
    m.get('p2') === 15, 'got ' + m.get('p2'));
}

section('collectMaxPlyPerPuzzle: mixed length-4 + length-5 input');
{
  // Pathological: same puzzle has both length-4 and length-5 entries (e.g.
  // partial backfill). Each entry contributes its best-available value:
  // length-5 entries contribute m[4], length-4 entries contribute m[3].
  // Final per-puzzle max is the max across both.
  const shard = {
    'pos-A': [
      ['p1', 1500, 'w', 5],          // length-4: contributes m[3]=5
      ['p1', 1500, 'b', 3, 22],      // length-5: contributes m[4]=22
    ],
  };
  const m = new Map();
  F.collectMaxPlyPerPuzzle(shard, m);
  check('p1 max = 22 (m[4] wins over m[3])',
    m.get('p1') === 22, 'got ' + m.get('p1'));
}

section('collectMaxPlyPerPuzzle: NaN/non-finite ply does not poison the map');
{
  // Defensive: corrupt input could have NaN in m[3] or m[4]. typeof NaN is
  // 'number', so a naive check would set the map value to NaN; then
  // NaN > anything is always false, so subsequent legitimate plies for the
  // same puzzle would never update the map. Verifying isFinite() guards
  // both readers.
  const shard = {
    'pos-A': [
      ['p1', 1500, 'w', NaN],          // corrupt m[3] → contributes 0
      ['p1', 1500, 'w', 10],           // valid → contributes 10
    ],
    'pos-B': [
      ['p2', 1500, 'w', 5, NaN],       // corrupt m[4] → falls back to m[3]=5
    ],
    'pos-C': [
      ['p3', 1500, 'w', 7, Infinity],  // non-finite m[4] → fallback to m[3]=7
    ],
  };
  const m = new Map();
  F.collectMaxPlyPerPuzzle(shard, m);
  check('p1: NaN entry doesn\'t poison; max = 10',
    m.get('p1') === 10, 'got ' + m.get('p1'));
  check('p2: NaN m[4] falls back to m[3]=5',
    m.get('p2') === 5, 'got ' + m.get('p2'));
  check('p3: Infinity m[4] falls back to m[3]=7',
    m.get('p3') === 7, 'got ' + m.get('p3'));
}

// ─── runFilter: end-to-end on a synthetic data dir ──────────────────────
section('runFilter: end-to-end with rating-floor only');
{
  const src = path.join(tmpRoot, 'src1');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  // Minimal data: one index shard, one body shard
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 800, 'w', 5], ['p2', 1500, 'w', 5]],
    'k2': [['p3', 600, 'b', 10]],   // sub-floor, alone → drop position
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    JSON.stringify({ id: 'p1', rating: 800,  fen: 'x', moves: '' }) + '\n' +
    JSON.stringify({ id: 'p2', rating: 1500, fen: 'x', moves: '' }) + '\n' +
    JSON.stringify({ id: 'p3', rating: 600,  fen: 'x', moves: '' }) + '\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ test: true }));

  const out = path.join(tmpRoot, 'out1');
  const stats = F.runFilter({
    sourceDir: src, outDir: out,
    ratingFloor: 1000,
  });
  check('positionsKept = 1', stats.positionsKept === 1);
  check('positionsDropped = 1', stats.positionsDropped === 1);
  check('entriesKept = 1', stats.entriesKept === 1);
  check('puzzlesReferenced = 1', stats.puzzlesReferenced === 1);
  check('bodiesKept = 1', stats.bodiesKept === 1);

  // Verify on-disk: only k1 with only p2; only p2 body
  const idxOut = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  check('index has only k1', Object.keys(idxOut).length === 1 && 'k1' in idxOut);
  check('k1 has only p2', idxOut['k1'].length === 1 && idxOut['k1'][0][0] === 'p2');
  const bodyText = fs.readFileSync(path.join(out, 'puzzles', '000.ndjson'), 'utf8');
  check('body has only p2', bodyText.includes('"id":"p2"') &&
    !bodyText.includes('"id":"p1"') && !bodyText.includes('"id":"p3"'));

  // meta.filterStats
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  check('meta.filterStats.ratingFloor = 1000',
    meta.filterStats && meta.filterStats.ratingFloor === 1000);
  check('meta.filterStats.maxEmissionPly = null',
    meta.filterStats.maxEmissionPly === null);
}

section('runFilter: end-to-end with max-emission-ply only');
{
  const src = path.join(tmpRoot, 'src2');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'shallow':  [['p1', 1500, 'w', 5]],   // ≤ cap → kept
    'mid':      [['p2', 1500, 'w', 24]],  // == cap → kept
    'deep':     [['p3', 1500, 'w', 50]],  // > cap → dropped
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    JSON.stringify({ id: 'p1', rating: 1500, fen: 'x', moves: '' }) + '\n' +
    JSON.stringify({ id: 'p2', rating: 1500, fen: 'x', moves: '' }) + '\n' +
    JSON.stringify({ id: 'p3', rating: 1500, fen: 'x', moves: '' }) + '\n');
  fs.writeFileSync(path.join(src, 'meta.json'), '{}');

  const out = path.join(tmpRoot, 'out2');
  const stats = F.runFilter({
    sourceDir: src, outDir: out, maxEmissionPly: 24,
  });
  check('positionsKept = 2 (shallow + mid)', stats.positionsKept === 2);
  check('positionsDropped = 1 (deep)', stats.positionsDropped === 1);
  check('puzzlesReferenced = 2', stats.puzzlesReferenced === 2);
  check('bodiesKept = 2', stats.bodiesKept === 2);
  check('p3 body dropped (orphan)', stats.bodiesDropped === 1);
}

section('runFilter: end-to-end with max-puzzle-ply only');
{
  const src = path.join(tmpRoot, 'src3');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  // p1 has entries at plies 5 and 10 → start ply 10 (kept under cap=20)
  // p2 has entries at plies 5 and 30 → start ply 30 (dropped at cap=20)
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'early':  [['p1', 1500, 'w', 5], ['p2', 1500, 'w', 5]],
    'mid':    [['p1', 1500, 'w', 10]],
    'deep':   [['p2', 1500, 'w', 30]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    JSON.stringify({ id: 'p1', rating: 1500, fen: 'x', moves: '' }) + '\n' +
    JSON.stringify({ id: 'p2', rating: 1500, fen: 'x', moves: '' }) + '\n');
  fs.writeFileSync(path.join(src, 'meta.json'), '{}');

  const out = path.join(tmpRoot, 'out3');
  const stats = F.runFilter({
    sourceDir: src, outDir: out, maxPuzzlePly: 20,
  });
  check('puzzlesDroppedByPuzzlePly = 1 (p2)',
    stats.puzzlesDroppedByPuzzlePly === 1);
  check('positionsKept = 2 (early + mid)', stats.positionsKept === 2);
  check('positionsDropped = 1 (deep, only had p2)', stats.positionsDropped === 1);
  check('puzzlesReferenced = 1 (only p1)', stats.puzzlesReferenced === 1);
  check('bodiesKept = 1', stats.bodiesKept === 1);

  const idx = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  check('early: p2 entry stripped, only p1 remains',
    idx['early'].length === 1 && idx['early'][0][0] === 'p1');
  check('mid: p1 still there',
    idx['mid'] && idx['mid'].length === 1);
  check('deep: position fully dropped',
    !('deep' in idx));
}

section('runFilter: composed (rating + emission ply + puzzle ply)');
{
  const src = path.join(tmpRoot, 'src4');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  // p_keep: rating 1500, plies [5,15], start=15 → survives all filters
  // p_lowrating: rating 800, plies [5,15], start=15 → dropped by rating
  // p_deepply: rating 1500, plies [5,40], start=40 → dropped by max-puzzle-ply
  // p_emission: rating 1500, plies [5,15,40], start=40 → dropped by max-puzzle-ply
  //   (also: ply 40 entry dropped by emission-ply)
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'p1-pos': [
      ['p_keep', 1500, 'w', 5],
      ['p_lowrating', 800, 'w', 5],
      ['p_deepply', 1500, 'w', 5],
      ['p_emission', 1500, 'w', 5],
    ],
    'p2-pos': [['p_keep', 1500, 'w', 15], ['p_lowrating', 800, 'w', 15], ['p_emission', 1500, 'w', 15]],
    'p3-pos': [['p_deepply', 1500, 'w', 40], ['p_emission', 1500, 'w', 40]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    JSON.stringify({ id: 'p_keep', rating: 1500 }) + '\n' +
    JSON.stringify({ id: 'p_lowrating', rating: 800 }) + '\n' +
    JSON.stringify({ id: 'p_deepply', rating: 1500 }) + '\n' +
    JSON.stringify({ id: 'p_emission', rating: 1500 }) + '\n');
  fs.writeFileSync(path.join(src, 'meta.json'), '{}');

  const out = path.join(tmpRoot, 'out4');
  const stats = F.runFilter({
    sourceDir: src, outDir: out,
    ratingFloor: 1000,
    maxEmissionPly: 30,
    maxPuzzlePly: 20,
  });
  check('puzzlesDroppedByPuzzlePly = 2 (p_deepply, p_emission)',
    stats.puzzlesDroppedByPuzzlePly === 2);
  check('puzzlesReferenced = 1 (only p_keep)',
    stats.puzzlesReferenced === 1);
  check('bodiesKept = 1', stats.bodiesKept === 1);

  const idx = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  check('p1-pos has only p_keep',
    idx['p1-pos'] && idx['p1-pos'].length === 1 && idx['p1-pos'][0][0] === 'p_keep');
  check('p2-pos has only p_keep',
    idx['p2-pos'] && idx['p2-pos'].length === 1 && idx['p2-pos'][0][0] === 'p_keep');
  check('p3-pos fully dropped', !('p3-pos' in idx));
}

// ─── runFilter: refuses identity copy ───────────────────────────────────
section('runFilter: refuses identity copy (no filter active)');
{
  const src = path.join(tmpRoot, 'src5');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), '{}');
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'), '');
  let threw = false;
  try {
    F.runFilter({ sourceDir: src, outDir: path.join(tmpRoot, 'out5') });
  } catch (e) {
    threw = e.message.includes('no filter');
  }
  check('throws on no-op identity copy', threw);
}

// ─── runFilter: whitelist-only path still works ─────────────────────────
section('runFilter: whitelist-only (legacy path) still works');
{
  const src = path.join(tmpRoot, 'src6');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'kept-pos': [['p1', 1500, 'w', 5]],
    'drop-pos': [['p2', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    JSON.stringify({ id: 'p1', rating: 1500 }) + '\n' +
    JSON.stringify({ id: 'p2', rating: 1500 }) + '\n');
  fs.writeFileSync(path.join(src, 'meta.json'), '{}');

  const stats = F.runFilter({
    sourceDir: src, outDir: path.join(tmpRoot, 'out6'),
    whitelistSet: new Set(['kept-pos']),
  });
  check('positionsKept = 1', stats.positionsKept === 1);
  check('puzzlesReferenced = 1', stats.puzzlesReferenced === 1);
  check('bodiesKept = 1', stats.bodiesKept === 1);
}

// ─── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

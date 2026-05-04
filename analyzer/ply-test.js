#!/usr/bin/env node
/**
 * ply-test.js — Tests for the per-entry `ply` and `startPly` fields on
 * index entries.
 *
 * The build-index emits index entries shaped
 *   [puzzleId, rating, color, ply, startPly]
 * where:
 *   - ply (m[3]):      the source-game ply at which THIS particular
 *                      indexed posKey was reached (1-indexed). Differs
 *                      across entries of the same puzzle (one per
 *                      mainline position). Used by post-build
 *                      `--max-emission-ply` to drop deep-mainline
 *                      emissions without rewalking the PGN.
 *   - startPly (m[4]): the source-game ply at which the puzzle ITSELF
 *                      starts (= verbose.length, the final mainline
 *                      ply where puzzle.fen lives). CONSTANT across
 *                      all entries of a given puzzle. Used by the
 *                      runtime "puzzle start ply" slider.
 *
 * Coverage:
 *   - End-to-end: build a synthetic PGN, verify emitted entries include
 *     both ply and startPly
 *   - Per-position ply (m[3]) differs across positions of one source game
 *   - Puzzle start ply (m[4]) is constant across positions of one source
 *     game and equals the mainline length
 *   - Dedup-keeps-min-ply: when a source game transposes back into a
 *     previously-seen position, the lower (earlier) m[3] is kept; m[4]
 *     is unaffected by dedup (it's a property of the puzzle, not the
 *     emission)
 *   - Backward-compat: filter-data + capPerPosition handle length-3,
 *     length-4, and length-5 entries identically
 *
 * Run: node analyzer/ply-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fenPositionKey, SHARD_HEX_LEN } = require('../lib/posKey');
const crypto = require('crypto');
const { capPerPosition } = require('./build-index');
const { filterIndexShard } = require('./filter-data');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }
function shardId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, SHARD_HEX_LEN);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-test-'));

// Helper: load all index shards into a flat posKey -> entries map.
function loadIndex(outDir) {
  const indexDir = path.join(outDir, 'index');
  const shardFiles = fs.readdirSync(indexDir).filter(f => f.endsWith('.json'));
  const merged = Object.create(null);
  for (const f of shardFiles) {
    const obj = JSON.parse(fs.readFileSync(path.join(indexDir, f), 'utf8'));
    for (const [k, v] of Object.entries(obj)) merged[k] = v;
  }
  return merged;
}

// ─── end-to-end: ply field is emitted ────────────────────────────────────
section('end-to-end: emitted entries include ply + startPly fields');
{
  // One puzzle, mainline = 4 plies (1.e4 e5 2.Nf3 Nc6). The puzzle position
  // is "after 2...Nc6" (ply 4); positions are emitted at plies 1..4. Every
  // entry's startPly should be 4 (the mainline length, regardless of which
  // position the entry indexes).
  const pgn = `[Event "synthetic"]
[Result "*"]
[PuzzleId "PLY1"]
[PuzzleRating "1500"]
[PuzzleThemes "test"]
[Annotator "Bb5"]
[Site "https://lichess.org/00000000#1"]
[Opening ""]

1. e4 e5 2. Nf3 Nc6 *
`;
  const inputDir = path.join(tmpRoot, 'e2e1');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  fs.writeFileSync(inputPgn, pgn);
  const outDir = path.join(inputDir, 'out');
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, inputPgn, outDir], { stdio: 'pipe' });

  const idx = loadIndex(outDir);
  const allEntries = Object.values(idx).flat();
  check('4 positions emitted (one per mainline ply)',
    allEntries.length === 4, 'got ' + allEntries.length);
  check('every entry is length 5',
    allEntries.every(e => e.length === 5),
    'lengths: ' + allEntries.map(e => e.length).join(','));
  check('every entry has puzzleId === "PLY1"',
    allEntries.every(e => e[0] === 'PLY1'));
  check('every entry has rating === 1500',
    allEntries.every(e => e[1] === 1500));
  check('every entry has color (w or b)',
    allEntries.every(e => e[2] === 'w' || e[2] === 'b'));
  check('ply (m[3]) values are integers',
    allEntries.every(e => Number.isInteger(e[3])));
  check('startPly (m[4]) values are integers',
    allEntries.every(e => Number.isInteger(e[4])));

  // m[3] plies should be 1, 2, 3, 4 (one of each)
  const plies = allEntries.map(e => e[3]).sort((a, b) => a - b);
  check('m[3] plies are exactly 1..4', JSON.stringify(plies) === JSON.stringify([1, 2, 3, 4]),
    'got ' + JSON.stringify(plies));

  // m[4] startPly should be 4 for ALL entries — constant across the puzzle.
  check('m[4] startPly is 4 for every entry (mainline length)',
    allEntries.every(e => e[4] === 4),
    'got ' + JSON.stringify(allEntries.map(e => e[4])));
}

// ─── ply correctness: specific position → specific ply ───────────────────
section('end-to-end: position-to-ply mapping is correct');
{
  // Same PGN as above; we'll look up each known position and check its ply.
  const inputDir = path.join(tmpRoot, 'e2e1');
  const outDir = path.join(inputDir, 'out');
  const idx = loadIndex(outDir);

  // Reconstruct the post-1.e4 position
  const { Chess } = require('chess.js');
  const c = new Chess();
  c.move('e4');
  const ply1Key = fenPositionKey(c.fen());
  c.move('e5');
  const ply2Key = fenPositionKey(c.fen());
  c.move('Nf3');
  const ply3Key = fenPositionKey(c.fen());
  c.move('Nc6');
  const ply4Key = fenPositionKey(c.fen());

  check('after 1.e4 → ply 1',
    idx[ply1Key] && idx[ply1Key][0][3] === 1,
    'got ply ' + (idx[ply1Key] && idx[ply1Key][0][3]));
  check('after 1...e5 → ply 2',
    idx[ply2Key] && idx[ply2Key][0][3] === 2,
    'got ply ' + (idx[ply2Key] && idx[ply2Key][0][3]));
  check('after 2.Nf3 → ply 3',
    idx[ply3Key] && idx[ply3Key][0][3] === 3,
    'got ply ' + (idx[ply3Key] && idx[ply3Key][0][3]));
  check('after 2...Nc6 → ply 4 (puzzle starting position)',
    idx[ply4Key] && idx[ply4Key][0][3] === 4,
    'got ply ' + (idx[ply4Key] && idx[ply4Key][0][3]));
}

// ─── dedup-keeps-min-ply: transposition keeps lowest ply ─────────────────
section('end-to-end: transposition within source game keeps lowest ply (m[3] only)');
{
  // Mainline that returns to a previously-seen position: 1.Nf3 Nf6 2.Ng1 Ng8.
  // After ply 4 the board is back to the initial position (which we don't
  // emit — it's the only "ply 0" we skip). But after ply 2 (1.Nf3 Nf6) the
  // position is "knights out". Then 1.Nf3 Nf6 2.Ng1 returns to "after 1...
  // some-move" — actually the post-2.Ng1 position equals the post-Nf6
  // position with white-to-move now, which is different. Let me think...
  //
  // Easier: 1. Nf3 Nf6 2. Nf3-... no wait, can't move to occupied square.
  //
  // Use a 4-knight transposition: 1. Nc3 Nc6 2. Nb1 Nb8 3. Nc3 Nc6.
  // After ply 2 (1.Nc3 Nc6) and after ply 6 (3.Nc3 Nc6) the boards are
  // identical (4 knights out, white to move). We expect the entry for
  // that posKey to have m[3]=2, not m[3]=6.
  //
  // m[4] (startPly) is unaffected by dedup — it's a property of the puzzle,
  // not the emission. mainline length = 6, so every entry should have m[4]=6.
  const pgn = `[Event "synthetic"]
[Result "*"]
[PuzzleId "TRANS1"]
[PuzzleRating "1200"]
[PuzzleThemes "test"]
[Annotator "e4"]
[Site "https://lichess.org/00000000#1"]
[Opening ""]

1. Nc3 Nc6 2. Nb1 Nb8 3. Nc3 Nc6 *
`;
  const inputDir = path.join(tmpRoot, 'transpo');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  fs.writeFileSync(inputPgn, pgn);
  const outDir = path.join(inputDir, 'out');
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, inputPgn, outDir], { stdio: 'pipe' });

  const idx = loadIndex(outDir);

  // Look up the post-1...Nc6 position. It should be present and have ply=2,
  // not ply=6 (its second occurrence in the mainline). startPly=6 either way.
  const { Chess } = require('chess.js');
  const c = new Chess();
  c.move('Nc3'); c.move('Nc6');
  const transKey = fenPositionKey(c.fen());

  check('transposed position is in index',
    Array.isArray(idx[transKey]) && idx[transKey].length > 0);
  check('only one entry (dedup preserved)',
    idx[transKey].length === 1, 'got ' + idx[transKey].length);
  check('entry has m[3]=2 (lowest), not m[3]=6',
    idx[transKey][0][3] === 2, 'got m[3] ' + idx[transKey][0][3]);
  check('entry has m[4]=6 (mainline length, dedup-invariant)',
    idx[transKey][0][4] === 6, 'got m[4] ' + idx[transKey][0][4]);

  // Also: the post-1.Nc3 position appears at ply 1 and ply 5 — should be ply 1.
  const c2 = new Chess(); c2.move('Nc3');
  const trans2 = fenPositionKey(c2.fen());
  check('post-1.Nc3 entry has m[3]=1 (lowest), not m[3]=5',
    idx[trans2] && idx[trans2][0][3] === 1, 'got m[3] ' + (idx[trans2] && idx[trans2][0][3]));
  check('post-1.Nc3 entry has m[4]=6 (same startPly as the rest)',
    idx[trans2] && idx[trans2][0][4] === 6, 'got m[4] ' + (idx[trans2] && idx[trans2][0][4]));

  // Cross-position check: every entry across all shards has m[4]=6.
  const allEntries = Object.values(idx).flat();
  check('every entry across the index has m[4]=6 (constant per puzzle)',
    allEntries.every(e => e[4] === 6),
    'got ' + JSON.stringify(allEntries.map(e => e[4])));
}

// ─── backward-compat: capPerPosition handles length-3 + length-4 + length-5 ─
section('backward-compat: capPerPosition tolerates mixed-length entries');
{
  // capPerPosition only reads entry[1] for sort. Length doesn't matter.
  // Mix legacy length-3 (pre-ply), legacy length-4 (post-ply, pre-startPly),
  // and current length-5 (post-startPly) entries in the same shard.
  const grouped = new Map([
    ['p1', [
      ['legacy3', 100, 'w'],                 // length 3
      ['legacy4', 500, 'b', 5],              // length 4
      ['legacy3b', 300, 'w'],                // length 3
      ['cur5',     900, 'b', 4, 20],         // length 5 (highest rating)
      ['cur5b',    700, 'w', 8, 30],         // length 5
    ]],
  ]);
  const r = capPerPosition(grouped, 3);
  check('drops 2 entries', r.entriesDropped === 2,
    'got ' + r.entriesDropped);
  const arr = grouped.get('p1');
  check('top entry kept (rating 900, length 5, startPly preserved)',
    arr[0][0] === 'cur5' && arr[0].length === 5 && arr[0][4] === 20);
  check('second entry kept (rating 700, length 5, startPly preserved)',
    arr[1][0] === 'cur5b' && arr[1].length === 5 && arr[1][4] === 30);
  check('third entry kept (rating 500, length 4 — legacy shape preserved)',
    arr[2][0] === 'legacy4' && arr[2].length === 4 && arr[2][3] === 5);
  check('length-3 entries dropped (lowest ratings)',
    !arr.some(e => e[0] === 'legacy3' || e[0] === 'legacy3b'));
}

// ─── backward-compat: filterIndexShard preserves all entry shapes ────────
section('backward-compat: filterIndexShard preserves length-3 + length-4 + length-5 shapes');
{
  const shard = {
    'kept-pos': [
      ['p1', 1500, 'w'],                // length 3 — legacy pre-ply
      ['p2', 1800, 'b', 7],             // length 4 — legacy post-ply, pre-startPly
      ['p3', 2100, 'w', 11, 25],        // length 5 — current shape
    ],
    'drop-pos': [['p4', 900, 'w', 3, 10]],
  };
  const whitelist = new Set(['kept-pos']);
  const r = filterIndexShard(shard, whitelist);
  check('kept-pos retained', Array.isArray(r.kept['kept-pos']));
  check('legacy length-3 entry pass-through (no mutation)',
    r.kept['kept-pos'][0].length === 3 && r.kept['kept-pos'][0][0] === 'p1');
  check('legacy length-4 entry pass-through (ply preserved)',
    r.kept['kept-pos'][1].length === 4 && r.kept['kept-pos'][1][3] === 7);
  check('current length-5 entry pass-through (ply + startPly preserved)',
    r.kept['kept-pos'][2].length === 5 &&
    r.kept['kept-pos'][2][3] === 11 &&
    r.kept['kept-pos'][2][4] === 25);
  check('drop-pos dropped', !('drop-pos' in r.kept));
  check('referenced ids = {p1, p2, p3}',
    r.referencedPuzzleIds.size === 3 &&
    r.referencedPuzzleIds.has('p1') &&
    r.referencedPuzzleIds.has('p2') &&
    r.referencedPuzzleIds.has('p3'));
}

// ─── ply field survives capping (sanity) ─────────────────────────────────
section('end-to-end: ply field survives the per-position cap');
{
  // Three puzzles that share a hot position via different source-game plies.
  // Cap=2 should drop the lowest-rated, but the survivors must keep their ply.
  const pgnEntries = [
    { id: 'A', rating: 800,  ply: 1, mainline: '1. e4' },
    { id: 'B', rating: 1500, ply: 1, mainline: '1. e4' },
    { id: 'C', rating: 2000, ply: 1, mainline: '1. e4' },
  ].map(p => `[Event "x"]
[Result "*"]
[PuzzleId "${p.id}"]
[PuzzleRating "${p.rating}"]
[PuzzleThemes "t"]
[Annotator "e5"]
[Site "https://lichess.org/00000000#1"]
[Opening ""]

${p.mainline} *
`).join('\n');

  const inputDir = path.join(tmpRoot, 'capply');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  fs.writeFileSync(inputPgn, pgnEntries);
  const outDir = path.join(inputDir, 'out');
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, inputPgn, outDir, '--max-per-position', '2'],
    { stdio: 'pipe' });

  const idx = loadIndex(outDir);
  const sharedEntries = Object.values(idx).find(arr => arr.length > 1);
  check('shared shard has 2 entries (cap held)',
    sharedEntries && sharedEntries.length === 2);
  check('all surviving entries are length 5 (ply + startPly preserved through cap)',
    sharedEntries && sharedEntries.every(e => e.length === 5),
    sharedEntries && JSON.stringify(sharedEntries.map(e => e.length)));
  check('all surviving entries have ply=1',
    sharedEntries && sharedEntries.every(e => e[3] === 1));
  check('all surviving entries have startPly=1 (single-move mainlines)',
    sharedEntries && sharedEntries.every(e => e[4] === 1),
    sharedEntries && JSON.stringify(sharedEntries.map(e => e[4])));
  // Survivors should be the top-2 by rating: B (1500) + C (2000)
  const ids = sharedEntries.map(e => e[0]).sort();
  check('top-2 by rating kept (B + C)',
    JSON.stringify(ids) === JSON.stringify(['B', 'C']),
    JSON.stringify(ids));
}

// ─── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

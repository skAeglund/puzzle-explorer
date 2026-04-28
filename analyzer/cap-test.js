#!/usr/bin/env node
/**
 * cap-test.js — Tests for the per-position cap added to build-index.js phase 2.
 *
 * Coverage:
 *   - capPerPosition pure helper: 0/disabled, exact-fit, overflow, multi-shard
 *   - rating-desc sort + stable tie-breaks
 *   - end-to-end: synthetic PGN with multiple puzzles sharing the same start
 *     position, run build-index.js with --max-per-position, verify the shard
 *     contains only the top-N puzzles by rating
 *   - meta.json reports entriesDroppedByCap and positionsCapped correctly
 *
 * Run: node analyzer/cap-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { capPerPosition } = require('./build-index');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));

// ─── capPerPosition unit tests ───────────────────────────────────────────
section('capPerPosition — disabled (maxN <= 0)');
{
  const grouped = new Map([['p1', [['a', 100, 'w'], ['b', 200, 'b']]]]);
  const r0 = capPerPosition(grouped, 0);
  check('maxN=0: nothing dropped', r0.entriesDropped === 0 && r0.positionsCapped === 0);
  check('maxN=0: array untouched', grouped.get('p1').length === 2);

  const grouped2 = new Map([['p1', [['a', 100, 'w']]]]);
  const rNeg = capPerPosition(grouped2, -1);
  check('maxN<0: nothing dropped', rNeg.entriesDropped === 0);
}

section('capPerPosition — under and at limit');
{
  const grouped = new Map([
    ['p1', [['a', 100, 'w']]],
    ['p2', [['x', 500, 'b'], ['y', 600, 'w']]],
  ]);
  const r = capPerPosition(grouped, 5);
  check('all-under-limit: nothing dropped',
    r.entriesDropped === 0 && r.positionsCapped === 0);
  check('all-under-limit: arrays untouched',
    grouped.get('p1').length === 1 && grouped.get('p2').length === 2);

  // Exact-fit case
  const grouped2 = new Map([['p1', [['a', 100, 'w'], ['b', 200, 'b']]]]);
  const r2 = capPerPosition(grouped2, 2);
  check('exactly at limit: not capped (no drop, no sort needed)',
    r2.entriesDropped === 0 && r2.positionsCapped === 0);
  // Insertion order preserved (no sort triggered when length === maxN)
  check('exactly at limit: order preserved',
    grouped2.get('p1')[0][0] === 'a' && grouped2.get('p1')[1][0] === 'b');
}

section('capPerPosition — overflow keeps top-N by rating desc');
{
  const grouped = new Map([
    ['p1', [['low', 100, 'w'], ['hi', 500, 'b'], ['mid', 300, 'w']]],
  ]);
  const r = capPerPosition(grouped, 2);
  check('drops 1 entry', r.entriesDropped === 1);
  check('caps 1 position', r.positionsCapped === 1);
  const arr = grouped.get('p1');
  check('keeps highest rating first', arr[0][0] === 'hi' && arr[0][1] === 500);
  check('keeps second-highest', arr[1][0] === 'mid' && arr[1][1] === 300);
  check('drops lowest rating', arr.length === 2);
}

section('capPerPosition — multi-shard accounting');
{
  const grouped = new Map([
    ['hot1', Array.from({ length: 100 }, (_, i) => ['p' + i, i, 'w'])],
    ['hot2', Array.from({ length: 50 }, (_, i) => ['q' + i, i, 'b'])],
    ['cold', [['c1', 1500, 'w']]],
  ]);
  const r = capPerPosition(grouped, 10);
  check('drops 90 from hot1 + 40 from hot2',
    r.entriesDropped === (100 - 10) + (50 - 10), 'got ' + r.entriesDropped);
  check('caps 2 positions (cold under limit)', r.positionsCapped === 2);
  check('cold position untouched', grouped.get('cold').length === 1);
  check('hot1 trimmed to 10', grouped.get('hot1').length === 10);
  check('hot1 top entry is highest-rated (rating 99)',
    grouped.get('hot1')[0][1] === 99);
  check('hot1 last kept entry is rating 90',
    grouped.get('hot1')[9][1] === 90);
}

section('capPerPosition — tie-break stability');
{
  // All entries at same rating — stable sort means insertion order preserved.
  const grouped = new Map([
    ['p1', [['a', 1500, 'w'], ['b', 1500, 'b'], ['c', 1500, 'w'], ['d', 1500, 'b']]],
  ]);
  capPerPosition(grouped, 2);
  // Stable sort + comparator returning 0 for equal ratings: original order kept.
  // So we keep 'a' and 'b' (first two), drop 'c' and 'd'.
  const arr = grouped.get('p1');
  check('stable tie-break: keeps first two by insertion order',
    arr[0][0] === 'a' && arr[1][0] === 'b');
}

// ─── end-to-end via build-index.js subprocess ────────────────────────────
section('end-to-end: build-index.js --max-per-position drops correctly');
{
  // Build a synthetic PGN with 5 puzzles, all sharing the starting position
  // (i.e. same posKey for the very first ply 1.e4). Each has a distinct rating.
  // Mainline = just `1. e4` (1 ply), Annotator = `Nf3` (any legal SAN).
  // After mainline the position is "after 1.e4", which is the shared posKey.
  const ratings = [800, 1200, 2000, 1600, 1000];
  const pgnEntries = ratings.map((r, i) => `[Event "synthetic"]
[Result "*"]
[PuzzleId "P${i}"]
[PuzzleRating "${r}"]
[PuzzleThemes "test"]
[Annotator "e5"]
[Site "https://lichess.org/00000000#1"]
[Opening ""]

1. e4 *
`).join('\n');

  const inputDir = path.join(tmpRoot, 'e2e');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  fs.writeFileSync(inputPgn, pgnEntries);

  const outDir = path.join(inputDir, 'out');
  // Cap at 3, verify only top-3 by rating kept at the shared position.
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, inputPgn, outDir, '--max-per-position', '3'],
    { stdio: 'pipe' });

  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  check('meta: 5 puzzles parsed', meta.puzzlesParsed === 5);
  check('meta: maxPerPosition = 3', meta.maxPerPosition === 3);
  check('meta: entriesDroppedByCap === 2 (5 - 3)',
    meta.entriesDroppedByCap === 2, 'got ' + meta.entriesDroppedByCap);
  check('meta: positionsCapped === 1 (just the shared after-1.e4 posKey)',
    meta.positionsCapped === 1, 'got ' + meta.positionsCapped);

  // Find the shard that holds the after-1.e4 position and confirm it has
  // exactly the top-3 rated puzzles.
  const indexDir = path.join(outDir, 'index');
  const shardFiles = fs.readdirSync(indexDir).filter(f => f.endsWith('.json'));
  let foundCappedPosition = false;
  for (const f of shardFiles) {
    const obj = JSON.parse(fs.readFileSync(path.join(indexDir, f), 'utf8'));
    for (const [posKey, entries] of Object.entries(obj)) {
      if (entries.length > 1) {
        // The shared posKey (after 1.e4)
        foundCappedPosition = true;
        check('shared shard: 3 entries (capped from 5)',
          entries.length === 3, 'got ' + entries.length);
        const keptRatings = entries.map(e => e[1]).sort((a, b) => b - a);
        check('shared shard: ratings are top-3 [2000, 1600, 1200]',
          keptRatings[0] === 2000 && keptRatings[1] === 1600 && keptRatings[2] === 1200,
          JSON.stringify(keptRatings));
        check('shared shard: 800 and 1000 dropped',
          !entries.some(e => e[1] === 800) && !entries.some(e => e[1] === 1000));
      }
    }
  }
  check('found the shared (capped) position somewhere', foundCappedPosition);
}

// ─── end-to-end: cap=0 disables cap (byte-compat with old builds) ────────
section('end-to-end: --max-per-position=0 disables cap');
{
  const ratings = [800, 1200, 2000];
  const pgnEntries = ratings.map((r, i) => `[Event "synthetic"]
[Result "*"]
[PuzzleId "Q${i}"]
[PuzzleRating "${r}"]
[PuzzleThemes "test"]
[Annotator "e5"]
[Site "https://lichess.org/11111111#1"]
[Opening ""]

1. e4 *
`).join('\n');

  const inputDir = path.join(tmpRoot, 'nocap');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  fs.writeFileSync(inputPgn, pgnEntries);

  const outDir = path.join(inputDir, 'out');
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, inputPgn, outDir, '--max-per-position', '0'],
    { stdio: 'pipe' });

  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  check('cap=0: maxPerPosition === null in meta',
    meta.maxPerPosition === null);
  check('cap=0: 0 dropped', meta.entriesDroppedByCap === 0);
  check('cap=0: 0 capped', meta.positionsCapped === 0);

  // All 3 entries should be present at the shared after-1.e4 position.
  const indexDir = path.join(outDir, 'index');
  const shardFiles = fs.readdirSync(indexDir).filter(f => f.endsWith('.json'));
  let maxLen = 0;
  for (const f of shardFiles) {
    const obj = JSON.parse(fs.readFileSync(path.join(indexDir, f), 'utf8'));
    for (const entries of Object.values(obj)) {
      if (entries.length > maxLen) maxLen = entries.length;
    }
  }
  check('cap=0: shared shard has all 3 entries', maxLen === 3, 'got ' + maxLen);
}

// ─── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

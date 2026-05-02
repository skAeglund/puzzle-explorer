#!/usr/bin/env node
/**
 * concat-pgn-test.js — Tests for concat-pgn.js.
 *
 * Coverage:
 *   - Two non-overlapping inputs concat in order
 *   - Duplicate PuzzleId across inputs: first-seen wins
 *   - Duplicate PuzzleId within one input: first occurrence kept
 *   - Game block with no PuzzleId is skipped (counted as noId)
 *   - Trailing block without trailing blank line is flushed
 *   - CRLF line endings tolerated
 *   - Empty input file → 0 games, no errors
 *   - Output is valid PGN that round-trips (build-index can parse it)
 *
 * Run: node analyzer/concat-pgn-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-test-'));
const script = path.join(__dirname, 'concat-pgn.js');

function gameBlock(id, mainline) {
  return `[Event "x"]
[Result "*"]
[PuzzleId "${id}"]
[PuzzleRating "1500"]
[PuzzleThemes "test"]
[Annotator "e5"]
[Site "https://lichess.org/00000000#1"]
[Opening ""]

${mainline} *`;
}

function run(out, ...inputs) {
  const stdout = execFileSync('node', [script, out, ...inputs], { stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(stdout.toString());
}

// ─── basic concat, no overlap ────────────────────────────────────────────
section('basic: two inputs, no overlap');
{
  const dir = path.join(tmpRoot, 'basic');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.pgn');
  const b = path.join(dir, 'b.pgn');
  fs.writeFileSync(a, gameBlock('A1', '1. e4') + '\n\n' + gameBlock('A2', '1. d4') + '\n');
  fs.writeFileSync(b, gameBlock('B1', '1. Nf3') + '\n');
  const out = path.join(dir, 'out.pgn');

  const r = run(out, a, b);
  check('total games seen = 3', r.totalGames === 3, 'got ' + r.totalGames);
  check('total written = 3 (no dups)', r.totalWritten === 3);
  check('duplicates = 0', r.totalDuplicates === 0);
  check('uniquePuzzleIds = 3', r.uniquePuzzleIds === 3);

  const text = fs.readFileSync(out, 'utf8');
  check('contains all 3 PuzzleIds',
    text.includes('"A1"') && text.includes('"A2"') && text.includes('"B1"'));
}

// ─── dedup across inputs: first-seen wins ────────────────────────────────
section('dedup: cross-input duplicate, first-seen wins');
{
  const dir = path.join(tmpRoot, 'cross-dup');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'han.pgn');
  const b = path.join(dir, 'deltas.pgn');
  // a has X1 with mainline 1.e4 (the "Han" version)
  // b has X1 with mainline 1.d4 (the "deltas" version) — should be dropped
  fs.writeFileSync(a, gameBlock('X1', '1. e4 HAN') + '\n');
  fs.writeFileSync(b, gameBlock('X1', '1. d4 DELTAS') + '\n\n' + gameBlock('B2', '1. c4') + '\n');
  const out = path.join(dir, 'out.pgn');

  const r = run(out, a, b);
  check('written = 2 (X1 from Han + B2 from deltas)', r.totalWritten === 2);
  check('duplicates = 1', r.totalDuplicates === 1);

  const text = fs.readFileSync(out, 'utf8');
  check('Han version of X1 is in output', text.includes('1. e4 HAN'));
  check('deltas version of X1 is NOT in output', !text.includes('1. d4 DELTAS'));
  check('B2 is in output', text.includes('1. c4'));
}

// ─── dedup within one input ──────────────────────────────────────────────
section('dedup: within-input duplicate, first occurrence kept');
{
  const dir = path.join(tmpRoot, 'self-dup');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.pgn');
  fs.writeFileSync(a,
    gameBlock('S1', '1. e4 FIRST') + '\n\n' +
    gameBlock('S1', '1. d4 SECOND') + '\n\n' +
    gameBlock('S2', '1. Nf3') + '\n');
  const out = path.join(dir, 'out.pgn');

  const r = run(out, a);
  check('games seen = 3', r.totalGames === 3);
  check('written = 2', r.totalWritten === 2);
  check('duplicates = 1', r.totalDuplicates === 1);

  const text = fs.readFileSync(out, 'utf8');
  check('first occurrence kept', text.includes('1. e4 FIRST'));
  check('second occurrence dropped', !text.includes('1. d4 SECOND'));
}

// ─── no-PuzzleId games skipped ───────────────────────────────────────────
section('skip: games with no PuzzleId');
{
  const dir = path.join(tmpRoot, 'no-id');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.pgn');
  // Mix one valid game with one no-id game
  fs.writeFileSync(a,
    gameBlock('N1', '1. e4') + '\n\n' +
    `[Event "no-id"]
[Result "*"]

1. d4 *` + '\n');
  const out = path.join(dir, 'out.pgn');

  const r = run(out, a);
  check('games seen = 2', r.totalGames === 2);
  check('written = 1', r.totalWritten === 1);
  check('noId = 1', r.totalNoId === 1);
}

// ─── trailing block without trailing newline ─────────────────────────────
section('boundary: trailing block flushed without trailing blank line');
{
  const dir = path.join(tmpRoot, 'trailing');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.pgn');
  // No trailing newline at all
  fs.writeFileSync(a, gameBlock('T1', '1. e4'));  // no \n at end
  const out = path.join(dir, 'out.pgn');

  const r = run(out, a);
  check('trailing block written', r.totalWritten === 1, 'got ' + r.totalWritten);
}

// ─── CRLF line endings ───────────────────────────────────────────────────
section('boundary: CRLF line endings tolerated');
{
  const dir = path.join(tmpRoot, 'crlf');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.pgn');
  // Write with explicit CRLF
  const block = gameBlock('CR1', '1. e4').replace(/\n/g, '\r\n');
  fs.writeFileSync(a, block + '\r\n\r\n');
  const out = path.join(dir, 'out.pgn');

  const r = run(out, a);
  check('CRLF input parsed', r.totalWritten === 1, 'got ' + r.totalWritten);
}

// ─── empty input ─────────────────────────────────────────────────────────
section('boundary: empty input');
{
  const dir = path.join(tmpRoot, 'empty');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.pgn');
  fs.writeFileSync(a, '');
  const out = path.join(dir, 'out.pgn');

  const r = run(out, a);
  check('empty file → 0 games', r.totalGames === 0);
  check('empty file → 0 written', r.totalWritten === 0);
  check('output file exists (empty)', fs.existsSync(out));
}

// ─── round-trip: output is parseable by build-index ──────────────────────
section('round-trip: combined output runs through build-index cleanly');
{
  const dir = path.join(tmpRoot, 'rt');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a.pgn');
  const b = path.join(dir, 'b.pgn');
  // Use single-ply mainlines so the puzzle starting position has black to
  // move, matching the "e5" Annotator solution used in gameBlock().
  fs.writeFileSync(a, gameBlock('R1', '1. e4') + '\n');
  fs.writeFileSync(b, gameBlock('R2', '1. d4') + '\n');
  const combined = path.join(dir, 'combined.pgn');

  run(combined, a, b);

  const outDir = path.join(dir, 'out');
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, combined, outDir], { stdio: 'pipe' });

  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  check('build-index parsed both puzzles', meta.puzzlesParsed === 2,
    'got ' + meta.puzzlesParsed);
}

// ─── input order matters for dedup ───────────────────────────────────────
section('order: argv order determines first-seen winner');
{
  const dir = path.join(tmpRoot, 'order');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'first.pgn');
  const b = path.join(dir, 'second.pgn');
  fs.writeFileSync(a, gameBlock('O1', '1. e4 FROM_FIRST') + '\n');
  fs.writeFileSync(b, gameBlock('O1', '1. d4 FROM_SECOND') + '\n');

  // Run a-then-b: a wins
  const out1 = path.join(dir, 'out1.pgn');
  run(out1, a, b);
  check('a-first: a wins', fs.readFileSync(out1, 'utf8').includes('FROM_FIRST'));

  // Run b-then-a: b wins
  const out2 = path.join(dir, 'out2.pgn');
  run(out2, b, a);
  check('b-first: b wins', fs.readFileSync(out2, 'utf8').includes('FROM_SECOND'));
}

// ─── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

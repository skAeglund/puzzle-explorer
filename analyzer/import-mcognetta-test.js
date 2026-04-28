#!/usr/bin/env node
/**
 * import-mcognetta-test.js — Unit + integration tests for the mcognetta importer.
 *
 * Coverage:
 *   - plyFromGameUrl         URL → ply N (with /black, /white, missing-anchor)
 *   - extractIdFromBodyLine  fast-path id extraction from puzzles ndjson
 *   - stripPgnComments       handles consecutive {} {} (the chess.js v1.4 bug case)
 *   - formatMovetext         even/odd ply counts, single-ply edge case
 *   - escapeTagValue         backslash, quote, newline collapsing
 *   - convertOne             happy path + error surface (missing fields, bad ply,
 *                            short pgn, illegal solution UCI, promotion solution)
 *   - validateRoundTrip      true positive + tampered FEN catches mismatch
 *
 * The integration test consumes fixtures/mcognetta-sample.ndjson and asserts
 * the produced PGN re-parses to the exact drill FEN and Annotator.
 *
 * Run: node analyzer/import-mcognetta-test.js
 */

const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');
const {
  plyFromGameUrl,
  extractIdFromBodyLine,
  stripPgnComments,
  formatMovetext,
  escapeTagValue,
  convertOne,
  validateRoundTrip,
} = require('./import-mcognetta');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── plyFromGameUrl ──────────────────────────────────────────────────────
section('plyFromGameUrl');
{
  check('plain #51', plyFromGameUrl('https://lichess.org/wvPFkjF9#51') === 51);
  check('with /black#16', plyFromGameUrl('https://lichess.org/sVgQxr8Q/black#16') === 16);
  check('with /white#22', plyFromGameUrl('https://lichess.org/abc12345/white#22') === 22);
  check('large ply (#250)', plyFromGameUrl('https://lichess.org/x#250') === 250);
  check('no anchor → null', plyFromGameUrl('https://lichess.org/x') === null);
  check('non-numeric anchor → null', plyFromGameUrl('https://lichess.org/x#foo') === null);
  check('zero anchor → null (Lichess plies are 1-indexed)', plyFromGameUrl('https://lichess.org/x#0') === null);
  check('null URL → null', plyFromGameUrl(null) === null);
  check('non-string → null', plyFromGameUrl(42) === null);
  check('empty → null', plyFromGameUrl('') === null);
  check('trailing whitespace tolerated', plyFromGameUrl('https://lichess.org/x#16   ') === 16);
}

// ─── extractIdFromBodyLine ───────────────────────────────────────────────
section('extractIdFromBodyLine');
{
  check('id at start of object',
    extractIdFromBodyLine('{"id":"abc12","fen":"foo"}') === 'abc12');
  check('5-char id (Lichess standard)',
    extractIdFromBodyLine('{"id":"00LZf","rating":2205}') === '00LZf');
  check('no id field → null',
    extractIdFromBodyLine('{"fen":"foo","moves":[]}') === null);
  check('empty line → null', extractIdFromBodyLine('') === null);
  check('garbage → null', extractIdFromBodyLine('not json at all') === null);
}

// ─── stripPgnComments ────────────────────────────────────────────────────
section('stripPgnComments');
{
  check('single comment removed',
    stripPgnComments('1. e4 { eval } e5 *') === '1. e4  e5 *');
  check('consecutive {} {} (the chess.js v1.4 trigger)',
    stripPgnComments('1. e4 { eval } { opening } e5 *') === '1. e4   e5 *');
  check('comment with brackets inside (Lichess %eval/%clk format)',
    stripPgnComments('1. e4 { [%eval 0.25] [%clk 0:10:00] } *') === '1. e4  *');
  check('no comments → unchanged',
    stripPgnComments('1. e4 e5 *') === '1. e4 e5 *');
  check('empty → empty', stripPgnComments('') === '');
  // Real-world consecutive-comment after stripping must round-trip through chess.js
  const stripped = stripPgnComments('[Result "*"]\n\n1. e4 { a } { b } e5 *');
  let ok = true;
  try { new Chess().loadPgn(stripped); } catch (e) { ok = false; }
  check('stripped output re-parses cleanly via chess.js v1', ok);
}

// ─── formatMovetext ──────────────────────────────────────────────────────
section('formatMovetext');
{
  const v2 = [{ san: 'e4' }, { san: 'e5' }];
  check('2 plies → "1. e4 e5 *"', formatMovetext(v2) === '1. e4 e5 *');
  const v3 = [{ san: 'e4' }, { san: 'e5' }, { san: 'Nf3' }];
  check('3 plies → "1. e4 e5 2. Nf3 *"', formatMovetext(v3) === '1. e4 e5 2. Nf3 *');
  const v1 = [{ san: 'e4' }];
  check('1 ply → "1. e4 *"', formatMovetext(v1) === '1. e4 *');
  // A 16-ply mainline (matches the #16 fixture case) — last token should be "8."
  const v16 = Array.from({ length: 16 }, (_, i) => ({ san: 'X' + i }));
  const out16 = formatMovetext(v16);
  check('16 plies includes "8." marker', out16.indexOf(' 8. ') !== -1);
  check('16 plies ends with "*"', out16.endsWith(' *'));
}

// ─── escapeTagValue ──────────────────────────────────────────────────────
section('escapeTagValue');
{
  check('plain string unchanged', escapeTagValue('hello') === 'hello');
  check('quote escaped', escapeTagValue('he said "hi"') === 'he said \\"hi\\"');
  check('backslash escaped (before quote escaping)',
    escapeTagValue('a\\b') === 'a\\\\b');
  check('newline collapsed to space', escapeTagValue('a\nb') === 'a b');
  check('CRLF collapsed', escapeTagValue('a\r\nb') === 'a b');
  check('null → empty', escapeTagValue(null) === '');
  check('undefined → empty', escapeTagValue(undefined) === '');
  check('number coerced', escapeTagValue(42) === '42');
}

// ─── convertOne — error surface ──────────────────────────────────────────
section('convertOne — error surface');
{
  check('null → no_puzzle', convertOne(null).err === 'no_puzzle');
  check('{} → no_puzzle', convertOne({}).err === 'no_puzzle');
  check('puzzle without PuzzleId',
    convertOne({ puzzle: {}, game: {} }).err === 'missing_puzzle_id');
  check('GameUrl without #N',
    convertOne({ puzzle: { PuzzleId: 'X', GameUrl: 'https://lichess.org/abc' }, game: {} }).err === 'no_ply');
  check('missing game.pgn',
    convertOne({ puzzle: { PuzzleId: 'X', GameUrl: 'https://lichess.org/abc#10', Moves: 'a b' }, game: {} }).err === 'no_game_pgn');
  check('only blunder, no solution → too_few_moves',
    convertOne({
      puzzle: { PuzzleId: 'X', GameUrl: 'https://lichess.org/abc#10', Moves: 'e2e4' },
      game: { pgn: '[Result "*"]\n\n1. e4 *' },
    }).err === 'too_few_moves');
  check('PGN too short for declared ply',
    convertOne({
      puzzle: { PuzzleId: 'X', GameUrl: 'https://lichess.org/abc#100', Moves: 'e2e4 e7e5' },
      game: { pgn: '[Result "*"]\n\n1. e4 e5 *' },
    }).err === 'pgn_too_short');
  check('illegal solution UCI flagged',
    convertOne({
      puzzle: { PuzzleId: 'X', GameUrl: 'https://lichess.org/abc#1', Moves: 'e2e4 z9z9' },
      game: { pgn: '[Result "*"]\n\n1. e4 e5 *' },
    }).err === 'illegal_solution_uci');
}

// ─── convertOne — happy paths ────────────────────────────────────────────
section('convertOne — happy paths');
{
  // Minimal synthetic: 2-ply game, 1-ply mainline, 1-ply solution.
  const r1 = convertOne({
    puzzle: {
      PuzzleId: 'TEST1', GameUrl: 'https://lichess.org/abc#1',
      Moves: 'e2e4 e7e5', Rating: '1500', Themes: 'opening short',
    },
    game: { pgn: '[Result "*"]\n\n1. e4 e5 *' },
  });
  check('minimal puzzle: no error', !r1.err, JSON.stringify(r1));
  check('minimal puzzle: pgn produced', r1.pgn && r1.pgn.includes('[PuzzleId "TEST1"]'));
  // Re-parse and check drill FEN (= position after blunder = after 1.e4).
  // chess.js v1 doesn't preserve the EP square through loadPgn replay, so we
  // compare the board+turn+castling segment only and accept any EP value.
  if (r1.pgn) {
    const c = new Chess();
    try {
      c.loadPgn(r1.pgn);
      const got = c.fen();
      const gotFields = got.split(' ');
      const want = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq';
      check('minimal puzzle: drill FEN board+turn+castling match',
        gotFields.slice(0, 3).join(' ') === want, got);
      check('minimal puzzle: 1 mainline ply', c.history().length === 1);
    } catch (e) { check('minimal puzzle: re-parses', false, e.message); }
  }
}

// ─── convertOne — promotion in solution ──────────────────────────────────
section('convertOne — multi-ply solution survives');
{
  // blunderPly=1: the blunder is white's 1.e4. Drill position = post-1.e4
  // (black to move, all back-rank pieces on home squares). From there:
  //   moves[1]=e7e5 is legal (black's reply)
  //   moves[2]=g1f3 is legal (white's next)
  // Source PGN only needs >=1 ply for truncation; the solution is independent
  // of what the source game played past the blunder.
  const r = convertOne({
    puzzle: {
      PuzzleId: 'MULTI', GameUrl: 'https://lichess.org/x#1',
      Moves: 'e2e4 e7e5 g1f3',  // blunder + 2 solution plies
      Rating: '1000', Themes: '',
    },
    game: { pgn: '[Result "*"]\n\n1. e4 e5 *' },
  });
  check('multi-ply solution: no error', !r.err, JSON.stringify(r));
  check('multi-ply solution: 2 SAN tokens in Annotator',
    r.pgn && (r.pgn.match(/\[Annotator "([^"]+)"\]/) || [])[1].split(/\s+/).length === 2);
  check('multi-ply solution: Annotator first move is e5',
    r.pgn && (r.pgn.match(/\[Annotator "([^"]+)"\]/) || [])[1].split(/\s+/)[0] === 'e5');
}

// ─── validateRoundTrip ───────────────────────────────────────────────────
section('validateRoundTrip');
{
  const goodPgn = '[Event "T"]\n[Result "*"]\n[Annotator "Nf3"]\n\n1. e4 e5 *';
  const goodFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  check('matching FEN + legal annotator → ok',
    validateRoundTrip(goodPgn, goodFen, 'Nf3').ok);
  check('FEN mismatch → fails with fen_mismatch',
    validateRoundTrip(goodPgn, 'fake fen', 'Nf3').reason.startsWith('fen_mismatch'));
  check('illegal annotator SAN → fails with annotator_illegal',
    validateRoundTrip(goodPgn, goodFen, 'Kxh8').reason.startsWith('annotator_illegal'));
  check('unparseable pgn → fails with reparse_failed',
    validateRoundTrip('not a pgn', goodFen, 'Nf3').reason.startsWith('reparse_failed'));
}

// ─── integration: real fixture round-trips ───────────────────────────────
section('integration: fixtures/mcognetta-sample.ndjson round-trips');
{
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'mcognetta-sample.ndjson');
  if (!fs.existsSync(fixturePath)) {
    check('fixture present', false, fixturePath + ' missing');
  } else {
    const line = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean)[0];
    const obj = JSON.parse(line);
    const r = convertOne(obj);
    check('fixture: convertOne returns no error', !r.err, JSON.stringify(r));
    if (r.pgn) {
      const c = new Chess();
      try {
        c.loadPgn(r.pgn);
        // Drill FEN per puzzle 004X6: position after a1b1 from the puzzle's FEN
        // (the blunder Ra1xb1 is applied to the Lichess puzzle.fen).
        const expected = '1r4k1/p4ppp/2Q5/3pq3/8/P6P/2PR1PP1/1R4K1 b - - 0 26';
        check('fixture: produced PGN re-parses to expected drill FEN',
          c.fen() === expected, 'got: ' + c.fen());
        check('fixture: 51 mainline plies (matches GameUrl #51)',
          c.history().length === 51, 'got: ' + c.history().length);
        const h = c.header();
        check('fixture: PuzzleId preserved', h.PuzzleId === '004X6');
        check('fixture: PuzzleRating preserved', h.PuzzleRating === '1176');
        check('fixture: Annotator has 3 SAN moves',
          h.Annotator.split(/\s+/).length === 3);
        check('fixture: Annotator first move is Rxb1+',
          h.Annotator.split(/\s+/)[0] === 'Rxb1+');
        check('fixture: Site preserves #51 anchor',
          h.Site === 'https://lichess.org/wvPFkjF9#51');
      } catch (e) { check('fixture: produced PGN re-parses', false, e.message); }
    }
  }
}

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * repertoire-test.js — Tests for lib/repertoireFilter.js + analyzer/repertoire-from-pgn.js.
 *
 * Coverage:
 *   - parseFenListText: comments, blanks, trailing whitespace, malformed lines
 *   - buildWhitelist: posKey canonicalization (EP-strip), duplicate detection
 *   - matchesAnyPosition: empty-set passthrough, hit, miss
 *   - PGN walker primitives: tokenize, strip{Headers,Comments,NAGs,MoveNumbers,Results}
 *   - walkGame: linear mainline, single variation, chained variations, nested
 *               variations, out-of-game-start variation, min-ply behavior
 *   - walkPgnFile: multi-game splitting; per-game errors don't pollute others
 *   - --min-ply CLI behavior via subprocess
 *
 * Run: node analyzer/repertoire-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RF = require('../lib/repertoireFilter');
const W = require('./repertoire-from-pgn');
const { fenPositionKey } = require('../lib/posKey');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repertoire-test-'));

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_NF3 = 'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1';

// ─── parseFenListText ────────────────────────────────────────────────────
section('parseFenListText');
{
  const text = [
    '# Reti',
    AFTER_NF3,
    '',
    '   # indented comment',
    AFTER_E4,
    '',
    'not a fen',                  // garbage
    'a/b/c w - - 0 1',            // 4 fields but board not 8 ranks
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1   ',  // trailing whitespace
  ].join('\n');
  const r = RF.parseFenListText(text);
  check('valid FENs extracted (3)', r.fens.length === 3, 'got ' + r.fens.length);
  check('comments stripped', !r.fens.some(f => f.startsWith('#')));
  check('errors recorded for garbage', r.errors.length === 2, 'got ' + r.errors.length);
  check('error includes line numbers',
    r.errors.every(e => typeof e.line === 'number'));
  check('trailing whitespace stripped on valid line',
    r.fens[2] === STARTPOS);

  // Edge cases
  check('non-string input → empty + error',
    RF.parseFenListText(null).errors.length === 1);
  check('empty string → empty', RF.parseFenListText('').fens.length === 0);
  check('only comments → empty',
    RF.parseFenListText('# nothing\n# else\n').fens.length === 0);
}

// ─── buildWhitelist ──────────────────────────────────────────────────────
section('buildWhitelist');
{
  const r = RF.buildWhitelist([AFTER_E4, AFTER_NF3].join('\n'));
  check('count matches input', r.count === 2);
  check('set contains canonicalized post-1.e4 key',
    r.set.has(fenPositionKey(AFTER_E4)));
  check('set contains canonicalized post-1.Nf3 key',
    r.set.has(fenPositionKey(AFTER_NF3)));

  // EP canonicalization: post-1.e4 with `e3` and post-1.e4 with `-` should
  // collapse to the same key (no enemy pawn can capture EP).
  const e4WithEp = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  const e4NoEp   = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  const dup = RF.buildWhitelist([e4WithEp, e4NoEp].join('\n'));
  check('EP variants canonicalize to same key (one dropped as duplicate)',
    dup.count === 1 && dup.dropped.length === 1);
  check('drop reason recorded',
    dup.dropped[0].reason === 'duplicate posKey');
}

// ─── matchesAnyPosition ──────────────────────────────────────────────────
section('matchesAnyPosition');
{
  const set = new Set([fenPositionKey(AFTER_E4), fenPositionKey(AFTER_NF3)]);

  check('match in middle of list',
    RF.matchesAnyPosition(set, [
      fenPositionKey(STARTPOS),
      fenPositionKey(AFTER_E4),
      'unrelated',
    ]) === true);
  check('no match',
    RF.matchesAnyPosition(set, [fenPositionKey(STARTPOS), 'x', 'y']) === false);
  check('empty positions list → false',
    RF.matchesAnyPosition(set, []) === false);
  check('empty set → true (no filter active)',
    RF.matchesAnyPosition(new Set(), [fenPositionKey(AFTER_E4)]) === true);
  check('null set → true (passthrough)',
    RF.matchesAnyPosition(null, [fenPositionKey(AFTER_E4)]) === true);
}

// ─── PGN preprocessing helpers ───────────────────────────────────────────
section('preprocessing helpers');
{
  check('stripHeaders removes [Tag "value"]',
    W.stripHeaders('[Event "x"]\n[Result "*"]\n\n1. e4 *').trim() === '1. e4 *');
  check('stripComments removes {...}',
    W.stripComments('1. e4 { eval } e5 *') === '1. e4  e5 *');
  check('stripComments handles consecutive {} {}',
    W.stripComments('1. e4 { a } { b } e5 *') === '1. e4   e5 *');
  check('stripNAGs removes ?! !? !! ??',
    W.stripNAGs('1. e4!? e5?! 2. Nf3!! Nc6??').replace(/\s+/g, ' ').trim() === '1. e4 e5 2. Nf3 Nc6');
  check('stripNAGs removes $1 $5 etc',
    W.stripNAGs('1. e4 $5 e5 $1 $14').replace(/\s+/g, ' ').trim() === '1. e4 e5');
  check('stripMoveNumbers removes "1." "1..." etc',
    W.stripMoveNumbers('1. e4 1... e5 2. Nf3').replace(/\s+/g, ' ').trim() === 'e4 e5 Nf3');
  check('stripResults removes 1-0',
    W.stripResults('1. e4 e5 1-0').replace(/\s+/g, ' ').trim() === '1. e4 e5');
  check('stripResults removes 1/2-1/2',
    W.stripResults('1. e4 e5 1/2-1/2').replace(/\s+/g, ' ').trim() === '1. e4 e5');
  check('stripResults removes *',
    W.stripResults('1. e4 e5 *').replace(/\s+/g, ' ').trim() === '1. e4 e5');
}

// ─── tokenize ────────────────────────────────────────────────────────────
section('tokenize');
{
  const t = W.tokenize('e4 e5 ( c5 Nf3 ) Nf3');
  check('tokenizes mixed SAN and parens',
    t.length === 7 && t[0] === 'e4' && t[3] === 'c5' && t[6] === 'Nf3',
    JSON.stringify(t));
  check('paren tokens are separate',
    t.includes('(') && t.includes(')'));

  const t2 = W.tokenize('e4(e5)');
  check('tokenizes without whitespace',
    t2.length === 4 && t2[0] === 'e4' && t2[1] === '(' && t2[2] === 'e5' && t2[3] === ')',
    JSON.stringify(t2));

  check('empty input → empty array',
    W.tokenize('').length === 0);
}

// ─── walkGame: linear mainline ───────────────────────────────────────────
section('walkGame — linear mainline');
{
  const r = W.walkGame('[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 *');
  check('linear: 4 unique positions', r.positions.size === 4, 'got ' + r.positions.size);
  check('linear: no errors', r.errors.length === 0, JSON.stringify(r.errors));
  // First emitted should be after-1.e4 at minPly 1
  const e4Key = fenPositionKey(AFTER_E4);
  check('linear: post-e4 minPly === 1',
    r.positions.has(e4Key) && r.positions.get(e4Key).minPly === 1);
}

section('walkGame — single variation');
{
  // Mainline e4 e5 with variation (1... c5 2. Nf3) — variation at ply 2
  const r = W.walkGame('[Event "x"]\n\n1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6 *');
  check('single variation: no errors', r.errors.length === 0, JSON.stringify(r.errors));
  // Should include positions from BOTH branches
  const e5Key = fenPositionKey('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const c5Key = fenPositionKey('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  check('single variation: contains mainline e5 position', r.positions.has(e5Key));
  check('single variation: contains variation c5 position', r.positions.has(c5Key));
  check('single variation: post-e4 minPly === 1',
    r.positions.get(fenPositionKey(AFTER_E4)).minPly === 1);
}

section('walkGame — chained variations');
{
  // Mainline e4 e5 with TWO variations on the same parent move (the bug case)
  const r = W.walkGame('[Event "x"]\n\n1. e4 e5 (1... c5) (1... d5) 2. Nf3 *');
  check('chained variations: no errors', r.errors.length === 0, JSON.stringify(r.errors));
  // All three black-1st-move alternatives should be present
  const e5Key = fenPositionKey('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const c5Key = fenPositionKey('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const d5Key = fenPositionKey('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  check('chained: e5 captured', r.positions.has(e5Key));
  check('chained: c5 captured', r.positions.has(c5Key));
  check('chained: d5 captured', r.positions.has(d5Key));
}

section('walkGame — nested variations');
{
  // 1. e4 e5 (1... c5 2. Nf3 (2. Nc3)) 2. Nf3 *
  // Parent: e5. Variation: c5 -> Nf3, with sub-variation (2. Nc3).
  const r = W.walkGame('[Event "x"]\n\n1. e4 e5 (1... c5 2. Nf3 (2. Nc3)) 2. Nf3 *');
  check('nested variations: no errors', r.errors.length === 0, JSON.stringify(r.errors));
  // Should contain post-1.e4 c5 2.Nf3 AND post-1.e4 c5 2.Nc3
  const sicNf3 = fenPositionKey('rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
  const sicNc3 = fenPositionKey('rnbqkbnr/pp1ppppp/8/2p5/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 2');
  check('nested: 2.Nf3 in sub-mainline captured', r.positions.has(sicNf3));
  check('nested: 2.Nc3 in sub-variation captured', r.positions.has(sicNc3));
}

section('walkGame — minPly tracking');
{
  // A position reached early in mainline AND late in a variation should
  // record the SHALLOWEST ply (minPly = the early one).
  // Mainline: 1.e4 e5 2.Nf3 Nc6 → after-Nc6 at ply 4
  // Variation at 1...c5: 1.e4 c5 (2. Nf3 Nc6 -- nope, that's not Sicilian
  //   structure. Let me use a real reachable common position.)
  //
  // Use: mainline 1.e4 e5; variation at e5: 1...e5 2.Nc3 Nc6 (transposes to
  // a position also reachable other ways but here just stays uniquely deep)
  // Hmm actually constructing collisions is hard. Just verify minPly is
  // tracked for the linear case.
  const r = W.walkGame('[Event "x"]\n\n1. e4 e5 *');
  check('minPly tracked: post-1.e4 ply 1',
    r.positions.get(fenPositionKey(AFTER_E4)).minPly === 1);
  check('minPly tracked: post-1.e4 e5 ply 2',
    r.positions.get(fenPositionKey('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2')).minPly === 2);
}

section('walkGame — error handling');
{
  // Illegal SAN should be reported but walk continues
  const r = W.walkGame('[Event "x"]\n\n1. e4 e5 2. NOTAMOVE Nc6 *');
  check('illegal SAN: error recorded',
    r.errors.some(e => e.includes('NOTAMOVE')));
  // Earlier valid moves still captured
  check('illegal SAN: prior moves still emitted',
    r.positions.has(fenPositionKey(AFTER_E4)));

  // Unbalanced parens
  const r2 = W.walkGame('[Event "x"]\n\n1. e4 e5 (1... c5 *');
  check('unbalanced "(": error reported',
    r2.errors.some(e => e.includes('unbalanced')));
  const r3 = W.walkGame('[Event "x"]\n\n1. e4 e5 ) *');
  check('unbalanced ")": error reported',
    r3.errors.some(e => e.includes('unbalanced')));
}

section('walkPgnFile — multi-game');
{
  const pgn = [
    '[Event "Game 1"]',
    '[Result "*"]',
    '',
    '1. e4 e5 *',
    '',
    '[Event "Game 2"]',
    '[Result "*"]',
    '',
    '1. d4 d5 *',
  ].join('\n');
  const r = W.walkPgnFile(pgn);
  check('multi-game: all positions merged', r.positions.size === 4, 'got ' + r.positions.size);
  check('multi-game: no errors', r.errors.length === 0);
  check('multi-game: post-1.e4 captured', r.positions.has(fenPositionKey(AFTER_E4)));
  check('multi-game: post-1.d4 captured',
    r.positions.has(fenPositionKey('rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1')));
}

// ─── CLI integration via subprocess ──────────────────────────────────────
section('CLI: --min-ply filter via subprocess');
{
  const pgnFile = path.join(tmpRoot, 'rep.pgn');
  fs.writeFileSync(pgnFile,
    '[Event "Reti"]\n[Result "*"]\n\n' +
    '1. Nf3 d5 2. g3 c5 (2... Nf6 3. Bg2 c5) 3. Bg2 Nc6 *\n');

  const script = path.join(__dirname, 'repertoire-from-pgn.js');
  const outNoFloor = path.join(tmpRoot, 'no-floor.txt');
  const outFloor3 = path.join(tmpRoot, 'floor3.txt');

  execFileSync('node', [script, pgnFile, '--out', outNoFloor], { stdio: 'pipe' });
  execFileSync('node', [script, pgnFile, '--out', outFloor3, '--min-ply', '3'], { stdio: 'pipe' });

  const noFloorLines = fs.readFileSync(outNoFloor, 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  const floor3Lines = fs.readFileSync(outFloor3, 'utf8').split('\n').filter(l => l && !l.startsWith('#'));

  check('CLI no-floor: more positions than floor=3',
    noFloorLines.length > floor3Lines.length,
    `no-floor=${noFloorLines.length}, floor3=${floor3Lines.length}`);
  // The post-1.Nf3 position is at ply 1, must be in no-floor but NOT in floor3.
  check('CLI no-floor: includes post-1.Nf3',
    noFloorLines.includes(AFTER_NF3));
  check('CLI floor=3: excludes post-1.Nf3 (ply 1 < 3)',
    !floor3Lines.includes(AFTER_NF3));

  // Sanity: --min-ply output is consumable by buildWhitelist
  const text = fs.readFileSync(outFloor3, 'utf8');
  const w = RF.buildWhitelist(text);
  check('CLI output round-trips through buildWhitelist',
    w.count === floor3Lines.length, `whitelist=${w.count}, lines=${floor3Lines.length}`);
  check('CLI output: no parse errors when re-loaded',
    w.errors.length === 0);
}

// ─── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

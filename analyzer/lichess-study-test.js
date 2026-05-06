#!/usr/bin/env node
/**
 * lichess-study-test.js — Test the lib/lichessStudy parser + walker.
 *
 * Coverage:
 *   - extractStudyId: URL forms, slugs, bare IDs, junk
 *   - studyPgnUrl: valid/invalid IDs
 *   - splitChapters: single, multi, trailing whitespace, CRLF
 *   - parseHeaders: standard tags, escaped quotes, missing values
 *   - parseStudyPgn: end-to-end on multi-chapter studies, Orientation,
 *     custom FEN start, study/chapter name split
 *   - tokenize: SAN forms (pawn, piece, castling, promotion, captures,
 *     check/mate, ambiguity disambiguators), comments (brace + line),
 *     NAGs, move numbers (single + triple-dot), variations, results,
 *     trailing annotation suffixes (!?, etc.)
 *   - walkChapter: simple mainline, color filter, ply range, variation
 *     handling (single, nested, sequential), starting from custom FEN,
 *     promotion + castling, illegal-SAN tolerance
 *   - walkStudy: auto color from Orientation, override color, defaultColor
 *     fallback, chapterFilter, totals
 *
 * Run: node analyzer/lichess-study-test.js
 */

const LichessStudy = require('../lib/lichessStudy');
const { Chess } = require('chess.js'); // build-time v1.x

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── extractStudyId ──────────────────────────────────────────────────────
section('extractStudyId');
check('bare 8-char ID', LichessStudy.extractStudyId('abcd1234') === 'abcd1234');
check('mixed case bare ID', LichessStudy.extractStudyId('AbCd1234') === 'AbCd1234');
check('study URL', LichessStudy.extractStudyId('https://lichess.org/study/abcd1234') === 'abcd1234');
check('study URL with chapter', LichessStudy.extractStudyId('https://lichess.org/study/abcd1234/wxyz5678') === 'abcd1234');
check('study URL .pgn export', LichessStudy.extractStudyId('https://lichess.org/study/abcd1234.pgn') === 'abcd1234');
check('http (not https) URL', LichessStudy.extractStudyId('http://lichess.org/study/abcd1234') === 'abcd1234');
check('whitespace trimmed', LichessStudy.extractStudyId('  abcd1234  ') === 'abcd1234');
check('null returns null', LichessStudy.extractStudyId(null) === null);
check('undefined returns null', LichessStudy.extractStudyId(undefined) === null);
check('empty string returns null', LichessStudy.extractStudyId('') === null);
check('7-char string returns null', LichessStudy.extractStudyId('abcd123') === null);
check('9-char string returns null', LichessStudy.extractStudyId('abcd12345') === null);
check('non-lichess URL returns null', LichessStudy.extractStudyId('https://example.com/study/abcd1234') === null);
check('garbage returns null', LichessStudy.extractStudyId('not a url or id') === null);

// ─── studyPgnUrl ─────────────────────────────────────────────────────────
section('studyPgnUrl');
check('valid ID produces URL', LichessStudy.studyPgnUrl('abcd1234') === 'https://lichess.org/api/study/abcd1234.pgn');
let threw = false;
try { LichessStudy.studyPgnUrl('bad'); } catch (e) { threw = true; }
check('invalid ID throws', threw);

// ─── splitChapters ───────────────────────────────────────────────────────
section('splitChapters');
const SINGLE_CHAPTER = '[Event "Test: Ch 1"]\n[Result "*"]\n\n1. e4 *\n';
check('single chapter → 1 blob', LichessStudy.splitChapters(SINGLE_CHAPTER).length === 1);

const MULTI_CHAPTER = [
  '[Event "Test: Ch 1"]',
  '[Result "*"]',
  '',
  '1. e4 *',
  '',
  '',
  '[Event "Test: Ch 2"]',
  '[Result "*"]',
  '',
  '1. d4 *',
  ''
].join('\n');
const blobs = LichessStudy.splitChapters(MULTI_CHAPTER);
check('multi chapter → 2 blobs', blobs.length === 2, 'got ' + blobs.length);
check('first blob mentions Ch 1', /Ch 1/.test(blobs[0]));
check('second blob mentions Ch 2', /Ch 2/.test(blobs[1]));

const CRLF = SINGLE_CHAPTER.replace(/\n/g, '\r\n');
check('CRLF normalized to LF', LichessStudy.splitChapters(CRLF).length === 1);

check('empty input → empty array', LichessStudy.splitChapters('').length === 0);
check('whitespace-only → empty', LichessStudy.splitChapters('   \n\n').length === 0);

// ─── parseHeaders ────────────────────────────────────────────────────────
section('parseHeaders');
const headerBlob = '[Event "My Study: Caro-Kann"]\n[Site "lichess.org"]\n[Orientation "black"]\n\n1. e4 c6 *';
const ph = LichessStudy.parseHeaders(headerBlob);
check('Event extracted', ph.headers.Event === 'My Study: Caro-Kann');
check('Site extracted', ph.headers.Site === 'lichess.org');
check('Orientation extracted', ph.headers.Orientation === 'black');
check('moveText extracted', ph.moveText === '1. e4 c6 *');

const escapedBlob = '[Event "He said \\"hi\\""]\n\n*';
const eh = LichessStudy.parseHeaders(escapedBlob);
check('escaped quotes unescaped', eh.headers.Event === 'He said "hi"');

const noHeaderBlob = '\n\n1. e4 *';
const nh = LichessStudy.parseHeaders(noHeaderBlob);
check('no headers → empty headers', Object.keys(nh.headers).length === 0);
check('moveText still extracted', nh.moveText === '1. e4 *');

// ─── parseStudyPgn ───────────────────────────────────────────────────────
section('parseStudyPgn — basic structure');
const STUDY_BASIC = [
  '[Event "Caro-Kann Study: Main Line"]',
  '[Site "https://lichess.org/study/abcd1234/chap1111"]',
  '[Result "*"]',
  '[Variant "Standard"]',
  '[ECO "B12"]',
  '[Opening "Caro-Kann Defense"]',
  '[Annotator "https://lichess.org/@/skAeglund"]',
  '[Orientation "black"]',
  '[UTCDate "2026.05.06"]',
  '',
  '1. e4 c6 2. d4 d5 *',
  '',
  '',
  '[Event "Caro-Kann Study: Sidelines"]',
  '[Site "https://lichess.org/study/abcd1234/chap2222"]',
  '[Result "*"]',
  '[Orientation "black"]',
  '',
  '1. e4 c6 2. Nc3 d5 3. Nf3 *',
  ''
].join('\n');
const study = LichessStudy.parseStudyPgn(STUDY_BASIC);
check('two chapters parsed', study.length === 2, 'got ' + study.length);
check('study name split correctly', study[0].studyName === 'Caro-Kann Study');
check('chapter name split correctly', study[0].chapterName === 'Main Line');
check('orientation parsed', study[0].orientation === 'black');
check('chapter index 0', study[0].index === 0);
check('chapter index 1', study[1].index === 1);
check('moveText present', /e4/.test(study[0].moveText));
check('startFen null when not set', study[0].startFen === null);

section('parseStudyPgn — custom FEN start');
const STUDY_FEN = [
  '[Event "Endgame: KPK"]',
  '[FEN "8/8/8/8/4k3/8/4P3/4K3 w - - 0 1"]',
  '[SetUp "1"]',
  '[Orientation "white"]',
  '',
  '1. e3 *',
  ''
].join('\n');
const fenStudy = LichessStudy.parseStudyPgn(STUDY_FEN);
check('startFen captured', fenStudy[0].startFen === '8/8/8/8/4k3/8/4P3/4K3 w - - 0 1');

section('parseStudyPgn — Event without colon');
const EVENT_NO_COLON = [
  '[Event "Just a title"]',
  '',
  '1. e4 *',
  ''
].join('\n');
const noColon = LichessStudy.parseStudyPgn(EVENT_NO_COLON);
check('studyName is full Event', noColon[0].studyName === 'Just a title');
check('chapterName is empty', noColon[0].chapterName === '');

section('parseStudyPgn — invalid orientation');
const BAD_ORIENT = '[Event "X"]\n[Orientation "sideways"]\n\n*\n';
const bo = LichessStudy.parseStudyPgn(BAD_ORIENT);
check('invalid Orientation → null', bo[0].orientation === null);

// ─── tokenize ────────────────────────────────────────────────────────────
section('tokenize — basic moves');
function moveTokens(text) {
  return LichessStudy.tokenize(text)
    .filter(t => t.type === 'move')
    .map(t => t.san);
}
check('basic mainline', JSON.stringify(moveTokens('1. e4 c6 2. d4 d5 *')) === JSON.stringify(['e4', 'c6', 'd4', 'd5']));
check('castling', JSON.stringify(moveTokens('1. O-O O-O-O *')) === JSON.stringify(['O-O', 'O-O-O']));
check('captures', JSON.stringify(moveTokens('1. exd5 Nxe5 *')) === JSON.stringify(['exd5', 'Nxe5']));
check('check + mate', JSON.stringify(moveTokens('1. Qh5+ Qxh5# *')) === JSON.stringify(['Qh5+', 'Qxh5#']));
check('promotion', JSON.stringify(moveTokens('1. e8=Q+ *')) === JSON.stringify(['e8=Q+']));
check('disambiguation', JSON.stringify(moveTokens('1. Nbd7 R1e2 *')) === JSON.stringify(['Nbd7', 'R1e2']));

section('tokenize — annotations stripped');
check('!? suffix stripped', moveTokens('1. e4!? c6 *')[0] === 'e4');
check('?? suffix stripped', moveTokens('1. e4?? *')[0] === 'e4');
check('triple ! stripped', moveTokens('1. e4!!! *')[0] === 'e4');

section('tokenize — comments');
check('brace comment skipped', JSON.stringify(moveTokens('1. e4 {good move} c6 *')) === JSON.stringify(['e4', 'c6']));
check('multiline brace comment skipped', JSON.stringify(moveTokens('1. e4 {line\nbreak\nhere} c6 *')) === JSON.stringify(['e4', 'c6']));
check('line comment skipped', JSON.stringify(moveTokens('1. e4 ;comment to eol\nc6 *')) === JSON.stringify(['e4', 'c6']));

section('tokenize — NAGs and move numbers');
check('NAG skipped', JSON.stringify(moveTokens('1. e4 $1 c6 $14 *')) === JSON.stringify(['e4', 'c6']));
check('triple-dot for black-only', JSON.stringify(moveTokens('1... c6 2. d4 *')) === JSON.stringify(['c6', 'd4']));

section('tokenize — variations and results');
const varTokens = LichessStudy.tokenize('1. e4 (1. d4 d5) c6 *');
const varTypes = varTokens.map(t => t.type + (t.san ? ':' + t.san : ''));
check('variation tokens emitted in order',
  JSON.stringify(varTypes) === JSON.stringify(['move:e4', 'open', 'move:d4', 'move:d5', 'close', 'move:c6', 'result']),
  'got ' + JSON.stringify(varTypes));

check('result 1-0', LichessStudy.tokenize('1. e4 1-0').filter(t => t.type === 'result').length === 1);
check('result 0-1', LichessStudy.tokenize('1. e4 0-1').filter(t => t.type === 'result').length === 1);
check('result 1/2-1/2', LichessStudy.tokenize('1. e4 1/2-1/2').filter(t => t.type === 'result').length === 1);
check('result *', LichessStudy.tokenize('1. e4 *').filter(t => t.type === 'result').length === 1);

// ─── walkChapter — simple mainlines ──────────────────────────────────────
section('walkChapter — simple mainline, white POV');
let result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 2. d4 d5 3. Nc3 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
check('3 white moves emitted', result.fens.length === 3, 'got ' + result.fens.length);
check('plies are 1, 3, 5', result.fens[0].ply === 1 && result.fens[1].ply === 3 && result.fens[2].ply === 5);
check('first FEN has black to move (after white played)', /\sb\s/.test(result.fens[0].fen));
check('sanLine grows', result.fens[2].sanLine.length === 5,
  'got ' + JSON.stringify(result.fens[2].sanLine));
check('no errors', result.errors.length === 0);

section('walkChapter — black POV');
result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 2. d4 d5 *', startFen: null },
  { Chess: Chess, userColor: 'b' }
);
check('2 black moves emitted', result.fens.length === 2, 'got ' + result.fens.length);
check('plies are 2 and 4', result.fens[0].ply === 2 && result.fens[1].ply === 4);
check('FEN has white to move (after black played)', /\sw\s/.test(result.fens[0].fen));

section('walkChapter — ply range');
result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 *', startFen: null },
  { Chess: Chess, userColor: 'w', plyMin: 3, plyMax: 5 }
);
check('only ply 3 and 5 emitted', result.fens.length === 2 &&
  result.fens[0].ply === 3 && result.fens[1].ply === 5,
  'got plies ' + result.fens.map(f => f.ply).join(','));

section('walkChapter — single variation');
// Mainline: 1.e4 c6 2.d4
// Variation after c6: 2.Nc3 d5
// White-POV: should emit positions after e4 (ply 1), d4 (ply 3), AND
// Nc3 (ply 3 in variation).
result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 2. d4 (2. Nc3 d5) d5 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
const fens = result.fens.map(f => ({ ply: f.ply, line: f.sanLine.join(' ') }));
check('3 white-move emissions (e4, d4, Nc3)', fens.length === 3, JSON.stringify(fens));
check('mainline d4 appears', fens.some(f => f.line === 'e4 c6 d4'));
check('variation Nc3 appears', fens.some(f => f.line === 'e4 c6 Nc3'));
check('no errors', result.errors.length === 0);

section('walkChapter — nested variations');
// 1.e4 c6 (1...e5 2.Nf3 (2.Nc3 d6) Nc6) 2.d4
// White moves to capture: e4 (ply 1, mainline), Nf3 (ply 3, var-of-c6),
// Nc3 (ply 3, var-of-Nf3), d4 (ply 3, mainline)
result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 (1... e5 2. Nf3 (2. Nc3 d6) Nc6) 2. d4 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
const lines = result.fens.map(f => f.sanLine.join(' '));
check('e4 emitted', lines.indexOf('e4') >= 0);
check('Nc3 nested var emitted', lines.indexOf('e4 e5 Nc3') >= 0, 'lines: ' + JSON.stringify(lines));
check('Nf3 outer var emitted', lines.indexOf('e4 e5 Nf3') >= 0);
check('d4 mainline emitted', lines.indexOf('e4 c6 d4') >= 0);
check('exactly 4 white-move emissions', lines.length === 4);
check('no errors', result.errors.length === 0);

section('walkChapter — sequential variations on same move');
// 1.e4 (1.d4) (1.c4) e5
// White: e4 (ply 1 main), d4 (ply 1 var), c4 (ply 1 var)
result = LichessStudy.walkChapter(
  { moveText: '1. e4 (1. d4) (1. c4) 1... e5 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
const seqLines = result.fens.map(f => f.sanLine.join(' '));
check('e4 main', seqLines.indexOf('e4') >= 0);
check('d4 alt', seqLines.indexOf('d4') >= 0);
check('c4 alt', seqLines.indexOf('c4') >= 0);
check('exactly 3 emissions', seqLines.length === 3, JSON.stringify(seqLines));
check('all at ply 1', result.fens.every(f => f.ply === 1));

section('walkChapter — custom starting FEN');
// KPK endgame, white to play
const kpkFen = '8/8/8/8/4k3/8/4P3/4K3 w - - 0 1';
result = LichessStudy.walkChapter(
  { moveText: '1. Kd2 Kf4 2. e3+ *', startFen: kpkFen },
  { Chess: Chess, userColor: 'w' }
);
check('2 white moves from custom FEN', result.fens.length === 2);
check('no errors', result.errors.length === 0);

section('walkChapter — invalid starting FEN');
result = LichessStudy.walkChapter(
  { moveText: '1. e4 *', startFen: 'not a fen' },
  { Chess: Chess, userColor: 'w' }
);
check('invalid startFen produces error', result.errors.length === 1 && /invalid startFen/.test(result.errors[0].message));
check('no fens emitted on bad start', result.fens.length === 0);

section('walkChapter — illegal SAN tolerance');
// Mainline has illegal move; we should record an error but continue with
// what's parseable. After the bad mainline move, all subsequent mainline
// moves get skipped (chess state is wrong).
// Use "Bxx9" — starts with 'B' so it tokenizes as a move attempt, but the
// destination square is invalid. Engines reject it; we record the error.
result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 2. Bxx9 d5 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
check('error recorded for illegal SAN', result.errors.length === 1 && result.errors[0].san === 'Bxx9',
  'errors: ' + JSON.stringify(result.errors));
check('valid moves before error still emitted', result.fens.length === 1 && result.fens[0].sanLine.join(' ') === 'e4');

section('walkChapter — illegal SAN inside variation skips just that variation');
// Mainline e4 c6 d4 (good); variation has bad SAN — should skip variation
// but continue mainline.
result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 (1... e5 2. Bxx9 d6) 2. d4 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
check('error recorded', result.errors.length === 1);
const recoverLines = result.fens.map(f => f.sanLine.join(' '));
check('mainline e4 emitted', recoverLines.indexOf('e4') >= 0);
check('mainline d4 emitted', recoverLines.indexOf('e4 c6 d4') >= 0,
  'lines: ' + JSON.stringify(recoverLines));

section('walkChapter — promotion + castling round-trip');
// Walks through a real promotion and castling to make sure the SAN is
// faithfully replayed.
result = LichessStudy.walkChapter(
  { moveText: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
check('castling mainline parsed', result.fens.length === 4 && result.errors.length === 0);
check('last white move was O-O', result.fens[3].sanLine[result.fens[3].sanLine.length - 1] === 'O-O');

section('walkChapter — variation before any mainline move (malformed but tolerated)');
// Lichess shouldn't emit '(' at ply 0, but a hand-edited or concatenated PGN
// might. The walker should not crash; it should treat the variation as
// content at the same ply level as the mainline that follows.
result = LichessStudy.walkChapter(
  { moveText: '(1. d4) 1. e4 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
const preLines = result.fens.map(f => f.sanLine.join(' '));
check('no crash on leading variation', result.errors.length === 0,
  'errors: ' + JSON.stringify(result.errors));
// Expected: d4 (in the leading variation) AND e4 (mainline after) both
// emitted at ply 1. The variation snapshot has prevFen = startFen, so
// rewinding has nothing to do; chess stays at start; d4 plays cleanly.
// On ')', we restore to start (the snapshot fen) at ply 0.
check('mainline e4 emitted', preLines.indexOf('e4') >= 0, JSON.stringify(preLines));
check('leading variation d4 emitted', preLines.indexOf('d4') >= 0, JSON.stringify(preLines));

section('walkChapter — comments inside variations');
// Comments can appear anywhere; they should be transparent to the parser
// regardless of whether we're in a variation or the mainline.
result = LichessStudy.walkChapter(
  { moveText: '1. e4 c6 (1... e5 {sharp} 2. Nf3 {develops}) 2. d4 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
check('comments inside variation do not break parsing', result.errors.length === 0);
const cmtLines = result.fens.map(f => f.sanLine.join(' '));
check('mainline d4 still emitted', cmtLines.indexOf('e4 c6 d4') >= 0);
check('variation Nf3 still emitted', cmtLines.indexOf('e4 e5 Nf3') >= 0);

section('walkChapter — comments and NAGs do not break tokenization');
result = LichessStudy.walkChapter(
  { moveText: '1. e4 {good} $1 c6 ;comment\n2. d4 *', startFen: null },
  { Chess: Chess, userColor: 'w' }
);
check('e4 + d4 emitted despite annotations', result.fens.length === 2 && result.errors.length === 0);

// ─── walkStudy ───────────────────────────────────────────────────────────
section('walkStudy — auto color from Orientation');
const study2 = LichessStudy.parseStudyPgn(STUDY_BASIC);
const ws = LichessStudy.walkStudy(study2, { Chess: Chess, userColor: 'auto' });
check('two chapter records', ws.chapters.length === 2);
check('first resolved to black (Orientation: black)', ws.chapters[0].color === 'b');
check('second resolved to black', ws.chapters[1].color === 'b');
// 1.e4 c6 2.d4 d5 — black plays c6 (ply 2) and d5 (ply 4), so 2 fens.
check('first chapter emits 2 black-POV fens', ws.chapters[0].fens.length === 2);

section('walkStudy — override color');
const wsW = LichessStudy.walkStudy(study2, { Chess: Chess, userColor: 'w' });
check('forced w → first chapter has white-POV count', wsW.chapters[0].fens.length === 2);
check('color recorded as w', wsW.chapters[0].color === 'w');

section('walkStudy — defaultColor fallback');
const NO_ORIENT = '[Event "X: Y"]\n\n1. e4 c6 *\n';
const noOrient = LichessStudy.parseStudyPgn(NO_ORIENT);
check('chapter has no orientation', noOrient[0].orientation === null);
const wsDefB = LichessStudy.walkStudy(noOrient, { Chess: Chess, userColor: 'auto', defaultColor: 'b' });
check('defaultColor=b honored when orientation missing', wsDefB.chapters[0].color === 'b');
const wsDefW = LichessStudy.walkStudy(noOrient, { Chess: Chess, userColor: 'auto' });
check('defaultColor=w (default) used when orientation missing', wsDefW.chapters[0].color === 'w');

section('walkStudy — chapterFilter');
const wsFilt = LichessStudy.walkStudy(study2, {
  Chess: Chess,
  userColor: 'auto',
  chapterFilter: function (ch) { return ch.chapterName === 'Main Line'; }
});
check('first chapter not skipped', wsFilt.chapters[0].skipped === false);
check('second chapter skipped', wsFilt.chapters[1].skipped === true);
check('skipped chapter has empty fens', wsFilt.chapters[1].fens.length === 0);

section('walkStudy — totals');
check('totalFens sums chapters', wsW.totalFens === wsW.chapters.reduce((s, c) => s + c.fens.length, 0));
check('totalErrors starts at 0 on clean study', wsW.totalErrors === 0);

section('walkStudy — invalid args');
let threwInvalid = false;
try { LichessStudy.walkStudy(study2, { Chess: Chess, userColor: 'rainbow' }); } catch (e) { threwInvalid = true; }
check('bad userColor throws', threwInvalid);
threwInvalid = false;
try { LichessStudy.walkStudy('not an array', { Chess: Chess }); } catch (e) { threwInvalid = true; }
check('non-array chapters throws', threwInvalid);
threwInvalid = false;
try { LichessStudy.walkStudy(study2, {}); } catch (e) { threwInvalid = true; }
check('missing Chess throws', threwInvalid);

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

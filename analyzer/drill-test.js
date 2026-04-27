#!/usr/bin/env node
/**
 * drill-test.js — Test the drill state machine and progress storage layer.
 *
 * Run: node analyzer/drill-test.js
 */

const Drill = require('../lib/drill');
const Progress = require('../lib/progress');
const FSRS = require('../lib/fsrs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── helpers ─────────────────────────────────────────────────────────────
// A 3-move puzzle from the sample (white-to-move "Bxg4 Bxg4 Qxg4")
const PUZZLE_3 = {
  puzzleId: '0009B',
  fen: 'r2qr1k1/b1p2ppp/p5n1/P1p1p3/4P1n1/B2P2Pb/3NBP1P/RN1QR1K1 w - - 0 17',
  solutionUci: ['e2g4', 'h3g4', 'd1g4']
};
// A 1-move puzzle (mateIn1)
const PUZZLE_1 = {
  puzzleId: '00mJq',
  fen: 'r1b5/pp1nkpr1/2q1p3/8/3N4/3B4/P1P2PPP/R2Q1RK1 b - - 4 18',
  solutionUci: ['c6g2']
};

// ━━━ DRILL state machine ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Drill.start');
{
  const s = Drill.start(PUZZLE_3);
  check('puzzleId set',           s.puzzleId === PUZZLE_3.puzzleId);
  check('fen set',                s.fen === PUZZLE_3.fen);
  check('solutionUci copied',     s.solutionUci !== PUZZLE_3.solutionUci && s.solutionUci.length === 3);
  check('currentMoveIdx=0',       s.currentMoveIdx === 0);
  check('hintLevel=0',            s.hintLevel === 0);
  check('wrongAttempts=0',        s.wrongAttempts === 0);
  check('hintUsed=false',         s.hintUsed === false);
  check('complete=false',         s.complete === false);
  check('gradeRecorded=null',     s.gradeRecorded === null);
  check('userColor=w from FEN',   Drill.userColor(s) === 'w');
  check('userColor=b for PUZZLE_1', Drill.userColor(Drill.start(PUZZLE_1)) === 'b');

  let threw = false;
  try { Drill.start({}); } catch (e) { threw = true; }
  check('start({}) throws',       threw);
  threw = false;
  try { Drill.start({ puzzleId: 'x', fen: 'y', solutionUci: [] }); } catch (e) { threw = true; }
  check('start with empty solution throws', threw);
}

section('Drill.attemptUserMove — clean perfect run');
{
  let s = Drill.start(PUZZLE_3);
  let r = Drill.attemptUserMove(s, 'e2g4');  // user move 1
  check('move 1 result=continue',   r.result === 'continue');
  check('move 1 returns opp reply', r.opponentReply === 'h3g4');
  check('move 1 toRecord=null',     r.toRecord === null);
  check('move 1 advances idx by 2', r.state.currentMoveIdx === 2);

  s = r.state;
  r = Drill.attemptUserMove(s, 'd1g4');  // user move 2 (final)
  check('move 2 result=complete',   r.result === 'complete');
  check('move 2 no opp reply',      r.opponentReply === null);
  check('move 2 toRecord=easy',     r.toRecord === FSRS.GRADE.easy);
  check('state complete=true',      r.state.complete === true);
  check('idx past end',             r.state.currentMoveIdx === 3);
  check('gradeRecorded=easy',       r.state.gradeRecorded === FSRS.GRADE.easy);
}

section('Drill.attemptUserMove — single-move puzzle (mateIn1)');
{
  let s = Drill.start(PUZZLE_1);
  let r = Drill.attemptUserMove(s, 'c6g2');
  check('immediate complete',       r.result === 'complete');
  check('no opp reply',              r.opponentReply === null);
  check('toRecord=easy',             r.toRecord === FSRS.GRADE.easy);
  check('idx past end',              r.state.currentMoveIdx === 1);
}

section('Drill.attemptUserMove — first wrong locks Again immediately');
{
  let s = Drill.start(PUZZLE_3);
  let r = Drill.attemptUserMove(s, 'a2a4');  // wrong
  check('result=wrong',              r.result === 'wrong');
  check('expected revealed',         r.expected === 'e2g4');
  check('toRecord=again on first',   r.toRecord === FSRS.GRADE.again);
  check('wrongAttempts=1',           r.state.wrongAttempts === 1);
  check('gradeRecorded=again',       r.state.gradeRecorded === FSRS.GRADE.again);

  // Second wrong → counter increments, but no re-record
  r = Drill.attemptUserMove(r.state, 'b2b4');
  check('second wrong: result=wrong', r.result === 'wrong');
  check('second wrong: toRecord=null (locked)', r.toRecord === null);
  check('wrongAttempts=2',           r.state.wrongAttempts === 2);

  // User finally plays correct → continues but no re-record
  r = Drill.attemptUserMove(r.state, 'e2g4');
  check('correct after wrongs: continue', r.result === 'continue');
  check('correct after wrongs: toRecord=null', r.toRecord === null);
  check('opp reply still played',    r.opponentReply === 'h3g4');

  // Final correct → complete but no re-record (already locked at again)
  r = Drill.attemptUserMove(r.state, 'd1g4');
  check('completion after wrongs: complete', r.result === 'complete');
  check('completion after wrongs: toRecord=null (locked at again)', r.toRecord === null);
  check('gradeRecorded stays at again', r.state.gradeRecorded === FSRS.GRADE.again);
}

section('Drill.requestHint');
{
  let s = Drill.start(PUZZLE_3);
  let r = Drill.requestHint(s);
  check('level 1 set',               r.state.hintLevel === 1);
  check('level 1 hintUsed=true',     r.state.hintUsed === true);
  check('level 1 fromSquare given',  r.hintInfo && r.hintInfo.fromSquare === 'e2');
  check('level 1 no toSquare',       !r.hintInfo.toSquare);

  r = Drill.requestHint(r.state);
  check('level 2 set',               r.state.hintLevel === 2);
  check('level 2 has toSquare',      r.hintInfo.toSquare === 'g4');

  r = Drill.requestHint(r.state);
  check('level 2 sticky (no level 3)', r.state.hintLevel === 2);

  // Hint alone does NOT trigger toRecord
  s = Drill.start(PUZZLE_3);
  r = Drill.requestHint(s);
  check('hint does NOT trigger record', r.state.gradeRecorded === null);
}

section('Drill.attemptUserMove — completion grades by branch');
{
  // Hint then perfect → Hard
  let s = Drill.start(PUZZLE_3);
  s = Drill.requestHint(s).state;          // hint used
  let r = Drill.attemptUserMove(s, 'e2g4');
  r = Drill.attemptUserMove(r.state, 'd1g4');
  check('hint + clean → toRecord=hard', r.toRecord === FSRS.GRADE.hard);
  check('hint + clean → gradeRecorded=hard', r.state.gradeRecorded === FSRS.GRADE.hard);

  // No hint, no wrong → Easy
  s = Drill.start(PUZZLE_3);
  r = Drill.attemptUserMove(s, 'e2g4');
  r = Drill.attemptUserMove(r.state, 'd1g4');
  check('clean run → toRecord=easy', r.toRecord === FSRS.GRADE.easy);

  // Wrong then hint → already locked at Again from first wrong; hint doesn't change it
  s = Drill.start(PUZZLE_3);
  r = Drill.attemptUserMove(s, 'h2h4');         // wrong → again locked
  r = Drill.requestHint(r.state);                // hint used afterwards
  r = { state: r.state, result: 'continue', toRecord: null };
  let r2 = Drill.attemptUserMove(r.state, 'e2g4');
  r2 = Drill.attemptUserMove(r2.state, 'd1g4');
  check('wrong + hint + finish → still again', r2.state.gradeRecorded === FSRS.GRADE.again);

  // Hint then wrong → first wrong locks again (overrides hint's would-be hard)
  s = Drill.start(PUZZLE_3);
  s = Drill.requestHint(s).state;           // hint, no record yet
  let rr = Drill.attemptUserMove(s, 'h2h4');  // wrong → locks again
  check('hint then wrong → locks again', rr.state.gradeRecorded === FSRS.GRADE.again);
  check('hint then wrong → toRecord=again', rr.toRecord === FSRS.GRADE.again);
}

section('Drill.attemptUserMove — already_complete is a no-op');
{
  let s = Drill.start(PUZZLE_1);
  let r = Drill.attemptUserMove(s, 'c6g2');
  check('complete reached', r.result === 'complete');
  let r2 = Drill.attemptUserMove(r.state, 'a1a2');
  check('post-complete: result=already_complete', r2.result === 'already_complete');
  check('post-complete: state unchanged',         r2.state === r.state);
}

section('Drill.userColor');
{
  check('white-to-move FEN → w', Drill.userColor({ fen: 'rn... w KQkq - 0 1' }) === 'w');
  check('black-to-move FEN → b', Drill.userColor({ fen: 'rn... b KQkq - 0 1' }) === 'b');
  check('weird side defaults to w', Drill.userColor({ fen: 'rn... ? KQkq - 0 1' }) === 'w');
}

// ━━━ PROGRESS storage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function freshStorage() {
  Progress.setStorage(Progress._makeMemoryStorage());
}

section('Progress.load default');
{
  freshStorage();
  const d = Progress.load();
  check('empty storage → empty positions', JSON.stringify(d) === '{"positions":{}}');
  check('isCompleted on unknown puzzle = false', Progress.isCompleted('xxx') === false);
  check('getCard on unknown → fresh new', Progress.getCard('xxx').state === FSRS.STATE.new);
  check('isDue on unknown → true (new)', Progress.isDue('xxx') === true);
}

section('Progress.recordReview lifecycle');
{
  freshStorage();
  const card = Progress.recordReview('puzzle1', FSRS.GRADE.easy);
  check('returned card has stability', Number.isFinite(card.stability) && card.stability > 0);
  check('isCompleted true after record', Progress.isCompleted('puzzle1'));
  const entry = Progress.getEntry('puzzle1');
  check('entry has lastSeen ISO', /^\d{4}-\d{2}-\d{2}T/.test(entry.lastSeen));
  check('entry has srs',          entry.srs && entry.srs.state === FSRS.STATE.review);
  check('isDue immediately after easy review = false (scheduled future)',
    Progress.isDue('puzzle1') === false);

  // Multiple puzzles persist independently
  Progress.recordReview('puzzle2', FSRS.GRADE.again);
  const both = Progress.exportData();
  check('two puzzles tracked',    Object.keys(both.positions).length === 2);
  check('puzzle2 due (again, 1d)', Progress.isDue('puzzle2', FSRS.localDateString(new Date(Date.now() + 2 * 86400000))) === true);
}

section('Progress.stats');
{
  freshStorage();
  Progress.recordReview('a', FSRS.GRADE.easy);
  Progress.recordReview('b', FSRS.GRADE.again);
  Progress.recordReview('c', FSRS.GRADE.hard);
  const s = Progress.stats();
  check('total=3', s.total === 3);
  check('completed=3', s.completed === 3);
  // Just-recorded cards are scheduled for tomorrow at minimum (1-day floor),
  // so none are due on the same day they were reviewed.
  check('immediately after recording, none are due', s.due === 0);

  // Backdate one card's due field to verify the due counter actually ticks.
  const data = Progress.exportData();
  data.positions.b.srs.due = '2020-01-01';
  Progress.importData(data);
  const s2 = Progress.stats();
  check('backdated card → due=1', s2.due === 1);
}

section('Progress: corrupt JSON → graceful fallback');
{
  const stub = Progress._makeMemoryStorage();
  stub.setItem(Progress.STORAGE_KEY, '{not valid json');
  Progress.setStorage(stub);
  // Suppress the warn
  const origWarn = console.warn;
  console.warn = function () {};
  const d = Progress.load();
  console.warn = origWarn;
  check('corrupt JSON → empty positions', JSON.stringify(d) === '{"positions":{}}');
  check('isCompleted on corrupt store = false', Progress.isCompleted('anything') === false);
}

section('Progress: bad schema (missing positions) → empty');
{
  const stub = Progress._makeMemoryStorage();
  stub.setItem(Progress.STORAGE_KEY, '{"foo":1}');
  Progress.setStorage(stub);
  const d = Progress.load();
  check('bad schema → empty positions',
    JSON.stringify(d) === '{"positions":{}}');
}

section('Progress: degenerate schema rejects {positions: []} (array)');
{
  const stub = Progress._makeMemoryStorage();
  stub.setItem(Progress.STORAGE_KEY, JSON.stringify({ positions: [] }));
  Progress.setStorage(stub);
  const d = Progress.load();
  check('positions-as-array → empty', JSON.stringify(d) === '{"positions":{}}');
}

section('Progress: corrupt entry value (non-object) → recordReview survives');
{
  const stub = Progress._makeMemoryStorage();
  stub.setItem(Progress.STORAGE_KEY, JSON.stringify({ positions: { abc: 'corrupt' } }));
  Progress.setStorage(stub);
  let threw = false;
  try { Progress.recordReview('abc', FSRS.GRADE.easy); }
  catch (e) { threw = true; }
  check('corrupt entry: recordReview does not throw', !threw);
  check('corrupt entry: replaced with valid object', typeof Progress.getEntry('abc') === 'object');
  check('corrupt entry: srs initialized', Progress.getCard('abc').state === FSRS.STATE.review);
}

section('Progress.recordReview: non-Date `now` arg falls back to current time');
{
  freshStorage();
  let threw = false;
  try { Progress.recordReview('id', FSRS.GRADE.easy, 'not-a-date'); }
  catch (e) { threw = true; }
  check('string-now: does not throw',  !threw);
  const e = Progress.getEntry('id');
  check('string-now: lastSeen is ISO',  /^\d{4}-\d{2}-\d{2}T/.test(e.lastSeen));

  freshStorage();
  threw = false;
  try { Progress.recordReview('id2', FSRS.GRADE.easy, new Date('garbage')); }
  catch (e2) { threw = true; }
  check('Invalid-Date-now: does not throw', !threw);
  const e2 = Progress.getEntry('id2');
  check('Invalid-Date-now: lastSeen is ISO', /^\d{4}-\d{2}-\d{2}T/.test(e2.lastSeen));
}

section('Progress: setItem throws (quota) → save returns false, no crash');
{
  const stub = {
    getItem: function () { return null; },
    setItem: function () { throw new Error('QuotaExceededError'); },
    removeItem: function () {},
    clear: function () {}
  };
  Progress.setStorage(stub);
  const origWarn = console.warn;
  console.warn = function () {};
  const ok = Progress.save({ positions: {} });
  console.warn = origWarn;
  check('save returns false on throw', ok === false);
}

section('Progress.exportData / importData round-trip');
{
  freshStorage();
  Progress.recordReview('aaa', FSRS.GRADE.easy);
  Progress.recordReview('bbb', FSRS.GRADE.hard);
  const exported = Progress.exportData();

  freshStorage();
  check('after fresh, no aaa', !Progress.isCompleted('aaa'));
  Progress.importData(exported);
  check('after import, aaa back', Progress.isCompleted('aaa'));
  check('after import, bbb back', Progress.isCompleted('bbb'));

  // Bad import should reject
  check('import null rejected',     Progress.importData(null) === false);
  check('import {} rejected',       Progress.importData({}) === false);
}

section('Progress.clear');
{
  freshStorage();
  Progress.recordReview('zzz', FSRS.GRADE.easy);
  check('zzz tracked',              Progress.isCompleted('zzz'));
  Progress.clear();
  check('after clear, zzz gone',    !Progress.isCompleted('zzz'));
  check('after clear, exportData empty',
    Object.keys(Progress.exportData().positions).length === 0);
}

// ━━━ INTEGRATION: drill state machine + progress persistence ━━━━━━━━━━━━━

section('Integration: drill perfect run → progress reflects Easy');
{
  freshStorage();
  let s = Drill.start(PUZZLE_3);
  let r = Drill.attemptUserMove(s, 'e2g4');
  if (r.toRecord !== null) Progress.recordReview(s.puzzleId, r.toRecord);
  s = r.state;
  r = Drill.attemptUserMove(s, 'd1g4');
  if (r.toRecord !== null) Progress.recordReview(r.state.puzzleId, r.toRecord);

  const card = Progress.getCard(PUZZLE_3.puzzleId);
  check('card recorded',            card.state === FSRS.STATE.review);
  check('completed flag',           Progress.isCompleted(PUZZLE_3.puzzleId));
  check('scheduled days > 1 (easy)', card.scheduledDays > 1);
}

section('Integration: drill with first wrong → progress reflects Again');
{
  freshStorage();
  let s = Drill.start(PUZZLE_3);
  let r = Drill.attemptUserMove(s, 'h2h4');  // wrong → toRecord=again
  if (r.toRecord !== null) Progress.recordReview(s.puzzleId, r.toRecord);
  s = r.state;
  // User then completes correctly — additional toRecord should be null
  r = Drill.attemptUserMove(s, 'e2g4');
  check('post-wrong continue: no record', r.toRecord === null);
  s = r.state;
  r = Drill.attemptUserMove(s, 'd1g4');
  check('post-wrong complete: no record', r.toRecord === null);

  const card = Progress.getCard(PUZZLE_3.puzzleId);
  check('lapses=1 from again',      card.lapses === 1);
  check('scheduled days = 1 (again floor)', card.scheduledDays === 1);
}

section('Integration: drilling SAME puzzle twice grades both times');
{
  freshStorage();
  // First drill: easy
  let s1 = Drill.start(PUZZLE_3);
  let r = Drill.attemptUserMove(s1, 'e2g4');
  if (r.toRecord) Progress.recordReview(s1.puzzleId, r.toRecord);
  r = Drill.attemptUserMove(r.state, 'd1g4');
  if (r.toRecord) Progress.recordReview(s1.puzzleId, r.toRecord);
  const reps1 = Progress.getCard(PUZZLE_3.puzzleId).reps;

  // Second drill (same puzzle, fresh state): easy again
  let s2 = Drill.start(PUZZLE_3);
  r = Drill.attemptUserMove(s2, 'e2g4');
  if (r.toRecord) Progress.recordReview(s2.puzzleId, r.toRecord);
  r = Drill.attemptUserMove(r.state, 'd1g4');
  if (r.toRecord) Progress.recordReview(s2.puzzleId, r.toRecord);
  const reps2 = Progress.getCard(PUZZLE_3.puzzleId).reps;

  check('second drill increments reps', reps2 > reps1, `reps1=${reps1} reps2=${reps2}`);
}

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

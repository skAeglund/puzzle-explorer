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
// Manufactured under-promotion fixture (closes #7). Real Lichess data
// includes the underPromotion theme — e.g. a forced knight promo because
// queen/rook would stalemate, or a knight promo that forks. The state
// machine compares UCI strings; the FEN doesn't need to be one of those
// exact puzzles, just has to drive the same code path. Solution `e7e8n`
// would mark the user wrong if the UI auto-queened — which is the bug
// the promotion picker fixes.
const PUZZLE_UNDERPROMO = {
  puzzleId: 'underpromo-fixture',
  fen: '8/4P3/3k4/8/8/8/8/7K w - - 0 1',
  solutionUci: ['e7e8n']
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

section('Drill.attemptUserMove — under-promotion solution (e7e8n)');
{
  // Correct: exact UCI match including the promotion piece. State machine
  // doesn't care which piece — it's a string compare — but this locks in
  // the contract that under-promotion is reachable end-to-end.
  let s = Drill.start(PUZZLE_UNDERPROMO);
  let r = Drill.attemptUserMove(s, 'e7e8n');
  check('e7e8n accepted as correct',   r.result === 'complete');
  check('toRecord=easy on first try',  r.toRecord === FSRS.GRADE.easy);

  // Auto-queen would have submitted 'e7e8q' — verify that's wrong, and
  // that it locks Again on first attempt (this is the user-facing bug
  // the promotion picker fixes: without it, the user has no way to
  // express "knight" and gets locked into a fail grade for a tactic
  // they may have actually seen correctly).
  s = Drill.start(PUZZLE_UNDERPROMO);
  r = Drill.attemptUserMove(s, 'e7e8q');
  check('e7e8q rejected as wrong',     r.result === 'wrong');
  check('expected reflects e7e8n',     r.expected === 'e7e8n');
  check('first-wrong locks Again',     r.toRecord === FSRS.GRADE.again);

  // Other under-promotions (rook, bishop) are also wrong — only the exact
  // UCI is the solution. Confirms we're not doing any "any promotion is
  // fine" leniency.
  s = Drill.start(PUZZLE_UNDERPROMO);
  r = Drill.attemptUserMove(s, 'e7e8r');
  check('e7e8r rejected as wrong',     r.result === 'wrong');
  s = Drill.start(PUZZLE_UNDERPROMO);
  r = Drill.attemptUserMove(s, 'e7e8b');
  check('e7e8b rejected as wrong',     r.result === 'wrong');
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

section('Drill timing — userMoveCount + computeAvgMoveTimeMs');
{
  // Solution alternates user/opp starting with user, so user gets ceil(N/2)
  check('1-move solution → 1 user move',  Drill.userMoveCount(Drill.start(PUZZLE_1)) === 1);
  check('3-move solution → 2 user moves', Drill.userMoveCount(Drill.start(PUZZLE_3)) === 2);

  // No markSolveStart → null (timing not engaged)
  let s = Drill.start(PUZZLE_3);
  check('no solveStartedAt → avg=null',
    Drill.computeAvgMoveTimeMs(s, new Date()) === null);

  // markSolveStart sets the baseline
  const t0 = new Date('2026-01-01T12:00:00Z');
  s = Drill.markSolveStart(s, t0);
  check('markSolveStart sets solveStartedAt', typeof s.solveStartedAt === 'number');

  // 20s elapsed, 2 user moves → 10s avg
  const t20s = new Date(t0.getTime() + 20000);
  check('20s/2 moves → 10000ms avg',
    Drill.computeAvgMoveTimeMs(s, t20s) === 10000);

  // markSolveStart is idempotent — second call doesn't reset the timer
  let s2 = Drill.markSolveStart(s, new Date(t0.getTime() + 5000));
  check('markSolveStart idempotent', s2.solveStartedAt === s.solveStartedAt);

  // Negative elapsed (clock skew or now < start) → null, not a negative avg
  const tBefore = new Date(t0.getTime() - 1000);
  check('negative elapsed → null',
    Drill.computeAvgMoveTimeMs(s, tBefore) === null);
}

section('Drill grading — clean solve, time-based');
{
  const t0 = new Date('2026-01-01T12:00:00Z');
  // PUZZLE_3: user moves are 'e2g4' and 'd1g4' (2 user moves)

  // Fast solve: 2 moves in 8s → 4s avg → Easy
  let s = Drill.markSolveStart(Drill.start(PUZZLE_3), t0);
  let r = Drill.attemptUserMove(s, 'e2g4', { now: new Date(t0.getTime() + 4000) });
  r = Drill.attemptUserMove(r.state, 'd1g4', { now: new Date(t0.getTime() + 8000) });
  check('fast clean solve (4s avg) → easy',  r.toRecord === FSRS.GRADE.easy);
  check('avgMoveTimeMs stored on state',     r.state.avgMoveTimeMs === 4000);

  // Medium: 2 moves in 50s → 25s avg → Good
  s = Drill.markSolveStart(Drill.start(PUZZLE_3), t0);
  r = Drill.attemptUserMove(s, 'e2g4', { now: new Date(t0.getTime() + 30000) });
  r = Drill.attemptUserMove(r.state, 'd1g4', { now: new Date(t0.getTime() + 50000) });
  check('medium clean solve (25s avg) → good', r.toRecord === FSRS.GRADE.good);

  // Slow: 2 moves in 150s → 75s avg → Hard
  s = Drill.markSolveStart(Drill.start(PUZZLE_3), t0);
  r = Drill.attemptUserMove(s, 'e2g4', { now: new Date(t0.getTime() + 70000) });
  r = Drill.attemptUserMove(r.state, 'd1g4', { now: new Date(t0.getTime() + 150000) });
  check('slow clean solve (75s avg) → hard',   r.toRecord === FSRS.GRADE.hard);

  // Boundary: exactly 10s avg → easy (strict > comparison)
  s = Drill.markSolveStart(Drill.start(PUZZLE_3), t0);
  r = Drill.attemptUserMove(s, 'e2g4', { now: new Date(t0.getTime() + 10000) });
  r = Drill.attemptUserMove(r.state, 'd1g4', { now: new Date(t0.getTime() + 20000) });
  check('exactly 10s avg → easy (boundary)',   r.toRecord === FSRS.GRADE.easy);

  // Boundary: exactly 60s avg → good (strict > comparison)
  s = Drill.markSolveStart(Drill.start(PUZZLE_3), t0);
  r = Drill.attemptUserMove(s, 'e2g4', { now: new Date(t0.getTime() + 50000) });
  r = Drill.attemptUserMove(r.state, 'd1g4', { now: new Date(t0.getTime() + 120000) });
  check('exactly 60s avg → good (boundary)',   r.toRecord === FSRS.GRADE.good);
}

section('Drill grading — timing does NOT override hint or wrong');
{
  const t0 = new Date('2026-01-01T12:00:00Z');
  // Hint + fast solve → still Hard (hint dominates)
  let s = Drill.markSolveStart(Drill.start(PUZZLE_3), t0);
  s = Drill.requestHint(s).state;
  let r = Drill.attemptUserMove(s, 'e2g4', { now: new Date(t0.getTime() + 1000) });
  r = Drill.attemptUserMove(r.state, 'd1g4', { now: new Date(t0.getTime() + 2000) });
  check('hint + fast → hard (hint wins)',  r.toRecord === FSRS.GRADE.hard);

  // Wrong + slow solve → still locked at Again from first wrong
  s = Drill.markSolveStart(Drill.start(PUZZLE_3), t0);
  r = Drill.attemptUserMove(s, 'a2a4', { now: new Date(t0.getTime() + 5000) });
  check('first wrong → again',             r.toRecord === FSRS.GRADE.again);
  r = Drill.attemptUserMove(r.state, 'e2g4', { now: new Date(t0.getTime() + 200000) });
  r = Drill.attemptUserMove(r.state, 'd1g4', { now: new Date(t0.getTime() + 400000) });
  check('wrong + slow finish → still again', r.state.gradeRecorded === FSRS.GRADE.again);
}

section('Drill grading — backward-compat: no timing engaged → Easy');
{
  // Existing tests above already cover this (no markSolveStart calls).
  // Add an explicit assertion to document the contract.
  let s = Drill.start(PUZZLE_3);
  let r = Drill.attemptUserMove(s, 'e2g4');
  r = Drill.attemptUserMove(r.state, 'd1g4');
  check('no markSolveStart → grade=easy',  r.toRecord === FSRS.GRADE.easy);
  check('no markSolveStart → avgMoveTimeMs=null',
    r.state.avgMoveTimeMs === null);
}

section('Drill.sanHistory — initialization + Drill.applyOpponentReply');
{
  // Issue #10: move-history strip. The state machine carries a SAN trail
  // populated by the caller (drill.js doesn't have a chess.js handle, so
  // the caller computes SAN and pipes it through). Wrong attempts are
  // explicitly NOT recorded.

  // Initial state: empty array, not shared across instances.
  const a = Drill.start(PUZZLE_3);
  const b = Drill.start(PUZZLE_3);
  check('start → sanHistory is []',          Array.isArray(a.sanHistory) && a.sanHistory.length === 0);
  check('start → sanHistory not shared',     a.sanHistory !== b.sanHistory);

  // attemptUserMove with userSan appends on success path.
  let r = Drill.attemptUserMove(a, 'e2g4', { userSan: 'Bxg4' });
  check('success+userSan → length 1',        r.state.sanHistory.length === 1);
  check('success+userSan → "Bxg4"',          r.state.sanHistory[0] === 'Bxg4');
  check('input state.sanHistory unchanged',  a.sanHistory.length === 0);

  // applyOpponentReply appends in sequence.
  let s = Drill.applyOpponentReply(r.state, 'Bxg4');
  check('opp reply → length 2',              s.sanHistory.length === 2);
  check('opp reply order preserved',         s.sanHistory[1] === 'Bxg4');
  check('input state untouched',             r.state.sanHistory.length === 1);

  // Final user move completes the puzzle and still appends.
  let r2 = Drill.attemptUserMove(s, 'd1g4', { userSan: 'Qxg4' });
  check('final user move appends',           r2.state.sanHistory.length === 3);
  check('final entry is Qxg4',               r2.state.sanHistory[2] === 'Qxg4');
  check('full sequence Bxg4/Bxg4/Qxg4',      JSON.stringify(r2.state.sanHistory) === JSON.stringify(['Bxg4','Bxg4','Qxg4']));
  check('puzzle complete after 3rd entry',   r2.state.complete === true);
}

section('Drill.sanHistory — wrong attempts NOT recorded');
{
  let s = Drill.start(PUZZLE_3);
  // Wrong move: must NOT touch sanHistory regardless of userSan.
  let r = Drill.attemptUserMove(s, 'a1a2', { userSan: 'Ra2' });
  check('wrong attempt → result=wrong',      r.result === 'wrong');
  check('wrong → sanHistory still []',       r.state.sanHistory.length === 0);
  // Recover: a correct move from the SAME (post-wrong) state appends normally.
  let r2 = Drill.attemptUserMove(r.state, 'e2g4', { userSan: 'Bxg4' });
  check('post-wrong correct → length 1',     r2.state.sanHistory.length === 1);
  check('post-wrong correct → "Bxg4"',       r2.state.sanHistory[0] === 'Bxg4');
}

section('Drill.sanHistory — backward-compat: legacy callers without userSan');
{
  // Existing tests above call attemptUserMove without opts.userSan, and
  // they expect to keep passing (147 of them). This section pins the
  // backward-compat contract explicitly.
  let s = Drill.start(PUZZLE_3);
  let r = Drill.attemptUserMove(s, 'e2g4');             // no opts
  check('no opts → no crash, success',       r.result === 'continue');
  check('no opts → sanHistory empty',        r.state.sanHistory.length === 0);
  let r2 = Drill.attemptUserMove(r.state, 'd1g4', {});  // empty opts
  check('empty opts → no crash, success',    r2.result === 'complete');
  check('empty opts → sanHistory empty',     r2.state.sanHistory.length === 0);

  // applyOpponentReply with no/non-string SAN is a no-op.
  let s0 = Drill.start(PUZZLE_3);
  check('applyOpp(undefined) → state ===',   Drill.applyOpponentReply(s0) === s0);
  check('applyOpp(null) → state ===',        Drill.applyOpponentReply(s0, null) === s0);
  check('applyOpp("") → state ===',          Drill.applyOpponentReply(s0, '') === s0);
  check('applyOpp(42) → state ===',          Drill.applyOpponentReply(s0, 42) === s0);
  // String input returns a NEW state (assign-shallow-merge contract).
  let s1 = Drill.applyOpponentReply(s0, 'd5');
  check('applyOpp("d5") → new state',        s1 !== s0);
  check('applyOpp("d5") → length 1',         s1.sanHistory.length === 1);
  check('input s0 untouched after apply',    s0.sanHistory.length === 0);
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
  check('hasSrsCard on unknown = false', Progress.hasSrsCard('xxx') === false);
  // isDue on unknown is FALSE: unknown puzzles aren't in the review
  // queue. Searched-and-drilled-cleanly puzzles get markSeen (no SRS
  // card), and we don't want them re-surfacing as due-today.
  check('isDue on unknown → false (no SRS card)', Progress.isDue('xxx') === false);
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

section('Progress.markSeen — completed without SRS scheduling');
{
  freshStorage();
  const e = Progress.markSeen('p1');
  check('returns the entry',                 e && e.completed === true);
  check('isCompleted=true after markSeen',   Progress.isCompleted('p1') === true);
  check('hasSrsCard=false after markSeen',   Progress.hasSrsCard('p1') === false);
  check('isDue=false after markSeen',        Progress.isDue('p1') === false);
  check('lastSeen is ISO',                   /^\d{4}-\d{2}-\d{2}T/.test(Progress.getEntry('p1').lastSeen));
  // Stats should show it as completed but NOT due
  const s = Progress.stats();
  check('stats.total=1',                     s.total === 1);
  check('stats.completed=1',                 s.completed === 1);
  check('stats.due=0 (no SRS card)',         s.due === 0);

  // Idempotent: second call updates lastSeen but doesn't introduce SRS
  const before = Progress.getEntry('p1').lastSeen;
  // small delay so ISO strings differ — bypass with a future Date
  Progress.markSeen('p1', new Date(Date.parse(before) + 60000));
  const after = Progress.getEntry('p1').lastSeen;
  check('repeat markSeen advances lastSeen', after !== before);
  check('repeat markSeen still no SRS',      Progress.hasSrsCard('p1') === false);
}

section('Progress: markSeen → recordReview transition (puzzle gets failed later)');
{
  freshStorage();
  Progress.markSeen('p2');
  check('initial: hasSrsCard=false', Progress.hasSrsCard('p2') === false);

  // User re-encounters the puzzle and fails — recordReview creates the SRS card
  Progress.recordReview('p2', FSRS.GRADE.again);
  check('after recordReview: hasSrsCard=true', Progress.hasSrsCard('p2') === true);
  check('after recordReview: isDue eventually false (1-day floor)',
    Progress.isDue('p2') === false);  // due=tomorrow today
  // Stats should now count it as in the queue (not due today, but scheduled)
  const s = Progress.stats();
  check('total=1', s.total === 1);
  check('completed=1', s.completed === 1);
}

section('Progress: recordReview → markSeen (re-drilling a clean re-attempt)');
{
  // recordReview creates an SRS card. A subsequent markSeen MUST NOT
  // wipe that card — the queue should keep its schedule. (User clicks
  // a previously-failed puzzle from search and solves it; the queue
  // path goes through recordReview, but if a code path ever called
  // markSeen on a scheduled card, the schedule should survive.)
  freshStorage();
  Progress.recordReview('p3', FSRS.GRADE.again);
  const cardBefore = JSON.stringify(Progress.getCard('p3'));
  Progress.markSeen('p3');
  const cardAfter = JSON.stringify(Progress.getCard('p3'));
  check('markSeen preserves existing SRS card', cardBefore === cardAfter);
  check('still hasSrsCard',                     Progress.hasSrsCard('p3') === true);
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
  // Corrupt shapes that previously slipped through and persisted, then
  // got rejected by load() on next read — net effect was a silent local
  // data wipe. These should reject at the write boundary now.
  freshStorage();
  Progress.markSeen('keep');
  check('import {positions:[...]} rejected (array)',
    Progress.importData({ positions: [{ bad: true }] }) === false);
  check('  → existing data preserved', Progress.isCompleted('keep'));
  check('import {positions:"str"} rejected (non-object)',
    Progress.importData({ positions: 'no' }) === false);
  check('  → existing data preserved', Progress.isCompleted('keep'));
  check('import {positions:null} rejected',
    Progress.importData({ positions: null }) === false);
  check('  → existing data preserved', Progress.isCompleted('keep'));
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

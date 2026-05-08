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
  check('solutionRevealed=false', s.solutionRevealed === false);
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

section('Drill.revealSolution');
{
  // From clean state — locks Again, returns full remaining moves.
  let s = Drill.start(PUZZLE_3);
  let r = Drill.revealSolution(s);
  check('locks gradeRecorded=Again',     r.state.gradeRecorded === FSRS.GRADE.again);
  check('toRecord=Again on first call',  r.toRecord === FSRS.GRADE.again);
  check('solutionRevealed=true',         r.state.solutionRevealed === true);
  check('remainingMoves = full slice',   JSON.stringify(r.remainingMoves) === JSON.stringify(['e2g4','h3g4','d1g4']));
  check('not yet complete',              r.state.complete === false);
  // Idempotent: second call doesn't double-record.
  let r2 = Drill.revealSolution(r.state);
  check('second call: toRecord=null',    r2.toRecord === null);
  check('second call: still revealed',   r2.state.solutionRevealed === true);

  // From wrong-attempt state — Again was already locked by the wrong path,
  // so revealSolution doesn't double-record.
  let sw = Drill.start(PUZZLE_3);
  let wr = Drill.attemptUserMove(sw, 'a1a2');  // illegal-as-solution
  check('after wrong: gradeRecorded=Again',   wr.state.gradeRecorded === FSRS.GRADE.again);
  let rev = Drill.revealSolution(wr.state);
  check('reveal-after-wrong: toRecord=null',  rev.toRecord === null);
  check('reveal-after-wrong: still locked',   rev.state.gradeRecorded === FSRS.GRADE.again);
  check('reveal-after-wrong: revealed=true',  rev.state.solutionRevealed === true);
  check('reveal-after-wrong: wrongAttempts preserved', rev.state.wrongAttempts === 1);

  // From hint-only state — hint doesn't lock the grade, so revealSolution
  // is the FIRST locker. Returns toRecord=Again.
  let sh = Drill.start(PUZZLE_3);
  sh = Drill.requestHint(sh).state;
  check('hint did not lock',                  sh.gradeRecorded === null);
  let rh = Drill.revealSolution(sh);
  check('reveal-after-hint: toRecord=Again',  rh.toRecord === FSRS.GRADE.again);
  check('reveal-after-hint: hintUsed preserved', rh.state.hintUsed === true);

  // Mid-puzzle: one correct user move played → currentMoveIdx=2. Reveal
  // returns the slice from idx 2 (just the final user move 'd1g4').
  let sm = Drill.start(PUZZLE_3);
  sm = Drill.attemptUserMove(sm, 'e2g4').state;
  check('after correct move: currentMoveIdx=2', sm.currentMoveIdx === 2);
  let rm = Drill.revealSolution(sm);
  check('mid-puzzle: remainingMoves slice',     JSON.stringify(rm.remainingMoves) === JSON.stringify(['d1g4']));
  check('mid-puzzle: locks Again',              rm.toRecord === FSRS.GRADE.again);

  // Already-complete state — no-op.
  let sc = Drill.start(PUZZLE_1);  // 1-move puzzle
  sc = Drill.attemptUserMove(sc, 'c6g2').state;
  check('1-move puzzle complete',               sc.complete === true);
  let rc = Drill.revealSolution(sc);
  check('reveal on complete: toRecord=null',    rc.toRecord === null);
  check('reveal on complete: empty remaining',  rc.remainingMoves.length === 0);
  check('reveal on complete: solutionRevealed unchanged',
        rc.state.solutionRevealed === sc.solutionRevealed);
}

section('Drill.revealSolution → autoplay-equivalent feeds remainingMoves through attemptUserMove');
{
  // Caller (UI) is expected to drive remainingMoves back into attemptUserMove.
  // Verify that the final attemptUserMove's grade-locking is a no-op
  // (gradeRecorded stays Again) and the puzzle reaches complete=true.
  let s = Drill.start(PUZZLE_3);
  let r = Drill.revealSolution(s);
  s = r.state;
  // remainingMoves = ['e2g4','h3g4','d1g4']. UI feeds the user-side moves
  // (idx 0 and 2) into attemptUserMove; attemptUserMove auto-advances past
  // the opp move at idx 1.
  let m1 = Drill.attemptUserMove(s, 'e2g4', { userSan: 'Bxg4' });
  check('first reveal-step: continue',          m1.result === 'continue');
  check('opponentReply returned',               m1.opponentReply === 'h3g4');
  check('grade still Again after 1st step',     m1.state.gradeRecorded === FSRS.GRADE.again);
  let m2 = Drill.attemptUserMove(m1.state, 'd1g4', { userSan: 'Qxg4' });
  check('second reveal-step: complete',         m2.result === 'complete');
  check('grade STILL Again on completion',      m2.state.gradeRecorded === FSRS.GRADE.again);
  check('toRecord=null on completion (locked)', m2.toRecord === null);
  check('solutionRevealed survives autoplay',   m2.state.solutionRevealed === true);
  check('puzzle marked complete',               m2.state.complete === true);
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

section('Drill.attemptUserMove — alt-mate: any checkmate completes the puzzle');
{
  // Per Lichess puzzle docs the canonical rule is that all player moves
  // are "only moves" except on the final move, where any checkmate is
  // accepted. We extend that to ANY ply: once mate is delivered the
  // game is over regardless of which line was canonical, so a faster
  // mid-puzzle mate also counts. drill.js doesn't have chess.js, so the
  // UI passes opts.isCheckmate based on chess.in_checkmate() post-move.
  // The state machine doesn't validate move legality (caller's job) —
  // any UCI string drives the path here.

  // Single-move mateIn1 puzzle, alternative mate UCI (not c6g2).
  let s = Drill.start(PUZZLE_1);
  let r = Drill.attemptUserMove(s, 'c6c2', { isCheckmate: true });
  check('alt-mate at last ply → result=complete',  r.result === 'complete');
  check('alt-mate has no opp reply',               r.opponentReply === null);
  check('alt-mate state.complete=true',            r.state.complete === true);
  check('alt-mate idx jumps past end',             r.state.currentMoveIdx === s.solutionUci.length);
  check('alt-mate clean → toRecord=easy',          r.toRecord === FSRS.GRADE.easy);
  check('alt-mate gradeRecorded=easy',             r.state.gradeRecorded === FSRS.GRADE.easy);
  check('alt-mate wrongAttempts NOT incremented',  r.state.wrongAttempts === 0);

  // Multi-move puzzle, alt-mate found at move 0 (skips remaining solution).
  let s3 = Drill.start(PUZZLE_3);
  let r3 = Drill.attemptUserMove(s3, 'd1d8', { isCheckmate: true });
  check('mid-puzzle alt-mate → result=complete',   r3.result === 'complete');
  check('mid-puzzle alt-mate idx=length',          r3.state.currentMoveIdx === 3);
  check('mid-puzzle alt-mate has no opp reply',    r3.opponentReply === null);
  check('mid-puzzle alt-mate state complete',      r3.state.complete === true);

  // SAN appended on alt-mate path — same contract as the canonical
  // success path.
  let rSan = Drill.attemptUserMove(s, 'c6c2', { isCheckmate: true, userSan: 'Qc2#' });
  check('alt-mate appends userSan',                rSan.state.sanHistory.length === 1);
  check('alt-mate sanHistory[0] === userSan',      rSan.state.sanHistory[0] === 'Qc2#');

  // Hint-then-alt-mate: existing hintUsed flag still penalizes.
  let sH = Drill.start(PUZZLE_1);
  sH = Drill.requestHint(sH).state;
  let rH = Drill.attemptUserMove(sH, 'c6c2', { isCheckmate: true });
  check('hint-then-alt-mate → toRecord=hard',      rH.toRecord === FSRS.GRADE.hard);
  check('hint-then-alt-mate gradeRecorded=hard',   rH.state.gradeRecorded === FSRS.GRADE.hard);

  // Wrong-then-alt-mate: Again was already locked on the first wrong
  // (canonical first-wrong-locks-Again rule). The eventual alt-mate
  // completes the puzzle but does NOT re-record — toRecord=null and
  // gradeRecorded stays at Again. Caller MUST NOT double-record.
  let sW = Drill.start(PUZZLE_3);
  let rW1 = Drill.attemptUserMove(sW, 'a1a1');                  // wrong, no mate
  check('first wrong → result=wrong',              rW1.result === 'wrong');
  check('first wrong locks Again',                 rW1.toRecord === FSRS.GRADE.again);
  let rW2 = Drill.attemptUserMove(rW1.state, 'd1d8', { isCheckmate: true });
  check('after-wrong alt-mate → result=complete',  rW2.result === 'complete');
  check('after-wrong alt-mate toRecord=null',      rW2.toRecord === null);
  check('after-wrong alt-mate stays Again',        rW2.state.gradeRecorded === FSRS.GRADE.again);
  check('after-wrong wrongAttempts not bumped again', rW2.state.wrongAttempts === 1);
}

section('Drill.attemptUserMove — alt-mate: regression guards (false / missing flag)');
{
  // Missing flag, false flag, empty opts, no opts — all hit the legacy
  // wrong path. This locks the backward-compat contract: callers that
  // don't pass isCheckmate (legacy code, tests above this section) keep
  // the original wrong-move behavior.
  let s = Drill.start(PUZZLE_1);

  let rNoFlag  = Drill.attemptUserMove(s, 'c6c2');
  check('no opts → wrong path',                    rNoFlag.result === 'wrong');
  check('no opts → wrongAttempts=1',               rNoFlag.state.wrongAttempts === 1);

  let rEmpty   = Drill.attemptUserMove(s, 'c6c2', {});
  check('empty opts → wrong path',                 rEmpty.result === 'wrong');

  let rFalse   = Drill.attemptUserMove(s, 'c6c2', { isCheckmate: false });
  check('isCheckmate=false → wrong path',          rFalse.result === 'wrong');

  let rUndef   = Drill.attemptUserMove(s, 'c6c2', { isCheckmate: undefined });
  check('isCheckmate=undefined → wrong path',      rUndef.result === 'wrong');

  // Canonical match still wins via the normal path even with
  // isCheckmate=true (flag is harmless — UCI matches expected, never
  // hits the alt-mate branch). Locks the "flag passes through cleanly"
  // contract from the UI side.
  let rMatch = Drill.attemptUserMove(s, 'c6g2', { isCheckmate: true });
  check('canonical match + flag → result=complete', rMatch.result === 'complete');
  check('canonical match + flag → toRecord=easy',   rMatch.toRecord === FSRS.GRADE.easy);

  // Already-complete short-circuits regardless of isCheckmate.
  let sDone = Drill.attemptUserMove(s, 'c6g2').state;
  let rDone = Drill.attemptUserMove(sDone, 'b1b1', { isCheckmate: true });
  check('already-complete + alt-mate → already_complete',
        rDone.result === 'already_complete');
  check('already-complete + alt-mate → toRecord=null', rDone.toRecord === null);
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

section('Progress.stats: state distribution (issue #9)');
{
  freshStorage();
  // Three cards in different FSRS states. After grade=again from new the
  // card moves to learning; after grade=easy it goes straight to review.
  // After grade=again from review it goes to relearning.
  Progress.recordReview('newCard',  FSRS.GRADE.easy);   // → review
  Progress.recordReview('learnCard', FSRS.GRADE.again); // → learning
  Progress.recordReview('relearn',  FSRS.GRADE.easy);   // → review
  Progress.recordReview('relearn',  FSRS.GRADE.again);  // → relearning
  const s = Progress.stats();
  check('states.review = 1',     s.states.review === 1);
  check('states.learning = 1',   s.states.learning === 1);
  check('states.relearning = 1', s.states.relearning === 1);
  check('states.new = 0',        s.states.new === 0);
}

section('Progress.stats: markSeen-only entries bucket as "new"');
{
  freshStorage();
  Progress.markSeen('clean');           // no .srs at all
  Progress.recordReview('reviewed', FSRS.GRADE.easy);
  const s = Progress.stats();
  check('markSeen → states.new += 1', s.states.new === 1);
  check('recordReview → states.review += 1', s.states.review === 1);
  check('total = 2', s.total === 2);
}

section('Progress.stats: lapse rate (issue #9)');
{
  freshStorage();
  // No reviews yet → lapseRate is null (no division-by-zero surprise).
  const s0 = Progress.stats();
  check('no reviews → lapseRate=null', s0.lapseRate === null);
  check('totalReps=0', s0.totalReps === 0);
  check('totalLapses=0', s0.totalLapses === 0);

  // Two cards reviewed; one of them eventually fails. FSRS counts reps on
  // non-Again moves (including the first review of a new card) and lapses
  // on every Again move that lands on an already-graduated card.
  Progress.recordReview('p1', FSRS.GRADE.easy);   // p1: new→review,    reps=1
  Progress.recordReview('p2', FSRS.GRADE.easy);   // p2: new→review,    reps=1
  Progress.recordReview('p2', FSRS.GRADE.easy);   // p2: review+easy,   reps=2
  Progress.recordReview('p2', FSRS.GRADE.again);  // p2: review+again,  lapses=1 (reps unchanged)
  const s = Progress.stats();
  check('totalReps=3',   s.totalReps === 3);
  check('totalLapses=1', s.totalLapses === 1);
  check('lapseRate≈0.333', Math.abs(s.lapseRate - 1/3) < 1e-9);
}

section('Progress.stats: recentActivity bucketed last 7 days');
{
  freshStorage();
  // Manufacture entries with specific lastSeen timestamps spread across
  // the past 10 days (some inside the 7-day window, some outside).
  const now = new Date('2025-06-15T12:00:00Z');
  const dayMs = 86400000;
  const data = { positions: {} };
  // Inside window (last 7 days = 2025-06-09 .. 2025-06-15):
  //   p1 lastSeen today (2025-06-15)
  //   p2 lastSeen today
  //   p3 lastSeen 6 days ago (2025-06-09 — first day of window)
  //   p4 lastSeen 3 days ago (2025-06-12)
  // Outside window:
  //   p5 lastSeen 8 days ago (2025-06-07)
  data.positions.p1 = { completed: true, lastSeen: new Date(now - 0 * dayMs).toISOString() };
  data.positions.p2 = { completed: true, lastSeen: new Date(now - 0 * dayMs).toISOString() };
  data.positions.p3 = { completed: true, lastSeen: new Date(now - 6 * dayMs).toISOString() };
  data.positions.p4 = { completed: true, lastSeen: new Date(now - 3 * dayMs).toISOString() };
  data.positions.p5 = { completed: true, lastSeen: new Date(now - 8 * dayMs).toISOString() };
  Progress.importData(data);

  const s = Progress.stats(now);
  check('recentActivity length 7',          s.recentActivity.length === 7);
  // Order: oldest first, ending today. Index 6 = today, index 0 = today-6.
  // localDateString uses LOCAL time; the test fixture's UTC dates may shift
  // ±1 day depending on the test runner's TZ. So compare against
  // FSRS.localDateString(now-N*dayMs) for each slot.
  for (let i = 0; i < 7; i++) {
    const expectedDate = FSRS.localDateString(new Date(now - (6 - i) * dayMs));
    check('recentActivity[' + i + '].date = ' + expectedDate,
          s.recentActivity[i].date === expectedDate);
  }
  // Counts: today should be 2 (p1+p2), today-3 should be 1 (p4), today-6
  // should be 1 (p3), other slots 0.
  const todayCount = s.recentActivity[6].count;
  const day3Count  = s.recentActivity[3].count;
  const day6Count  = s.recentActivity[0].count;
  check('today bucket count = 2', todayCount === 2);
  check('3-days-ago bucket count = 1', day3Count === 1);
  check('6-days-ago bucket count = 1', day6Count === 1);
  // Out-of-window entry shouldn't appear anywhere.
  let totalIn7 = 0;
  for (let i = 0; i < 7; i++) totalIn7 += s.recentActivity[i].count;
  check('out-of-window entry not bucketed', totalIn7 === 4);
}

section('Progress.stats: streak fields default to zero on fresh storage');
{
  freshStorage();
  const s = Progress.stats();
  check('currentStreak=0',  s.currentStreak === 0);
  check('longestStreak=0',  s.longestStreak === 0);
  check('lastReviewDay=null', s.lastReviewDay === null);
}

section('Progress.recordReview streak: same-day review does NOT bump');
{
  freshStorage();
  const day1 = new Date('2025-06-15T08:00:00');
  const day1later = new Date('2025-06-15T18:00:00');
  Progress.recordReview('a', FSRS.GRADE.easy, day1);
  Progress.recordReview('b', FSRS.GRADE.easy, day1later);
  const s = Progress.stats(day1later);
  check('same-day pair → currentStreak=1', s.currentStreak === 1);
  check('longestStreak=1', s.longestStreak === 1);
  check('lastReviewDay set', s.lastReviewDay === FSRS.localDateString(day1));
}

section('Progress.recordReview streak: consecutive-day reviews increment');
{
  freshStorage();
  const day1 = new Date('2025-06-13T12:00:00');
  const day2 = new Date('2025-06-14T12:00:00');
  const day3 = new Date('2025-06-15T12:00:00');
  Progress.recordReview('a', FSRS.GRADE.easy, day1);
  Progress.recordReview('b', FSRS.GRADE.easy, day2);
  Progress.recordReview('c', FSRS.GRADE.easy, day3);
  const s = Progress.stats(day3);
  check('3 consecutive days → currentStreak=3', s.currentStreak === 3);
  check('longestStreak=3', s.longestStreak === 3);
}

section('Progress.recordReview streak: gap resets currentStreak to 1');
{
  freshStorage();
  const day1 = new Date('2025-06-10T12:00:00');
  const day2 = new Date('2025-06-11T12:00:00');
  const day3 = new Date('2025-06-15T12:00:00');  // 4-day gap from day2
  Progress.recordReview('a', FSRS.GRADE.easy, day1);
  Progress.recordReview('b', FSRS.GRADE.easy, day2);
  Progress.recordReview('c', FSRS.GRADE.easy, day3);
  const s = Progress.stats(day3);
  check('post-gap currentStreak=1', s.currentStreak === 1);
  // Previous max (day1 → day2 was a streak of 2) should survive in longest.
  check('longestStreak preserved at 2', s.longestStreak === 2);
}

section('Progress.stats: streak displays 0 when broken (gap > 1 day from today)');
{
  freshStorage();
  const day1 = new Date('2025-06-10T12:00:00');
  const day2 = new Date('2025-06-11T12:00:00');
  Progress.recordReview('a', FSRS.GRADE.easy, day1);
  Progress.recordReview('b', FSRS.GRADE.easy, day2);
  // "Now" is 5 days after day2 — streak is broken from the user's POV.
  const fiveLater = new Date('2025-06-16T12:00:00');
  const s = Progress.stats(fiveLater);
  check('display currentStreak=0 (broken)', s.currentStreak === 0);
  check('longestStreak still 2',            s.longestStreak === 2);
  check('lastReviewDay preserved',          s.lastReviewDay === FSRS.localDateString(day2));
}

section('Progress.stats: streak still alive when today === lastReviewDay+1');
{
  freshStorage();
  const day1 = new Date('2025-06-13T12:00:00');
  const day2 = new Date('2025-06-14T12:00:00');
  const day3 = new Date('2025-06-15T08:00:00');  // morning of day after day2 — streak alive
  Progress.recordReview('a', FSRS.GRADE.easy, day1);
  Progress.recordReview('b', FSRS.GRADE.easy, day2);
  // No review on day3 yet — but streak should display as 2 (still extendable).
  const s = Progress.stats(day3);
  check('currentStreak=2 (alive on day-after)', s.currentStreak === 2);
}

section('Progress.recordReview streak: backward-compat with pre-meta data');
{
  freshStorage();
  // Simulate old data: positions only, no meta.
  Progress.importData({ positions: { p1: { completed: true, lastSeen: '2025-06-14T12:00:00.000Z' } } });
  const before = Progress.exportData();
  check('imported data has no meta', !before.meta);
  // Trigger a review — meta should appear.
  Progress.recordReview('p2', FSRS.GRADE.easy, new Date('2025-06-15T12:00:00'));
  const after = Progress.exportData();
  check('meta initialized after first recordReview', !!after.meta);
  check('lastReviewDay set', after.meta.lastReviewDay === FSRS.localDateString(new Date('2025-06-15T12:00:00')));
  check('currentStreak=1 (no prior streak data)', after.meta.currentStreak === 1);
  check('longestStreak=1', after.meta.longestStreak === 1);
}

section('Progress.markSeen: does NOT bump streak (recordReview-only per spec)');
{
  freshStorage();
  Progress.markSeen('p1', new Date('2025-06-15T12:00:00'));
  const s = Progress.stats(new Date('2025-06-15T12:00:00'));
  check('markSeen alone → currentStreak=0', s.currentStreak === 0);
  check('lastReviewDay still null',         s.lastReviewDay === null);
  check('longestStreak=0',                  s.longestStreak === 0);
}

section('Progress.recordReview streak: clock-backwards (delta < 0) treated as gap');
{
  freshStorage();
  const dayLate  = new Date('2025-06-15T12:00:00');
  const dayEarly = new Date('2025-06-14T12:00:00');  // earlier than the recorded
  Progress.recordReview('a', FSRS.GRADE.easy, dayLate);
  // Now record with an earlier date — clock got moved back, OR a sync arrived
  // with stale data. dayDelta(2025-06-15, 2025-06-14) = -1, neither 0 nor 1.
  Progress.recordReview('b', FSRS.GRADE.easy, dayEarly);
  const data = Progress.exportData();
  // Streak resets to 1 on the new (earlier) day — honest "you reviewed today,
  // your old streak is gone." Better than silently keeping a confusing count.
  check('currentStreak reset to 1', data.meta.currentStreak === 1);
  check('lastReviewDay = the earlier day', data.meta.lastReviewDay === FSRS.localDateString(dayEarly));
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

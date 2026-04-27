/**
 * drill.js — Pure state machine for one puzzle drilling session.
 *
 * Side-effect-free: takes a state, returns new state plus instructions for
 * the caller (which board move to play next, which grade to record). The
 * caller (UI code in index.html) handles chess.js move execution, board
 * animation, and progress.recordReview persistence.
 *
 * Grade-recording rule (lifted from MistakeLab's tactic flow):
 *   - First wrong attempt → record `Again` immediately (so users who
 *     blunder and navigate away still get graded as failed).
 *   - On clean completion (no wrongs ever) → record `Easy` if no hint used,
 *     `Hard` if hint used.
 *   - Once recorded, locked: subsequent wrongs/hints don't re-record.
 *
 * Solution UCI array convention: alternating user / opponent moves starting
 * with the user's first move (matching Han Schut's PGN Annotator format).
 *   moves[0] = user's move
 *   moves[1] = opponent's reply (auto-played)
 *   moves[2] = user's next move
 *   ...
 *
 * Dual-mode load (Node + browser):
 *   Node:    const Drill = require('../lib/drill');
 *   Browser: <script src="lib/drill.js"></script>  (defines window.Drill)
 */
(function (root) {
  'use strict';

  var FSRS = (typeof module !== 'undefined' && module.exports)
    ? require('./fsrs')
    : root.FSRS;

  // ─── state factory ──────────────────────────────────────────────────────
  function start(opts) {
    if (!opts || !opts.puzzleId || !opts.fen || !Array.isArray(opts.solutionUci)) {
      throw new Error('Drill.start requires { puzzleId, fen, solutionUci }');
    }
    if (opts.solutionUci.length === 0) {
      throw new Error('Drill.start: solutionUci is empty');
    }
    return {
      puzzleId: opts.puzzleId,
      fen: opts.fen,
      solutionUci: opts.solutionUci.slice(),
      currentMoveIdx: 0,         // index into solutionUci of the next expected move
      hintLevel: 0,              // 0=none, 1=piece shown, 2=full move shown
      wrongAttempts: 0,
      hintUsed: false,
      complete: false,
      gradeRecorded: null        // FSRS grade once locked; null until first record
    };
  }

  // Compute what grade SHOULD be recorded if the puzzle ended at this state.
  // Used at completion time. First-wrong path uses GRADE.again directly.
  function computeGradeAtCompletion(state) {
    return FSRS.gradeForAttempt({
      wrong: state.wrongAttempts > 0,
      hintUsed: state.hintUsed
    });
  }

  // Internal: locks the grade if not already locked, returns either
  // the newly-locked grade (for the caller to persist) or null.
  function lockGrade(state, grade) {
    if (state.gradeRecorded !== null) return { state: state, toRecord: null };
    return {
      state: assign(state, { gradeRecorded: grade }),
      toRecord: grade
    };
  }

  // ─── attempts ───────────────────────────────────────────────────────────
  // Caller passes the user's UCI move; we classify and return:
  //   { state, result, expected?, opponentReply?, toRecord? }
  // result ∈ 'wrong' | 'continue' | 'complete' | 'already_complete'
  //
  // 'continue' means: keep drilling. If opponentReply is set, the caller
  // should play that move on the board automatically; the user's next
  // expected move is still at the post-advance currentMoveIdx.
  // 'complete' means: puzzle solved. Caller should show feedback, animate
  // the last move, and call progress.recordReview if toRecord !== null.
  function attemptUserMove(state, uciMove) {
    if (state.complete) {
      return { state: state, result: 'already_complete', toRecord: null };
    }
    var expected = state.solutionUci[state.currentMoveIdx];

    // Wrong move: increment counter, lock Again on first wrong.
    if (uciMove !== expected) {
      var wrongState = assign(state, {
        wrongAttempts: state.wrongAttempts + 1
      });
      var locked = lockGrade(wrongState, FSRS.GRADE.again);
      return {
        state: locked.state,
        result: 'wrong',
        expected: expected,
        toRecord: locked.toRecord
      };
    }

    // Correct: advance past this move, then auto-advance past opp reply (if any).
    var newIdx = state.currentMoveIdx + 1;
    var opponentReply = null;
    if (newIdx < state.solutionUci.length) {
      opponentReply = state.solutionUci[newIdx];
      newIdx = newIdx + 1;
    }
    var complete = newIdx >= state.solutionUci.length;
    var nextState = assign(state, {
      currentMoveIdx: newIdx,
      complete: complete
    });

    var toRecord = null;
    if (complete) {
      var grade = computeGradeAtCompletion(nextState);
      var lockedC = lockGrade(nextState, grade);
      nextState = lockedC.state;
      toRecord = lockedC.toRecord;
    }

    return {
      state: nextState,
      result: complete ? 'complete' : 'continue',
      opponentReply: opponentReply,
      toRecord: toRecord
    };
  }

  // ─── hints ──────────────────────────────────────────────────────────────
  // Returns { state, hintInfo }. hintInfo describes what the UI should reveal:
  //   level 1 → { fromSquare: 'e2' }                (piece to move)
  //   level 2 → { fromSquare: 'e2', toSquare: 'g4' } (full move)
  // After level 2, further calls are no-ops.
  function requestHint(state) {
    if (state.complete) {
      return { state: state, hintInfo: null };
    }
    var newLevel = Math.min(2, state.hintLevel + 1);
    var nextState = assign(state, {
      hintLevel: newLevel,
      hintUsed: true
    });
    return { state: nextState, hintInfo: hintInfoFor(nextState, newLevel) };
  }

  function hintInfoFor(state, level) {
    var expected = state.solutionUci[state.currentMoveIdx];
    if (!expected || level <= 0) return null;
    var info = { fromSquare: expected.slice(0, 2) };
    if (level >= 2) info.toSquare = expected.slice(2, 4);
    return info;
  }

  // ─── helpers ────────────────────────────────────────────────────────────
  // Shallow-merge — produces a new state object without mutating input.
  // Equivalent to {...a, ...b} but ES5-safe.
  function assign(a, b) {
    var out = {};
    var k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    return out;
  }

  // Convenience: which side moves first in this puzzle? Useful for board
  // orientation. Returns 'w' or 'b' from the FEN. Static — doesn't change
  // with state.
  function userColor(state) {
    var parts = state.fen.split(' ');
    return parts[1] === 'b' ? 'b' : 'w';
  }

  var api = {
    start: start,
    attemptUserMove: attemptUserMove,
    requestHint: requestHint,
    hintInfoFor: hintInfoFor,
    computeGradeAtCompletion: computeGradeAtCompletion,
    userColor: userColor
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Drill = api;
  }
})(typeof self !== 'undefined' ? self : this);

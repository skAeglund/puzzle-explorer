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
      gradeRecorded: null,       // FSRS grade once locked; null until first record
      // Timing fields. solveStartedAt is set externally via markSolveStart()
      // when the user can actually first move (i.e. AFTER any pre-puzzle
      // blunder animation in the UI). null = timing not engaged → grade
      // falls back to legacy behavior (clean=Easy). avgMoveTimeMs is
      // populated on completion by attemptUserMove for the UI to read.
      solveStartedAt: null,
      avgMoveTimeMs: null,
      // SAN trail for the move-history strip (issue #10). Strings only,
      // appended in play order — user moves on attemptUserMove's success
      // path, opponent replies on applyOpponentReply. Wrong attempts are
      // never pushed (the spec is explicit). drill.js doesn't have a
      // chess.js handle, so SAN must be supplied by the caller; missing
      // SAN means no append, which is fine for legacy callers / tests
      // that don't care about the strip.
      sanHistory: [],
      // Flipped to true by Drill.revealSolution. Lets the UI render a
      // distinct completion message ("Solution shown") and gives tests
      // a positive signal that the give-up path was taken (vs. the user
      // simply happening to play the right moves after a Again-lock).
      solutionRevealed: false
    };
  }

  // Mark the moment the user can first move. Idempotent — only the first
  // call wins, so accidental double-calls (e.g. blunder anim + immediate
  // fallback) don't reset the timer mid-thinking. Caller passes `now`
  // (Date) for testability; defaults to current time.
  function markSolveStart(state, now) {
    if (state.solveStartedAt !== null) return state;
    var ms = (now instanceof Date && Number.isFinite(now.getTime()))
      ? now.getTime() : Date.now();
    return assign(state, { solveStartedAt: ms });
  }

  // Number of user moves the puzzle requires (solution moves alternate
  // user / opp starting with the user, so user gets ceil(N/2) of N).
  function userMoveCount(state) {
    return Math.ceil(state.solutionUci.length / 2);
  }

  // Average per-user-move thinking time at the moment of `now`. Returns
  // null if timing wasn't engaged (markSolveStart never called) or if
  // the elapsed delta is non-finite/negative.
  // NOTE: includes the auto-played opponent reply animation + 400ms
  // delay between user moves. For a 3-move puzzle that's ~0.65s total
  // overhead, which is noise against the 10s/60s thresholds. If the
  // thresholds get tuned tighter later, switch to per-turn timing
  // (markSolveStart-equivalent after each opp reply settles).
  function computeAvgMoveTimeMs(state, now) {
    if (!state.solveStartedAt) return null;
    var nowMs = (now instanceof Date && Number.isFinite(now.getTime()))
      ? now.getTime() : Date.now();
    var elapsed = nowMs - state.solveStartedAt;
    var n = userMoveCount(state);
    if (n <= 0 || !Number.isFinite(elapsed) || elapsed < 0) return null;
    return elapsed / n;
  }

  // Compute what grade SHOULD be recorded if the puzzle ended at this state.
  // Used at completion time. First-wrong path uses GRADE.again directly.
  // opts.avgMoveTimeMs (number|null) drives the time-based Easy/Good/Hard
  // split for clean solves. Without it, falls through to legacy Easy.
  function computeGradeAtCompletion(state, opts) {
    opts = opts || {};
    return FSRS.gradeForAttempt({
      wrong: state.wrongAttempts > 0,
      hintUsed: state.hintUsed,
      avgMoveTimeMs: opts.avgMoveTimeMs
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
  function attemptUserMove(state, uciMove, opts) {
    opts = opts || {};
    if (state.complete) {
      return { state: state, result: 'already_complete', toRecord: null };
    }
    var expected = state.solutionUci[state.currentMoveIdx];

    // UCI mismatch — almost always wrong, with one canonical exception:
    // alternative checkmate. Per Lichess's own puzzle docs, all player
    // moves are "only moves" except that on the final move any move
    // delivering mate is accepted. We extend that to ANY ply: once the
    // user delivers checkmate the game is over regardless of which mate
    // the canonical line chose, so a mid-puzzle alt-mate (faster than
    // the recorded solution) also short-circuits to a clean completion.
    //
    // drill.js has no chess.js handle, so the UI computes the mate flag
    // after chess.move() succeeds (chess.in_checkmate() is the post-move
    // oracle) and threads it through opts. Missing/false → legacy
    // wrong-path runs, so legacy callers and existing tests are
    // unaffected.
    if (uciMove !== expected) {
      if (opts.isCheckmate) {
        // Alt-mate completion. Append SAN if supplied, advance the cursor
        // past the end so review-nav and any other consumers see a
        // consistent "puzzle is over" state, set complete=true, and run
        // the same time-based grade computation the canonical complete
        // path uses. lockGrade is a no-op if a prior wrong already
        // locked Again — toRecord stays null and the caller won't
        // double-record. No opp reply: mate ends the game.
        var mateSanHistory = (typeof opts.userSan === 'string' && opts.userSan)
          ? state.sanHistory.concat([opts.userSan])
          : state.sanHistory;
        var mateState = assign(state, {
          currentMoveIdx: state.solutionUci.length,
          complete: true,
          sanHistory: mateSanHistory
        });
        var mateAvgMs = computeAvgMoveTimeMs(mateState, opts.now);
        mateState = assign(mateState, { avgMoveTimeMs: mateAvgMs });
        var mateGrade = computeGradeAtCompletion(mateState, { avgMoveTimeMs: mateAvgMs });
        var mateLocked = lockGrade(mateState, mateGrade);
        return {
          state: mateLocked.state,
          result: 'complete',
          opponentReply: null,
          toRecord: mateLocked.toRecord
        };
      }
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
    // SAN trail: append the user's SAN if the caller supplied one. Missing
    // SAN means no append (legacy callers / tests). Wrong-path doesn't
    // reach this code, which matches the spec: only successful moves are
    // recorded. Opp reply isn't appended here — the caller plays the opp
    // move on chess.js (which is where SAN is computed) and then calls
    // Drill.applyOpponentReply with the resulting SAN.
    var nextSanHistory = (typeof opts.userSan === 'string' && opts.userSan)
      ? state.sanHistory.concat([opts.userSan])
      : state.sanHistory;
    var nextState = assign(state, {
      currentMoveIdx: newIdx,
      complete: complete,
      sanHistory: nextSanHistory
    });

    var toRecord = null;
    if (complete) {
      // Compute avg per-move thinking time at this exact moment, store it
      // on the state (UI reads it for the completion message), and pass
      // it into the grade decision. Returns null if timing wasn't engaged.
      var avgMs = computeAvgMoveTimeMs(nextState, opts.now);
      nextState = assign(nextState, { avgMoveTimeMs: avgMs });
      var grade = computeGradeAtCompletion(nextState, { avgMoveTimeMs: avgMs });
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

  // ─── opponent reply SAN tracking ────────────────────────────────────────
  // Pure SAN-recording for the move-history strip (issue #10). The caller
  // plays the opp's UCI on chess.js (driven by attemptUserMove's
  // opponentReply return), gets a SAN string back, and pipes it through
  // here so sanHistory stays in sequence with the user's moves.
  //
  // Does NOT advance currentMoveIdx — attemptUserMove already auto-advanced
  // past the opponent move. This is a strictly additive recorder, deliberately
  // separate from any state transitions. Missing/non-string SAN is a no-op
  // so callers can pass through unconditionally without guarding.
  function applyOpponentReply(state, opponentSan) {
    if (typeof opponentSan !== 'string' || !opponentSan) return state;
    return assign(state, {
      sanHistory: state.sanHistory.concat([opponentSan])
    });
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

  // ─── reveal solution (give-up escalation) ──────────────────────────────
  // Issue #11: after a hint or a wrong attempt, the user can ask to see the
  // remaining solution rather than abandon the puzzle. Locks the grade at
  // Again (giving up is at least as bad as a single wrong attempt) and
  // returns the remaining UCI moves for the UI to auto-play. The UI then
  // feeds the user-side moves back through attemptUserMove one at a time
  // — currentMoveIdx still advances naturally, sanHistory still populates,
  // and the final attemptUserMove's grade-locking path is a no-op because
  // gradeRecorded is already set.
  //
  // Returns { state, remainingMoves, toRecord }
  //   remainingMoves: alternating user/opp UCI starting at currentMoveIdx.
  //                   Empty array if state.complete (the puzzle is over).
  //   toRecord:       FSRS.GRADE.again if newly locked here; null if the
  //                   grade was already locked (e.g. by a prior wrong
  //                   attempt) — caller should NOT double-record.
  //
  // Idempotent w.r.t. the lock: a second call after the first returns
  // toRecord:null. solutionRevealed stays true after first call.
  function revealSolution(state) {
    if (state.complete) {
      return { state: state, remainingMoves: [], toRecord: null };
    }
    var locked = lockGrade(state, FSRS.GRADE.again);
    var nextState = assign(locked.state, { solutionRevealed: true });
    return {
      state: nextState,
      remainingMoves: state.solutionUci.slice(state.currentMoveIdx),
      toRecord: locked.toRecord
    };
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
    markSolveStart: markSolveStart,
    attemptUserMove: attemptUserMove,
    applyOpponentReply: applyOpponentReply,
    requestHint: requestHint,
    hintInfoFor: hintInfoFor,
    revealSolution: revealSolution,
    computeGradeAtCompletion: computeGradeAtCompletion,
    computeAvgMoveTimeMs: computeAvgMoveTimeMs,
    userMoveCount: userMoveCount,
    userColor: userColor
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Drill = api;
  }
})(typeof self !== 'undefined' ? self : this);

/**
 * fsrs.js — FSRS-5 long-term scheduler, pure functions only.
 *
 * Lifted from MistakeLab (skAeglund/mistake-lab) under the same authorship.
 * The "SRS-N" comment markers refer to bug-fix issues in that repo and are
 * preserved for provenance — they document defensive rationale, not project
 * tracker references that bind here.
 *
 * Same dual-mode loading as lib/posKey.js:
 *   Node:    const FSRS = require('../lib/fsrs');
 *   Browser: <script src="lib/fsrs.js"></script>  (defines window.FSRS)
 *
 * Coupling deliberately removed:
 *   - getCardForPosition  (read from storage)
 *   - recordReview        (write to storage)
 *   - buildReviewQueue    (sort UI list)
 * These belong in puzzle-explorer's storage wrapper, not the scheduler.
 *
 * The puzzle-explorer grade mapping (per project plan) is:
 *   any wrong attempt → Again (1)
 *   hint only         → Hard  (2)
 *   perfect           → Easy  (4)
 * Good (3) is intentionally never emitted; the algorithm still supports it
 * if a future caller wants it.
 */
(function (root) {
  'use strict';

  // ─── FSRS-5 weights (community-trained defaults) ────────────────────────
  // w[17] and w[18] are short-term scheduler weights, unused by this
  // long-term-only path — preserved so swapping in a freshly trained 19-weight
  // set from upstream FSRS-5 stays a one-line change.
  var FSRS_W = [
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
    1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
    2.9898,
    0.51655, 0.6621
  ];
  var FSRS_F = 19.0 / 81.0;
  var FSRS_C = -0.5;
  var FSRS_GRADE = { again: 1, hard: 2, good: 3, easy: 4 };
  var FSRS_STATE = { new: 0, learning: 1, review: 2, relearning: 3 };
  var DESIRED_RETENTION = 0.9;
  var MAX_INTERVAL = 365;

  // ─── pure math ──────────────────────────────────────────────────────────
  function retrievability(t, s) {
    return Math.pow(1.0 + FSRS_F * (t / s), FSRS_C);
  }
  function nextInterval(rd, s) {
    return (s / FSRS_F) * (Math.pow(rd, 1.0 / FSRS_C) - 1.0);
  }
  function s0(g) {
    return [0, FSRS_W[0], FSRS_W[1], FSRS_W[2], FSRS_W[3]][g];
  }
  function d0(g) {
    return Math.min(10, Math.max(1, FSRS_W[4] - Math.exp(FSRS_W[5] * (g - 1)) + 1));
  }
  function deltaD(g) { return -FSRS_W[6] * (g - 3); }
  function dp(d, g) { return d + deltaD(g) * ((10 - d) / 9); }
  function difficulty(d, g) {
    return Math.min(10, Math.max(1, FSRS_W[7] * d0(FSRS_GRADE.easy) + (1 - FSRS_W[7]) * dp(d, g)));
  }
  function sSuccess(d, s, r, g) {
    var td = 11 - d, ts = Math.pow(s, -FSRS_W[9]);
    var tr = Math.exp(FSRS_W[10] * (1 - r)) - 1;
    var h = g === FSRS_GRADE.hard ? FSRS_W[15] : 1;
    var b = g === FSRS_GRADE.easy ? FSRS_W[16] : 1;
    return s * (1 + td * ts * tr * h * b * Math.exp(FSRS_W[8]));
  }
  function sFail(d, s, r) {
    var result = Math.pow(d, -FSRS_W[12]) * (Math.pow(s + 1, FSRS_W[13]) - 1) *
                 Math.exp(FSRS_W[14] * (1 - r)) * FSRS_W[11];
    return Math.min(result, s);
  }

  // ─── card lifecycle ─────────────────────────────────────────────────────
  function newCard() {
    return {
      state: FSRS_STATE.new,
      stability: 0,
      difficulty: 0,
      due: null,
      reps: 0,
      lapses: 0,
      lastReview: null,
      elapsedDays: 0,
      scheduledDays: 0
    };
  }

  // [ML SRS-2] local-date string in YYYY-MM-DD form (device's local timezone,
  // not UTC). Used as both the "today" comparison key in isDue and the
  // persisted "due" in review() so both sides match. UTC-based scheduling
  // drifts ±12h depending on user's timezone and time of day — short
  // intervals (1 day) could be honored anywhere from 7h to 36h after the
  // review. Local-date keeps "1 day later" consistent at the user's local
  // midnight rollover. Cross-device users in different timezones could see
  // ±1 day inconsistency; acceptable trade-off for typical single-timezone use.
  function localDateString(d) {
    d = d || new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function review(card, grade, now) {
    now = now || new Date();
    var c = Object.assign({}, card);

    // [ML SRS-8] validate c.lastReview before computing elapsed. A malformed
    // value (cross-version corruption, manual edit, schema migration miss)
    // makes new Date(bad) return Invalid Date, the subtraction NaN, and
    // Math.max(0, NaN) is NaN per spec — which then propagates through
    // retrievability / difficulty / stability and gets persisted as NaN.
    // isDue on a NaN-due card silently returns false, so the card vanishes
    // from the queue forever. Treat unparseable lastReview as "no prior
    // review" — elapsed=0 falls into the same branch as a brand-new
    // lastReview, no harm.
    var elapsed = 0;
    if (c.lastReview) {
      var lrTime = new Date(c.lastReview).getTime();
      if (Number.isFinite(lrTime)) {
        var rawElapsed = (now.getTime() - lrTime) / 86400000;
        // [ML SRS-11] surface clock skew when the clamp triggers. Negative
        // elapsed means lastReview is in the future relative to "now" —
        // either system clock moved backwards (timezone change, NTP
        // resync, manual edit) or a different device wrote the card with
        // a clock ahead of this one. The clamp itself is correct
        // (avoids NaN downstream and prevents inflating retrievability
        // beyond 1.0); just log so the case is debuggable.
        if (rawElapsed < 0) {
          (typeof console !== 'undefined' && console.warn) &&
            console.warn('[FSRS] clock skew: elapsed=' + rawElapsed.toFixed(2) +
                         ' days for lastReview=' + c.lastReview + '; clamping to 0');
        }
        elapsed = Math.max(0, rawElapsed);
      }
    }
    c.elapsedDays = elapsed;

    if (c.state === FSRS_STATE.new) {
      c.stability = s0(grade);
      c.difficulty = d0(grade);
      c.reps = 1;
      if (grade === FSRS_GRADE.again) {
        c.state = FSRS_STATE.learning;
        c.lapses = 1;
      } else {
        c.state = FSRS_STATE.review;
      }
    } else {
      var r = retrievability(elapsed, c.stability);
      c.difficulty = difficulty(c.difficulty, grade);
      if (grade === FSRS_GRADE.again) {
        c.stability = sFail(c.difficulty, c.stability, r);
        c.lapses++;
        c.state = FSRS_STATE.relearning;
      } else {
        c.stability = sSuccess(c.difficulty, c.stability, r, grade);
        c.reps++;
        c.state = FSRS_STATE.review;
      }
    }

    var ivl;
    if (grade === FSRS_GRADE.again) {
      // [ML SRS-3] state is always learning/relearning here. Half-stability
      // floor of 1 day matches MistakeLab's behavior. Same-day re-review
      // (ivl=0) is intentionally avoided: puzzle drilling locks the
      // first-attempt grade per session, so re-surfacing in the same
      // session would double-grade.
      ivl = Math.max(1, Math.round(c.stability * 0.5));
    } else {
      ivl = Math.max(1, Math.round(nextInterval(DESIRED_RETENTION, c.stability)));
    }
    ivl = Math.min(ivl, MAX_INTERVAL);
    c.scheduledDays = ivl;
    c.lastReview = now.toISOString();
    c.due = localDateString(new Date(now.getTime() + ivl * 86400000));
    return c;
  }

  // [ML SRS-8] defensive validator. If a non-new card has corrupt math
  // fields (NaN/Infinity from a propagation bug, schema migration, or
  // manual edit; out-of-range difficulty from a bad upstream weight set),
  // the FSRS update formulas can produce more NaN, and isDue silently
  // buries the card. Reset to a fresh new card in that case — accept the
  // data loss vs. corrupt-forever. Skip validation for actual new cards
  // (stability/difficulty=0 are valid for those — review's new-card branch
  // initializes them from grade).
  function validateCard(card) {
    if (!card || card.state === FSRS_STATE.new) return card || newCard();
    if (!Number.isFinite(card.stability) || card.stability <= 0 ||
        !Number.isFinite(card.difficulty) || card.difficulty < 1 || card.difficulty > 10) {
      (typeof console !== 'undefined' && console.warn) &&
        console.warn('[FSRS] corrupt card (s=' + card.stability + ' d=' + card.difficulty +
                     '); resetting to new');
      return newCard();
    }
    return card;
  }

  function isDue(card, todayStr) {
    if (!card || card.state === FSRS_STATE.new) return true;
    if (!card.due) return true;
    return card.due <= (todayStr || localDateString());
  }

  // ─── grade decision (puzzle-explorer specific mapping) ──────────────────
  // Per project plan: wrong attempt → again, hint used → hard, perfect → easy.
  // Good (3) is never emitted by this helper; callers using it directly are
  // free to pass FSRS_GRADE.good if they want the standard 4-grade UI.
  function gradeForAttempt(opts) {
    if (opts && opts.wrong) return FSRS_GRADE.again;
    if (opts && opts.hintUsed) return FSRS_GRADE.hard;
    return FSRS_GRADE.easy;
  }

  // ─── exports ────────────────────────────────────────────────────────────
  var api = {
    GRADE: FSRS_GRADE,
    STATE: FSRS_STATE,
    DESIRED_RETENTION: DESIRED_RETENTION,
    MAX_INTERVAL: MAX_INTERVAL,
    WEIGHTS: FSRS_W,
    newCard: newCard,
    review: review,
    isDue: isDue,
    validateCard: validateCard,
    localDateString: localDateString,
    gradeForAttempt: gradeForAttempt,
    // exposed for tests / advanced callers
    _retrievability: retrievability,
    _nextInterval: nextInterval,
    _difficulty: difficulty,
    _sSuccess: sSuccess,
    _sFail: sFail,
    _s0: s0,
    _d0: d0
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.FSRS = api;
  }
})(typeof self !== 'undefined' ? self : this);

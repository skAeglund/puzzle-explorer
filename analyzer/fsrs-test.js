#!/usr/bin/env node
/**
 * fsrs-test.js — Verify lib/fsrs.js produces sane scheduling and handles
 * the documented edge cases (corrupt input, clock skew, NaN propagation).
 *
 * Run: node analyzer/fsrs-test.js
 */

const F = require('../lib/fsrs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── new card invariants ─────────────────────────────────────────────────
section('new card');
{
  const c = F.newCard();
  check('state=new',                 c.state === F.STATE.new);
  check('stability=0',               c.stability === 0);
  check('difficulty=0',              c.difficulty === 0);
  check('reps=0',                    c.reps === 0);
  check('lapses=0',                  c.lapses === 0);
  check('due=null',                  c.due === null);
  check('lastReview=null',           c.lastReview === null);
  check('isDue(new) === true',       F.isDue(c) === true);
}

// ─── single review on a new card, each grade ─────────────────────────────
section('first review on new card — grade ordering');
{
  const t0 = new Date('2026-01-01T12:00:00Z');
  const again = F.review(F.newCard(), F.GRADE.again, t0);
  const hard  = F.review(F.newCard(), F.GRADE.hard,  t0);
  const good  = F.review(F.newCard(), F.GRADE.good,  t0);
  const easy  = F.review(F.newCard(), F.GRADE.easy,  t0);

  check('again → state=learning',     again.state === F.STATE.learning);
  check('hard → state=review',        hard.state === F.STATE.review);
  check('good → state=review',        good.state === F.STATE.review);
  check('easy → state=review',        easy.state === F.STATE.review);

  check('again sets lapses=1',        again.lapses === 1);
  check('hard does not lapse',        hard.lapses === 0);
  check('easy does not lapse',        easy.lapses === 0);

  check('again sets reps=1',          again.reps === 1);
  check('all stabilities finite',
    [again, hard, good, easy].every(c => Number.isFinite(c.stability)));
  check('all difficulties in [1,10]',
    [again, hard, good, easy].every(c => c.difficulty >= 1 && c.difficulty <= 10));

  check('hard ivl < easy ivl',        hard.scheduledDays < easy.scheduledDays,
    `hard=${hard.scheduledDays} easy=${easy.scheduledDays}`);
  check('good ivl < easy ivl',        good.scheduledDays < easy.scheduledDays,
    `good=${good.scheduledDays} easy=${easy.scheduledDays}`);
  check('again ivl is the floor (1d)', again.scheduledDays === 1);

  check('all ivl ≤ MAX_INTERVAL',
    [again, hard, good, easy].every(c => c.scheduledDays <= F.MAX_INTERVAL));

  // due field is set, format is YYYY-MM-DD, lastReview is ISO
  check('easy.due is YYYY-MM-DD',     /^\d{4}-\d{2}-\d{2}$/.test(easy.due));
  check('easy.lastReview is ISO',     /^\d{4}-\d{2}-\d{2}T/.test(easy.lastReview));
}

// ─── multi-step easy trajectory: stability and ivl grow until cap ────────
section('repeated Easy on the same card — stability grows, ivl saturates');
{
  let card = F.newCard();
  let prevIvl = 0;
  let now = new Date('2026-01-01T12:00:00Z');
  let trajectory = [];
  for (let i = 0; i < 12; i++) {
    card = F.review(card, F.GRADE.easy, now);
    trajectory.push(card.scheduledDays);
    // jump forward by the scheduled interval to simulate user reviewing on time
    now = new Date(now.getTime() + card.scheduledDays * 86400000);
  }
  console.log('    trajectory (days): ' + trajectory.join(', '));
  check('first review schedules ivl ≥ 1',  trajectory[0] >= 1);
  check('ivl is monotonically non-decreasing',
    trajectory.every((v, i) => i === 0 || v >= trajectory[i - 1]));
  check('ivl saturates at MAX_INTERVAL',
    trajectory[trajectory.length - 1] === F.MAX_INTERVAL);
}

// ─── struggling card: repeated Again stays at floor ──────────────────────
section('repeated Again — stays at 1-day floor, lapses accumulate');
{
  let card = F.newCard();
  let now = new Date('2026-01-01T12:00:00Z');
  let lapses = [];
  let ivls = [];
  for (let i = 0; i < 5; i++) {
    card = F.review(card, F.GRADE.again, now);
    lapses.push(card.lapses);
    ivls.push(card.scheduledDays);
    now = new Date(now.getTime() + 86400000);
  }
  console.log('    lapses:  ' + lapses.join(', '));
  console.log('    ivls:    ' + ivls.join(', '));
  check('lapses monotonically increase', lapses.every((v, i) => i === 0 || v > lapses[i - 1]));
  check('all ivls === 1',                 ivls.every(v => v === 1));
  check('state=relearning after first',   card.state === F.STATE.relearning);
}

// ─── corrupt card — validateCard rescues ─────────────────────────────────
section('validateCard');
{
  const ok = F.review(F.newCard(), F.GRADE.easy);
  check('valid card passes through',    F.validateCard(ok) === ok);

  const nanS = Object.assign({}, ok, { stability: NaN });
  check('NaN stability → fresh new',    F.validateCard(nanS).state === F.STATE.new);

  const negS = Object.assign({}, ok, { stability: -1 });
  check('negative stability → fresh new', F.validateCard(negS).state === F.STATE.new);

  const badD = Object.assign({}, ok, { difficulty: 99 });
  check('out-of-range difficulty → fresh new', F.validateCard(badD).state === F.STATE.new);

  const fresh = F.newCard();
  fresh.stability = 0; fresh.difficulty = 0; // legitimately 0 for new
  check('new card with s=0 d=0 NOT reset', F.validateCard(fresh).state === F.STATE.new);

  check('null → fresh new',             F.validateCard(null).state === F.STATE.new);
  check('undefined → fresh new',        F.validateCard(undefined).state === F.STATE.new);
}

// ─── clock skew: lastReview in the future ────────────────────────────────
section('clock skew tolerance');
{
  // Suppress the warn during test
  const origWarn = console.warn; let warned = false;
  console.warn = function (m) { warned = true; };

  const card = F.review(F.newCard(), F.GRADE.easy, new Date('2026-06-01T12:00:00Z'));
  // lastReview is now mid-2026; review again with "now" set to early 2026 (clock back)
  const out = F.review(card, F.GRADE.good, new Date('2026-01-01T12:00:00Z'));

  console.warn = origWarn;
  check('clock-skew warn emitted',           warned);
  check('elapsedDays clamped to 0',          out.elapsedDays === 0);
  check('stability remains finite',          Number.isFinite(out.stability));
  check('difficulty remains finite & in range',
    Number.isFinite(out.difficulty) && out.difficulty >= 1 && out.difficulty <= 10);
}

// ─── unparseable lastReview ──────────────────────────────────────────────
section('unparseable lastReview');
{
  const card = Object.assign({}, F.review(F.newCard(), F.GRADE.easy));
  card.lastReview = 'not-a-date';
  const out = F.review(card, F.GRADE.good);
  check('elapsedDays falls to 0 (no NaN)',  out.elapsedDays === 0);
  check('stability finite',                  Number.isFinite(out.stability));
  check('difficulty finite',                 Number.isFinite(out.difficulty));
}

// ─── isDue / localDateString ─────────────────────────────────────────────
section('isDue and localDateString');
{
  check('localDateString format',
    /^\d{4}-\d{2}-\d{2}$/.test(F.localDateString(new Date('2026-04-27T03:00:00Z'))));

  // Card due tomorrow → not due today
  const today = F.localDateString(new Date('2026-04-27T12:00:00Z'));
  const tomorrow = F.localDateString(new Date('2026-04-28T12:00:00Z'));
  check('card due tomorrow not due today',
    F.isDue({ state: F.STATE.review, due: tomorrow }, today) === false);
  check('card due today IS due',
    F.isDue({ state: F.STATE.review, due: today }, today) === true);
  check('card due yesterday IS due',
    F.isDue({ state: F.STATE.review, due: '2026-04-26' }, today) === true);
  check('card with due=null → due (treated as new)',
    F.isDue({ state: F.STATE.review, due: null }, today) === true);
  check('new card → always due',
    F.isDue({ state: F.STATE.new }, today) === true);
}

// ─── grade mapping ───────────────────────────────────────────────────────
section('gradeForAttempt — puzzle-explorer mapping');
{
  check('perfect → easy',     F.gradeForAttempt({}) === F.GRADE.easy);
  check('hint used → hard',   F.gradeForAttempt({ hintUsed: true }) === F.GRADE.hard);
  check('wrong → again',      F.gradeForAttempt({ wrong: true }) === F.GRADE.again);
  check('wrong wins over hint',
    F.gradeForAttempt({ wrong: true, hintUsed: true }) === F.GRADE.again);
  check('no opts → easy',     F.gradeForAttempt() === F.GRADE.easy);
}

section('gradeForAttempt — time-based grading for clean solves');
{
  // Thresholds: <=10s → easy, 10-60s → good, >60s → hard.
  // Strict > comparisons, so boundaries land in the lower bucket.
  check('1ms avg → easy',
    F.gradeForAttempt({ avgMoveTimeMs: 1 }) === F.GRADE.easy);
  check('5s avg → easy',
    F.gradeForAttempt({ avgMoveTimeMs: 5000 }) === F.GRADE.easy);
  check('exactly 10s → easy (boundary)',
    F.gradeForAttempt({ avgMoveTimeMs: 10000 }) === F.GRADE.easy);
  check('10.001s → good',
    F.gradeForAttempt({ avgMoveTimeMs: 10001 }) === F.GRADE.good);
  check('30s avg → good',
    F.gradeForAttempt({ avgMoveTimeMs: 30000 }) === F.GRADE.good);
  check('exactly 60s → good (boundary)',
    F.gradeForAttempt({ avgMoveTimeMs: 60000 }) === F.GRADE.good);
  check('60.001s → hard',
    F.gradeForAttempt({ avgMoveTimeMs: 60001 }) === F.GRADE.hard);
  check('120s avg → hard',
    F.gradeForAttempt({ avgMoveTimeMs: 120000 }) === F.GRADE.hard);

  // Hint dominates time-based logic
  check('hint + fast → hard',
    F.gradeForAttempt({ hintUsed: true, avgMoveTimeMs: 1000 }) === F.GRADE.hard);
  // Wrong dominates everything
  check('wrong + slow → again',
    F.gradeForAttempt({ wrong: true, avgMoveTimeMs: 100000 }) === F.GRADE.again);

  // Non-finite / non-number avgMoveTimeMs falls through to easy (legacy)
  check('null avg → easy',
    F.gradeForAttempt({ avgMoveTimeMs: null }) === F.GRADE.easy);
  check('NaN avg → easy',
    F.gradeForAttempt({ avgMoveTimeMs: NaN }) === F.GRADE.easy);
  check('string avg → easy',
    F.gradeForAttempt({ avgMoveTimeMs: '30000' }) === F.GRADE.easy);
}

// ─── due-date computation: review now, due field is set N days later ─────
section('scheduling: due-date arithmetic across DST-ish dates');
{
  const t = new Date('2026-03-08T12:00:00Z'); // around US DST start; harmless in UTC
  const c = F.review(F.newCard(), F.GRADE.easy, t);
  const dueParts = c.due.split('-').map(Number);
  const dueMs = Date.UTC(dueParts[0], dueParts[1] - 1, dueParts[2]);
  const tMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const dayDiff = (dueMs - tMs) / 86400000;
  // Allow ±1 because localDateString uses LOCAL date, may shift by tz
  check('due is scheduledDays (±1 for tz) after now',
    Math.abs(dayDiff - c.scheduledDays) <= 1,
    `dayDiff=${dayDiff} scheduled=${c.scheduledDays}`);
}

// ─── round-trip: serialize / deserialize via JSON ────────────────────────
section('JSON round-trip');
{
  const c = F.review(F.newCard(), F.GRADE.easy);
  const c2 = JSON.parse(JSON.stringify(c));
  // Continue the schedule on the deserialized card
  const c3 = F.review(c2, F.GRADE.good);
  check('survives JSON round-trip', Number.isFinite(c3.stability) && c3.state === F.STATE.review);
}

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * theme-stats-test.js — first-attempt theme tracking on Progress.
 *
 * Stores the first-attempt verdict + themes + puzzle rating as an immutable
 * `first` field ON each progress entry (so it rides Gist sync). Exercises:
 *   - markFirstAttempt(id, pass, themes, rating, now): write-once, theme
 *     hygiene, rating validation, coexistence with markSeen/recordReview.
 *   - themeStats(): per-theme success-rate accounting AND the Lichess-style
 *     PERFORMANCE rating (avgRating - 500 + 1000*firstWinFraction), including
 *     the difficulty weighting and graceful handling of legacy unrated records.
 *
 * Run: node analyzer/theme-stats-test.js
 */

const Progress = require('../lib/progress');
const FSRS = require('../lib/fsrs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }
function fresh() { Progress.setStorage(Progress._makeMemoryStorage()); }
function rate(b) { return b.attempts ? (b.attempts - b.fails) / b.attempts : null; }

// ━━━ markFirstAttempt — write-once + rating ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('markFirstAttempt — write-once');
{
  fresh();
  const e1 = Progress.markFirstAttempt('p1', true, ['fork', 'pin'], 1500, new Date('2026-01-01T00:00:00Z'));
  check('first call sets first.pass=true', e1.first && e1.first.pass === true);
  check('first call records themes', JSON.stringify(e1.first.themes) === JSON.stringify(['fork', 'pin']));
  check('first call records rating', e1.first.rating === 1500);
  check('first.at recorded', e1.first.at === '2026-01-01T00:00:00.000Z');
  const e2 = Progress.markFirstAttempt('p1', false, ['skewer'], 2000, new Date('2026-02-01T00:00:00Z'));
  check('second call is a no-op (returns null)', e2 === null);
  const stored = Progress.getEntry('p1');
  check('stored verdict unchanged', stored.first.pass === true);
  check('stored rating unchanged', stored.first.rating === 1500);
}

section('markFirstAttempt — rating validation');
{
  fresh();
  check('rating 0 → omitted',        Progress.markFirstAttempt('a', true, ['x'], 0).first.rating === undefined);
  check('negative rating → omitted', Progress.markFirstAttempt('b', true, ['x'], -5).first.rating === undefined);
  check('NaN/string → omitted',      Progress.markFirstAttempt('c', true, ['x'], 'abc').first.rating === undefined);
  check('null rating → omitted',     Progress.markFirstAttempt('d', true, ['x'], null).first.rating === undefined);
  check('float rating → rounded',    Progress.markFirstAttempt('e', true, ['x'], 1500.7).first.rating === 1501);
  check('numeric string → coerced',  Progress.markFirstAttempt('f', true, ['x'], '1800').first.rating === 1800);
}

section('markFirstAttempt — bad inputs / theme hygiene');
{
  fresh();
  check('null id → null',   Progress.markFirstAttempt(null, true, ['fork'], 1500) === null);
  check('empty id → null',  Progress.markFirstAttempt('', true, ['fork'], 1500) === null);
  check('number id → null', Progress.markFirstAttempt(7, true, ['fork'], 1500) === null);
  const e = Progress.markFirstAttempt('p', true, 'fork', 1500);  // non-array themes
  check('non-array themes → empty themes, no throw', e.first && e.first.themes.length === 0);
  const e2 = Progress.markFirstAttempt('q', false, ['fork', '', null, 42, 'fork', 'pin'], 1500);
  check('themes deduped + non-strings dropped', JSON.stringify(e2.first.themes) === JSON.stringify(['fork', 'pin']));
}

section('markFirstAttempt — non-Date now falls back to current time');
{
  fresh();
  const e = Progress.markFirstAttempt('p', true, ['fork'], 1500, 'not-a-date');
  check('first.at is a valid ISO string', typeof e.first.at === 'string' && Number.isFinite(new Date(e.first.at).getTime()));
  check('rating still recorded with bad now', e.first.rating === 1500);
}

// ━━━ coexistence with markSeen / recordReview ━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('coexistence — markFirstAttempt does not disturb srs/completed and vice versa');
{
  fresh();
  Progress.recordReview('p', FSRS.GRADE.again);          // first-wrong path order
  Progress.markFirstAttempt('p', false, ['fork', 'discoveredAttack'], 1700);
  let e = Progress.getEntry('p');
  check('recordReview kept its srs card', !!(e.srs && typeof e.srs === 'object'));
  check('completed still true', e.completed === true);
  check('first attached alongside srs', e.first && e.first.pass === false && e.first.rating === 1700);
  Progress.recordReview('p', FSRS.GRADE.good);            // later review
  e = Progress.getEntry('p');
  check('later recordReview preserves first', !!(e.first && e.first.pass === false && e.first.rating === 1700));
  check('later recordReview updated srs (reps≥2)', e.srs.reps >= 2);
}

// ━━━ themeStats — success-rate accounting ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('themeStats — pass/fail accounting (success rate)');
{
  fresh();
  Progress.markFirstAttempt('f1', false, ['fork'], 1500);
  Progress.markFirstAttempt('f2', false, ['fork'], 1500);
  Progress.markFirstAttempt('f3', true,  ['fork'], 1500);
  Progress.markFirstAttempt('q1', true,  ['pin'], 1500);
  Progress.markFirstAttempt('q2', true,  ['pin'], 1500);
  Progress.markFirstAttempt('b1', false, ['backRankMate', 'fork'], 1500);
  const agg = Progress.themeStats();
  check('totalPuzzles = 6', agg.totalPuzzles === 6, 'got ' + agg.totalPuzzles);
  check('fork attempts = 4', agg.themes.fork.attempts === 4);
  check('fork fails = 3', agg.themes.fork.fails === 3);
  check('fork successRate = 0.25', Math.abs(rate(agg.themes.fork) - 0.25) < 1e-9);
  check('pin attempts = 2, fails = 0', agg.themes.pin.attempts === 2 && agg.themes.pin.fails === 0);
  check('backRankMate fails = 1', agg.themes.backRankMate.fails === 1);
}

// ━━━ themeStats — performance rating (Lichess formula) ━━━━━━━━━━━━━━━━━━
section('themeStats — performance = avgRating - 500 + 1000*p');
{
  fresh();
  // 100% on avg 1500 → 1500 - 500 + 1000 = 2000
  Progress.markFirstAttempt('a1', true, ['allWin'], 1500);
  Progress.markFirstAttempt('a2', true, ['allWin'], 1500);
  Progress.markFirstAttempt('a3', true, ['allWin'], 1500);
  // 0% on avg 1500 → 1500 - 500 + 0 = 1000
  Progress.markFirstAttempt('b1', false, ['allLose'], 1500);
  Progress.markFirstAttempt('b2', false, ['allLose'], 1500);
  Progress.markFirstAttempt('b3', false, ['allLose'], 1500);
  // 50% on avg 1500 → equals avg = 1500
  Progress.markFirstAttempt('c1', true,  ['half'], 1500);
  Progress.markFirstAttempt('c2', false, ['half'], 1500);
  Progress.markFirstAttempt('c3', true,  ['half'], 1500);
  Progress.markFirstAttempt('c4', false, ['half'], 1500);
  const agg = Progress.themeStats();
  check('100% → perf 2000', agg.themes.allWin.performance === 2000, 'got ' + agg.themes.allWin.performance);
  check('0% → perf 1000', agg.themes.allLose.performance === 1000, 'got ' + agg.themes.allLose.performance);
  check('50% → perf == avg (1500)', agg.themes.half.performance === 1500, 'got ' + agg.themes.half.performance);
  check('avgRating computed', agg.themes.allWin.avgRating === 1500);
}

section('themeStats — difficulty weighting (same success%, different rating)');
{
  fresh();
  // Both themes: 100% first-attempt. Hard theme should out-perform easy theme.
  Progress.markFirstAttempt('h1', true, ['hard'], 2000);
  Progress.markFirstAttempt('h2', true, ['hard'], 2000);
  Progress.markFirstAttempt('h3', true, ['hard'], 2000);
  Progress.markFirstAttempt('e1', true, ['easy'], 1000);
  Progress.markFirstAttempt('e2', true, ['easy'], 1000);
  Progress.markFirstAttempt('e3', true, ['easy'], 1000);
  const agg = Progress.themeStats();
  check('hard 100% → perf 2500', agg.themes.hard.performance === 2500, 'got ' + agg.themes.hard.performance);
  check('easy 100% → perf 1500', agg.themes.easy.performance === 1500, 'got ' + agg.themes.easy.performance);
  check('same success% but hard out-performs easy', agg.themes.hard.performance > agg.themes.easy.performance);
}

section('themeStats — mixed ratings average correctly');
{
  fresh();
  // [1000, 2000] both solved → avg 1500, 100% → 2000
  Progress.markFirstAttempt('m1', true, ['mix'], 1000);
  Progress.markFirstAttempt('m2', true, ['mix'], 2000);
  // odd division: 2/3 on avg 1200 → 1200 - 500 + round(666.67) = 1367
  Progress.markFirstAttempt('n1', true,  ['odd'], 1200);
  Progress.markFirstAttempt('n2', true,  ['odd'], 1200);
  Progress.markFirstAttempt('n3', false, ['odd'], 1200);
  const agg = Progress.themeStats();
  check('mixed avg 1500, 100% → 2000', agg.themes.mix.performance === 2000, 'got ' + agg.themes.mix.performance);
  check('mix avgRating = 1500', agg.themes.mix.avgRating === 1500);
  check('2/3 on avg 1200 → 1367', agg.themes.odd.performance === 1367, 'got ' + agg.themes.odd.performance);
}

section('themeStats — legacy unrated records: success rate yes, performance no');
{
  fresh();
  Progress.markFirstAttempt('r1', true,  ['mixed'], 1500);  // rated, win
  Progress.markFirstAttempt('r2', false, ['mixed']);        // unrated (legacy), loss — no rating arg
  const t = Progress.themeStats().themes.mixed;
  check('attempts counts both', t.attempts === 2);
  check('fails counts the unrated loss', t.fails === 1);
  check('successRate over all = 0.5', Math.abs(rate(t) - 0.5) < 1e-9);
  check('ratedAttempts = 1 (only the rated one)', t.ratedAttempts === 1);
  check('performance ignores unrated → 1500-500+1000 = 2000', t.performance === 2000, 'got ' + t.performance);
  check('avgRating from rated subset only', t.avgRating === 1500);

  // A theme with ZERO rated attempts → performance null.
  fresh();
  Progress.markFirstAttempt('u1', true, ['noRating']);
  const t2 = Progress.themeStats().themes.noRating;
  check('all-unrated theme: performance null', t2.performance === null);
  check('all-unrated theme: avgRating null', t2.avgRating === null);
  check('all-unrated theme: still counts attempts', t2.attempts === 1);
}

section('themeStats — skips pre-feature entries and tombstones');
{
  fresh();
  Progress.recordReview('legacy', FSRS.GRADE.easy);            // no `first`
  Progress.markFirstAttempt('new1', false, ['fork'], 1500);
  Progress.markFirstAttempt('new2', false, ['pin'], 1500);
  Progress.forget('new2');                                     // tombstone
  const agg = Progress.themeStats();
  check('legacy (no first) excluded', agg.totalPuzzles === 1);
  check('only new1 counted', agg.themes.fork && agg.themes.fork.attempts === 1);
  check('tombstoned new2 excluded (pin absent)', !agg.themes.pin);
}

section('themeStats — empty + namespacing');
{
  fresh();
  check('empty store → 0 puzzles', Progress.themeStats().totalPuzzles === 0);
  Progress.setUsername('alice');
  Progress.markFirstAttempt('x', false, ['fork'], 1500);
  check('alice sees her entry', Progress.themeStats().totalPuzzles === 1);
  Progress.setUsername('bob');
  check('bob (different namespace) sees nothing', Progress.themeStats().totalPuzzles === 0);
  Progress.setUsername('');
}

// ━━━ setUserThemes — manual tagging ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('setUserThemes — basics + hygiene');
{
  fresh();
  Progress.markFirstAttempt('p', false, ['short', 'advantage'], 1700);  // only noise themes
  const e = Progress.setUserThemes('p', ['fork', '', null, 'fork', 'pin'], new Date('2026-03-01T00:00:00Z'));
  check('userThemes deduped + cleaned', JSON.stringify(e.userThemes) === JSON.stringify(['fork', 'pin']));
  check('userThemesAt stamped', e.userThemesAt === '2026-03-01T00:00:00.000Z');
  check('does NOT touch first verdict', e.first.pass === false && e.first.rating === 1700);
  check('does NOT bump lastSeen to tag time', e.lastSeen !== e.userThemesAt);
  check('bad id → null', Progress.setUserThemes(null, ['fork']) === null);
  // Replace semantics + empty (cleared) state retained.
  Progress.setUserThemes('p', ['skewer'], new Date('2026-03-02T00:00:00Z'));
  check('replaces (not merges) prior tags', JSON.stringify(Progress.getEntry('p').userThemes) === JSON.stringify(['skewer']));
  Progress.setUserThemes('p', [], new Date('2026-03-03T00:00:00Z'));
  check('empty array retained (not deleted)', Array.isArray(Progress.getEntry('p').userThemes) && Progress.getEntry('p').userThemes.length === 0);
}

section('themeStats — user tags contribute (union with intrinsic, inherit verdict+rating)');
{
  fresh();
  // A puzzle with only noise themes, failed at 1800, manually tagged "fork".
  Progress.markFirstAttempt('p1', false, ['short', 'crushing'], 1800);
  Progress.setUserThemes('p1', ['fork'], new Date());
  // A puzzle intrinsically "fork", solved at 1200.
  Progress.markFirstAttempt('p2', true, ['fork'], 1200);
  const t = Progress.themeStats().themes.fork;
  check('user-tagged puzzle joins the fork bucket', t.attempts === 2);
  check('inherits the tagged puzzle’s fail', t.fails === 1);
  check('inherits rating into perf basis', t.ratedAttempts === 2 && t.ratingSum === 3000);
  // perf: avg 1500, 1 of 2 first-win → 1500 - 500 + 500 = 1500
  check('performance uses tagged puzzle’s rating', t.performance === 1500, 'got ' + t.performance);
}

section('themeStats — dedupe when a tag duplicates an intrinsic theme');
{
  fresh();
  Progress.markFirstAttempt('p', true, ['fork', 'short'], 1500);
  Progress.setUserThemes('p', ['fork'], new Date());  // redundant tag
  check('fork counted once, not twice', Progress.themeStats().themes.fork.attempts === 1);
}

section('themeStats — custom (non-canonical) tag makes its own bucket');
{
  fresh();
  Progress.markFirstAttempt('p', false, ['advantage'], 1600);
  Progress.setUserThemes('p', ['calculation'], new Date());
  const agg = Progress.themeStats();
  check('custom theme bucket exists', !!agg.themes.calculation);
  check('custom theme records the fail', agg.themes.calculation.fails === 1 && agg.themes.calculation.performance === 1100);
}

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' theme-stats: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

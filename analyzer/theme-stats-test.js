#!/usr/bin/env node
/**
 * theme-stats-test.js — first-attempt theme tracking on Progress.
 *
 * The failed-themes stats store the first-attempt verdict + themes as an
 * immutable `first` field ON each progress entry (so it rides Gist sync).
 * This exercises the two Progress functions that own it:
 *   - markFirstAttempt(id, pass, themes, now): write-once, theme hygiene,
 *     coexistence with markSeen/recordReview (doesn't clobber, isn't clobbered).
 *   - themeStats(): per-theme attempt/fail aggregation over the active
 *     namespace, skipping tombstones and pre-feature (no-`first`) entries.
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

// ━━━ markFirstAttempt — write-once ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('markFirstAttempt — write-once');
{
  fresh();
  const e1 = Progress.markFirstAttempt('p1', true, ['fork', 'pin'], new Date('2026-01-01T00:00:00Z'));
  check('first call sets first.pass=true', e1.first && e1.first.pass === true);
  check('first call records themes', JSON.stringify(e1.first.themes) === JSON.stringify(['fork', 'pin']));
  check('first.at recorded', e1.first.at === '2026-01-01T00:00:00.000Z');
  const e2 = Progress.markFirstAttempt('p1', false, ['skewer'], new Date('2026-02-01T00:00:00Z'));
  check('second call is a no-op (returns null)', e2 === null);
  const stored = Progress.getEntry('p1');
  check('stored verdict unchanged', stored.first.pass === true);
  check('stored themes unchanged', JSON.stringify(stored.first.themes) === JSON.stringify(['fork', 'pin']));
  const agg = Progress.themeStats();
  check('aggregate sees one puzzle', agg.totalPuzzles === 1);
  check('skewer never recorded', !agg.themes.skewer);
}

section('markFirstAttempt — bad inputs');
{
  fresh();
  check('null id → null',   Progress.markFirstAttempt(null, true, ['fork']) === null);
  check('empty id → null',  Progress.markFirstAttempt('', true, ['fork']) === null);
  check('number id → null', Progress.markFirstAttempt(7, true, ['fork']) === null);
  const e = Progress.markFirstAttempt('p', true, 'fork');  // non-array themes
  check('non-array themes → empty themes, no throw', e.first && e.first.themes.length === 0);
  const e2 = Progress.markFirstAttempt('q', false, ['fork', '', null, 42, 'fork', 'pin']);
  check('themes deduped + non-strings dropped', JSON.stringify(e2.first.themes) === JSON.stringify(['fork', 'pin']));
}

section('markFirstAttempt — non-Date now falls back to current time');
{
  fresh();
  const e = Progress.markFirstAttempt('p', true, ['fork'], 'not-a-date');
  check('first.at is a valid ISO string', typeof e.first.at === 'string' && Number.isFinite(new Date(e.first.at).getTime()));
}

// ━━━ coexistence with markSeen / recordReview ━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('coexistence — markFirstAttempt does not disturb srs/completed and vice versa');
{
  fresh();
  // Order mirrors the UI's first-wrong path: recordReview then markFirstAttempt.
  Progress.recordReview('p', FSRS.GRADE.again);
  Progress.markFirstAttempt('p', false, ['fork', 'discoveredAttack']);
  let e = Progress.getEntry('p');
  check('recordReview kept its srs card', !!(e.srs && typeof e.srs === 'object'));
  check('completed still true', e.completed === true);
  check('first attached alongside srs', e.first && e.first.pass === false);
  // A later review must not strip `first`.
  Progress.recordReview('p', FSRS.GRADE.good);
  e = Progress.getEntry('p');
  check('later recordReview preserves first', !!(e.first && e.first.pass === false));
  check('later recordReview updated srs (reps≥2)', e.srs.reps >= 2);
}

section('coexistence — clean-solve order (markSeen then markFirstAttempt)');
{
  fresh();
  Progress.markSeen('p');
  Progress.markFirstAttempt('p', true, ['fork']);
  const e = Progress.getEntry('p');
  check('markSeen entry has no srs card', !(e.srs && typeof e.srs === 'object'));
  check('first.pass=true attached', e.first && e.first.pass === true);
  check('still counts as seen for theme stats', Progress.themeStats().themes.fork.attempts === 1);
}

// ━━━ themeStats — aggregation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('themeStats — pass/fail accounting');
{
  fresh();
  Progress.markFirstAttempt('f1', false, ['fork']);
  Progress.markFirstAttempt('f2', false, ['fork']);
  Progress.markFirstAttempt('f3', true,  ['fork']);
  Progress.markFirstAttempt('q1', true,  ['pin']);
  Progress.markFirstAttempt('q2', true,  ['pin']);
  Progress.markFirstAttempt('b1', false, ['backRankMate', 'fork']);
  const agg = Progress.themeStats();
  check('totalPuzzles = 6', agg.totalPuzzles === 6, 'got ' + agg.totalPuzzles);
  check('fork attempts = 4', agg.themes.fork.attempts === 4);
  check('fork fails = 3', agg.themes.fork.fails === 3);
  check('fork successRate = 0.25', Math.abs(rate(agg.themes.fork) - 0.25) < 1e-9);
  check('pin attempts = 2, fails = 0', agg.themes.pin.attempts === 2 && agg.themes.pin.fails === 0);
  check('pin successRate = 1.0', rate(agg.themes.pin) === 1);
  check('backRankMate fails = 1', agg.themes.backRankMate.fails === 1);
}

section('themeStats — skips pre-feature entries and tombstones');
{
  fresh();
  // Pre-feature: an entry with completed/srs but no `first` (drilled before
  // this shipped). Must NOT count.
  Progress.recordReview('legacy', FSRS.GRADE.easy);
  // Genuine first attempt.
  Progress.markFirstAttempt('new1', false, ['fork']);
  // Forget it → tombstone. Must NOT count even though it had `first`.
  Progress.markFirstAttempt('new2', false, ['pin']);
  Progress.forget('new2');
  const agg = Progress.themeStats();
  check('legacy (no first) excluded', agg.totalPuzzles === 1);
  check('only new1 counted', agg.themes.fork && agg.themes.fork.attempts === 1);
  check('tombstoned new2 excluded (pin absent)', !agg.themes.pin);
}

section('themeStats — empty + namespacing');
{
  fresh();
  check('empty store → 0 puzzles', Progress.themeStats().totalPuzzles === 0);
  // Namespacing is inherited from Progress: setUsername swaps the active key.
  Progress.setUsername('alice');
  Progress.markFirstAttempt('x', false, ['fork']);
  check('alice sees her entry', Progress.themeStats().totalPuzzles === 1);
  Progress.setUsername('bob');
  check('bob (different namespace) sees nothing', Progress.themeStats().totalPuzzles === 0);
  Progress.setUsername('');
}

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' theme-stats: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

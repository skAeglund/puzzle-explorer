#!/usr/bin/env node
/**
 * session-test.js — Test the session queue state machine.
 *
 * Run: node analyzer/session-test.js
 */

const Session = require('../lib/session');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── deterministic RNG for shuffle tests ─────────────────────────────────
// Mulberry32 — small, seedable, good enough for ordering checks.
function mulberry32(seed) {
  var t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    var x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── fixtures ────────────────────────────────────────────────────────────
const MATCHES = [
  ['p1', 1000],
  ['p2', 1200],
  ['p3', 1400],
  ['p4', 1600],
  ['p5', 1800],
  ['p6', 2000],
  ['p7', 2200]
];
const NEVER_COMPLETED = function () { return false; };
const ALL_COMPLETED   = function () { return true; };

// ━━━ filterByRating ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.filterByRating');
{
  const all = Session.filterByRating(MATCHES, null, null);
  check('null bounds → all in', all.length === 7);

  const tight = Session.filterByRating(MATCHES, 1400, 1800);
  check('inclusive lower bound', tight[0][0] === 'p3');
  check('inclusive upper bound', tight[tight.length - 1][0] === 'p5');
  check('range count correct', tight.length === 3);

  const empty = Session.filterByRating(MATCHES, 3000, 4000);
  check('out-of-range → empty', empty.length === 0);

  const oneSided = Session.filterByRating(MATCHES, 1500, null);
  check('null upper → no upper limit', oneSided.length === 4);

  // Non-numeric / missing rating tuples pass through unfiltered.
  const odd = [['x', null], ['y', undefined], ['z', 1500]];
  const oddOut = Session.filterByRating(odd, 1000, 2000);
  check('null rating passes through', oddOut.some(m => m[0] === 'x'));
  check('undefined rating passes through', oddOut.some(m => m[0] === 'y'));
  check('numeric rating still filtered', oddOut.some(m => m[0] === 'z'));

  // Defensive: malformed entries skipped, not crashing.
  const dirty = [null, undefined, [], ['onlyId'], ['ok', 1500]];
  const dirtyOut = Session.filterByRating(dirty, 1000, 2000);
  check('malformed entries skipped', dirtyOut.length === 1 && dirtyOut[0][0] === 'ok');
}

// ━━━ countUnsolved ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.countUnsolved');
{
  check('all unsolved', Session.countUnsolved(MATCHES, NEVER_COMPLETED) === 7);
  check('all solved',   Session.countUnsolved(MATCHES, ALL_COMPLETED)   === 0);

  const halfDone = function (pid) { return pid === 'p1' || pid === 'p3' || pid === 'p5'; };
  check('partial solved', Session.countUnsolved(MATCHES, halfDone) === 4);

  // Default predicate: undefined → treats nothing as completed.
  check('missing predicate → all unsolved', Session.countUnsolved(MATCHES) === 7);
}

// ━━━ create ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.create — basic shape');
{
  const s = Session.create({
    matches: MATCHES,
    ratingMin: null,
    ratingMax: null,
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(1)
  });
  check('queue is array',     Array.isArray(s.queue));
  check('queue length == 7',  s.queue.length === 7);
  check('total == 7',         s.total === 7);
  check('inRangeTotal == 7',  s.inRangeTotal === 7);
  check('cursor === -1',      s.cursor === -1);
  check('complete=false',     s.complete === false);
  check('ratingMin null',     s.ratingMin === null);
  check('ratingMax null',     s.ratingMax === null);

  // All ids are present, just shuffled.
  const ids = s.queue.slice().sort();
  check('all ids in queue', JSON.stringify(ids) === JSON.stringify(['p1','p2','p3','p4','p5','p6','p7']));
}

section('Session.create — rating filter');
{
  const s = Session.create({
    matches: MATCHES,
    ratingMin: 1300,
    ratingMax: 1700,
    isCompleted: NEVER_COMPLETED
  });
  // p3=1400, p4=1600 are inclusive-in. p5=1800 is out (>1700).
  check('range filtered queue', s.queue.length === 2);
  check('inRangeTotal matches',  s.inRangeTotal === 2);
  // Sorted-ids check is shuffle-independent.
  const sorted = s.queue.slice().sort();
  check('only in-range ids', JSON.stringify(sorted) === JSON.stringify(['p3','p4']));
  check('ratingMin stored as number', s.ratingMin === 1300);
  check('ratingMax stored as number', s.ratingMax === 1700);
}

section('Session.create — unsolved-only queue');
{
  // Mark half complete; in-range count should still include them, queue should not.
  const half = function (pid) { return pid === 'p2' || pid === 'p4' || pid === 'p6'; };
  const s = Session.create({
    matches: MATCHES,
    ratingMin: null,
    ratingMax: null,
    isCompleted: half
  });
  check('inRangeTotal includes solved', s.inRangeTotal === 7);
  check('queue excludes solved',         s.queue.length === 4);
  check('total === unsolved count',      s.total === 4);
  const sorted = s.queue.slice().sort();
  check('only unsolved ids in queue', JSON.stringify(sorted) === JSON.stringify(['p1','p3','p5','p7']));
}

section('Session.create — empty cases');
{
  const noMatches = Session.create({ matches: [] });
  check('empty matches → complete=true', noMatches.complete === true);
  check('empty matches → queue empty',   noMatches.queue.length === 0);

  const allDone = Session.create({ matches: MATCHES, isCompleted: ALL_COMPLETED });
  check('all completed → queue empty',     allDone.queue.length === 0);
  check('all completed → inRangeTotal=7',  allDone.inRangeTotal === 7);
  check('all completed → complete=true',   allDone.complete === true);

  const outOfRange = Session.create({
    matches: MATCHES, ratingMin: 5000, ratingMax: 6000, isCompleted: NEVER_COMPLETED
  });
  check('no in-range → complete=true', outOfRange.complete === true);
  check('no in-range → queue empty',   outOfRange.queue.length === 0);
}

section('Session.create — throws on missing opts');
{
  let threw = false;
  try { Session.create(); } catch (e) { threw = true; }
  check('create() throws', threw);

  // Defensive defaults: no matches passed → empty.
  const s = Session.create({});
  check('create({}) → empty queue', s.queue.length === 0);
}

section('Session.create — does not mutate input');
{
  const input = MATCHES.slice();
  const inputJson = JSON.stringify(input);
  Session.create({ matches: input, isCompleted: NEVER_COMPLETED, rng: mulberry32(99) });
  check('input matches array unmutated', JSON.stringify(input) === inputJson);
}

// ━━━ advance ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.advance — walks the queue');
{
  const s0 = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(7)
  });
  const r1 = Session.advance(s0);
  check('first advance yields a puzzleId', typeof r1.puzzleId === 'string' && r1.puzzleId.length > 0);
  check('first advance: cursor=0',          r1.state.cursor === 0);
  check('first advance: !exhausted',        r1.exhausted === false);
  check('puzzleId is queue[0]',             r1.puzzleId === s0.queue[0]);

  // Walk the full queue.
  let st = s0;
  const seen = [];
  for (let i = 0; i < 7; i++) {
    const r = Session.advance(st);
    seen.push(r.puzzleId);
    st = r.state;
  }
  check('walked 7 puzzles',                 seen.length === 7);
  check('seen matches queue order',         JSON.stringify(seen) === JSON.stringify(s0.queue));
  check('state.cursor=6 after last',        st.cursor === 6);
  check('state.complete=false on last id',  st.complete === false);

  // One more → exhausted.
  const rEnd = Session.advance(st);
  check('post-end: puzzleId null',          rEnd.puzzleId === null);
  check('post-end: exhausted=true',         rEnd.exhausted === true);
  check('post-end: state.complete=true',    rEnd.state.complete === true);
  check('post-end: cursor pinned at total', rEnd.state.cursor === 7);

  // Idempotent: advance on a complete state stays complete.
  const rEnd2 = Session.advance(rEnd.state);
  check('idempotent: still null',           rEnd2.puzzleId === null);
  check('idempotent: still exhausted',      rEnd2.exhausted === true);
  check('idempotent: cursor unchanged',     rEnd2.state.cursor === 7);
}

section('Session.advance — empty queue');
{
  const s = Session.create({ matches: [] });
  const r = Session.advance(s);
  check('empty: puzzleId null',  r.puzzleId === null);
  check('empty: exhausted=true', r.exhausted === true);
}

section('Session.advance — does not mutate input state');
{
  const s = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(11)
  });
  const before = JSON.stringify(s);
  Session.advance(s);
  check('input state unmutated', JSON.stringify(s) === before);
}

section('Session.advance — throws on missing state');
{
  let threw = false;
  try { Session.advance(); } catch (e) { threw = true; }
  check('advance() throws', threw);
}

// ━━━ progress ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.progress');
{
  const s0 = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(3)
  });
  const p0 = Session.progress(s0);
  check('fresh: current=0',      p0.current === 0);
  check('fresh: total=7',        p0.total === 7);

  const r1 = Session.advance(s0);
  const p1 = Session.progress(r1.state);
  check('after first: current=1', p1.current === 1);
  check('after first: total=7',   p1.total === 7);

  // Walk to end + one over.
  let st = s0;
  for (let i = 0; i < 8; i++) st = Session.advance(st).state;
  const pEnd = Session.progress(st);
  check('exhausted: current=7',   pEnd.current === 7);
  check('exhausted: total=7',     pEnd.total === 7);

  // Defensive: undefined state.
  const pNull = Session.progress(null);
  check('null state: current=0', pNull.current === 0);
  check('null state: total=0',   pNull.total === 0);
}

// ━━━ deterministic shuffle (sanity-check the rng wiring) ━━━━━━━━━━━━━━━━

section('Session.create — deterministic shuffle with seeded rng');
{
  const s1 = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(42)
  });
  const s2 = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(42)
  });
  check('same seed → same order', JSON.stringify(s1.queue) === JSON.stringify(s2.queue));

  const s3 = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(43)
  });
  // Not a strict guarantee for tiny arrays, but with 7 elements collision is rare.
  check('different seed → different order (7-element heuristic)',
        JSON.stringify(s1.queue) !== JSON.stringify(s3.queue),
        'if this flakes, pick another seed pair — 7! = 5040 permutations');
}

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

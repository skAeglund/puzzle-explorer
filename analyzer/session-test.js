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

section('Session.create — sets kind="search" on returned state');
{
  const s = Session.create({ matches: MATCHES, isCompleted: NEVER_COMPLETED });
  check('kind === "search"', s.kind === 'search');
}

section('Session.createFromIds — basic shape');
{
  const ids = ['p1', 'p2', 'p3'];
  const s = Session.createFromIds(ids);
  check('kind === "review" by default', s.kind === 'review');
  check('queue preserves caller order',
        JSON.stringify(s.queue) === JSON.stringify(ids));
  check('total === ids.length', s.total === 3);
  check('inRangeTotal === ids.length', s.inRangeTotal === 3);
  check('ratingMin/Max null', s.ratingMin === null && s.ratingMax === null);
  check('cursor === -1', s.cursor === -1);
  check('complete === false', s.complete === false);
}

section('Session.createFromIds — empty / nullish input');
{
  const empty = Session.createFromIds([]);
  check('empty array → complete=true', empty.complete === true);
  check('empty array → total=0',       empty.total === 0);
  check('empty array → kind=review',   empty.kind === 'review');

  // Defensive: non-array should treat as empty rather than throw
  const nullish = Session.createFromIds(null);
  check('null input → complete=true', nullish.complete === true);
  const undef = Session.createFromIds();
  check('undefined input → complete=true', undef.complete === true);
}

section('Session.createFromIds — filters out non-string / empty entries');
{
  const ids = ['valid', '', null, undefined, 42, 'also-valid'];
  const s = Session.createFromIds(ids);
  check('only valid strings kept',
        JSON.stringify(s.queue) === JSON.stringify(['valid', 'also-valid']));
  check('total reflects clean count', s.total === 2);
}

section('Session.createFromIds — opts.kind override');
{
  const s = Session.createFromIds(['a'], { kind: 'custom-mode' });
  check('caller-supplied kind respected', s.kind === 'custom-mode');
  const sNullKind = Session.createFromIds(['a'], { kind: null });
  check('null kind falls back to default', sNullKind.kind === 'review');
  const sEmptyKind = Session.createFromIds(['a'], { kind: '' });
  check('empty-string kind falls back to default', sEmptyKind.kind === 'review');
}

section('Session.createFromIds — does not mutate input array');
{
  const ids = ['a', 'b', 'c'];
  const snapshot = ids.slice();
  Session.createFromIds(ids);
  check('input untouched', JSON.stringify(ids) === JSON.stringify(snapshot));
}

section('Session.createFromIds → advance walks the queue');
{
  const s = Session.createFromIds(['rev1', 'rev2', 'rev3']);
  let r = Session.advance(s);
  check('first advance → rev1',  r.puzzleId === 'rev1' && !r.exhausted);
  check('first advance preserves kind', r.state.kind === 'review');
  r = Session.advance(r.state);
  check('second advance → rev2', r.puzzleId === 'rev2');
  r = Session.advance(r.state);
  check('third advance → rev3',  r.puzzleId === 'rev3');
  r = Session.advance(r.state);
  check('fourth advance → exhausted', r.exhausted === true && r.puzzleId === null);
  check('exhausted state.complete=true', r.state.complete === true);
}

section('Session.createFromIds → progress label');
{
  let s = Session.createFromIds(['a', 'b', 'c', 'd']);
  let p = Session.progress(s);
  check('initial: 0/4', p.current === 0 && p.total === 4);
  s = Session.advance(s).state;
  p = Session.progress(s);
  check('after 1 advance: 1/4', p.current === 1 && p.total === 4);
  s = Session.advance(Session.advance(s).state).state;
  p = Session.progress(s);
  check('after 3 advances: 3/4', p.current === 3 && p.total === 4);
}

// ━━━ retreat ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.retreat — walks backward through the queue');
{
  // Build a fresh session and walk to the third puzzle.
  let s = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(7)
  });
  s = Session.advance(s).state; // cursor 0
  s = Session.advance(s).state; // cursor 1
  s = Session.advance(s).state; // cursor 2 (3rd puzzle)
  check('precondition: cursor=2', s.cursor === 2);
  const queueAt2 = s.queue[2];
  const queueAt1 = s.queue[1];
  const queueAt0 = s.queue[0];

  const r1 = Session.retreat(s);
  check('first retreat: cursor=1',         r1.state.cursor === 1);
  check('first retreat: puzzleId=queue[1]', r1.puzzleId === queueAt1);
  check('first retreat: !atStart',          r1.atStart === false);
  check('first retreat: complete=false',    r1.state.complete === false);

  const r2 = Session.retreat(r1.state);
  check('second retreat: cursor=0',          r2.state.cursor === 0);
  check('second retreat: puzzleId=queue[0]', r2.puzzleId === queueAt0);
  check('second retreat: atStart=true',      r2.atStart === true);

  // Walking forward from here should resume at queue[1] (cursor was 0,
  // advance bumps to 1 — so the forward walk re-yields queueAt1).
  const fwd = Session.advance(r2.state);
  check('advance after retreat: cursor=1',    fwd.state.cursor === 1);
  check('advance after retreat: puzzleId',    fwd.puzzleId === queueAt1);

  // Retain the cursor=2 baseline: original `s` is unmutated.
  check('original state unmutated', s.cursor === 2 && s.queue[2] === queueAt2);
}

section('Session.retreat — idempotent at cursor 0');
{
  let s = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(13)
  });
  s = Session.advance(s).state; // cursor 0
  const r1 = Session.retreat(s);
  check('cursor 0 → atStart=true',    r1.atStart === true);
  check('cursor 0 → puzzleId=null',   r1.puzzleId === null);
  check('cursor 0 → cursor unchanged', r1.state.cursor === 0);

  // Idempotent: another retreat is still a no-op.
  const r2 = Session.retreat(r1.state);
  check('repeat retreat: still atStart', r2.atStart === true);
  check('repeat retreat: still null',    r2.puzzleId === null);
  check('repeat retreat: cursor=0',      r2.state.cursor === 0);
}

section('Session.retreat — fresh state (cursor=-1)');
{
  // Calling retreat before the first advance — defensive case. The UI
  // gates the button so this shouldn't happen in practice, but make sure
  // we don't crash or jump to a nonsense cursor.
  const s = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(1)
  });
  check('precondition: cursor=-1', s.cursor === -1);
  const r = Session.retreat(s);
  check('fresh: atStart=true',       r.atStart === true);
  check('fresh: puzzleId=null',      r.puzzleId === null);
  check('fresh: cursor unchanged',   r.state.cursor === -1);
}

section('Session.retreat — empty queue');
{
  const s = Session.create({ matches: [] });
  const r = Session.retreat(s);
  check('empty: atStart=true',  r.atStart === true);
  check('empty: puzzleId=null', r.puzzleId === null);
}

section('Session.retreat — from complete state skips dead cursor');
{
  // Walk a 3-puzzle queue to exhaustion. advance() pins cursor at
  // queue.length and sets complete=true; the visible board is still
  // queue[length-1]. Retreat from this state should land on
  // queue[length-2] (the puzzle BEFORE the visually-current one) in
  // one step, NOT on queue[length-1] (re-loading the same puzzle).
  let s = Session.createFromIds(['a', 'b', 'c']);
  s = Session.advance(s).state; // cursor 0
  s = Session.advance(s).state; // cursor 1
  s = Session.advance(s).state; // cursor 2 (last puzzle visible)
  const final = Session.advance(s); // exhaust
  check('precondition: complete=true',     final.state.complete === true);
  check('precondition: cursor=length',     final.state.cursor === 3);
  check('precondition: exhausted=true',    final.exhausted === true);

  const r = Session.retreat(final.state);
  check('post-complete retreat: cursor=1',   r.state.cursor === 1);
  check('post-complete retreat: puzzleId=b', r.puzzleId === 'b');
  check('post-complete retreat: complete=false', r.state.complete === false);
  check('post-complete retreat: !atStart',   r.atStart === false);
}

section('Session.retreat — from complete with single-puzzle queue');
{
  // Edge case: 1-puzzle session, exhausted. Retreat has no "second-to-last"
  // to land on. Should be a no-op with atStart=true.
  let s = Session.createFromIds(['only']);
  s = Session.advance(s).state;     // cursor 0
  const final = Session.advance(s); // exhaust → cursor 1, complete
  check('precondition: complete=true', final.state.complete === true);

  const r = Session.retreat(final.state);
  check('1-puzzle complete retreat: atStart=true', r.atStart === true);
  check('1-puzzle complete retreat: puzzleId=null', r.puzzleId === null);
}

section('Session.retreat — does not mutate input state');
{
  let s = Session.create({
    matches: MATCHES, isCompleted: NEVER_COMPLETED, rng: mulberry32(11)
  });
  s = Session.advance(s).state;
  s = Session.advance(s).state;
  const before = JSON.stringify(s);
  Session.retreat(s);
  check('input state unmutated', JSON.stringify(s) === before);
}

section('Session.retreat — throws on missing state');
{
  let threw = false;
  try { Session.retreat(); } catch (e) { threw = true; }
  check('retreat() throws', threw);
}

section('Session.retreat — round-trip with progress');
{
  // After advancing N times then retreating once, progress should drop
  // by 1. Verifies the cursor decrement plays nicely with the existing
  // progress() display contract.
  let s = Session.createFromIds(['a', 'b', 'c', 'd', 'e']);
  s = Session.advance(s).state; // 1/5
  s = Session.advance(s).state; // 2/5
  s = Session.advance(s).state; // 3/5
  let p = Session.progress(s);
  check('forward: 3/5', p.current === 3 && p.total === 5);

  s = Session.retreat(s).state; // 2/5
  p = Session.progress(s);
  check('retreat: 2/5', p.current === 2 && p.total === 5);

  s = Session.retreat(s).state; // 1/5
  p = Session.progress(s);
  check('retreat: 1/5', p.current === 1 && p.total === 5);
}

// ━━━ createTraining ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.createTraining: basic queueing');
{
  // 7 puzzles spanning 1000-2200 (see MATCHES). Three rounds:
  //   Easy [1000,1399] → p1, p2 (target 5, takes both)
  //   Medium [1400,1999] → p3, p4, p5 (target 2, takes 2)
  //   Hard [2000+] → p6, p7 (target 5, takes both)
  const t = Session.createTraining({
    matches: MATCHES,
    rounds: [
      { label: 'Easy',   ratingMin: 1000, ratingMax: 1399, target: 5 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 2 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 5 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(1)
  });
  check('kind: training', t.kind === 'training');
  check('cursor: -1', t.cursor === -1);
  check('not complete', t.complete === false);
  check('total = sum of round counts', t.total === 6);  // 2 + 2 + 2
  check('queue length matches total', t.queue.length === 6);
  check('rounds metadata count = 3', t.rounds.length === 3);
  check('round 0 label', t.rounds[0].label === 'Easy');
  check('round 0 count = 2 (only p1,p2 in range)', t.rounds[0].count === 2);
  check('round 0 startIndex = 0', t.rounds[0].startIndex === 0);
  check('round 1 startIndex = 2', t.rounds[1].startIndex === 2);
  check('round 1 count = 2 (capped at target)', t.rounds[1].count === 2);
  check('round 2 startIndex = 4', t.rounds[2].startIndex === 4);
  check('round 2 target preserved', t.rounds[2].target === 5);
  check('round 2 count = 2 (only p6,p7 in range)', t.rounds[2].count === 2);
  check('inRangeTotal counts unique ids across rounds', t.inRangeTotal === 7);
  // Queue order: round 0 ids first, then round 1, then round 2.
  const r0 = t.queue.slice(0, 2);
  const r1 = t.queue.slice(2, 4);
  const r2 = t.queue.slice(4, 6);
  const isIn = (set, ids) => ids.every(id => set.includes(id));
  check('round 0 contains only p1,p2', isIn(['p1', 'p2'], r0) && r0.length === 2);
  check('round 1 contains only medium ids', isIn(['p3', 'p4', 'p5'], r1));
  check('round 2 contains only p6,p7', isIn(['p6', 'p7'], r2) && r2.length === 2);
}

section('Session.createTraining: empty rounds skipped (count=0)');
{
  // No matches in the 'Hard' bucket.
  const t = Session.createTraining({
    matches: [['p1', 1000], ['p2', 1500]],
    rounds: [
      { label: 'Easy',   ratingMin: 0,    ratingMax: 1399, target: 3 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 3 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 3 }
    ],
    isCompleted: NEVER_COMPLETED
  });
  check('total = 2 (no hard puzzles)', t.total === 2);
  check('hard round has count=0', t.rounds[2].count === 0);
  check('hard round still in metadata', t.rounds[2].label === 'Hard');
  // Empty round's startIndex should equal queue.length AT THE TIME the
  // round was processed — for Hard that's after Easy(1) + Medium(1) = 2.
  check('empty round startIndex = total before it', t.rounds[2].startIndex === 2);
  check('not complete (other rounds populated)', t.complete === false);
}

section('Session.createTraining: all rounds empty');
{
  const t = Session.createTraining({
    matches: [['p1', 500]],   // below all bucket floors
    rounds: [
      { label: 'Easy',   ratingMin: 800, ratingMax: 1399, target: 3 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 3 }
    ],
    isCompleted: NEVER_COMPLETED
  });
  check('total = 0', t.total === 0);
  check('complete = true (immediate)', t.complete === true);
  check('rounds metadata still populated', t.rounds.length === 2);
}

section('Session.createTraining: solved puzzles excluded');
{
  const solvedSet = { p1: true, p3: true, p5: true };
  const t = Session.createTraining({
    matches: MATCHES,
    rounds: [
      { label: 'Easy',   ratingMin: 1000, ratingMax: 1399, target: 5 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 5 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 5 }
    ],
    isCompleted: function (id) { return !!solvedSet[id]; },
    rng: mulberry32(2)
  });
  check('solved p1 excluded from queue', t.queue.indexOf('p1') === -1);
  check('solved p3 excluded', t.queue.indexOf('p3') === -1);
  check('solved p5 excluded', t.queue.indexOf('p5') === -1);
  check('unsolved p2 included', t.queue.indexOf('p2') !== -1);
  check('inRangeTotal counts solved+unsolved', t.inRangeTotal === 7);
  check('total only counts unsolved', t.total === 4);
}

section('Session.createTraining: dedup across overlapping rounds');
{
  // Spec says rounds dedupe — earlier round wins. Use overlapping bounds
  // to verify: p3 (rating 1400) is in BOTH "Easy" (incl. 1400) and
  // "Medium" (also incl. 1400). It should land in Easy only.
  const t = Session.createTraining({
    matches: [['p1', 1000], ['p3', 1400], ['p5', 1800]],
    rounds: [
      { label: 'Easy',   ratingMin: 1000, ratingMax: 1400, target: 5 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1800, target: 5 }
    ],
    isCompleted: NEVER_COMPLETED
  });
  check('p3 placed in Easy round (earlier wins)', t.rounds[0].count === 2);
  check('p3 NOT duplicated in Medium round', t.rounds[1].count === 1);
  check('queue length is 3, no dupes', t.total === 3);
  // Set semantics: each id appears exactly once.
  const seen = {};
  let dupe = false;
  for (let i = 0; i < t.queue.length; i++) {
    if (seen[t.queue[i]]) dupe = true;
    seen[t.queue[i]] = true;
  }
  check('no duplicate ids in queue', !dupe);
}

section('Session.createTraining: target=0 round contributes nothing');
{
  const t = Session.createTraining({
    matches: MATCHES,
    rounds: [
      { label: 'Skip', ratingMin: 1000, ratingMax: 1400, target: 0 },
      { label: 'Use',  ratingMin: 1400, ratingMax: 1999, target: 5 }
    ],
    isCompleted: NEVER_COMPLETED
  });
  check('target=0 → count=0', t.rounds[0].count === 0);
  check('subsequent round still works', t.rounds[1].count > 0);
}

section('Session.createTraining: defensive against missing/invalid rounds');
{
  const empty = Session.createTraining({
    matches: MATCHES,
    rounds: [],
    isCompleted: NEVER_COMPLETED
  });
  check('no rounds → empty queue', empty.total === 0);
  check('no rounds → complete', empty.complete === true);

  const noOpts = (function () {
    try { Session.createTraining(); return false; } catch (e) { return true; }
  })();
  check('no opts → throws', noOpts);

  // Bad round entries skipped/coerced; whole call doesn't throw.
  const tolerant = Session.createTraining({
    matches: MATCHES,
    rounds: [null, undefined, {}, { label: 'Hard', ratingMin: 2000, target: 5 }],
    isCompleted: NEVER_COMPLETED
  });
  check('bad round entries do not crash', tolerant.rounds.length === 4);
  check('only the valid round contributes', tolerant.total === 2);  // p6,p7
}

section('Session.createTraining: integrates with advance/retreat');
{
  const t0 = Session.createTraining({
    matches: MATCHES,
    rounds: [
      { label: 'Easy',   ratingMin: 1000, ratingMax: 1399, target: 5 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 5 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 5 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(3)
  });
  check('initial total = 7', t0.total === 7);
  // Walk all the way through. advance/retreat treat training queue same
  // as a 'search' queue.
  let s = t0;
  for (let i = 0; i < 7; i++) {
    const r = Session.advance(s);
    s = r.state;
    check('advance #' + (i + 1) + ' returns puzzleId', !!r.puzzleId);
  }
  const tail = Session.advance(s);
  check('post-tail advance: exhausted', tail.exhausted === true);
  check('post-tail advance: complete=true', tail.state.complete === true);

  // Retreat from complete state: should land on queue[length-2] = queue[5]
  // (the puzzle BEFORE the last one drilled), not queue[length-1].
  const back1 = Session.retreat(tail.state);
  check('retreat from complete → queue[length-2]',
    back1.puzzleId === t0.queue[5]);
  check('retreat from complete → cursor=length-2',
    back1.state.cursor === 5);

  // Walk back to start, then one more retreat is a no-op.
  let s2 = back1.state;
  for (let i = 0; i < 5; i++) s2 = Session.retreat(s2).state;
  check('after 5 more retreats, cursor=0', s2.cursor === 0);
  const noop = Session.retreat(s2);
  check('retreat at cursor=0: atStart', noop.atStart === true);
  check('retreat at cursor=0: puzzleId null', noop.puzzleId === null);
  check('retreat at cursor=0: state unchanged', noop.state === s2);
}

section('Session.createTraining: within-round rating sort (warm-up)');
{
  // Single round with 7 puzzles spanning 1000-2200, target=5. The sample
  // is random (depends on seed) but should always come out ascending.
  const t = Session.createTraining({
    matches: MATCHES,
    rounds: [
      { label: 'Mixed', ratingMin: 1000, ratingMax: 2300, target: 5 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  // Look up rating per id from MATCHES to avoid hard-coding the sample.
  const ratingOf = {};
  MATCHES.forEach(m => { ratingOf[m[0]] = m[1]; });
  const ratings = t.queue.map(id => ratingOf[id]);
  let asc = true;
  for (let i = 1; i < ratings.length; i++) if (ratings[i] < ratings[i - 1]) asc = false;
  check('round 0 ratings ascending', asc, JSON.stringify(ratings));
  check('round 0 size = target', t.queue.length === 5);
}

section('Session.createTraining: warm-up is sample-then-sort, not sort-then-sample');
{
  // If we sorted-then-sampled, target=3 from a 7-pool would ALWAYS yield
  // {p1, p2, p3} regardless of seed. Different seeds should yield different
  // *sets* of ids (with a 7-element heuristic, collision is rare).
  const t1 = Session.createTraining({
    matches: MATCHES,
    rounds: [{ label: 'Pick 3', ratingMin: 1000, ratingMax: 2300, target: 3 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(11)
  });
  const t2 = Session.createTraining({
    matches: MATCHES,
    rounds: [{ label: 'Pick 3', ratingMin: 1000, ratingMax: 2300, target: 3 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(12)
  });
  const set1 = t1.queue.slice().sort().join(',');
  const set2 = t2.queue.slice().sort().join(',');
  check('different seeds → different samples (heuristic)',
        set1 !== set2,
        'if this flakes, pick another seed pair — C(7,3)=35 combos');
  // And both samples are individually ascending.
  const ratingOf = {};
  MATCHES.forEach(m => { ratingOf[m[0]] = m[1]; });
  const r1 = t1.queue.map(id => ratingOf[id]);
  const r2 = t2.queue.map(id => ratingOf[id]);
  const isAsc = a => a.every((v, i) => i === 0 || a[i - 1] <= v);
  check('seed-A sample is ascending', isAsc(r1), JSON.stringify(r1));
  check('seed-B sample is ascending', isAsc(r2), JSON.stringify(r2));
}

section('Session.createTraining: warm-up — rounds concatenate, each sorted asc internally');
{
  // Two rounds: queue[0..count0) is round 0 sorted asc, queue[count0..) is
  // round 1 sorted asc. The boundary between rounds may step DOWN in rating
  // (round 1's lowest can be below round 0's highest if buckets overlap or
  // if user configured a non-monotonic round order — that's allowed).
  const t = Session.createTraining({
    matches: MATCHES,
    rounds: [
      { label: 'Easy',   ratingMin: 1000, ratingMax: 1499, target: 5 },
      { label: 'Medium', ratingMin: 1500, ratingMax: 1999, target: 5 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(13)
  });
  const ratingOf = {};
  MATCHES.forEach(m => { ratingOf[m[0]] = m[1]; });
  const ratings = t.queue.map(id => ratingOf[id]);
  const c0 = t.rounds[0].count;
  const r0 = ratings.slice(0, c0);
  const r1 = ratings.slice(c0);
  const isAsc = a => a.every((v, i) => i === 0 || a[i - 1] <= v);
  check('round 0 segment ascending', isAsc(r0), JSON.stringify(r0));
  check('round 1 segment ascending', isAsc(r1), JSON.stringify(r1));
}

section('Session.createTraining: warm-up — ties keep shuffle order (stable sort)');
{
  // All four puzzles share rating 1500. Sort is a no-op on values, so the
  // queue order should match the shuffle order. Two different seeds should
  // produce different orders (sort can't rescue equality).
  const TIES = [['a', 1500], ['b', 1500], ['c', 1500], ['d', 1500]];
  const sA = Session.createTraining({
    matches: TIES,
    rounds: [{ label: 'Tied', ratingMin: 1500, ratingMax: 1500, target: 4 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(101)
  });
  const sB = Session.createTraining({
    matches: TIES,
    rounds: [{ label: 'Tied', ratingMin: 1500, ratingMax: 1500, target: 4 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(202)
  });
  check('all four tied ids picked (count=4)', sA.queue.length === 4 && sB.queue.length === 4);
  check('tied ratings → seed-dependent order',
        JSON.stringify(sA.queue) !== JSON.stringify(sB.queue),
        'if this flakes, swap seeds — 4! = 24 permutations');
}

section('Session.createTraining: warm-up — rating-less puzzles sort to end of round');
{
  // p_late has no numeric rating, p_early/p_mid do. Round target = all 3.
  // Expected order: p_early (1000), p_mid (1500), p_late (no rating, end).
  const t = Session.createTraining({
    matches: [['p_late', null], ['p_mid', 1500], ['p_early', 1000]],
    rounds: [{ label: 'Mix', ratingMin: 0, ratingMax: 9999, target: 5 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(31)
  });
  // filterByRating passes rating-less tuples through unfiltered. Confirm
  // all three made it.
  check('all 3 in queue (rating-less passes through filter)', t.queue.length === 3);
  check('p_early first (lowest rating)',  t.queue[0] === 'p_early');
  check('p_mid second',                    t.queue[1] === 'p_mid');
  check('rating-less puzzle last',         t.queue[2] === 'p_late');
}

section('Session.createTraining: warm-up — multiple rating-less entries stay in their shuffle order');
{
  // Three rating-less entries in a single round. Comparator returns 0 for
  // null-vs-null so stable sort preserves the shuffle order. Two seeds
  // should still produce different orderings (because the shuffle differs
  // and the sort doesn't override it for tied/null pairs).
  const NULLS = [['x', null], ['y', null], ['z', null], ['w', null]];
  const sA = Session.createTraining({
    matches: NULLS,
    rounds: [{ label: 'Nulls', ratingMin: 0, ratingMax: 9999, target: 4 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(303)
  });
  const sB = Session.createTraining({
    matches: NULLS,
    rounds: [{ label: 'Nulls', ratingMin: 0, ratingMax: 9999, target: 4 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(404)
  });
  check('all 4 nulls picked', sA.queue.length === 4 && sB.queue.length === 4);
  check('multiple nulls → seed-dependent order (sort doesn\'t collapse)',
        JSON.stringify(sA.queue) !== JSON.stringify(sB.queue),
        'if this flakes, swap seeds — 4! = 24 permutations');
}

// ━━━ trainingRound ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.trainingRound');
{
  const t = Session.createTraining({
    matches: MATCHES,
    rounds: [
      { label: 'Easy',   ratingMin: 1000, ratingMax: 1399, target: 5 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 5 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 5 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(4)
  });
  // Round counts: easy=2, medium=3, hard=2 → total=7.
  // startIndex: easy=0, medium=2, hard=5.

  // cursor=-1 (not started yet)
  const r0 = Session.trainingRound(t);
  check('cursor=-1 → roundIndex 0', r0.roundIndex === 0);
  check('cursor=-1 → label Easy', r0.label === 'Easy');
  check('cursor=-1 → currentInRound 0', r0.currentInRound === 0);
  check('totalInRound matches round count', r0.totalInRound === 2);
  check('totalRounds reports all rounds', r0.totalRounds === 3);

  // cursor=0 (first easy puzzle)
  const t1 = Session.advance(t).state;
  const r1 = Session.trainingRound(t1);
  check('cursor=0 → Easy 1/2', r1.roundIndex === 0 && r1.currentInRound === 1 && r1.totalInRound === 2);

  // cursor=1 (second easy)
  const t2 = Session.advance(t1).state;
  const r2 = Session.trainingRound(t2);
  check('cursor=1 → Easy 2/2', r2.roundIndex === 0 && r2.currentInRound === 2);

  // cursor=2 (first medium — round boundary)
  const t3 = Session.advance(t2).state;
  const r3 = Session.trainingRound(t3);
  check('cursor=2 → Medium 1/3 (boundary)', r3.roundIndex === 1 && r3.currentInRound === 1 && r3.totalInRound === 3);
  check('cursor=2 → label flips to Medium', r3.label === 'Medium');

  // cursor=4 (last medium)
  let t4 = Session.advance(t3).state;
  t4 = Session.advance(t4).state;
  const r4 = Session.trainingRound(t4);
  check('cursor=4 → Medium 3/3', r4.roundIndex === 1 && r4.currentInRound === 3);

  // cursor=5 (first hard)
  const t5 = Session.advance(t4).state;
  const r5 = Session.trainingRound(t5);
  check('cursor=5 → Hard 1/2', r5.roundIndex === 2 && r5.currentInRound === 1);

  // cursor=6 (last hard) then complete
  const t6 = Session.advance(t5).state;
  const r6 = Session.trainingRound(t6);
  check('cursor=6 → Hard 2/2', r6.roundIndex === 2 && r6.currentInRound === 2);

  const tEnd = Session.advance(t6);
  check('exhausted advance fires', tEnd.exhausted === true);
  const rEnd = Session.trainingRound(tEnd.state);
  check('complete state → still reports last round', rEnd.roundIndex === 2);
  check('complete state → currentInRound clamped to count', rEnd.currentInRound === 2);
}

section('Session.trainingRound: skips empty rounds in lookup');
{
  // Easy is empty (no matches < 1400 in this set), Medium and Hard populated.
  const t = Session.createTraining({
    matches: [['p1', 1500], ['p2', 1700], ['p3', 2100]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 3 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 3 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 3 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(5)
  });
  // Expected: queue has 3 puzzles; rounds[0].count=0, rounds[1].count=2,
  // rounds[2].count=1. cursor=0 should map to Medium, not Easy.
  check('Easy round empty', t.rounds[0].count === 0);
  check('Medium round has 2', t.rounds[1].count === 2);
  check('Hard round has 1', t.rounds[2].count === 1);

  const t1 = Session.advance(t).state;     // cursor=0
  const r1 = Session.trainingRound(t1);
  check('empty leading round skipped → cursor=0 maps to Medium',
    r1.roundIndex === 1 && r1.label === 'Medium' && r1.currentInRound === 1);

  const t2 = Session.advance(t1).state;    // cursor=1
  const r2 = Session.trainingRound(t2);
  check('cursor=1 still in Medium', r2.roundIndex === 1 && r2.currentInRound === 2);

  const t3 = Session.advance(t2).state;    // cursor=2 → Hard
  const r3 = Session.trainingRound(t3);
  check('cursor=2 → Hard 1/1', r3.roundIndex === 2 && r3.currentInRound === 1);
}

section('Session.trainingRound: defensive on non-training states');
{
  check('null state → null', Session.trainingRound(null) === null);
  check('undefined state → null', Session.trainingRound(undefined) === null);
  // A regular search-kind state must not be misread as training.
  const search = Session.create({
    matches: MATCHES, ratingMin: 1000, ratingMax: 2200,
    isCompleted: NEVER_COMPLETED
  });
  check('search-kind state → null', Session.trainingRound(search) === null);
  // createFromIds returns kind: 'review' by default.
  const review = Session.createFromIds(['a', 'b', 'c']);
  check('review-kind state → null', Session.trainingRound(review) === null);
}

section('Session.trainingRound: roundNumber/roundCount filter empty rounds');
{
  // roundCount counts non-empty rounds; roundNumber is the 1-based position
  // of the matched round among non-empty rounds. totalRounds (the configured
  // count) stays separate so callers can compare configured vs. populated.

  // (a) all 3 rounds populated → roundNumber === roundIndex+1, roundCount===3
  const tAll = Session.createTraining({
    matches: [['e', 1000], ['m', 1500], ['h', 2100]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  const a0 = Session.trainingRound(Session.advance(tAll).state);
  check('all populated: roundNumber=1 at first round', a0.roundNumber === 1);
  check('all populated: roundCount=3', a0.roundCount === 3);
  check('all populated: totalRounds=3 unchanged', a0.totalRounds === 3);
  const a1 = Session.trainingRound(Session.advance(Session.advance(tAll).state).state);
  check('all populated: roundNumber=2 at second round', a1.roundNumber === 2);
  const a2 = Session.trainingRound(
    Session.advance(Session.advance(Session.advance(tAll).state).state).state
  );
  check('all populated: roundNumber=3 at third round', a2.roundNumber === 3);

  // (b) leading round empty → first puzzle reports "Round 1/2", not "2/3"
  const tLead = Session.createTraining({
    matches: [['m', 1500], ['h', 2100]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(8)
  });
  const lead0 = Session.trainingRound(Session.advance(tLead).state);
  check('empty leading: roundCount=2', lead0.roundCount === 2);
  check('empty leading: Medium shown as Round 1/2', lead0.roundNumber === 1 && lead0.label === 'Medium');
  check('empty leading: totalRounds still 3 (configured)', lead0.totalRounds === 3);
  const lead1 = Session.trainingRound(Session.advance(Session.advance(tLead).state).state);
  check('empty leading: Hard shown as Round 2/2', lead1.roundNumber === 2 && lead1.label === 'Hard');

  // (c) middle round empty → easy is 1/2, hard is 2/2 (Medium is skipped)
  const tMid = Session.createTraining({
    matches: [['e', 1000], ['h', 2100]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(9)
  });
  const mid0 = Session.trainingRound(Session.advance(tMid).state);
  check('empty middle: roundCount=2', mid0.roundCount === 2);
  check('empty middle: Easy shown as Round 1/2', mid0.roundNumber === 1 && mid0.label === 'Easy');
  const mid1 = Session.trainingRound(Session.advance(Session.advance(tMid).state).state);
  check('empty middle: Hard shown as Round 2/2 (skips Medium)',
    mid1.roundNumber === 2 && mid1.label === 'Hard');

  // (d) trailing round empty → easy is 1/2, medium is 2/2
  const tTail = Session.createTraining({
    matches: [['e', 1000], ['m', 1500]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(10)
  });
  const tail0 = Session.trainingRound(Session.advance(tTail).state);
  check('empty trailing: roundCount=2', tail0.roundCount === 2);
  check('empty trailing: Easy shown as Round 1/2', tail0.roundNumber === 1 && tail0.label === 'Easy');
  const tail1 = Session.trainingRound(Session.advance(Session.advance(tTail).state).state);
  check('empty trailing: Medium shown as Round 2/2', tail1.roundNumber === 2 && tail1.label === 'Medium');

  // (e) only ONE round populated (two consecutive empties trailing) →
  // user sees "Round 1/1" — the lone round at full denominator.
  const tOnly = Session.createTraining({
    matches: [['a', 1000], ['b', 1100]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 2 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 2 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 2 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(11)
  });
  const only0 = Session.trainingRound(Session.advance(tOnly).state);
  check('two trailing empties: roundCount=1', only0.roundCount === 1);
  check('two trailing empties: Round 1/1 · Easy', only0.roundNumber === 1 && only0.label === 'Easy');
  check('two trailing empties: totalRounds still 3 (configured)', only0.totalRounds === 3);
  const only1 = Session.trainingRound(Session.advance(Session.advance(tOnly).state).state);
  check('two trailing empties: stays at Round 1/1 across the round',
    only1.roundNumber === 1 && only1.label === 'Easy' && only1.currentInRound === 2);
}

// ━━━ createTrainingRetry ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Retry queue used after a training session completes with failures.
// Single 'Retry' round, no shuffle, sorted by rating asc.

section('Session.createTrainingRetry: basic queue');
{
  // Mixed rating order in → sorted asc out.
  const t = Session.createTrainingRetry([['c', 1800], ['a', 900], ['b', 1300]]);
  check('kind=training', t.kind === 'training');
  check('queue length=3', t.queue.length === 3);
  check('sorted asc by rating', t.queue.join(',') === 'a,b,c');
  check('total=3', t.total === 3);
  check('inRangeTotal=3', t.inRangeTotal === 3);
  check('not complete (cursor=-1)', t.cursor === -1 && t.complete === false);
  check('one round', Array.isArray(t.rounds) && t.rounds.length === 1);
  check('round labeled Retry', t.rounds[0].label === 'Retry');
  check('round count=3', t.rounds[0].count === 3);
  check('round target=3', t.rounds[0].target === 3);
  check('round startIndex=0', t.rounds[0].startIndex === 0);
  check('round rating bounds null', t.rounds[0].ratingMin === null && t.rounds[0].ratingMax === null);
}

section('Session.createTrainingRetry: accepts plain string ids');
{
  const t = Session.createTrainingRetry(['x', 'y', 'z']);
  // Without ratings, sort is stable on Infinity → input order preserved.
  check('queue preserved when no ratings', t.queue.join(',') === 'x,y,z');
  check('count=3', t.rounds[0].count === 3);
}

section('Session.createTrainingRetry: mixed string + tuple input');
{
  const t = Session.createTrainingRetry([['a', 1500], 'b', ['c', 1000]]);
  // Sort: c (1000) < a (1500) < b (Infinity, no rating).
  check('mixed sort: c < a < b', t.queue.join(',') === 'c,a,b');
}

section('Session.createTrainingRetry: deduplication');
{
  // Same id appearing twice — second occurrence dropped, first wins.
  const t = Session.createTrainingRetry([['a', 1000], ['a', 2000], ['b', 1500]]);
  check('dedup keeps 2 unique', t.queue.length === 2);
  check('first occurrence wins (rating 1000 used for sort)', t.queue.join(',') === 'a,b');
}

section('Session.createTrainingRetry: stable sort within equal ratings');
{
  // Equal ratings → input order preserved (stable).
  const t = Session.createTrainingRetry([['a', 1500], ['b', 1500], ['c', 1500]]);
  check('stable sort preserves input order', t.queue.join(',') === 'a,b,c');
}

section('Session.createTrainingRetry: empty input');
{
  const t = Session.createTrainingRetry([]);
  check('kind=training even when empty', t.kind === 'training');
  check('complete=true on empty queue', t.complete === true);
  check('total=0', t.total === 0);
  check('one Retry round with count=0', t.rounds.length === 1 && t.rounds[0].count === 0);
}

section('Session.createTrainingRetry: defensive on bad input');
{
  // Non-array → empty state.
  const tNull = Session.createTrainingRetry(null);
  check('null → empty queue', tNull.queue.length === 0 && tNull.complete === true);
  const tUndef = Session.createTrainingRetry(undefined);
  check('undefined → empty queue', tUndef.queue.length === 0);
  const tStr = Session.createTrainingRetry('not-an-array');
  check('string → empty queue', tStr.queue.length === 0);
  // Malformed entries dropped silently.
  const tMixed = Session.createTrainingRetry([
    null,                    // dropped
    [],                      // empty array → dropped
    [''],                    // empty string id → dropped
    [123],                   // non-string id → dropped
    ['valid', 1500],         // ok
    'plain-id'               // ok
  ]);
  check('only valid entries kept', tMixed.queue.length === 2);
  check('valid ids preserved', tMixed.queue.indexOf('valid') >= 0 && tMixed.queue.indexOf('plain-id') >= 0);
}

section('Session.createTrainingRetry: integrates with advance + trainingRound');
{
  const t0 = Session.createTrainingRetry([['a', 1000], ['b', 1100], ['c', 1200]]);
  const t1 = Session.advance(t0);
  check('advance returns first puzzle', t1.puzzleId === 'a');
  check('cursor=0 after first advance', t1.state.cursor === 0);
  const r1 = Session.trainingRound(t1.state);
  check('trainingRound: Round 1/1 · Retry', r1.roundNumber === 1 && r1.roundCount === 1 && r1.label === 'Retry');
  check('trainingRound: 1/3 in round', r1.currentInRound === 1 && r1.totalInRound === 3);
  // Walk to completion.
  const t2 = Session.advance(t1.state);
  const t3 = Session.advance(t2.state);
  const t4 = Session.advance(t3.state);
  check('exhausted after 3 advances', t4.exhausted === true && t4.state.complete === true);
  // From completed state, retreat. Per Session.retreat's documented contract,
  // retreating from a completed state steps to queue[length-2] (skips the
  // already-visible last puzzle), so user gets to puzzle 'b' in one click.
  const back = Session.retreat(t4.state);
  check('retreat from complete → puzzle b (skips visible last puzzle)',
    back.puzzleId === 'b' && back.state.complete === false);
}

section('Session.createTrainingRetry: handles non-numeric / NaN ratings');
{
  // String rating → treated as null (sorts to end).
  const t = Session.createTrainingRetry([
    ['a', 'not-a-number'],
    ['b', 1500],
    ['c', NaN],
    ['d', 1000]
  ]);
  // d (1000) < b (1500) < a (null) and c (NaN→null), stable input order for those two.
  check('non-numeric ratings treated as null/end', t.queue[0] === 'd' && t.queue[1] === 'b');
  check('null-rating entries kept (a before c by input order)',
    t.queue.indexOf('a') >= 0 && t.queue.indexOf('c') >= 0);
}

// ━━━ endEarly (issue #4) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Session.endEarly: zero-attempt — collapses to total=0, all rounds 0');
{
  // Mid-flight training, user clicked End-here before drilling anything.
  // attemptedTotal=0; all rounds.count drop to 0; complete=true; cursor at
  // queue.length so progress() reads N/N (here 0/0).
  const t = Session.createTraining({
    matches: [['e1', 1000], ['m1', 1500], ['h1', 2100]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  const r = Session.endEarly(t, {});
  check('complete=true', r.complete === true);
  check('cursor=queue.length', r.cursor === r.queue.length);
  check('total=0 (zero attempts)', r.total === 0);
  check('round 0 count=0', r.rounds[0].count === 0);
  check('round 1 count=0', r.rounds[1].count === 0);
  check('round 2 count=0', r.rounds[2].count === 0);
  check('queue not truncated', r.queue.length === 3);
}

section('Session.endEarly: partial-mid-round — counts attempted-in-round');
{
  // 2+2+2 training (target=2 each, pool size = target so sampling is
  // deterministic — every queued id is known up-front, no rng dependency
  // on which subset got picked). User drilled both Easy + 1 of the 2
  // Medium = 3 total. Expected round counts: Easy=2, Medium=1, Hard=0.
  const t = Session.createTraining({
    matches: [
      ['e1', 1000], ['e2', 1100],            // Easy pool: exactly 2
      ['m1', 1500], ['m2', 1600],            // Medium pool: exactly 2
      ['h1', 2100], ['h2', 2200]             // Hard pool: exactly 2
    ],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 2 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 2 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 2 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  // User drilled both Easy puzzles + 1 of the 2 Medium puzzles.
  const easyIds = t.queue.slice(t.rounds[0].startIndex,
                                 t.rounds[0].startIndex + t.rounds[0].count);
  const mediumIds = t.queue.slice(t.rounds[1].startIndex,
                                   t.rounds[1].startIndex + t.rounds[1].count);
  const drilled = {};
  easyIds.forEach(id => { drilled[id] = true; });
  drilled[mediumIds[0]] = true;     // only first Medium attempted

  const r = Session.endEarly(t, drilled);
  check('total=3 (2 Easy + 1 Medium)', r.total === 3);
  check('round Easy count=2',          r.rounds[0].count === 2);
  check('round Medium count=1',        r.rounds[1].count === 1);
  check('round Hard count=0',          r.rounds[2].count === 0);
  check('complete=true',               r.complete === true);
  check('startIndex preserved Easy=0', r.rounds[0].startIndex === 0);
  check('startIndex preserved Medium=2', r.rounds[1].startIndex === 2);
  check('startIndex preserved Hard=4',   r.rounds[2].startIndex === 4);
  check('progress() reads total/total', JSON.stringify(Session.progress(r)) === JSON.stringify({current: 3, total: 3}));
}

section('Session.endEarly: drilledIds with ids not in queue ignored');
{
  // User somehow has trainingOutcomes for puzzles that weren't in this
  // session's queue (e.g., from a prior Retry session that overwrote the
  // outcomes map — defensive). Those outsider ids must NOT inflate counts.
  const t = Session.createTraining({
    matches: [['x1', 1000], ['x2', 1500]],
    rounds: [
      { label: 'Easy',   ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'Medium', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'Hard',   ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  // 'foreign' is NOT in t.queue.
  const drilled = { foreign: true };
  drilled[t.queue[0]] = true;     // legit attempt
  const r = Session.endEarly(t, drilled);
  check('total=1 (foreign ignored)', r.total === 1);
  // Round containing t.queue[0] should have count=1; others 0.
  let totalCount = 0;
  for (let i = 0; i < r.rounds.length; i++) totalCount += r.rounds[i].count;
  check('rounds.count sum = total', totalCount === 1);
}

section('Session.endEarly: idempotent on already-complete state');
{
  const t = Session.createTraining({
    matches: [['x1', 1000]],
    rounds: [{ label: 'Solo', ratingMin: 0, ratingMax: 9999, target: 1 }],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  // Drill the only puzzle so state.complete becomes true.
  const a = Session.advance(t);
  const a2 = Session.advance(a.state);
  check('precondition: a2.state.complete', a2.state.complete === true);
  const r = Session.endEarly(a2.state, { 'x1': true });
  check('returns input unchanged when already complete', r === a2.state);
}

section('Session.endEarly: defensive on null / non-training shapes');
{
  check('null → null',          Session.endEarly(null, {}) === null);
  check('undefined → undefined', Session.endEarly(undefined, {}) === undefined);
  // Non-training (search) state — the function still runs (no kind gate),
  // since search states have rounds:undefined, the loop sees no rounds,
  // and the result is a "complete" state with total=0. UI-layer is the
  // gate that prevents misuse; lib stays generic.
  const search = Session.create({
    matches: MATCHES, ratingMin: 1000, ratingMax: 2200,
    isCompleted: NEVER_COMPLETED
  });
  const r = Session.endEarly(search, {});
  check('search state: complete=true', r.complete === true);
  check('search state: total=0',       r.total === 0);
}

section('Session.endEarly: drilledIds default ({}) treats as zero attempts');
{
  const t = Session.createTraining({
    matches: [['x1', 1000], ['x2', 1500]],
    rounds: [
      { label: 'A', ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'B', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'C', ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  const r = Session.endEarly(t);  // no drilledIds arg
  check('omitted drilledIds: total=0', r.total === 0);
  check('omitted drilledIds: complete=true', r.complete === true);
}

section('Session.endEarly: returns NEW state object (no input mutation)');
{
  const t = Session.createTraining({
    matches: [['x1', 1000], ['x2', 1500]],
    rounds: [
      { label: 'A', ratingMin: 800,  ratingMax: 1399, target: 1 },
      { label: 'B', ratingMin: 1400, ratingMax: 1999, target: 1 },
      { label: 'C', ratingMin: 2000, ratingMax: null, target: 1 }
    ],
    isCompleted: NEVER_COMPLETED,
    rng: mulberry32(7)
  });
  const cursorBefore = t.cursor;
  const completeBefore = t.complete;
  const totalBefore = t.total;
  const round0CountBefore = t.rounds[0].count;
  const drilled = {};
  drilled[t.queue[0]] = true;
  const r = Session.endEarly(t, drilled);
  check('input cursor unchanged',     t.cursor === cursorBefore);
  check('input complete unchanged',   t.complete === completeBefore);
  check('input total unchanged',      t.total === totalBefore);
  check('input round 0 count unchanged', t.rounds[0].count === round0CountBefore);
  check('result is a different object', r !== t);
  check('result.rounds is a different array', r.rounds !== t.rounds);
  check('result.rounds[0] is a different object', r.rounds[0] !== t.rounds[0]);
}

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * offline-test.js — Verify lib/offline.js pure helpers: shard grouping, the
 * cross-repertoire match union (with the min-ply tie-break that MUST match
 * lib/repertoireUnion.js), and the position-set signature.
 *
 * Run: node analyzer/offline-test.js
 */

const Offline = require('../lib/offline');
const RepertoireUnion = require('../lib/repertoireUnion');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

function ids(matches) { return matches.map(m => m[0]).sort(); }
function plyOf(matches, id) {
  for (const m of matches) if (m[0] === id) return m[3];
  return 'MISSING';
}

// ━━━ groupByShard ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('groupByShard');
{
  const g = Offline.groupByShard([
    { id: 'aaa', shard: '00f' },
    { id: 'bbb', shard: '00f' },
    { id: 'ccc', shard: 'a12' },
    { id: 'aaa', shard: '00f' }   // dup id+shard
  ]);
  check('two shards', Object.keys(g).length === 2);
  check('00f has aaa+bbb (deduped)', g['00f'].length === 2 && g['00f'].indexOf('aaa') !== -1 && g['00f'].indexOf('bbb') !== -1);
  check('a12 has ccc', g['a12'].length === 1 && g['a12'][0] === 'ccc');

  check('non-array → {}', Object.keys(Offline.groupByShard(null)).length === 0);
  const skip = Offline.groupByShard([
    { id: 'x' },                  // no shard
    { shard: '0ab' },             // no id
    { id: 'y', shard: '' },       // empty shard
    { id: 'z', shard: '0cd' }
  ]);
  check('skips malformed pairs', Object.keys(skip).length === 1 && skip['0cd'][0] === 'z');
}

// ━━━ unionManifests — basics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('unionManifests — dedup + attribution');
{
  // pid 'p1' in both reps; rep A reaches it at ply 8, rep B at ply 4 → keep 4.
  const r = Offline.unionManifests([
    { repId: 'A', matches: [['p1', 1500, 'w', 8, 6, [1]], ['p2', 1600, 'b', 10, 8, [2]]] },
    { repId: 'B', matches: [['p1', 1500, 'w', 4, 6, [1]], ['p3', 1700, 'w', 12, 10, [3]]] }
  ]);
  check('3 unique puzzles', r.matches.length === 3, 'got ' + r.matches.length);
  check('p1 kept at min ply (4)', plyOf(r.matches, 'p1') === 4, 'got ' + plyOf(r.matches, 'p1'));
  check('p1 attributed to A+B', r.pidToReps['p1'].length === 2 &&
        r.pidToReps['p1'].indexOf('A') !== -1 && r.pidToReps['p1'].indexOf('B') !== -1);
  check('p2 attributed to A only', r.pidToReps['p2'].length === 1 && r.pidToReps['p2'][0] === 'A');
  check('p3 attributed to B only', r.pidToReps['p3'].length === 1 && r.pidToReps['p3'][0] === 'B');
}

section('unionManifests — missing ply is most-permissive');
{
  // A missing ply must never be displaced by a numeric one, and a missing ply
  // displaces a present one. (Matches repertoireUnion's posture exactly.)
  const a = Offline.unionManifests([
    { repId: 'A', matches: [['p', 1500, 'w', undefined, 6, [1]]] },
    { repId: 'B', matches: [['p', 1500, 'w', 4, 6, [1]]] }
  ]);
  check('missing(prev) not displaced by present(cur)', plyOf(a.matches, 'p') === undefined);
  const b = Offline.unionManifests([
    { repId: 'A', matches: [['p', 1500, 'w', 4, 6, [1]]] },
    { repId: 'B', matches: [['p', 1500, 'w', undefined, 6, [1]]] }
  ]);
  check('present(prev) displaced by missing(cur)', plyOf(b.matches, 'p') === undefined);
}

section('unionManifests — defensive');
{
  check('non-array → empty', Offline.unionManifests(null).matches.length === 0);
  const r = Offline.unionManifests([
    { repId: 'A', matches: null },          // bad matches
    { repId: 'B', matches: [['x', 1, 'w', 1, 1, []], [null], [/*empty*/], ['', 2, 'w', 1, 1, []]] }
  ]);
  check('skips bad sources + entries without id', r.matches.length === 1 && r.matches[0][0] === 'x');
}

// ━━━ determinism vs shuffle (parity property) ━━━━━━━━━━━━━━━━━━━━━━━━━━
section('unionManifests — order-independent under shuffle');
{
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const base = [
    { repId: 'A', matches: [['p1', 1, 'w', 9, 1, []], ['p2', 1, 'w', 3, 1, []]] },
    { repId: 'B', matches: [['p1', 1, 'w', 2, 1, []], ['p2', 1, 'w', 7, 1, []]] },
    { repId: 'C', matches: [['p1', 1, 'w', 5, 1, []], ['p3', 1, 'w', 4, 1, []]] }
  ];
  const ref = Offline.unionManifests(base);
  let stable = true, plyStable = true;
  for (let t = 0; t < 500; t++) {
    const shuffledSources = shuffle(base).map(s => ({ repId: s.repId, matches: shuffle(s.matches) }));
    const r = Offline.unionManifests(shuffledSources);
    if (ids(r.matches).join(',') !== ids(ref.matches).join(',')) stable = false;
    if (plyOf(r.matches, 'p1') !== 2) plyStable = false; // min across 9/2/5
  }
  check('id set stable across 500 shuffles', stable);
  check('p1 min-ply (2) stable across shuffles', plyStable);
}

// ━━━ parity: single-source union == repertoireUnion accumulator ━━━━━━━━
section('parity with repertoireUnion (single rep, one shard)');
{
  // Drive the real accumulator and compare its finalized matches to feeding
  // those same finalized matches back through unionManifests (identity).
  const shardJson = {
    'KEYa': [['p1', 1500, 'w', 8, 6, [1]], ['p2', 1600, 'b', 10, 8, [2]]],
    'KEYb': [['p1', 1500, 'w', 4, 6, [1]]]   // same pid, smaller ply
  };
  const triples = [
    { key: 'KEYa', item: { fen: 'x', orientation: 'white' }, repId: 'A' },
    { key: 'KEYb', item: { fen: 'y', orientation: 'white' }, repId: 'A' }
  ];
  const acc = RepertoireUnion.createAccumulator({ matchOwnColorOnly: false });
  acc.ingestShard(shardJson, triples);
  const finalized = acc.finalize();
  check('accumulator keeps p1 at min ply 4', plyOf(finalized.matches, 'p1') === 4, 'got ' + plyOf(finalized.matches, 'p1'));

  const passedThrough = Offline.unionManifests([{ repId: 'A', matches: finalized.matches }]);
  check('union of finalized set is identity (ids)', ids(passedThrough.matches).join(',') === ids(finalized.matches).join(','));
  check('union of finalized set is identity (p1 ply)', plyOf(passedThrough.matches, 'p1') === 4);
}

// ━━━ dedupMatches convenience ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('dedupMatches');
{
  const out = Offline.dedupMatches([
    [['p1', 1, 'w', 8, 1, []], ['p2', 1, 'w', 3, 1, []]],
    [['p1', 1, 'w', 2, 1, []]]
  ]);
  check('2 unique', out.length === 2);
  check('p1 min ply 2', plyOf(out, 'p1') === 2);
  check('non-array → []', Offline.dedupMatches(null).length === 0);
}

// ━━━ itemSig ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('itemSig');
{
  const a = Offline.itemSig(['k1', 'k2', 'k3']);
  const b = Offline.itemSig(['k3', 'k1', 'k2']);   // reordered
  check('order-independent', a === b, a + ' vs ' + b);
  check('8 hex chars', /^[0-9a-f]{8}$/.test(a), a);

  const c = Offline.itemSig(['k1', 'k2']);          // dropped one
  check('change in set → different sig', a !== c);

  const empty = Offline.itemSig([]);
  check('empty set is stable', empty === Offline.itemSig(null));
  check('empty differs from non-empty', empty !== a);

  // Adding a position changes the signature (staleness trigger).
  const d = Offline.itemSig(['k1', 'k2', 'k3', 'k4']);
  check('added position → different sig', d !== a);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

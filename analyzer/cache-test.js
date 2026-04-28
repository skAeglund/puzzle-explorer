#!/usr/bin/env node
/**
 * cache-test.js — Test the cache module's pure helpers and Node graceful-no-op
 * behavior. The IndexedDB plumbing isn't exercised here (no IDB in Node);
 * those layers are small enough to verify by inspection. What IS tested:
 *
 *   - selectEvictions: stable LRU selection, edge cases on bad input.
 *   - compareBuildVersion: match / mismatch / unknown verdicts.
 *   - In-Node API surface: available() returns false, every read returns null,
 *     every write resolves cleanly without throwing.
 *
 * Run: node analyzer/cache-test.js
 */

const Cache = require('../lib/cache');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ━━━ selectEvictions (pure) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('selectEvictions — happy paths');
{
  const e3 = [
    { key: 'a', lastSeenAt: 1 },
    { key: 'b', lastSeenAt: 2 },
    { key: 'c', lastSeenAt: 3 }
  ];
  check('len ≤ max → no evictions',           Cache._selectEvictions(e3, 5).length === 0);
  check('len === max → no evictions',         Cache._selectEvictions(e3, 3).length === 0);
  check('evict 1 oldest when over by 1',      JSON.stringify(Cache._selectEvictions(e3, 2)) === JSON.stringify(['a']));
  check('evict 2 oldest when over by 2',      JSON.stringify(Cache._selectEvictions(e3, 1)) === JSON.stringify(['a', 'b']));
  check('evict all when max=0',               Cache._selectEvictions(e3, 0).length === 3);
}

section('selectEvictions — stability on ties');
{
  // All three tied on lastSeenAt; eviction order should match input order.
  const tied = [
    { key: 'first',  lastSeenAt: 5 },
    { key: 'second', lastSeenAt: 5 },
    { key: 'third',  lastSeenAt: 5 }
  ];
  check('all-tied: evict 1 → input[0]',      JSON.stringify(Cache._selectEvictions(tied, 2)) === JSON.stringify(['first']));
  check('all-tied: evict 2 → input[0..1]',   JSON.stringify(Cache._selectEvictions(tied, 1)) === JSON.stringify(['first', 'second']));

  // Mixed: oldest distinct first, then ties broken by input order.
  const mix = [
    { key: 'newer-1', lastSeenAt: 10 },
    { key: 'oldest',  lastSeenAt: 1 },
    { key: 'tied-a',  lastSeenAt: 5 },
    { key: 'tied-b',  lastSeenAt: 5 }
  ];
  check('mixed: cap=2 → drop oldest + tied-a', JSON.stringify(Cache._selectEvictions(mix, 2)) === JSON.stringify(['oldest', 'tied-a']));
}

section('selectEvictions — defensive against bad input');
{
  check('null → []',                Cache._selectEvictions(null, 5).length === 0);
  check('undefined → []',           Cache._selectEvictions(undefined, 5).length === 0);
  check('not-an-array → []',        Cache._selectEvictions({ a: 1 }, 5).length === 0);
  check('empty array → []',         Cache._selectEvictions([], 5).length === 0);

  // Entries missing lastSeenAt are treated as oldest (ts=0) and evict first.
  const noTs = [
    { key: 'has-ts',  lastSeenAt: 100 },
    { key: 'no-ts' /* missing */ },
    { key: 'bad-ts',  lastSeenAt: 'NaN' }
  ];
  // Both 'no-ts' and 'bad-ts' get ts=0; tied → input-order. So eviction
  // order under cap=1 is no-ts, bad-ts (both before has-ts).
  check('missing/bad lastSeenAt → ts=0, input-order', JSON.stringify(Cache._selectEvictions(noTs, 1)) === JSON.stringify(['no-ts', 'bad-ts']));

  // Entries with no key are silently skipped (defensive, not an error).
  const partial = [
    { lastSeenAt: 1 },                   // no key — skipped
    { key: 'real', lastSeenAt: 2 }
  ];
  check('skip entries without a key',  Cache._selectEvictions(partial, 0).length === 1);
}

// ━━━ compareBuildVersion (pure) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('compareBuildVersion');
{
  check('equal strings → match',           Cache._compareBuildVersion('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z') === 'match');
  check('different strings → mismatch',    Cache._compareBuildVersion('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z') === 'mismatch');
  check('stored missing → unknown',        Cache._compareBuildVersion(null, '2026-01-01') === 'unknown');
  check('current missing → unknown',       Cache._compareBuildVersion('2026-01-01', null) === 'unknown');
  check('both missing → unknown',          Cache._compareBuildVersion(null, null) === 'unknown');
  check('empty string stored → unknown',   Cache._compareBuildVersion('', '2026-01-01') === 'unknown');
  check('empty string current → unknown',  Cache._compareBuildVersion('2026-01-01', '') === 'unknown');
  check('undefined stored → unknown',      Cache._compareBuildVersion(undefined, 'x') === 'unknown');
}

// ━━━ Node graceful-no-op behavior ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Node environment: no IndexedDB available');
{
  check('available() === false',          Cache.available() === false);
  check('MAX_SHARDS exposed as number',   typeof Cache.MAX_SHARDS === 'number' && Cache.MAX_SHARDS === 100);
}

// All async paths must resolve cleanly without throwing in Node.
async function asyncTests() {
  section('Node async: every op resolves to null/no-op');

  const ix = await Cache.getIndex('abc');
  check('getIndex(...) → null',           ix === null);

  const bd = await Cache.getBody('abc');
  check('getBody(...) → null',            bd === null);

  // Writes return undefined (void) and must not throw.
  let putThrew = false;
  try { await Cache.putIndex('abc', { foo: 1 }); }
  catch (e) { putThrew = true; }
  check('putIndex resolves without throwing', !putThrew);

  let putBodyThrew = false;
  try { await Cache.putBody('abc', 'line1\nline2'); }
  catch (e) { putBodyThrew = true; }
  check('putBody resolves without throwing', !putBodyThrew);

  const cv = await Cache.checkBuildVersion('2026-01-01');
  check('checkBuildVersion → {wiped:false}', cv && cv.wiped === false);

  let wipeThrew = false;
  try { await Cache.wipe(); }
  catch (e) { wipeThrew = true; }
  check('wipe resolves without throwing', !wipeThrew);

  const st = await Cache.stats();
  check('stats → {indexCount:0, bodyCount:0}',
    st && st.indexCount === 0 && st.bodyCount === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

asyncTests();

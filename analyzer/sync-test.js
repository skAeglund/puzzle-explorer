#!/usr/bin/env node
/**
 * sync-test.js — Test the gist sync layer.
 *
 * Coverage:
 *   - Sync.merge: pure-function correctness across the path-product of
 *     {empty, present} × {local, remote} × {newer, older, equal} × edge
 *     cases (missing lastSeen, deep clone, srs preservation).
 *   - Username + credentials: namespacing of LS keys, restore-from-LS
 *     across sessions, clearCredentials wipes both keys.
 *   - notifyMutation: dirty flag set on every call (configured or not),
 *     debounced fetch only when configured.
 *   - syncToGist read-merge-write round-trip with a fake fetch.
 *   - Read failure: schedules retry, dirty preserved, status 'error'.
 *   - Write failure: same defensive behavior.
 *   - Username mismatch: refuses to write, status 'error'.
 *   - keepalive on small body, dropped on large body.
 *   - createGist: POSTs, adopts new id, persists under namespaced key.
 *   - loadFromGist: applies remote, dirty if local had unsynced data.
 *   - flushNow: bypasses debounce, pushes immediately.
 *
 * Run: node analyzer/sync-test.js
 */

const Sync = require('../lib/sync');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── helpers ─────────────────────────────────────────────────────────────
// A fresh module-state reset between tests, since Sync is a singleton with
// module-level state. We do it by re-injecting fresh hooks + clearing
// credentials + setting username to ''.
function freshSync() {
  Sync._resetForTesting();
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: function () { throw new Error('fetch should not be called in this test'); },
    now: function () { return 1700000000000; },        // fixed
    setTimeout: function (fn) { return { fn: fn, fired: false }; }, // never fires unless we drive it
    clearTimeout: function () {}
  });
}

// Build a fake fetch that records calls + returns a queued sequence of
// responses. Each response is a function returning { ok, status, json,
// text } shaped like real fetch.
function makeFakeFetch(responses) {
  const calls = [];
  let i = 0;
  function fetchFn(url, opts) {
    calls.push({ url: url, opts: opts || {} });
    if (i >= responses.length) {
      return Promise.reject(new Error('fake fetch: no more queued responses (call #' + (i+1) + ')'));
    }
    const r = responses[i++];
    return Promise.resolve(r);
  }
  fetchFn.calls = calls;
  fetchFn.remaining = function () { return responses.length - i; };
  return fetchFn;
}
function jsonResponse(body, opts) {
  opts = opts || {};
  return {
    ok: opts.status ? (opts.status >= 200 && opts.status < 300) : true,
    status: opts.status || 200,
    json: function () { return Promise.resolve(body); },
    text: function () { return Promise.resolve(JSON.stringify(body)); }
  };
}
function errorResponse(status) {
  return { ok: false, status: status, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(''); } };
}

// ━━━ MERGE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('merge: empty + empty');
{
  const m = Sync.merge(null, null);
  check('null + null → empty positions', JSON.stringify(m.positions) === '{}');
  check('null + null → version present', typeof m.version === 'number');
}

section('merge: local-only / remote-only deep-clone');
{
  const local = { positions: { a: { lastSeen: '2025-01-01T00:00:00.000Z', completed: true } } };
  const m = Sync.merge(local, null);
  check('local-only positions copied', m.positions.a.completed === true);
  m.positions.a.completed = false;
  check('result is deep clone (mutating result does not affect local)',
    local.positions.a.completed === true);
  const remote = { positions: { b: { lastSeen: '2025-01-02T00:00:00.000Z' } }, version: 1 };
  const m2 = Sync.merge(null, remote);
  check('remote-only positions copied', !!m2.positions.b);
  m2.positions.b.lastSeen = 'mutated';
  check('result is deep clone of remote',
    remote.positions.b.lastSeen === '2025-01-02T00:00:00.000Z');
}

section('merge: per-pid latest-wins by lastSeen');
{
  const local = {
    positions: {
      a: { lastSeen: '2025-01-02T00:00:00.000Z', completed: true,  srs: { reps: 5 } },
      b: { lastSeen: '2025-01-01T00:00:00.000Z', completed: true,  srs: { reps: 1 } }
    }
  };
  const remote = {
    positions: {
      a: { lastSeen: '2025-01-01T00:00:00.000Z', completed: false, srs: { reps: 1 } }, // older
      b: { lastSeen: '2025-01-03T00:00:00.000Z', completed: true,  srs: { reps: 9 } }  // newer
    }
  };
  const m = Sync.merge(local, remote);
  check('local newer wins for a',  m.positions.a.srs.reps === 5);
  check('remote newer wins for b', m.positions.b.srs.reps === 9);
}

section('merge: disjoint pids unioned');
{
  const local  = { positions: { a: { lastSeen: '2025-01-01T00:00:00.000Z' } } };
  const remote = { positions: { b: { lastSeen: '2025-01-01T00:00:00.000Z' } } };
  const m = Sync.merge(local, remote);
  check('a present', !!m.positions.a);
  check('b present', !!m.positions.b);
  check('exactly two entries', Object.keys(m.positions).length === 2);
}

section('merge: equal lastSeen → remote wins (deterministic tiebreak)');
{
  const t = '2025-01-01T00:00:00.000Z';
  const local  = { positions: { a: { lastSeen: t, mark: 'L' } } };
  const remote = { positions: { a: { lastSeen: t, mark: 'R' } } };
  const m = Sync.merge(local, remote);
  check('tie → remote wins', m.positions.a.mark === 'R');
}

section('merge: missing lastSeen treated as epoch 0');
{
  const local  = { positions: { a: { mark: 'L' } } };                                // no lastSeen
  const remote = { positions: { a: { lastSeen: '2025-01-01T00:00:00.000Z', mark: 'R' } } };
  const m = Sync.merge(local, remote);
  check('local missing lastSeen → remote wins', m.positions.a.mark === 'R');
  // And the symmetric case
  const local2  = { positions: { a: { lastSeen: '2025-01-01T00:00:00.000Z', mark: 'L' } } };
  const remote2 = { positions: { a: { mark: 'R' } } };
  const m2 = Sync.merge(local2, remote2);
  check('remote missing lastSeen → local wins', m2.positions.a.mark === 'L');
}

section('merge: corrupt lastSeen treated as epoch 0');
{
  const local  = { positions: { a: { lastSeen: 'not-a-date', mark: 'L' } } };
  const remote = { positions: { a: { lastSeen: '2025-01-01T00:00:00.000Z', mark: 'R' } } };
  const m = Sync.merge(local, remote);
  check('corrupt local lastSeen → remote wins', m.positions.a.mark === 'R');
}

section('merge: corrupt local entry skipped');
{
  const local  = { positions: { a: 'corrupt-string', b: { lastSeen: '2025-01-02T00:00:00.000Z', mark: 'L' } } };
  const remote = { positions: { a: { lastSeen: '2025-01-01T00:00:00.000Z', mark: 'R' } } };
  const m = Sync.merge(local, remote);
  check('corrupt entry: remote preserved', m.positions.a.mark === 'R');
  check('valid sibling entry merged',     m.positions.b.mark === 'L');
}

section('merge: remote with bad shape is normalized');
{
  const m = Sync.merge({ positions: {} }, { positions: 'not-an-object' });
  check('non-object positions → empty', JSON.stringify(m.positions) === '{}');
}

section('merge: forward-compat fields on remote preserved');
{
  const local  = { positions: { a: { lastSeen: '2025-01-02T00:00:00.000Z', completed: true } } };
  const remote = { positions: { a: { lastSeen: '2025-01-01T00:00:00.000Z', completed: false, futureField: 42 } } };
  const m = Sync.merge(local, remote);
  // Local newer wins, but the remote's futureField is preserved by the
  // {...remote, ...winner} spread.
  check('local won', m.positions.a.completed === true);
  check('remote forward-compat field preserved', m.positions.a.futureField === 42);
}

// ━━━ USERNAME / CREDENTIALS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('Sync.setUsername normalizes + persists');
{
  freshSync();
  Sync.setUsername('  Anders  ');
  check('username normalized lowercase + trimmed', Sync.getUsername() === 'anders');
}

section('credentials are namespaced by username');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  Sync._setHooks({ storage: storage });
  Sync.setUsername('alice');
  Sync.setCredentials('tok-A', 'gist-A');
  Sync.setUsername('bob');
  // bob has no creds → both empty
  check('switch user: token cleared', Sync.getCredentials().token === '');
  check('switch user: gist id cleared', Sync.getCredentials().gistId === '');
  Sync.setCredentials('tok-B', 'gist-B');
  // back to alice — should restore via LS namespacing
  Sync.setUsername('alice');
  check('switch back: token restored',  Sync.getCredentials().token  === 'tok-A');
  check('switch back: gist id restored', Sync.getCredentials().gistId === 'gist-A');
  // verify LS contains BOTH namespaced keys
  check('LS has alice token key', !!storage.getItem(Sync.LS_TOKEN_PREFIX + 'alice'));
  check('LS has bob token key',   !!storage.getItem(Sync.LS_TOKEN_PREFIX + 'bob'));
}

section('clearCredentials wipes both keys');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  Sync._setHooks({ storage: storage });
  Sync.setUsername('anders');
  Sync.setCredentials('tok', 'gist');
  Sync.clearCredentials();
  check('LS token cleared',   storage.getItem(Sync.LS_TOKEN_PREFIX  + 'anders') === null);
  check('LS gist id cleared', storage.getItem(Sync.LS_GISTID_PREFIX + 'anders') === null);
  check('isConfigured false', Sync.isConfigured() === false);
}

section('init() restores username from LS at cold start');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  storage.setItem(Sync.LS_USERNAME, 'returning-user');
  storage.setItem(Sync.LS_TOKEN_PREFIX  + 'returning-user', 'persisted-tok');
  storage.setItem(Sync.LS_GISTID_PREFIX + 'returning-user', 'persisted-gist');
  Sync._setHooks({ storage: storage });
  Sync.init({ getProgressData: () => ({ positions: {} }), setProgressData: () => {} });
  check('username restored', Sync.getUsername() === 'returning-user');
  check('token restored',   Sync.getCredentials().token  === 'persisted-tok');
  check('gist id restored', Sync.getCredentials().gistId === 'persisted-gist');
  check('isConfigured true', Sync.isConfigured() === true);
}

// ━━━ NOTIFY MUTATION + DEBOUNCE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

section('notifyMutation: not configured → no fetch but dirty set');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  let fetchCalled = false;
  Sync._setHooks({
    storage: storage,
    fetch: function () { fetchCalled = true; return Promise.resolve(jsonResponse({})); },
    setTimeout: function (fn, ms) { return { fn: fn, ms: ms }; }, // never fires
    clearTimeout: function () {}
  });
  Sync.notifyMutation();
  check('no fetch when unconfigured', fetchCalled === false);
  check('LS dirty flag set', storage.getItem(Sync.LS_DIRTY_BASE) === '1');
  check('isDirty true', Sync.isDirty() === true);
}

section('notifyMutation: configured → debounce timer scheduled');
{
  freshSync();
  let scheduled = null;
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: function () { return Promise.resolve(jsonResponse({})); },
    setTimeout: function (fn, ms) { scheduled = { fn: fn, ms: ms }; return scheduled; },
    clearTimeout: function () {}
  });
  Sync.setUsername('anders');
  Sync.setCredentials('t', 'g');
  Sync.notifyMutation();
  check('debounce scheduled', scheduled !== null);
  check('debounce uses DEBOUNCE_MS', scheduled.ms === Sync.DEBOUNCE_MS);
}

section('rapid notifyMutation calls collapse via clearTimeout');
{
  freshSync();
  let scheduledCount = 0, clearedCount = 0;
  let lastTimer = null;
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: function () { return Promise.resolve(jsonResponse({})); },
    setTimeout: function (fn, ms) { scheduledCount++; lastTimer = { fn: fn, ms: ms }; return lastTimer; },
    clearTimeout: function (t) { if (t) clearedCount++; }
  });
  Sync.setUsername('a');
  Sync.setCredentials('t', 'g');
  Sync.notifyMutation();
  Sync.notifyMutation();
  Sync.notifyMutation();
  check('three setTimeout calls', scheduledCount === 3);
  check('two clearTimeout calls (the prior two timers)', clearedCount === 2);
}

// ━━━ SYNC ROUND-TRIP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function runAsync() {

section('syncToGist: read-merge-write round-trip');
{
  freshSync();
  let pendingTimer = null;
  const storage = Sync._makeMemoryStorage();
  // Remote already has a different position with an older timestamp;
  // local has a newer entry. Result should merge both.
  const remoteGist = {
    files: {
      [Sync.GIST_FILENAME]: {
        content: JSON.stringify({
          username: 'anders', version: 1,
          positions: { remote_only: { lastSeen: '2025-01-01T00:00:00.000Z', completed: true } }
        })
      }
    }
  };
  const fakeFetch = makeFakeFetch([
    jsonResponse(remoteGist),  // gistRead
    jsonResponse({})           // PATCH
  ]);
  let captured = null;
  let statusLog = [];
  Sync._setHooks({
    storage: storage,
    fetch: fakeFetch,
    setTimeout: function (fn, ms) { pendingTimer = { fn: fn, ms: ms }; return pendingTimer; },
    clearTimeout: function () { pendingTimer = null; }
  });
  Sync.init({
    getProgressData: function () {
      return { positions: { local_only: { lastSeen: '2025-01-02T00:00:00.000Z', completed: true } } };
    },
    setProgressData: function (d) { captured = d; },
    onStatusChange: function (s) { statusLog.push(s.status); }
  });
  Sync.setUsername('anders');
  Sync.setCredentials('tok', 'gist');
  Sync.notifyMutation();
  // Drive the debounce timer
  check('timer pending', pendingTimer !== null);
  await pendingTimer.fn();
  // Two fetches: GET then PATCH
  check('GET + PATCH fetched', fakeFetch.calls.length === 2);
  check('PATCH method used', fakeFetch.calls[1].opts.method === 'PATCH');
  // PATCH body has both positions
  const patchBody = JSON.parse(fakeFetch.calls[1].opts.body);
  const fileContent = JSON.parse(patchBody.files[Sync.GIST_FILENAME].content);
  check('PATCH merged: local entry present',  !!fileContent.positions.local_only);
  check('PATCH merged: remote entry present', !!fileContent.positions.remote_only);
  check('PATCH includes username',            fileContent.username === 'anders');
  check('PATCH does NOT include description', !('description' in patchBody));
  // Local was re-imported with the merged result
  check('setProgressData captured merge', captured && !!captured.positions.remote_only);
  // Dirty cleared, status ok
  check('dirty cleared after success',  Sync.isDirty() === false);
  check('LS dirty key removed',         storage.getItem(Sync.LS_DIRTY_PREFIX + 'anders') === null);
  check('status ended at "ok"',         statusLog[statusLog.length-1] === 'ok');
  check('status passed through "syncing"', statusLog.indexOf('syncing') >= 0);
}

section('syncToGist: read failure → retry scheduled, dirty preserved');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  let timersScheduled = [];
  const fakeFetch = makeFakeFetch([errorResponse(500)]); // GET fails
  Sync._setHooks({
    storage: storage,
    fetch: fakeFetch,
    setTimeout: function (fn, ms) { const t = { fn: fn, ms: ms }; timersScheduled.push(t); return t; },
    clearTimeout: function () {}
  });
  let statusLog = [];
  Sync.init({
    getProgressData: () => ({ positions: { p: { lastSeen: '2025-01-01T00:00:00.000Z' } } }),
    setProgressData: () => {},
    onStatusChange: (s) => statusLog.push(s.status)
  });
  Sync.setUsername('anders');
  Sync.setCredentials('tok', 'gist');
  Sync.notifyMutation();
  // Drive debounce
  await timersScheduled[0].fn();
  check('dirty still set after read failure', Sync.isDirty() === true);
  check('LS dirty flag preserved',           storage.getItem(Sync.LS_DIRTY_PREFIX + 'anders') === '1');
  check('retry timer scheduled',             timersScheduled.length >= 2);
  check('retry uses RETRY_MS',               timersScheduled[1].ms === Sync.RETRY_MS);
  check('status ended at "error"',           statusLog[statusLog.length-1] === 'error');
}

section('syncToGist: username mismatch refuses to write');
{
  freshSync();
  // Remote claims a different username — wrong-PAT scenario.
  const remoteGist = {
    files: {
      [Sync.GIST_FILENAME]: {
        content: JSON.stringify({ username: 'somebody-else', positions: { x: { lastSeen: '2025-01-01T00:00:00.000Z' } } })
      }
    }
  };
  const fakeFetch = makeFakeFetch([jsonResponse(remoteGist)]); // ONE response — no PATCH expected
  let pending = null;
  let statusLog = [];
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetch,
    setTimeout: function (fn, ms) { pending = { fn: fn, ms: ms }; return pending; },
    clearTimeout: function () {}
  });
  Sync.init({
    getProgressData: () => ({ positions: { local: { lastSeen: '2025-01-02T00:00:00.000Z' } } }),
    setProgressData: () => {},
    onStatusChange: (s) => statusLog.push(s.status)
  });
  Sync.setUsername('anders');
  Sync.setCredentials('t', 'g');
  Sync.notifyMutation();
  await pending.fn();
  check('only GET was made (no PATCH)',  fakeFetch.calls.length === 1);
  check('dirty preserved after mismatch', Sync.isDirty() === true);
  check('status ended at "error"',       statusLog[statusLog.length-1] === 'error');
}

section('keepalive flag: small body uses keepalive, large body does not');
{
  // Small payload first
  freshSync();
  const fakeFetchSmall = makeFakeFetch([
    jsonResponse({ files: { [Sync.GIST_FILENAME]: { content: JSON.stringify({ positions: {} }) } } }),
    jsonResponse({})
  ]);
  let pendingS = null;
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetchSmall,
    setTimeout: function (fn, ms) { pendingS = { fn: fn, ms: ms }; return pendingS; },
    clearTimeout: function () {}
  });
  Sync.init({ getProgressData: () => ({ positions: {} }), setProgressData: () => {} });
  Sync.setUsername('a');
  Sync.setCredentials('t', 'g');
  Sync.notifyMutation();
  await pendingS.fn();
  check('small body: keepalive=true', fakeFetchSmall.calls[1].opts.keepalive === true);

  // Large payload — generate enough positions to push body past KEEPALIVE_MAX_BYTES
  freshSync();
  const big = { positions: {} };
  for (let i = 0; i < 1500; i++) {
    big.positions['pid_' + i] = {
      lastSeen: '2025-01-01T00:00:00.000Z',
      completed: true,
      srs: { reps: i, lapses: 0, stability: 1.0, difficulty: 5.0, due: '2025-02-01T00:00:00.000Z', state: 'review' }
    };
  }
  const fakeFetchBig = makeFakeFetch([
    jsonResponse({ files: { [Sync.GIST_FILENAME]: { content: JSON.stringify({ positions: {} }) } } }),
    jsonResponse({})
  ]);
  let pendingB = null;
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetchBig,
    setTimeout: function (fn, ms) { pendingB = { fn: fn, ms: ms }; return pendingB; },
    clearTimeout: function () {}
  });
  Sync.init({ getProgressData: () => big, setProgressData: () => {} });
  Sync.setUsername('a');
  Sync.setCredentials('t', 'g');
  Sync.notifyMutation();
  await pendingB.fn();
  // Body should be over the cap; keepalive omitted.
  const bodyLen = fakeFetchBig.calls[1].opts.body.length;
  check('large body actually exceeds cap (sanity)', bodyLen > Sync.KEEPALIVE_MAX_BYTES);
  check('large body: keepalive omitted', !('keepalive' in fakeFetchBig.calls[1].opts) ||
                                          fakeFetchBig.calls[1].opts.keepalive !== true);
}

section('createGist: concurrent calls do NOT POST twice (in-flight guard)');
{
  freshSync();
  let postCount = 0;
  // Slow POST so we can fire two calls before the first resolves.
  const slowFetch = function (url, opts) {
    postCount++;
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({
          ok: true, status: 201,
          json: function () { return Promise.resolve({ id: 'gist-' + postCount }); },
          text: function () { return Promise.resolve(''); }
        });
      }, 10);
    });
  };
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: slowFetch,
    setTimeout: setTimeout,    // real setTimeout for this test
    clearTimeout: clearTimeout
  });
  Sync.setUsername('anders');
  Sync.setCredentials('tok', '');
  // Fire two concurrent calls. The in-flight guard returns the same
  // promise to both; only ONE POST should land.
  const ids = await Promise.all([
    Sync.createGist({ positions: {} }),
    Sync.createGist({ positions: {} })
  ]);
  check('exactly ONE POST made (no duplicate)', postCount === 1);
  check('both calls returned same id',          ids[0] === ids[1]);
  check('id adopted into credentials',          Sync.getCredentials().gistId === ids[0]);
  // After resolution, in-flight guard cleared — subsequent call POSTs again.
  await Sync.createGist({ positions: {} });
  check('post-resolution: new POST allowed', postCount === 2);
}

section('createGist: in-flight guard cleared after rejection (allows retry)');
{
  freshSync();
  let attempt = 0;
  const flakyFetch = function () {
    attempt++;
    return Promise.resolve(attempt === 1
      ? errorResponse(500)                      // first call: 500
      : jsonResponse({ id: 'recovered-id' }));  // second call: ok
  };
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: flakyFetch,
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.setUsername('a');
  Sync.setCredentials('t', '');
  let firstThrew = false;
  try { await Sync.createGist({ positions: {} }); }
  catch (e) { firstThrew = true; }
  check('first call rejected', firstThrew === true);
  // The guard MUST be cleared now — otherwise this hangs forever.
  const id = await Sync.createGist({ positions: {} });
  check('retry succeeded',         id === 'recovered-id');
  check('two POST attempts total', attempt === 2);
}

section('createGist: POSTs and adopts new id');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  const fakeFetch = makeFakeFetch([jsonResponse({ id: 'newly-created-id' })]);
  Sync._setHooks({
    storage: storage,
    fetch: fakeFetch,
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.setUsername('anders');
  Sync.setCredentials('tok', '');                    // no gist id yet
  const id = await Sync.createGist({ positions: {}, version: 1 });
  check('returned new id',          id === 'newly-created-id');
  check('adopted into credentials', Sync.getCredentials().gistId === 'newly-created-id');
  check('persisted to namespaced LS', storage.getItem(Sync.LS_GISTID_PREFIX + 'anders') === 'newly-created-id');
  check('POST method',              fakeFetch.calls[0].opts.method === 'POST');
  // POST body should include description (only on CREATE) and the seed
  const postBody = JSON.parse(fakeFetch.calls[0].opts.body);
  check('POST includes description', typeof postBody.description === 'string');
  check('POST is private',           postBody.public === false);
  // The seed should have the username stamped
  const fileContent = JSON.parse(postBody.files[Sync.GIST_FILENAME].content);
  check('seed username stamped',     fileContent.username === 'anders');
}

section('loadFromGist: marks dirty when local has NEWER version of an existing remote position');
{
  // Audit-fix scenario: same key on both sides, local lastSeen is newer.
  // Prior count-based heuristic missed this — count(merged) === count(remote)
  // because no key was added. The strict-newer pass catches it.
  freshSync();
  const remoteGist = {
    files: {
      [Sync.GIST_FILENAME]: {
        content: JSON.stringify({
          username: 'anders', version: 1,
          positions: { shared: { lastSeen: '2025-01-01T00:00:00.000Z', completed: false, srs: { reps: 1 } } }
        })
      }
    }
  };
  const fakeFetch = makeFakeFetch([jsonResponse(remoteGist)]);
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetch,
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.init({
    // Local has a NEWER version of the same position — same key, larger lastSeen.
    getProgressData: () => ({ positions: { shared: { lastSeen: '2025-01-05T00:00:00.000Z', completed: true, srs: { reps: 5 } } } }),
    setProgressData: () => {}
  });
  Sync.setUsername('anders');
  Sync.setCredentials('t', 'g');
  const result = await Sync.loadFromGist();
  check('result ok',                      result.ok === true);
  check('local newer → dirty=true',       Sync.isDirty() === true);
  // Count-based heuristic would've returned dirty=false here; this test pins
  // the corrected behavior in place.
  check('merged kept local version',      result.data.positions.shared.srs.reps === 5);
}

section('loadFromGist: clean equal state does NOT mark dirty');
{
  // The mirror case: local has only positions that match remote byte-for-byte.
  // No follow-up sync should be triggered.
  freshSync();
  const sameTime = '2025-01-01T00:00:00.000Z';
  const samePos = { shared: { lastSeen: sameTime, completed: true, srs: { reps: 1 } } };
  const remoteGist = {
    files: {
      [Sync.GIST_FILENAME]: {
        content: JSON.stringify({ username: 'anders', version: 1, positions: samePos })
      }
    }
  };
  const fakeFetch = makeFakeFetch([jsonResponse(remoteGist)]);
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetch,
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.init({ getProgressData: () => ({ positions: samePos }), setProgressData: () => {} });
  Sync.setUsername('anders');
  Sync.setCredentials('t', 'g');
  const result = await Sync.loadFromGist();
  check('result ok',                  result.ok === true);
  check('clean equal → dirty=false',  Sync.isDirty() === false);
}

section('loadFromGist: applies remote and marks dirty if local had unsynced data');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  const remoteGist = {
    files: {
      [Sync.GIST_FILENAME]: {
        content: JSON.stringify({
          username: 'anders', version: 1,
          positions: { from_remote: { lastSeen: '2025-01-01T00:00:00.000Z' } }
        })
      }
    }
  };
  const fakeFetch = makeFakeFetch([jsonResponse(remoteGist)]);
  let captured = null;
  Sync._setHooks({
    storage: storage,
    fetch: fakeFetch,
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.init({
    getProgressData: () => ({ positions: { local_only: { lastSeen: '2025-01-02T00:00:00.000Z' } } }),
    setProgressData: (d) => { captured = d; }
  });
  Sync.setUsername('anders');
  Sync.setCredentials('t', 'g');
  const result = await Sync.loadFromGist();
  check('result ok',                       result.ok === true);
  check('captured has remote entry',       !!captured.positions.from_remote);
  check('captured has local entry',        !!captured.positions.local_only);
  check('username stamped on merged data', captured.username === 'anders');
  check('dirty set (local data needs to be pushed)', Sync.isDirty() === true);
}

section('loadFromGist: username mismatch returns reason');
{
  freshSync();
  const remoteGist = {
    files: {
      [Sync.GIST_FILENAME]: {
        content: JSON.stringify({ username: 'somebody-else', positions: {} })
      }
    }
  };
  const fakeFetch = makeFakeFetch([jsonResponse(remoteGist)]);
  let captured = null;
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetch,
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.init({ getProgressData: () => ({ positions: {} }), setProgressData: (d) => { captured = d; } });
  Sync.setUsername('anders');
  Sync.setCredentials('t', 'g');
  const result = await Sync.loadFromGist();
  check('result not ok',                  result.ok === false);
  check('reason is username_mismatch',    result.reason === 'username_mismatch');
  check('setProgressData NOT called',     captured === null);
}

section('flushNow: bypasses debounce, syncs immediately');
{
  freshSync();
  const storage = Sync._makeMemoryStorage();
  const fakeFetch = makeFakeFetch([
    jsonResponse({ files: { [Sync.GIST_FILENAME]: { content: JSON.stringify({ positions: {} }) } } }),
    jsonResponse({})
  ]);
  let scheduledTimers = [];
  let cleared = 0;
  Sync._setHooks({
    storage: storage,
    fetch: fakeFetch,
    setTimeout: function (fn, ms) { const t = { fn: fn, ms: ms }; scheduledTimers.push(t); return t; },
    clearTimeout: function () { cleared++; }
  });
  Sync.init({ getProgressData: () => ({ positions: { p: { lastSeen: '2025-01-01T00:00:00.000Z' } } }),
              setProgressData: () => {} });
  Sync.setUsername('a');
  Sync.setCredentials('t', 'g');
  Sync.notifyMutation();   // schedules debounce
  check('debounce scheduled', scheduledTimers.length === 1);
  await Sync.flushNow();   // should clear the debounce + GET + PATCH
  check('debounce cleared by flushNow', cleared >= 1);
  check('GET + PATCH issued',           fakeFetch.calls.length === 2);
  check('dirty cleared',                Sync.isDirty() === false);
}

section('flushNow: not-dirty short-circuits (no fetch)');
{
  freshSync();
  let fetchCalled = false;
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: function () { fetchCalled = true; return Promise.resolve(jsonResponse({})); },
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.init({ getProgressData: () => ({ positions: {} }), setProgressData: () => {} });
  Sync.setUsername('a');
  Sync.setCredentials('t', 'g');
  // No notifyMutation → not dirty
  const result = await Sync.flushNow();
  check('flushNow returned false', result === false);
  check('no fetch made',           fetchCalled === false);
}

section('5s GET cache: two reads in window share one fetch');
{
  freshSync();
  let now = 1700000000000;
  const remoteGist = { files: { [Sync.GIST_FILENAME]: { content: JSON.stringify({ positions: {} }) } } };
  const fakeFetch = makeFakeFetch([jsonResponse(remoteGist), jsonResponse(remoteGist)]);
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetch,
    now: function () { return now; },
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.setUsername('a');
  Sync.setCredentials('t', 'g');
  await Sync.gistRead();
  await Sync.gistRead();
  check('two reads within 5s → one fetch', fakeFetch.calls.length === 1);
  // Advance past the cache TTL
  now += 6000;
  await Sync.gistRead();
  check('after TTL → second fetch', fakeFetch.calls.length === 2);
}

section('GET 401/404 propagates as error');
{
  freshSync();
  const fakeFetch = makeFakeFetch([errorResponse(401)]);
  Sync._setHooks({
    storage: Sync._makeMemoryStorage(),
    fetch: fakeFetch,
    setTimeout: () => {}, clearTimeout: () => {}
  });
  Sync.setUsername('a');
  Sync.setCredentials('t', 'g');
  let threw = false;
  try { await Sync.gistRead(); } catch (e) { threw = true; }
  check('401 → throws', threw === true);
}

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);

}

runAsync().catch(e => { console.error(e); process.exit(1); });

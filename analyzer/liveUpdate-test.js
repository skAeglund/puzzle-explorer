#!/usr/bin/env node
/**
 * liveUpdate-test.js — Verify lib/liveUpdate.js OTA orchestration off-device
 * by injecting a fake Capgo plugin, fetch, and local-version loader.
 *
 * Covers: compareDecision branches; checkAndStage downloads+sets only when the
 * manifest is newer; equal/older/malformed manifests no-op; download/set
 * failures degrade without throwing; notifyReady delegates and is failure-safe;
 * staging never calls reload (no mid-session disruption).
 *
 * Run: node analyzer/liveUpdate-test.js
 */
const LiveUpdate = require('../lib/liveUpdate');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// Fake plugin recording calls; reload must never be invoked by staging.
function makePlugin(opts) {
  opts = opts || {};
  return {
    calls: [],
    notifyAppReady() { this.calls.push('notifyAppReady'); return Promise.resolve({ bundle: { id: 'builtin' } }); },
    download(o) {
      this.calls.push(['download', o]);
      if (opts.downloadFails) return Promise.reject(new Error('net'));
      return Promise.resolve({ id: 'bndl_' + o.version, version: o.version, status: 'pending' });
    },
    set(o) { this.calls.push(['set', o]); if (opts.setFails) return Promise.reject(new Error('setfail')); return Promise.resolve(); },
    reload() { this.calls.push('reload'); return Promise.resolve(); }
  };
}
function reset() { LiveUpdate._setPlugin(null); LiveUpdate._setFetch(null); LiveUpdate._setLocalVersionLoader(null); }

async function run() {
  // ━━━ compareDecision (pure) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('compareDecision');
  {
    const d = LiveUpdate.compareDecision;
    check('newer remote → update', d(3, { version: 5, url: 'u' }).action === 'update');
    check('update carries version+url', (() => { const r = d(3, { version: 5, url: 'u' }); return r.version === 5 && r.url === 'u'; })());
    check('equal → noop up-to-date', (() => { const r = d(5, { version: 5, url: 'u' }); return r.action === 'noop' && r.reason === 'up-to-date'; })());
    check('older remote → noop', d(9, { version: 5, url: 'u' }).action === 'noop');
    check('unknown local (0) updates to any', d(0, { version: 1, url: 'u' }).action === 'update');
    check('null manifest → noop', d(3, null).reason === 'no-manifest');
    check('missing version → noop', d(3, { url: 'u' }).reason === 'bad-manifest-version');
    check('missing url → noop', d(3, { version: 9 }).reason === 'no-url');
    check('non-numeric currentVersion treated as 0', d('x', { version: 1, url: 'u' }).action === 'update');
  }

  // ━━━ availability ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('availability');
  {
    reset();
    check('no plugin → unavailable', LiveUpdate.available() === false);
    LiveUpdate._setPlugin(makePlugin());
    check('injected plugin → available', LiveUpdate.available() === true);
  }

  // ━━━ notifyReady ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('notifyReady');
  {
    reset();
    check('no plugin → false, no throw', (await LiveUpdate.notifyReady()) === false);
    const p = makePlugin(); LiveUpdate._setPlugin(p);
    const ok = await LiveUpdate.notifyReady();
    check('delegates to notifyAppReady', ok === true && p.calls.indexOf('notifyAppReady') !== -1);
  }

  // ━━━ checkAndStage: newer → download only (no set, no reload) ━━━━━━━━━
  section('checkAndStage: downloads a newer bundle (no set/reload yet)');
  {
    reset();
    const p = makePlugin(); LiveUpdate._setPlugin(p);
    LiveUpdate._setLocalVersionLoader(() => 3);
    LiveUpdate._setFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 7, url: 'https://x/app/bundles/7.zip' }) }));
    const r = await LiveUpdate.checkAndStage({ manifestUrl: 'https://x/app/app-manifest.json' });
    check('reports staged update', r.ok === true && r.updated === true && r.staged === true && r.version === 7, JSON.stringify(r));
    const dl = p.calls.find(c => Array.isArray(c) && c[0] === 'download');
    check('download called with url+string version', dl && dl[1].url === 'https://x/app/bundles/7.zip' && dl[1].version === '7');
    check('set NOT called during staging (avoids pending-validation limbo)', !p.calls.some(c => Array.isArray(c) && c[0] === 'set'));
    check('reload NOT called during staging', p.calls.indexOf('reload') === -1);
  }

  // ━━━ checkAndStage: up-to-date → no download ━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('checkAndStage: up-to-date no-op');
  {
    reset();
    const p = makePlugin(); LiveUpdate._setPlugin(p);
    LiveUpdate._setLocalVersionLoader(() => 7);
    LiveUpdate._setFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 7, url: 'u' }) }));
    const r = await LiveUpdate.checkAndStage({ manifestUrl: 'm' });
    check('no update when equal', r.ok === true && r.updated === false && r.reason === 'up-to-date');
    check('no download/set calls', !p.calls.some(c => Array.isArray(c)));
  }

  // ━━━ failure handling ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('failure handling degrades, never throws');
  {
    // manifest fetch fails
    reset();
    LiveUpdate._setPlugin(makePlugin());
    LiveUpdate._setLocalVersionLoader(() => 1);
    LiveUpdate._setFetch(() => Promise.reject(new Error('offline')));
    const r1 = await LiveUpdate.checkAndStage({ manifestUrl: 'm' });
    check('manifest fetch failure → noop', r1.ok === true && r1.updated === false && r1.reason === 'no-manifest');

    // download fails
    reset();
    const p2 = makePlugin({ downloadFails: true }); LiveUpdate._setPlugin(p2);
    LiveUpdate._setLocalVersionLoader(() => 1);
    LiveUpdate._setFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 2, url: 'u' }) }));
    const r2 = await LiveUpdate.checkAndStage({ manifestUrl: 'm' });
    check('download failure → ok:false, no set, no throw', r2.ok === false && r2.reason === 'download-failed'
      && !p2.calls.some(c => Array.isArray(c) && c[0] === 'set'));

    // no manifestUrl / no plugin
    reset();
    const r3 = await LiveUpdate.checkAndStage({});
    check('missing manifestUrl → unavailable', r3.ok === false && r3.reason === 'unavailable');
  }

  // ━━━ applyNow ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('applyNow');
  {
    reset();
    check('no plugin → false, no throw', (await LiveUpdate.applyNow()) === false);

    // After staging a download, applyNow set()s that bundle then reload()s —
    // in that order — so the swap is clean (no pending-validation limbo).
    reset();
    const p = makePlugin(); LiveUpdate._setPlugin(p);
    LiveUpdate._setLocalVersionLoader(() => 1);
    LiveUpdate._setFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 2, url: 'u' }) }));
    await LiveUpdate.checkAndStage({ manifestUrl: 'm' });
    const ok = await LiveUpdate.applyNow();
    const setIdx = p.calls.findIndex(c => Array.isArray(c) && c[0] === 'set');
    const reloadIdx = p.calls.indexOf('reload');
    check('set the staged bundle then reload', ok === true && setIdx !== -1 && reloadIdx !== -1 && setIdx < reloadIdx);
    check('set used the downloaded bundle id', p.calls[setIdx][1].id === 'bndl_2');

    // No pending download → applyNow is just a reload.
    reset();
    const p2 = makePlugin(); LiveUpdate._setPlugin(p2);
    await LiveUpdate.applyNow();
    check('no pending → reload only, no set', p2.calls.indexOf('reload') !== -1 && !p2.calls.some(c => Array.isArray(c) && c[0] === 'set'));
  }

  console.log('\n' + (fail === 0 ? '✓ ALL PASS' : '✗ FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * offlineFs-test.js — Verify lib/offlineFs.js, the native-filesystem backend
 * for the "Make available offline" stores. Exercises the logic off-device by
 * injecting a fake Capacitor Filesystem (in-memory file store) via _setFs().
 *
 * Covers: body/manifest round-trips, the {ok,error} write contract (incl. a
 * failing filesystem), missing-file-is-empty (first run), cross-repertoire
 * body sharing, manifest shaping (repId attached, keyPath stripped), deletion,
 * listing, and persistence across an in-memory reset (data survives a "reload"
 * because it was written to the fake disk).
 *
 * Run: node analyzer/offlineFs-test.js
 */

const OfflineFs = require('../lib/offlineFs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── fake Capacitor Filesystem ────────────────────────────────────────────
// In-memory file store keyed by directory/path. readFile rejects when absent
// (mirrors @capacitor/filesystem, which throws "File does not exist"), so the
// module's "missing → empty store" handling is genuinely exercised.
function makeFakeFs() {
  const files = Object.create(null);
  return {
    files,
    writeFile(opts) {
      files[opts.directory + '/' + opts.path] = opts.data;
      return Promise.resolve({ uri: 'fake://' + opts.path });
    },
    readFile(opts) {
      const k = opts.directory + '/' + opts.path;
      if (!(k in files)) return Promise.reject(new Error('File does not exist'));
      return Promise.resolve({ data: files[k] });
    }
  };
}

// A filesystem whose writes always fail — to verify the {ok,error} contract.
function makeFailingFs() {
  return {
    writeFile() { return Promise.reject(new Error('ENOSPC: disk full')); },
    readFile()  { return Promise.reject(new Error('File does not exist')); }
  };
}

async function run() {
  // ━━━ availability ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('availability');
  {
    OfflineFs._setFs(null);
    check('no Capacitor / no injected fs → unavailable', OfflineFs.available() === false);
    OfflineFs._setFs(makeFakeFs());
    check('injected fs → available', OfflineFs.available() === true);
  }

  // ━━━ bodies: round-trip + sharing + keys ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('bodies');
  {
    const fs = makeFakeFs();
    OfflineFs._setFs(fs);

    check('miss → null', (await OfflineFs.getOfflineBody('nope')) === null);
    check('empty store → no keys', (await OfflineFs.getOfflineBodyKeys()).length === 0);

    const r1 = await OfflineFs.putOfflineBodies([
      { id: 'aaaaa', body: { id: 'aaaaa', fen: 'FEN1', moves: ['e2e4'] } },
      { id: 'bbbbb', body: { id: 'bbbbb', fen: 'FEN2', moves: ['d2d4'] } }
    ]);
    check('put reports ok', r1 && r1.ok === true, JSON.stringify(r1));

    const a = await OfflineFs.getOfflineBody('aaaaa');
    check('body round-trips', a && a.fen === 'FEN1' && a.moves[0] === 'e2e4');

    const keys = (await OfflineFs.getOfflineBodyKeys()).sort();
    check('both ids present', keys.length === 2 && keys[0] === 'aaaaa' && keys[1] === 'bbbbb');

    // A second repertoire reusing id 'aaaaa' must not duplicate or clobber.
    await OfflineFs.putOfflineBodies([{ id: 'aaaaa', body: { id: 'aaaaa', fen: 'FEN1', moves: ['e2e4'] } }]);
    check('shared id not duplicated', (await OfflineFs.getOfflineBodyKeys()).length === 2);

    // empty put is a no-op success
    const r0 = await OfflineFs.putOfflineBodies([]);
    check('empty put → ok no-op', r0 && r0.ok === true);
  }

  // ━━━ manifests: shape + round-trip + list ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('manifests');
  {
    OfflineFs._setFs(makeFakeFs());

    check('missing manifest → null', (await OfflineFs.getOfflineManifest('repX')) === null);

    const man = { matches: [['p1', 1500, 'w', 6, 6, [3]]], itemSig: 'deadbeef', builtAt: 'x', key: 'SHOULD_BE_STRIPPED' };
    const w = await OfflineFs.putOfflineManifest('rep1', man);
    check('put manifest ok', w && w.ok === true, JSON.stringify(w));

    const got = await OfflineFs.getOfflineManifest('rep1');
    check('repId attached', got && got.repId === 'rep1');
    check('keyPath field stripped', got && typeof got.key === 'undefined');
    check('match entries preserved', got && got.matches.length === 1 && got.matches[0][0] === 'p1');
    check('itemSig preserved', got && got.itemSig === 'deadbeef');

    await OfflineFs.putOfflineManifest('rep2', { matches: [], itemSig: 'cafe' });
    const list = await OfflineFs.listOfflineManifests();
    const ids = list.map(m => m.repId).sort();
    check('list returns both with repIds', ids.length === 2 && ids[0] === 'rep1' && ids[1] === 'rep2');

    check('bad repId rejected', (await OfflineFs.putOfflineManifest('', man)).ok === false);
  }

  // ━━━ deletion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('deletion');
  {
    OfflineFs._setFs(makeFakeFs());
    await OfflineFs.putOfflineBodies([
      { id: 'x1', body: { fen: 'a' } }, { id: 'x2', body: { fen: 'b' } }, { id: 'x3', body: { fen: 'c' } }
    ]);
    await OfflineFs.deleteOfflineBodies(['x2']);
    const keys = (await OfflineFs.getOfflineBodyKeys()).sort();
    check('body deleted, others remain', keys.length === 2 && keys.indexOf('x2') === -1);

    await OfflineFs.putOfflineManifest('r', { matches: [] });
    await OfflineFs.deleteOfflineManifest('r');
    check('manifest deleted', (await OfflineFs.getOfflineManifest('r')) === null);
    // deleting absent keys is a harmless no-op
    await OfflineFs.deleteOfflineBodies(['ghost']);
    await OfflineFs.deleteOfflineManifest('ghost');
    check('deleting absent → no throw', true);
  }

  // ━━━ persistence across reset (survives a "reload") ━━━━━━━━━━━━━━━━━━━━
  section('persistence across reset');
  {
    const fs = makeFakeFs();
    OfflineFs._setFs(fs);
    await OfflineFs.putOfflineBodies([{ id: 'keep', body: { fen: 'persisted' } }]);
    await OfflineFs.putOfflineManifest('keepRep', { matches: [['keep', 1, 'w', 2, 2, []]] });

    // Reset in-memory caches but keep the SAME backing file store — simulates
    // closing and reopening the app. Data must come back from "disk".
    OfflineFs._setFs(fs);
    const b = await OfflineFs.getOfflineBody('keep');
    check('body survived reset', b && b.fen === 'persisted');
    const m = await OfflineFs.getOfflineManifest('keepRep');
    check('manifest survived reset', m && m.matches[0][0] === 'keep');
  }

  // ━━━ write-failure contract ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  section('write-failure contract');
  {
    OfflineFs._setFs(makeFailingFs());
    const r = await OfflineFs.putOfflineBodies([{ id: 'z', body: {} }]);
    check('failed body write → ok:false with error', r && r.ok === false && !!r.error, JSON.stringify(r));
    const rm = await OfflineFs.putOfflineManifest('z', { matches: [] });
    check('failed manifest write → ok:false with error', rm && rm.ok === false && !!rm.error, JSON.stringify(rm));
  }

  // ─── summary ───────────────────────────────────────────────────────────
  console.log('\n' + (fail === 0 ? '✓ ALL PASS' : '✗ FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(function (e) { console.error(e); process.exit(1); });

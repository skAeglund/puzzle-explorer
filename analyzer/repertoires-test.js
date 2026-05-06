#!/usr/bin/env node
/**
 * repertoires-test.js — Test the lib/repertoires data layer.
 *
 * Coverage:
 *   - create / list / get: shape, sort order, duplicate-name rejection
 *   - rename: collision check, no-op same-name, length/empty validation
 *   - addItem: dedup by fenPositionKey, orientation/label sanitization,
 *     length cap, MAX_ITEMS_PER_REPERTOIRE soft cap
 *   - removeItem: by-key match, missing item returns false
 *   - delete: produces tombstone, list() filters tombstones, get() returns null
 *   - importData / exportData round-trip including tombstones
 *   - Defensive load: corrupt JSON, bad schema (non-object, array),
 *     malformed entries (missing fen, non-string name)
 *   - Username switching: per-user storage isolation
 *   - Quota error on save returns false, no crash
 *
 * Run: node analyzer/repertoires-test.js
 */

const Repertoires = require('../lib/repertoires');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── helpers ─────────────────────────────────────────────────────────────
function fresh() {
  Repertoires.setStorage(Repertoires.makeMemoryStorage());
  Repertoires.setUsername('');
  Repertoires.setNow();   // reset to default Date.now
}

// Deterministic clock for tests that need ordered timestamps.
function fakeClock(start) {
  var t = start;
  return {
    now: function () { return new Date(t).toISOString(); },
    advance: function (ms) { t += ms; },
    set: function (ms) { t = ms; }
  };
}

// Distinct legal FENs for dedup tests.
var FEN_START   = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
var FEN_E4      = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
var FEN_E4_C5   = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
// Same position as FEN_START canonically but with different halfmove/fullmove.
// fenPositionKey uses only the first 4 fields so these dedup.
var FEN_START_DUP = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 5 17';

// ─── tests ───────────────────────────────────────────────────────────────
section('create + list + get');
fresh();
var r1 = Repertoires.create('Caro-Kann');
check('create returns entry with id, name, items', r1 && typeof r1.id === 'string' && r1.id.indexOf('rep_') === 0 && r1.name === 'Caro-Kann' && Array.isArray(r1.items) && r1.items.length === 0);
check('create stamps createdAt + lastSeen', typeof r1.createdAt === 'string' && typeof r1.lastSeen === 'string');
var r2 = Repertoires.create('Sicilian');
var r3 = Repertoires.create('  King\'s Indian  ');
check('create trims whitespace', r3 && r3.name === 'King\'s Indian');
var listed = Repertoires.list();
check('list returns 3 entries', listed.length === 3);
check('list sorts case-insensitively by name',
  listed[0].name === 'Caro-Kann' && listed[1].name === 'King\'s Indian' && listed[2].name === 'Sicilian',
  'got: ' + listed.map(function (r) { return r.name; }).join(', '));
check('get by id returns same entry', Repertoires.get(r1.id).name === 'Caro-Kann');
check('get for unknown id returns null', Repertoires.get('rep_nonexistent') === null);
check('get for empty/non-string returns null', Repertoires.get('') === null && Repertoires.get(null) === null);

section('create rejects bad input');
fresh();
check('empty name → null', Repertoires.create('') === null);
check('whitespace-only name → null', Repertoires.create('   ') === null);
check('non-string → null', Repertoires.create(null) === null && Repertoires.create(42) === null);
check('over-length name → null', Repertoires.create('x'.repeat(81)) === null);
Repertoires.create('London');
check('duplicate name (case-insensitive) → null', Repertoires.create('LONDON') === null);
check('duplicate after trim → null', Repertoires.create('  london  ') === null);

section('rename');
fresh();
var ra = Repertoires.create('A');
var rb = Repertoires.create('B');
check('rename happy path', Repertoires.rename(ra.id, 'A renamed') === true);
check('renamed value persisted', Repertoires.get(ra.id).name === 'A renamed');
check('rename to colliding name fails', Repertoires.rename(ra.id, 'B') === false);
check('rename same name (case change) succeeds', Repertoires.rename(ra.id, 'A RENAMED') === true);
check('case-changed name persisted', Repertoires.get(ra.id).name === 'A RENAMED');
check('rename empty fails', Repertoires.rename(ra.id, '') === false);
check('rename whitespace-only fails', Repertoires.rename(ra.id, '   ') === false);
check('rename over-length fails', Repertoires.rename(ra.id, 'x'.repeat(81)) === false);
check('rename unknown id fails', Repertoires.rename('rep_zzz', 'whatever') === false);

section('addItem dedup + sanitization');
fresh();
var rep = Repertoires.create('Test');
check('addItem first time succeeds', Repertoires.addItem(rep.id, FEN_START) === true);
check('item count is 1', Repertoires.get(rep.id).items.length === 1);
check('addItem same FEN again returns false (dedup)', Repertoires.addItem(rep.id, FEN_START) === false);
check('item count still 1', Repertoires.get(rep.id).items.length === 1);
check('addItem canonically-equivalent FEN returns false (dedup by posKey)', Repertoires.addItem(rep.id, FEN_START_DUP) === false);
check('different FEN succeeds', Repertoires.addItem(rep.id, FEN_E4) === true);
check('item count is 2', Repertoires.get(rep.id).items.length === 2);

check('addItem with orientation white persists', Repertoires.addItem(rep.id, FEN_E4_C5, { orientation: 'white' }) === true);
var items = Repertoires.get(rep.id).items;
check('orientation field present', items[items.length - 1].orientation === 'white');

// Replace with a fresh repertoire for the label test
var r2 = Repertoires.create('Labels test');
check('addItem with label persists trimmed', Repertoires.addItem(r2.id, FEN_START, { label: '  After 1.e4  ' }) === true);
check('label field stored trimmed', Repertoires.get(r2.id).items[0].label === 'After 1.e4');

check('addItem invalid orientation is dropped', Repertoires.addItem(r2.id, FEN_E4, { orientation: 'gray' }) === true);
check('orientation field absent on invalid input', Repertoires.get(r2.id).items[1].orientation === undefined);

check('addItem with empty/whitespace label drops the field', Repertoires.addItem(r2.id, FEN_E4_C5, { label: '   ' }) === true);
check('empty label not stored', Repertoires.get(r2.id).items[2].label === undefined);

check('addItem to unknown repertoire returns false', Repertoires.addItem('rep_zzz', FEN_START) === false);
check('addItem with empty fen returns false', Repertoires.addItem(rep.id, '') === false);
check('addItem with non-string fen returns false', Repertoires.addItem(rep.id, null) === false);

section('removeItem');
fresh();
var rr = Repertoires.create('Rem');
Repertoires.addItem(rr.id, FEN_START);
Repertoires.addItem(rr.id, FEN_E4);
Repertoires.addItem(rr.id, FEN_E4_C5);
check('initial count 3', Repertoires.get(rr.id).items.length === 3);
check('removeItem matches by canonical key', Repertoires.removeItem(rr.id, FEN_START_DUP) === true);
check('count after canonical-key remove is 2', Repertoires.get(rr.id).items.length === 2);
check('removed item is the one whose key matched',
  Repertoires.get(rr.id).items.every(function (it) { return it.fen !== FEN_START; }));
check('removeItem missing returns false', Repertoires.removeItem(rr.id, FEN_START) === false);
check('removeItem from unknown repertoire returns false', Repertoires.removeItem('rep_zzz', FEN_E4) === false);

section('delete creates tombstone');
fresh();
var clock = fakeClock(1700000000000);
Repertoires.setNow(clock.now);
var rd = Repertoires.create('Doomed');
clock.advance(1000);
check('delete returns true', Repertoires['delete'](rd.id) === true);
check('list omits deleted', Repertoires.list().length === 0);
check('get returns null for deleted', Repertoires.get(rd.id) === null);
var raw = Repertoires.exportData();
check('exportData includes tombstone', raw[rd.id] && raw[rd.id].deleted === true);
check('tombstone has lastSeen', typeof raw[rd.id].lastSeen === 'string');
check('tombstone has no name/items', raw[rd.id].name === undefined && raw[rd.id].items === undefined);
check('delete already-deleted is no-op-success', Repertoires['delete'](rd.id) === true);
check('delete unknown returns false', Repertoires['delete']('rep_zzz') === false);

section('exportData / importData round-trip');
fresh();
var ex1 = Repertoires.create('X1');
Repertoires.addItem(ex1.id, FEN_START, { orientation: 'white', label: 'start' });
Repertoires.addItem(ex1.id, FEN_E4);
var ex2 = Repertoires.create('X2');
Repertoires['delete'](ex2.id);  // tombstone
var exported = Repertoires.exportData();
fresh();
check('importData accepts exported map', Repertoires.importData(exported) === true);
check('round-tripped live entry preserved', Repertoires.get(ex1.id) && Repertoires.get(ex1.id).items.length === 2);
check('round-tripped tombstone preserved', Repertoires.exportData()[ex2.id].deleted === true);
check('list after round-trip omits tombstone', Repertoires.list().length === 1);
check('importData with null wipes', Repertoires.importData(null) === true && Repertoires.list().length === 0);
check('importData with array rejects', Repertoires.importData([]) === false);
check('importData with primitive rejects', Repertoires.importData(42) === false);

section('defensive load (corrupt / bad shapes)');
fresh();
var s = Repertoires.makeMemoryStorage();
Repertoires.setStorage(s);
s.setItem('puzzle_explorer_repertoires', '{not valid json');
check('corrupt JSON → empty', Object.keys(Repertoires.load()).length === 0);
s.setItem('puzzle_explorer_repertoires', JSON.stringify([1, 2, 3]));
check('top-level array → empty', Object.keys(Repertoires.load()).length === 0);
s.setItem('puzzle_explorer_repertoires', JSON.stringify('hello'));
check('top-level string → empty', Object.keys(Repertoires.load()).length === 0);
// Mix of valid and invalid entries — valid ones survive
s.setItem('puzzle_explorer_repertoires', JSON.stringify({
  good: { id: 'good', name: 'Good', items: [{ fen: FEN_START }], createdAt: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' },
  noLastSeen: { id: 'noLastSeen', name: 'X', items: [] },
  noName: { id: 'noName', items: [], lastSeen: '2026-01-01T00:00:00Z' },
  liveTombstone: { id: 'liveTombstone', deleted: true, lastSeen: '2026-01-01T00:00:00Z' },
  arrEntry: ['this', 'is', 'an', 'array'],
  primitive: 42,
  itemsBadFen: { id: 'itemsBadFen', name: 'Y', items: [{ fen: '' }, { fen: 'ok-but-no-key', }], lastSeen: '2026-01-01T00:00:00Z' }
}));
var defLoad = Repertoires.load();
check('valid entry survives', defLoad.good && defLoad.good.name === 'Good');
check('missing lastSeen filtered', !defLoad.noLastSeen);
check('missing name filtered (live)', !defLoad.noName);
check('tombstone with lastSeen survives', defLoad.liveTombstone && defLoad.liveTombstone.deleted === true);
check('array entry filtered', !defLoad.arrEntry);
check('primitive entry filtered', !defLoad.primitive);
check('items with empty fen dropped, others kept', defLoad.itemsBadFen && defLoad.itemsBadFen.items.length === 1);

section('quota error on save returns false');
fresh();
var quotaStore = Repertoires.makeMemoryStorage();
quotaStore.setItem = function () { throw new Error('QuotaExceededError'); };
Repertoires.setStorage(quotaStore);
check('create returns null on quota fail', Repertoires.create('Hopeless') === null);

section('username switching isolates storage');
fresh();
Repertoires.setUsername('alice');
var ra1 = Repertoires.create('Alice rep');
check('alice has 1 repertoire', Repertoires.list().length === 1);
Repertoires.setUsername('bob');
check('bob starts empty', Repertoires.list().length === 0);
Repertoires.create('Bob rep');
check('bob has 1', Repertoires.list().length === 1);
Repertoires.setUsername('alice');
check('alice still has 1', Repertoires.list().length === 1);
check('alice rep is hers', Repertoires.list()[0].name === 'Alice rep');

section('migrateLegacyToActive');
// Anonymous-mode user builds repertoires; later connects sync. Without
// migration they'd appear empty under the namespaced key. Mirrors
// lib/progress.js's migrateLegacyToActive contract.
fresh();
// Build legacy state under no-username key.
Repertoires.create('Anonymous rep');
check('anonymous mode has 1', Repertoires.list().length === 1);
// Switch to username — the namespaced key is empty, so list() reflects nothing.
Repertoires.setUsername('charlie');
check('namespaced key starts empty', Repertoires.list().length === 0);
// Run migration.
var migrated = Repertoires.migrateLegacyToActive();
check('migration returns true', migrated === true);
check('charlie now sees the migrated rep', Repertoires.list().length === 1);
check('migrated rep name preserved', Repertoires.list()[0].name === 'Anonymous rep');
// Idempotent — second call no-ops because active is non-empty.
check('second migration call returns false (already populated)', Repertoires.migrateLegacyToActive() === false);
check('still 1 rep after second call', Repertoires.list().length === 1);
// Legacy key is untouched (safety backup) — switching back to anonymous
// shows the original.
Repertoires.setUsername('');
check('legacy mode still has the rep (backup preserved)', Repertoires.list().length === 1);

section('migrateLegacyToActive guards');
fresh();
// No username set → no-op (legacy IS active).
check('no-op when no username', Repertoires.migrateLegacyToActive() === false);
// No legacy data → no-op.
Repertoires.setUsername('dave');
check('no-op when legacy is empty', Repertoires.migrateLegacyToActive() === false);
check('still nothing in active', Repertoires.list().length === 0);

section('lastSeen advances on writes');
fresh();
var c = fakeClock(1700000000000);
Repertoires.setNow(c.now);
var lt = Repertoires.create('LT');
var t0 = lt.lastSeen;
c.advance(1000);
Repertoires.rename(lt.id, 'LT2');
var t1 = Repertoires.get(lt.id).lastSeen;
check('rename advances lastSeen', new Date(t1).getTime() > new Date(t0).getTime());
c.advance(1000);
Repertoires.addItem(lt.id, FEN_START);
var t2 = Repertoires.get(lt.id).lastSeen;
check('addItem advances lastSeen', new Date(t2).getTime() > new Date(t1).getTime());
c.advance(1000);
Repertoires.removeItem(lt.id, FEN_START);
var t3 = Repertoires.get(lt.id).lastSeen;
check('removeItem advances lastSeen', new Date(t3).getTime() > new Date(t2).getTime());

section('soft cap on items per repertoire');
fresh();
check('MAX_ITEMS_PER_REPERTOIRE exposed on api', typeof Repertoires.MAX_ITEMS_PER_REPERTOIRE === 'number');
check('MAX_ITEMS_PER_REPERTOIRE is 2000', Repertoires.MAX_ITEMS_PER_REPERTOIRE === 2000);
// Build a unique-FEN factory by varying the en-passant + halfmove fields,
// which DON'T survive fenPositionKey canonicalization. We need actually-
// distinct positions for dedup not to fire — synthesize with different
// piece arrangements via a counter in pawn structure.
var capRep = Repertoires.create('Cap');
// Push exactly MAX_ITEMS_PER_REPERTOIRE distinct items by placing a single
// pawn on different squares — produces 64 unique positions, more than
// enough to validate the cap path without hitting it. Use the cap value
// from module config indirectly by checking that the cap (currently 2000)
// is enforced.
// Instead of synthesizing thousands of FENs, monkey-patch the cap by
// directly stuffing items via importData and verifying addItem refuses.
var stuffed = {};
stuffed[capRep.id] = {
  id: capRep.id,
  name: 'Cap',
  items: [],
  createdAt: capRep.createdAt,
  lastSeen: capRep.lastSeen
};
var CAP = 2000;
for (var i = 0; i < CAP; i++) {
  // Synthesize unique strings — even if some collide canonically,
  // _validateEntry stores them and addItem checks count first.
  stuffed[capRep.id].items.push({ fen: 'fen_' + i + '/8/8/8/8/8/8/8 w - - 0 1' });
}
Repertoires.importData(stuffed);
check(CAP + ' items present after import', Repertoires.get(capRep.id).items.length === CAP);
check('cap+1 addItem refused (cap)', Repertoires.addItem(capRep.id, FEN_START) === false);
check('count unchanged after refused add', Repertoires.get(capRep.id).items.length === CAP);

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n' + (fail ? '✗' : '✓') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * themes-test.js — theme FILTER feature (distinct from theme-stats-test.js,
 * which covers per-theme performance tracking on Progress).
 *
 * Coverage:
 *   - lib/themes.js codec: append-only invariant, curated ⊆ vocabulary,
 *     encodeThemes (curated-only / sorted / deduped / drops unknowns),
 *     decode round-trip, codeFor/keyForCode, labelFor fallback.
 *   - Session.filterByTheme: OR/union semantics, no-op on empty selection,
 *     legacy missing-m[5] pass-through vs present-empty drop, Set + array
 *     input, composition through create()/createTraining().
 *   - End-to-end pipeline:
 *       * build-index.js emits m[5] (curated codes) natively
 *       * filter-data.js --add-themes stamps m[5] from bodies on a length-5
 *         source (the no-rebuild path), and is idempotent on length-6
 *       * --add-themes combined with --add-puzzle-ply upgrades length-4 →
 *         length-6 in one pass
 *
 * Run: node analyzer/themes-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Themes = require('../lib/themes');
const Session = require('../lib/session');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-test-'));

function loadIndex(outDir) {
  const indexDir = path.join(outDir, 'index');
  const merged = Object.create(null);
  for (const f of fs.readdirSync(indexDir).filter(f => f.endsWith('.json'))) {
    const obj = JSON.parse(fs.readFileSync(path.join(indexDir, f), 'utf8'));
    for (const [k, v] of Object.entries(obj)) merged[k] = v;
  }
  return merged;
}
function entriesById(idx) {
  const byId = Object.create(null);
  for (const arr of Object.values(idx)) for (const e of arr) byId[e[0]] = byId[e[0]] || e;
  return byId;
}

// ━━━ lib/themes.js codec ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('themes codec — vocabulary + curated invariants');
{
  check('THEME_LIST has no duplicates',
    new Set(Themes.THEME_LIST).size === Themes.THEME_LIST.length);
  check('every curated key is in THEME_LIST (stable code)',
    Themes.CURATED.every(k => Themes.codeFor(k) >= 0),
    JSON.stringify(Themes.CURATED.filter(k => Themes.codeFor(k) < 0)));
  check('every GROUPS key is curated',
    Themes.GROUPS.every(g => g.keys.every(k => Themes.isCurated(k))));
  check('CURATED equals the flattened GROUPS keys',
    JSON.stringify(Themes.CURATED) ===
      JSON.stringify(Themes.GROUPS.reduce((a, g) => a.concat(g.keys), [])));
  check('CURATED has no duplicates',
    new Set(Themes.CURATED).size === Themes.CURATED.length);
  // Code stability spot-check: a handful of well-known keys must keep the
  // codes the published index was built with. If THEME_LIST is reordered
  // these break — which is the point (append-only guard).
  check('fork code stable (23)', Themes.codeFor('fork') === 23, 'got ' + Themes.codeFor('fork'));
  check('pin code stable (43)', Themes.codeFor('pin') === 43, 'got ' + Themes.codeFor('pin'));
  check('mateIn2 code stable (35)', Themes.codeFor('mateIn2') === 35, 'got ' + Themes.codeFor('mateIn2'));
}

section('themes codec — encodeThemes');
{
  check('curated-only: drops a canonical-but-not-curated theme',
    JSON.stringify(Themes.encodeThemes(['fork', 'crushing'])) ===
      JSON.stringify([Themes.codeFor('fork')]));
  check('drops a totally unknown theme',
    JSON.stringify(Themes.encodeThemes(['fork', 'totallyBogus'])) ===
      JSON.stringify([Themes.codeFor('fork')]));
  check('sorted ascending',
    JSON.stringify(Themes.encodeThemes(['pin', 'fork', 'opening'])) ===
      JSON.stringify([Themes.codeFor('fork'), Themes.codeFor('opening'), Themes.codeFor('pin')]
        .sort((a, b) => a - b)));
  check('deduped',
    JSON.stringify(Themes.encodeThemes(['fork', 'fork'])) ===
      JSON.stringify([Themes.codeFor('fork')]));
  check('non-array → []', JSON.stringify(Themes.encodeThemes('fork')) === '[]');
  check('empty array → []', JSON.stringify(Themes.encodeThemes([])) === '[]');
  check('all-non-curated → [] (present-but-empty signal)',
    JSON.stringify(Themes.encodeThemes(['master', 'crushing', 'veryLong'])) === '[]');
  check('non-string elements skipped',
    JSON.stringify(Themes.encodeThemes(['fork', 42, null, {}])) ===
      JSON.stringify([Themes.codeFor('fork')]));
}

section('themes codec — decode + labels');
{
  check('decode round-trips encode',
    JSON.stringify(Themes.decodeThemes(Themes.encodeThemes(['fork', 'middlegame', 'mateIn3'])).sort()) ===
      JSON.stringify(['fork', 'mateIn3', 'middlegame'].sort()));
  check('decode drops out-of-range codes',
    JSON.stringify(Themes.decodeThemes([Themes.codeFor('fork'), 99999, -1])) ===
      JSON.stringify(['fork']));
  check('labelFor known key', Themes.labelFor('xRayAttack') === 'X-ray attack');
  check('labelFor unknown camelKey prettifies',
    Themes.labelFor('someNewTheme') === 'Some new theme');
  check('keyForCode inverts codeFor',
    Themes.keyForCode(Themes.codeFor('skewer')) === 'skewer');
  check('codeFor unknown → -1', Themes.codeFor('nope') === -1);
}

// ━━━ Session.filterByTheme ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
section('Session.filterByTheme — semantics');
{
  const FORK = Themes.codeFor('fork');
  const PIN = Themes.codeFor('pin');
  const SKEWER = Themes.codeFor('skewer');
  const M = [
    ['a', 1500, 'w', 3, 10, [FORK, Themes.codeFor('middlegame')]],
    ['b', 1500, 'w', 3, 10, [PIN]],
    ['c', 1500, 'w', 3, 10, []],          // present-empty: no curated theme
    ['d', 1500, 'w', 3, 10],              // legacy: missing m[5]
  ];
  const ids = arr => arr.map(m => m[0]).join(',');

  check('select fork → matches + legacy pass-through',
    ids(Session.filterByTheme(M, [FORK])) === 'a,d');
  check('OR/union: pin|skewer → b + legacy d',
    ids(Session.filterByTheme(M, [PIN, SKEWER])) === 'b,d');
  check('present-empty m[5] dropped under active selection',
    !Session.filterByTheme(M, [FORK]).some(m => m[0] === 'c'));
  check('null selection → no-op (all pass)',
    ids(Session.filterByTheme(M, null)) === 'a,b,c,d');
  check('empty array selection → no-op (all pass)',
    ids(Session.filterByTheme(M, [])) === 'a,b,c,d');
  check('Set input works',
    ids(Session.filterByTheme(M, new Set([FORK]))) === 'a,d');
  check('selection of all-non-numeric → no-op',
    ids(Session.filterByTheme(M, [null, undefined, 'x'])) === 'a,b,c,d');
  check('returns a copy on no-op (not the same array ref)',
    Session.filterByTheme(M, []) !== M);
  check('no match for an unselected theme code',
    Session.filterByTheme(M, [SKEWER]).filter(m => m[0] !== 'd').length === 0);
}

section('Session.create / createTraining — themeCodes composition');
{
  const FORK = Themes.codeFor('fork');
  const PIN = Themes.codeFor('pin');
  const matches = [
    ['p1', 1200, 'w', 3, 10, [FORK]],
    ['p2', 1200, 'w', 3, 10, [PIN]],
    ['p3', 1200, 'w', 3, 10, [FORK, PIN]],
  ];
  const noComplete = () => false;

  const s = Session.create({ matches, themeCodes: [FORK], isCompleted: noComplete, rng: () => 0 });
  check('create: themeCodes filters queue to fork puzzles',
    s.queue.slice().sort().join(',') === 'p1,p3', s.queue.join(','));
  const sAll = Session.create({ matches, isCompleted: noComplete, rng: () => 0 });
  check('create: no themeCodes → all queued',
    sAll.queue.length === 3, '' + sAll.queue.length);

  const t = Session.createTraining({
    matches,
    rounds: [{ label: 'all', ratingMin: 0, ratingMax: 3000, target: 10 }],
    themeCodes: [PIN],
    isCompleted: noComplete,
    rng: () => 0,
  });
  check('createTraining: themeCodes bounds the pool to pin puzzles',
    t.queue.slice().sort().join(',') === 'p2,p3', t.queue.join(','));
}

// ━━━ end-to-end pipeline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function buildTinyData(outDir) {
  // Two puzzles: one with curated themes, one with only non-curated themes.
  const pgn = [
    {
      id: 'FORK1', rating: 1500, themes: 'fork middlegame short',
      mainline: '1. e4 e5 2. Bc4 Nc6', site: 'https://lichess.org/abcd1234#5', sol: 'Nf3'
    },
    {
      id: 'NONE1', rating: 1700, themes: 'master crushing veryLong',
      mainline: '1. e4 c5 2. Nc3 Nc6', site: 'https://lichess.org/efgh5678#5', sol: 'Nf3'
    },
  ].map(p => `[Event "x"]
[Result "*"]
[PuzzleId "${p.id}"]
[PuzzleRating "${p.rating}"]
[PuzzleThemes "${p.themes}"]
[Annotator "${p.sol}"]
[Site "${p.site}"]
[Opening ""]

${p.mainline} *
`).join('\n');
  const inDir = path.join(tmpRoot, 'pgnsrc');
  fs.mkdirSync(inDir, { recursive: true });
  const pgnPath = path.join(inDir, 'in.pgn');
  fs.writeFileSync(pgnPath, pgn);
  execFileSync('node', [path.join(__dirname, 'build-index.js'), pgnPath, outDir], { stdio: 'pipe' });
}

section('e2e — build-index emits m[5] (curated codes)');
const builtDir = path.join(tmpRoot, 'data');
{
  buildTinyData(builtDir);
  const byId = entriesById(loadIndex(builtDir));
  check('every entry length 6', Object.values(byId).every(e => e.length === 6));
  check('FORK1 m[5] = [fork, middlegame] (short dropped)',
    JSON.stringify(byId['FORK1'][5]) ===
      JSON.stringify([Themes.codeFor('fork'), Themes.codeFor('middlegame')].sort((a, b) => a - b)));
  check('NONE1 m[5] = [] (all themes non-curated)',
    JSON.stringify(byId['NONE1'][5]) === '[]');
}

section('e2e — filter-data --add-themes on a length-5 source (no rebuild)');
{
  // Strip m[5] from the built index to mimic the current published length-5
  // index, keep the bodies (which carry the theme strings).
  const src5 = path.join(tmpRoot, 'data5');
  fs.mkdirSync(path.join(src5, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src5, 'puzzles'), { recursive: true });
  for (const f of fs.readdirSync(path.join(builtDir, 'index'))) {
    const o = JSON.parse(fs.readFileSync(path.join(builtDir, 'index', f), 'utf8'));
    for (const k in o) o[k] = o[k].map(e => e.slice(0, 5));
    fs.writeFileSync(path.join(src5, 'index', f), JSON.stringify(o));
  }
  for (const f of fs.readdirSync(path.join(builtDir, 'puzzles'))) {
    fs.copyFileSync(path.join(builtDir, 'puzzles', f), path.join(src5, 'puzzles', f));
  }
  fs.copyFileSync(path.join(builtDir, 'meta.json'), path.join(src5, 'meta.json'));

  const out6 = path.join(tmpRoot, 'data6');
  execFileSync('node', [path.join(__dirname, 'filter-data.js'),
    '--source-dir', src5, '--out-dir', out6, '--add-themes'], { stdio: 'pipe' });

  const byId = entriesById(loadIndex(out6));
  check('--add-themes re-stamps length-5 → length-6',
    Object.values(byId).every(e => e.length === 6));
  check('FORK1 m[5] re-derived from body',
    JSON.stringify(byId['FORK1'][5]) ===
      JSON.stringify([Themes.codeFor('fork'), Themes.codeFor('middlegame')].sort((a, b) => a - b)));
  check('NONE1 m[5] = [] re-derived',
    JSON.stringify(byId['NONE1'][5]) === '[]');
  const meta = JSON.parse(fs.readFileSync(path.join(out6, 'meta.json'), 'utf8'));
  check('meta.filterStats.addThemes = true', meta.filterStats.addThemes === true);
  check('meta.filterStats.entriesStampedWithThemes > 0',
    meta.filterStats.entriesStampedWithThemes > 0);
}

section('e2e — --add-themes is idempotent on a length-6 source');
{
  const outIdem = path.join(tmpRoot, 'dataIdem');
  execFileSync('node', [path.join(__dirname, 'filter-data.js'),
    '--source-dir', builtDir, '--out-dir', outIdem, '--add-themes'], { stdio: 'pipe' });
  const a = entriesById(loadIndex(builtDir));
  const b = entriesById(loadIndex(outIdem));
  let same = true;
  for (const id in a) if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) same = false;
  check('build-index m[5] === --add-themes re-stamped m[5] (same codec)', same);
}

section('e2e — --add-puzzle-ply + --add-themes upgrades length-4 → length-6');
{
  // Hand-build a length-4 source (legacy: no m[4], no m[5]) plus a matching
  // body carrying themes. add-puzzle-ply stamps m[4] from max(m[3]); themes
  // come from the body. Combined, a length-4 entry should end length-6.
  const src4 = path.join(tmpRoot, 'data4');
  fs.mkdirSync(path.join(src4, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src4, 'puzzles'), { recursive: true });
  // Single position, single length-4 entry.
  fs.writeFileSync(path.join(src4, 'index', '000.json'),
    JSON.stringify({ 'k1': [['LEG1', 1400, 'w', 6]] }));
  fs.writeFileSync(path.join(src4, 'puzzles', '000.ndjson'),
    JSON.stringify({ id: 'LEG1', fen: '', moves: [], rating: 1400, themes: ['fork', 'pin', 'short'] }) + '\n');
  // No filterStats in meta → add-puzzle-ply safety gate treats source as
  // unfiltered (which it is).
  fs.writeFileSync(path.join(src4, 'meta.json'), JSON.stringify({ builtAt: '2026-01-01T00:00:00.000Z' }));

  const out46 = path.join(tmpRoot, 'data46');
  execFileSync('node', [path.join(__dirname, 'filter-data.js'),
    '--source-dir', src4, '--out-dir', out46, '--add-puzzle-ply', '--add-themes'], { stdio: 'pipe' });
  const byId = entriesById(loadIndex(out46));
  const e = byId['LEG1'];
  check('LEG1 upgraded to length 6', e && e.length === 6, e && ('len ' + e.length));
  check('LEG1 m[4] stamped (startPly = max m[3] = 6)', e && e[4] === 6, e && ('m4 ' + e[4]));
  check('LEG1 m[5] = [fork, pin] from body (short dropped)',
    e && JSON.stringify(e[5]) ===
      JSON.stringify([Themes.codeFor('fork'), Themes.codeFor('pin')].sort((a, b) => a - b)),
    e && JSON.stringify(e[5]));
}

// ─── summary ───
console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);

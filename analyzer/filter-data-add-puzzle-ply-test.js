#!/usr/bin/env node
/**
 * filter-data-add-puzzle-ply-test.js — Tests for the --add-puzzle-ply
 * operation in analyzer/filter-data.js.
 *
 * Coverage:
 *   - filterIndexShard with puzzleStartPlyMap:
 *       * length-4 entries get upgraded to length-5 (m[4] appended)
 *       * length-5 entries pass through unchanged (no double-stamp)
 *       * length-3 entries pass through unchanged (no anchoring m[3])
 *       * mixed-length input preserves per-entry shape correctly
 *       * entriesUpgraded counter is accurate
 *       * map without an entry for a given puzzleId leaves the entry
 *         length-4 (defensive — shouldn't happen at runFilter scale)
 *       * map present + ALSO ratingFloor → both effects compose
 *       * fast-path bypassed when only puzzleStartPlyMap is set
 *   - runFilter --addPuzzlePly mode:
 *       * stamp-only mode (no other filters): every puzzle/body kept,
 *         every length-4 entry upgraded
 *       * filter + stamp combined: surviving entries are upgraded
 *       * meta.json filterStats records addPuzzlePly + entriesUpgradedToLength5
 *       * stamp-only mode bypasses the no-op-identity-copy refusal
 *   - runFilter source==out guard: throws cleanly instead of wiping input
 *
 * Run: node analyzer/filter-data-add-puzzle-ply-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./filter-data');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'add-puzzle-ply-test-'));

// ─── filterIndexShard: m[4] stamping on length-4 entries ────────────────
section('filterIndexShard: stamps m[4] on length-4 entries');
{
  const shard = {
    'pos-A': [
      ['p1', 1500, 'w', 3],  // length-4 → upgrade
      ['p2', 1700, 'b', 5],  // length-4 → upgrade
    ],
  };
  const map = new Map([['p1', 22], ['p2', 18]]);
  const r = F.filterIndexShard(shard, { puzzleStartPlyMap: map });
  check('positionsKept = 1', r.positionsKept === 1);
  check('entriesKept = 2', r.entriesKept === 2);
  check('entriesUpgraded = 2 (both length-4 entries got m[4])',
    r.entriesUpgraded === 2, 'got ' + r.entriesUpgraded);
  const arr = r.kept['pos-A'];
  check('p1 upgraded to length 5', arr[0].length === 5);
  check('p1 m[4] = 22', arr[0][4] === 22, 'got ' + arr[0][4]);
  check('p1 m[3] preserved (=3)', arr[0][3] === 3);
  check('p2 upgraded to length 5', arr[1].length === 5);
  check('p2 m[4] = 18', arr[1][4] === 18, 'got ' + arr[1][4]);
}

// ─── filterIndexShard: length-5 entries pass through unchanged ──────────
section('filterIndexShard: length-5 entries pass through (no double-stamp)');
{
  // A length-5 entry's m[4] is canonical from build-index. Even if the
  // map has a different value for that puzzleId (shouldn't happen at
  // runFilter scale, but defensive), the entry's own m[4] wins.
  const shard = {
    'pos-A': [
      ['p1', 1500, 'w', 3, 22],   // length-5, m[4]=22 → preserve
    ],
  };
  // Map has a different value — should be IGNORED for length-5 entries.
  const map = new Map([['p1', 999]]);
  const r = F.filterIndexShard(shard, { puzzleStartPlyMap: map });
  check('entriesUpgraded = 0 (length-5 not counted as upgraded)',
    r.entriesUpgraded === 0);
  const e = r.kept['pos-A'][0];
  check('entry stays length 5', e.length === 5);
  check('m[4] = 22 (entry\'s own value, not map\'s 999)', e[4] === 22, 'got ' + e[4]);
}

// ─── filterIndexShard: length-3 entries pass through unchanged ──────────
section('filterIndexShard: length-3 entries pass through (no anchoring m[3])');
{
  // Length-3 entries [id, rating, color] lack m[3]. Synthesizing m[3]
  // for them just to attach m[4] would be wrong (we'd invent data we
  // don't have). Filter readers already pass-through length-3 entries
  // via the "missing field → unfiltered" back-compat. Leave them alone.
  const shard = {
    'pos-A': [
      ['p1', 1500, 'w'],         // length-3 — leave alone
      ['p2', 1700, 'b', 5],      // length-4 → upgrade
    ],
  };
  const map = new Map([['p1', 22], ['p2', 18]]);
  const r = F.filterIndexShard(shard, { puzzleStartPlyMap: map });
  check('entriesUpgraded = 1 (only p2)', r.entriesUpgraded === 1);
  check('p1 stays length 3', r.kept['pos-A'][0].length === 3);
  check('p2 upgraded to length 5', r.kept['pos-A'][1].length === 5);
  check('p2 m[4] = 18', r.kept['pos-A'][1][4] === 18);
}

// ─── filterIndexShard: missing puzzleId in map leaves entry length-4 ────
section('filterIndexShard: missing map entry → length-4 left alone');
{
  // Defensive case: map doesn't have an entry for this puzzleId (e.g.
  // pre-pass missed it somehow). Don't synthesize a fake m[4]; leave
  // the entry length-4 so back-compat readers handle it gracefully.
  const shard = {
    'pos-A': [['orphan', 1500, 'w', 5]],
  };
  const map = new Map([['someoneElse', 22]]);
  const r = F.filterIndexShard(shard, { puzzleStartPlyMap: map });
  check('entriesUpgraded = 0 (no map entry for orphan)', r.entriesUpgraded === 0);
  check('orphan stays length 4', r.kept['pos-A'][0].length === 4);
}

// ─── filterIndexShard: stamp + filter compose correctly ─────────────────
section('filterIndexShard: --add-puzzle-ply composes with --rating-floor');
{
  const shard = {
    'pos-A': [
      ['low',  800, 'w', 3],   // dropped by rating-floor
      ['mid', 1500, 'w', 5],   // kept + upgraded
      ['hi',  2000, 'b', 8],   // kept + upgraded
    ],
  };
  const map = new Map([['mid', 22], ['hi', 30]]);
  // Note: 'low' has no map entry — that's fine since it's dropped before
  // the upgrade step would even consider it.
  const r = F.filterIndexShard(shard, {
    ratingFloor: 1000,
    puzzleStartPlyMap: map,
  });
  check('entriesKept = 2', r.entriesKept === 2);
  check('entriesDropped = 1 (low)', r.entriesDropped === 1);
  check('entriesUpgraded = 2', r.entriesUpgraded === 2);
  check('mid m[4] = 22', r.kept['pos-A'][0][4] === 22);
  check('hi m[4] = 30', r.kept['pos-A'][1][4] === 30);
}

// ─── filterIndexShard: stamp-only bypasses the all-filter-off fast path ─
section('filterIndexShard: puzzleStartPlyMap alone disables fast-path');
{
  // The legacy fast path returns the input array reference unchanged when
  // there's no per-entry work to do. With stamping requested, we MUST
  // walk every entry — so the fast path can't fire.
  const shard = {
    'pos-A': [['p1', 1500, 'w', 5]],
  };
  const map = new Map([['p1', 22]]);
  const r = F.filterIndexShard(shard, { puzzleStartPlyMap: map });
  // If fast path fired, output array would be the same reference as input
  // and the entry would still be length-4. Verify upgrade actually happened:
  check('output entry is length 5 (fast path was bypassed)',
    r.kept['pos-A'][0].length === 5);
  check('output array is a new array (not the input ref)',
    r.kept['pos-A'] !== shard['pos-A']);
}

// ─── runFilter: stamp-only mode (no other filters) ──────────────────────
section('runFilter: --addPuzzlePly alone (no other filters)');
{
  const src = path.join(tmpRoot, 'src-stamp');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 3], ['p2', 1700, 'b', 5]],
    'k2': [['p1', 1500, 'w', 8]],   // p1 also appears here, so its max-ply spans
    'k3': [['p3', 1200, 'b', 12]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n' +
    '{"id":"p2","rating":1700}\n' +
    '{"id":"p3","rating":1200}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ source: 'test' }));

  const out = path.join(tmpRoot, 'out-stamp');
  const stats = F.runFilter({
    sourceDir: src,
    outDir: out,
    addPuzzlePly: true,
    dryRun: false,
  });

  check('addPuzzlePly recorded in stats', stats.addPuzzlePly === true);
  check('entriesUpgradedToLength5 = 4 (all 4 entries)',
    stats.entriesUpgradedToLength5 === 4, 'got ' + stats.entriesUpgradedToLength5);
  check('positionsKept = 3 (every position kept — no filtering)',
    stats.positionsKept === 3);
  check('entriesKept = 4', stats.entriesKept === 4);
  check('puzzlesReferenced = 3', stats.puzzlesReferenced === 3);
  check('bodiesKept = 3 (all bodies kept)', stats.bodiesKept === 3);
  check('bodiesDropped = 0', stats.bodiesDropped === 0);

  const out0 = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  check('p1 in k1: m[4] = 8 (max of k1\'s 3 and k2\'s 8)',
    out0['k1'][0][4] === 8, 'got ' + out0['k1'][0][4]);
  check('p1 in k2: m[4] = 8 (same canonical value across all entries)',
    out0['k2'][0][4] === 8, 'got ' + out0['k2'][0][4]);
  check('p2 m[4] = 5', out0['k1'][1][4] === 5);
  check('p3 m[4] = 12', out0['k3'][0][4] === 12);

  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  check('meta.filterStats.addPuzzlePly = true',
    meta.filterStats.addPuzzlePly === true);
  check('meta.filterStats.entriesUpgradedToLength5 = 4',
    meta.filterStats.entriesUpgradedToLength5 === 4);
  check('meta.filterStats.ratingFloor = null (not set)',
    meta.filterStats.ratingFloor === null);
}

// ─── runFilter: --addPuzzlePly combined with --ratingFloor ──────────────
section('runFilter: --addPuzzlePly + --ratingFloor compose');
{
  const src = path.join(tmpRoot, 'src-combined');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['low', 800, 'w', 3], ['mid', 1500, 'b', 5]],
    'k2': [['hi', 2000, 'w', 7]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"low","rating":800}\n' +
    '{"id":"mid","rating":1500}\n' +
    '{"id":"hi","rating":2000}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ source: 'test' }));

  const out = path.join(tmpRoot, 'out-combined');
  const stats = F.runFilter({
    sourceDir: src,
    outDir: out,
    ratingFloor: 1000,
    addPuzzlePly: true,
    dryRun: false,
  });

  check('entriesKept = 2 (low dropped)', stats.entriesKept === 2);
  check('entriesDropped = 1', stats.entriesDropped === 1);
  check('entriesUpgradedToLength5 = 2 (mid + hi only — low was dropped first)',
    stats.entriesUpgradedToLength5 === 2);
  check('bodiesKept = 2', stats.bodiesKept === 2);

  const out0 = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  check('mid upgraded with m[4]=5', out0['k1'][0][0] === 'mid' && out0['k1'][0][4] === 5);
  check('hi upgraded with m[4]=7', out0['k2'][0][0] === 'hi' && out0['k2'][0][4] === 7);
}

// ─── runFilter: --addPuzzlePly preserves canonical m[4] from length-5 ───
section('runFilter: length-5 input passes through (idempotent stamping)');
{
  // Input is already length-5 (e.g. from a fresh build-index.js run).
  // Stamping is a no-op on these entries — the entry's own m[4] is
  // canonical. entriesUpgradedToLength5 should be 0 because nothing
  // needed upgrading.
  const src = path.join(tmpRoot, 'src-len5');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 3, 22]],   // already length-5
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ source: 'test' }));

  const out = path.join(tmpRoot, 'out-len5');
  const stats = F.runFilter({
    sourceDir: src,
    outDir: out,
    addPuzzlePly: true,
    dryRun: false,
  });

  check('entriesUpgradedToLength5 = 0 (already length-5)',
    stats.entriesUpgradedToLength5 === 0);
  check('entriesKept = 1', stats.entriesKept === 1);

  const out0 = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  check('m[4] = 22 (canonical, unchanged)', out0['k1'][0][4] === 22);
  check('entry length = 5 (no padding)', out0['k1'][0].length === 5);
}

// ─── runFilter: --addPuzzlePly works on mixed length-3/4/5 input ────────
section('runFilter: mixed length-3 + length-4 + length-5 input');
{
  const src = path.join(tmpRoot, 'src-mixed');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [
      ['legacy3',  1500, 'w'],            // length-3 → no upgrade (no m[3])
      ['legacy4',  1700, 'b', 5],         // length-4 → upgrade to length-5
      ['current5', 1800, 'w', 3, 22],     // length-5 → no upgrade
    ],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"legacy3","rating":1500}\n' +
    '{"id":"legacy4","rating":1700}\n' +
    '{"id":"current5","rating":1800}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ source: 'test' }));

  const out = path.join(tmpRoot, 'out-mixed');
  const stats = F.runFilter({
    sourceDir: src,
    outDir: out,
    addPuzzlePly: true,
    dryRun: false,
  });

  check('entriesUpgradedToLength5 = 1 (only legacy4)',
    stats.entriesUpgradedToLength5 === 1, 'got ' + stats.entriesUpgradedToLength5);

  const out0 = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  const arr = out0['k1'];
  check('legacy3 stays length 3', arr[0].length === 3);
  check('legacy4 upgraded to length 5', arr[1].length === 5);
  check('legacy4 m[4] = 5 (= its own m[3], the only data we have)',
    arr[1][4] === 5, 'got ' + arr[1][4]);
  check('current5 stays length 5', arr[2].length === 5);
  check('current5 m[4] = 22 (preserved canonical)', arr[2][4] === 22);
}

// ─── runFilter: source==out guard ───────────────────────────────────────
section('runFilter: refuses when sourceDir === outDir');
{
  const dir = path.join(tmpRoot, 'src-same-as-out');
  fs.mkdirSync(path.join(dir, 'index'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index', '000.json'), JSON.stringify({
    'k': [['p', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(dir, 'puzzles', '000.ndjson'), '{"id":"p","rating":1500}\n');

  let threw = false;
  try {
    F.runFilter({
      sourceDir: dir,
      outDir: dir,        // same — must throw before wiping
      addPuzzlePly: true,
      dryRun: false,
    });
  } catch (e) {
    threw = e.message.includes('same path') || e.message.includes('refusing to wipe');
  }
  check('throws when source === out', threw);
  // Verify the source dir is intact (the throw happened before any wipe).
  check('source index file still readable',
    fs.existsSync(path.join(dir, 'index', '000.json')));
  check('source body file still readable',
    fs.existsSync(path.join(dir, 'puzzles', '000.ndjson')));
}

// ─── runFilter: source==out guard catches symlinked outDir → source ─────
section('runFilter: refuses when outDir is a symlink to sourceDir');
{
  // Defensive: the user might create a symlink at outDir pointing to source
  // (or vice versa). path.resolve() doesn't dereference symlinks, but
  // fs.rmSync({recursive:true}) on a directory symlink WOULD wipe the
  // target. The guard realpath's both paths so this case is caught.
  const realSrc = path.join(tmpRoot, 'src-symlink-target');
  fs.mkdirSync(path.join(realSrc, 'index'), { recursive: true });
  fs.mkdirSync(path.join(realSrc, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(realSrc, 'index', '000.json'), JSON.stringify({
    'k': [['p', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(realSrc, 'puzzles', '000.ndjson'),
    '{"id":"p","rating":1500}\n');

  const symlinkedOut = path.join(tmpRoot, 'src-symlink-out');
  let symlinkOk = false;
  try {
    fs.symlinkSync(realSrc, symlinkedOut, 'dir');
    symlinkOk = true;
  } catch (e) {
    // Some platforms / CI environments don't allow symlinks (e.g. Windows
    // without admin rights). Skip silently.
  }

  if (symlinkOk) {
    let threw = false;
    try {
      F.runFilter({
        sourceDir: realSrc,
        outDir: symlinkedOut,    // symlink resolving to source
        addPuzzlePly: true,
        dryRun: false,
      });
    } catch (e) {
      threw = e.message.includes('same path') || e.message.includes('refusing to wipe');
    }
    check('throws when outDir symlinks to sourceDir', threw);
    check('source files still intact after symlink-out attempt',
      fs.existsSync(path.join(realSrc, 'index', '000.json')) &&
      fs.existsSync(path.join(realSrc, 'puzzles', '000.ndjson')));
  } else {
    check('symlink test skipped (platform doesn\'t support symlinks)', true);
  }
}

// ─── runFilter: dry-run with --addPuzzlePly ─────────────────────────────
section('runFilter: --addPuzzlePly + --dryRun reports stats without writes');
{
  const src = path.join(tmpRoot, 'src-dry');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');

  const out = path.join(tmpRoot, 'out-dry');
  const stats = F.runFilter({
    sourceDir: src,
    outDir: out,
    addPuzzlePly: true,
    dryRun: true,
  });

  check('entriesUpgradedToLength5 = 1 (counted)', stats.entriesUpgradedToLength5 === 1);
  check('out dir not created', !fs.existsSync(out));
}

// ─── CLI: --add-puzzle-ply alone bypasses the no-filter-active check ────
section('CLI: --add-puzzle-ply alone runs successfully');
{
  const src = path.join(tmpRoot, 'src-cli');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 7]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ source: 'test' }));

  const out = path.join(tmpRoot, 'out-cli');
  const script = path.join(__dirname, 'filter-data.js');
  let stdout = '', exitCode = 0;
  try {
    stdout = execFileSync('node', [
      script,
      '--source-dir', src,
      '--out-dir', out,
      '--add-puzzle-ply',
    ], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status || 1;
    stdout = (e.stdout || '') + (e.stderr || '');
  }
  check('CLI exits 0', exitCode === 0, 'output: ' + stdout.slice(0, 200));
  check('output mentions stamping', stdout.includes('add puzzle-start ply'));
  // Verify output dir got created and entry was upgraded
  if (fs.existsSync(path.join(out, 'index', '000.json'))) {
    const obj = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
    check('CLI run produced length-5 output entry',
      obj['k1'] && obj['k1'][0].length === 5);
    check('CLI output entry m[4] = 7', obj['k1'][0][4] === 7);
  } else {
    check('output dir created', false, 'out dir missing');
  }
}

// ─── CLI: no filter and no --add-puzzle-ply still rejects ──────────────
section('CLI: no filter and no --add-puzzle-ply rejects with exit 1');
{
  const src = path.join(tmpRoot, 'src-cli-empty');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), '{}');
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'), '');

  const out = path.join(tmpRoot, 'out-cli-empty');
  const script = path.join(__dirname, 'filter-data.js');
  let exitCode = 0, stderr = '';
  try {
    execFileSync('node', [
      script,
      '--source-dir', src,
      '--out-dir', out,
    ], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status || 1;
    stderr = e.stderr || '';
  }
  check('CLI exits non-zero with no filters and no operations',
    exitCode === 1, 'exit ' + exitCode);
  check('error mentions filter or operation',
    stderr.includes('filter') && stderr.includes('operation'));
}

// ─── runFilter: refuses --add-puzzle-ply when source is emission-capped ──
section('runFilter: refuses --addPuzzlePly when source meta shows maxEmissionPly');
{
  // Reproduces the bug where --add-puzzle-ply was run on data-filtered/
  // (which had been emission-capped). The pre-pass walks survivor entries
  // and computes max(m[3]) clamped to the cap — producing wrong m[4]
  // values. The safety check reads source meta.json's filterStats and
  // refuses to run when the input is partial-puzzle.
  const src = path.join(tmpRoot, 'src-emission-capped');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  // This is what filter-data.js writes after a --max-emission-ply run.
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({
    source: 'test',
    filterStats: {
      maxEmissionPly: 22,
      ratingFloor: 1000,
    },
  }));

  const out = path.join(tmpRoot, 'out-emission-capped');
  let threw = false, msg = '';
  try {
    F.runFilter({
      sourceDir: src,
      outDir: out,
      addPuzzlePly: true,
      dryRun: false,
    });
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  check('throws when source meta has maxEmissionPly set', threw);
  check('error explains: emission-capped',
    msg.includes('emission-capped') && msg.includes('maxEmissionPly=22'));
  check('error includes correct salvage recipe',
    msg.includes('--source-dir ./data') && msg.includes('--add-puzzle-ply'));
}

section('runFilter: refuses --addPuzzlePly when source meta shows whitelistSize');
{
  // Whitelist also drops entries per puzzle (positions outside the whitelist
  // disappear), leaving partial puzzles. max(m[3]) over surviving entries
  // can underestimate when the puzzle's deepest position isn't in the
  // whitelist. Same correctness issue as emission-capping.
  const src = path.join(tmpRoot, 'src-whitelisted');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({
    source: 'test',
    filterStats: { whitelistSize: 100 },
  }));

  const out = path.join(tmpRoot, 'out-whitelisted');
  let threw = false, msg = '';
  try {
    F.runFilter({
      sourceDir: src,
      outDir: out,
      addPuzzlePly: true,
      dryRun: false,
    });
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  check('throws when source meta has whitelistSize > 0', threw);
  check('error explains: whitelist-filtered',
    msg.includes('whitelist-filtered') && msg.includes('whitelistSize=100'));
}

section('runFilter: --addPuzzlePly OK when source is rating-floor-only filtered');
{
  // ratingFloor drops puzzles WHOLESALE (all entries of a sub-floor puzzle
  // drop together — rating is per-puzzle). Surviving puzzles retain ALL
  // their entries, so max(m[3]) is unaffected. Backfill is safe.
  const src = path.join(tmpRoot, 'src-rating-only');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({
    source: 'test',
    filterStats: {
      ratingFloor: 1000,
      maxEmissionPly: null,    // explicitly null — not capped
      whitelistSize: null,
    },
  }));

  const out = path.join(tmpRoot, 'out-rating-only');
  let threw = false;
  try {
    F.runFilter({
      sourceDir: src,
      outDir: out,
      addPuzzlePly: true,
      dryRun: false,
    });
  } catch (e) {
    threw = true;
  }
  check('does NOT throw when only rating-floor was applied to source',
    !threw);
  check('produced upgraded length-5 output',
    fs.existsSync(path.join(out, 'index', '000.json')) &&
    JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'))['k1'][0].length === 5);
}

section('runFilter: --addPuzzlePly OK when source is max-puzzle-ply-only filtered');
{
  // maxPuzzlePly also drops puzzles wholesale (whole id removed when
  // start ply > cap). Surviving puzzles retain ALL their entries, so
  // max(m[3]) is unaffected. Backfill is safe.
  const src = path.join(tmpRoot, 'src-puzzle-ply-only');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({
    source: 'test',
    filterStats: { maxPuzzlePly: 80 },
  }));

  const out = path.join(tmpRoot, 'out-puzzle-ply-only');
  let threw = false;
  try {
    F.runFilter({
      sourceDir: src,
      outDir: out,
      addPuzzlePly: true,
      dryRun: false,
    });
  } catch (e) {
    threw = true;
  }
  check('does NOT throw when only max-puzzle-ply was applied to source',
    !threw);
}

section('runFilter: safety check skipped when meta.json absent');
{
  // No meta.json means we can't tell if the source is filtered — the
  // safety check is best-effort. Fall back to running. This preserves
  // back-compat for synthetic test fixtures and any hand-built sources
  // without meta.
  const src = path.join(tmpRoot, 'src-no-meta');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 5]],
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  // NO meta.json deliberately

  const out = path.join(tmpRoot, 'out-no-meta');
  let threw = false;
  try {
    F.runFilter({
      sourceDir: src,
      outDir: out,
      addPuzzlePly: true,
      dryRun: false,
    });
  } catch (e) {
    threw = true;
  }
  check('does NOT throw when source has no meta.json', !threw);
}

section('runFilter: combined unsafe filter+stamp single-pass IS allowed');
{
  // Anders's salvage path: run filter-data.js with --max-emission-ply
  // AND --add-puzzle-ply in one call against UNFILTERED source. The
  // pre-pass walks the unfiltered source (full emissions visible),
  // computes correct max(m[3]) per puzzle, then the filter writes the
  // capped output with the canonical m[4] stamped. Single-pass is the
  // ONLY correct way to combine these — the safety check must not
  // refuse it.
  const src = path.join(tmpRoot, 'src-salvage');
  fs.mkdirSync(path.join(src, 'index'), { recursive: true });
  fs.mkdirSync(path.join(src, 'puzzles'), { recursive: true });
  // Unfiltered source: NO filterStats in meta. Has entries at deep plies.
  fs.writeFileSync(path.join(src, 'index', '000.json'), JSON.stringify({
    'k1': [['p1', 1500, 'w', 5]],   // emission ply 5
    'k2': [['p1', 1500, 'b', 30]],  // emission ply 30 — the puzzle's start
  }));
  fs.writeFileSync(path.join(src, 'puzzles', '000.ndjson'),
    '{"id":"p1","rating":1500}\n');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({
    source: 'unfiltered build',
  }));

  const out = path.join(tmpRoot, 'out-salvage');
  const stats = F.runFilter({
    sourceDir: src,
    outDir: out,
    maxEmissionPly: 22,
    addPuzzlePly: true,
    dryRun: false,
  });

  check('filter+stamp succeeded', stats.entriesUpgradedToLength5 === 1);
  const outIdx = JSON.parse(fs.readFileSync(path.join(out, 'index', '000.json'), 'utf8'));
  // k2 (emission 30) was dropped by emission-cap; k1 (emission 5) survives
  // and gets m[4]=30 stamped — the CORRECT puzzle start ply, derived from
  // the unfiltered source before filtering.
  check('survivor at k1 stamped with correct m[4]=30 (NOT clamped to cap)',
    outIdx['k1'] && outIdx['k1'][0][4] === 30,
    'got ' + (outIdx['k1'] && outIdx['k1'][0][4]));
  check('emission-capped entry at k2 dropped',
    !outIdx['k2']);
}

// ─── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

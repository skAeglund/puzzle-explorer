#!/usr/bin/env node
/**
 * filter-data-test.js — Tests for analyzer/filter-data.js.
 *
 * Coverage:
 *   - filterIndexShard: keeps whitelisted posKeys, drops non-whitelisted,
 *     collects referenced puzzleIds, handles empty input
 *   - filterBodyShard: id-based filtering via fast string scan, handles
 *     malformed lines, empty input, mixed kept/dropped
 *   - runFilter: end-to-end with a real built fixture; verifies kept
 *     index/body/meta files; verifies the original source dir is untouched
 *   - --dry-run: stats without writes
 *   - re-run idempotency: filtering twice produces the same output
 *
 * Run: node analyzer/filter-data-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fenPositionKey } = require('../lib/posKey');
const F = require('./filter-data');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-data-test-'));

// ─── filterIndexShard ────────────────────────────────────────────────────
section('filterIndexShard');
{
  const shard = {
    'pos-A': [['p1', 1500, 'w'], ['p2', 1700, 'b']],
    'pos-B': [['p3', 1200, 'w']],
    'pos-C': [['p4', 1900, 'b'], ['p5', 1100, 'w']],
  };
  const wl = new Set(['pos-A', 'pos-C']);
  const r = F.filterIndexShard(shard, wl);
  check('positionsKept === 2', r.positionsKept === 2);
  check('positionsDropped === 1', r.positionsDropped === 1);
  check('kept has pos-A', 'pos-A' in r.kept);
  check('kept has pos-C', 'pos-C' in r.kept);
  check('kept does NOT have pos-B', !('pos-B' in r.kept));
  check('kept entries unchanged for pos-A',
    Array.isArray(r.kept['pos-A']) && r.kept['pos-A'].length === 2);
  check('referencedPuzzleIds: 4 puzzles (p1, p2, p4, p5)',
    r.referencedPuzzleIds.size === 4 &&
    r.referencedPuzzleIds.has('p1') && r.referencedPuzzleIds.has('p2') &&
    r.referencedPuzzleIds.has('p4') && r.referencedPuzzleIds.has('p5'));
  check('referencedPuzzleIds: p3 NOT referenced (in dropped pos-B)',
    !r.referencedPuzzleIds.has('p3'));

  // Empty whitelist → drops everything
  const empty = F.filterIndexShard(shard, new Set());
  check('empty whitelist: nothing kept', empty.positionsKept === 0);
  check('empty whitelist: 0 referenced ids', empty.referencedPuzzleIds.size === 0);

  // Empty shard
  const noShard = F.filterIndexShard({}, wl);
  check('empty shard: 0 kept, 0 dropped',
    noShard.positionsKept === 0 && noShard.positionsDropped === 0);
}

// ─── filterBodyShard ─────────────────────────────────────────────────────
section('filterBodyShard');
{
  const ndjson =
    '{"id":"a","fen":"X"}\n' +
    '{"id":"b","fen":"Y"}\n' +
    '{"id":"c","fen":"Z"}\n';
  const r = F.filterBodyShard(ndjson, new Set(['a', 'c']));
  check('keeps 2 bodies', r.bodiesKept === 2);
  check('drops 1 body', r.bodiesDropped === 1);
  check('output preserves \\n terminators',
    r.text === '{"id":"a","fen":"X"}\n{"id":"c","fen":"Z"}\n');

  // Empty keepIds → drops all
  const all = F.filterBodyShard(ndjson, new Set());
  check('empty keepIds: 3 dropped', all.bodiesDropped === 3 && all.bodiesKept === 0);
  check('empty keepIds: empty output', all.text === '');

  // Malformed line (no id field): dropped, not crash
  const bad = '{"no_id":"x"}\n{"id":"keep"}\n';
  const r2 = F.filterBodyShard(bad, new Set(['keep']));
  check('malformed line treated as drop',
    r2.bodiesKept === 1 && r2.bodiesDropped === 1);
  check('malformed line: id="keep" survives',
    r2.text === '{"id":"keep"}\n');

  // No trailing newline
  const noTrail = '{"id":"a"}\n{"id":"b"}';
  const r3 = F.filterBodyShard(noTrail, new Set(['a', 'b']));
  check('handles missing trailing newline', r3.bodiesKept === 2);

  // Empty input
  const empty = F.filterBodyShard('', new Set(['a']));
  check('empty input: 0 kept, 0 dropped',
    empty.bodiesKept === 0 && empty.bodiesDropped === 0);
}

// ─── end-to-end via runFilter ───────────────────────────────────────────
section('runFilter end-to-end');
{
  // Build a tiny dataset via build-index, then filter it.
  const inputDir = path.join(tmpRoot, 'e2e');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  // Two puzzles, distinct starting positions.
  fs.writeFileSync(inputPgn, [
    [
      '[Event "P1-test"]', '[Result "*"]',
      '[PuzzleId "P1"]', '[PuzzleRating "1500"]', '[PuzzleThemes "fork"]',
      '[Annotator "e5"]', '[Site "https://lichess.org/aaaaaaaa#1"]', '[Opening ""]',
      '', '1. e4 *', '',
    ].join('\n'),
    [
      '[Event "P2-test"]', '[Result "*"]',
      '[PuzzleId "P2"]', '[PuzzleRating "1700"]', '[PuzzleThemes "pin"]',
      '[Annotator "d5"]', '[Site "https://lichess.org/bbbbbbbb#1"]', '[Opening ""]',
      '', '1. Nf3 *', '',
    ].join('\n'),
  ].join('\n'));

  const dataDir = path.join(inputDir, 'data');
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, inputPgn, dataDir], { stdio: 'pipe' });

  // Whitelist: only after-1.e4
  const wl = new Set([
    fenPositionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'),
  ]);
  const outDir = path.join(inputDir, 'data-filtered');
  const stats = F.runFilter({
    sourceDir: dataDir, outDir, whitelistSet: wl, dryRun: false,
  });
  check('e2e: 1 position kept', stats.positionsKept === 1);
  check('e2e: 1 position dropped', stats.positionsDropped === 1);
  check('e2e: 1 puzzle referenced (P1)',
    stats.puzzlesReferenced === 1);
  check('e2e: 1 body kept', stats.bodiesKept === 1);
  check('e2e: 1 body dropped', stats.bodiesDropped === 1);
  check('e2e: meta filterStats populated',
    stats.meta && stats.meta.filterStats &&
    stats.meta.filterStats.positionsKept === 1);

  // Verify on disk
  const indexFiles = fs.readdirSync(path.join(outDir, 'index'));
  check('e2e: only 1 index shard written',
    indexFiles.length === 1 && indexFiles[0].endsWith('.json'));
  const indexContent = JSON.parse(fs.readFileSync(path.join(outDir, 'index', indexFiles[0]), 'utf8'));
  check('e2e: kept shard has 1 posKey',
    Object.keys(indexContent).length === 1);
  check('e2e: kept entry refers to P1',
    Object.values(indexContent)[0][0][0] === 'P1');

  const bodyFiles = fs.readdirSync(path.join(outDir, 'puzzles'));
  check('e2e: only 1 body shard written',
    bodyFiles.length === 1 && bodyFiles[0].endsWith('.ndjson'));
  const bodyContent = fs.readFileSync(path.join(outDir, 'puzzles', bodyFiles[0]), 'utf8');
  check('e2e: body shard contains only P1',
    bodyContent.includes('"id":"P1"') && !bodyContent.includes('"id":"P2"'));

  check('e2e: meta.json copied',
    fs.existsSync(path.join(outDir, 'meta.json')));

  // Cache invalidation contract — see lib/cache.js. Frontend's IDB shard
  // cache wipes itself when meta.builtAt changes. filter-data.js MUST bump
  // builtAt (to filteredAt) on every filter pass so existing users get
  // fresh shards after a republish. The original build-index.js timestamp
  // is preserved separately as buildIndexBuiltAt for any future caller
  // that wants the underlying-PGN-walk timestamp.
  const filteredMeta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  check('e2e: meta.builtAt was bumped to filteredAt (cache invalidation)',
    typeof filteredMeta.builtAt === 'string' &&
    filteredMeta.builtAt === filteredMeta.filteredAt,
    'builtAt=' + filteredMeta.builtAt + ' filteredAt=' + filteredMeta.filteredAt);
  check('e2e: original builtAt preserved as buildIndexBuiltAt',
    typeof filteredMeta.buildIndexBuiltAt === 'string' &&
    filteredMeta.buildIndexBuiltAt !== filteredMeta.builtAt);

  // Source dir preserved (READ-ONLY contract)
  check('source: index dir untouched, both shards still present',
    fs.readdirSync(path.join(dataDir, 'index')).length === 2);
  check('source: bodies dir untouched',
    fs.readdirSync(path.join(dataDir, 'puzzles')).length === 2);
}

// ─── dry-run leaves no writes ────────────────────────────────────────────
section('runFilter — dry-run');
{
  const inputDir = path.join(tmpRoot, 'dry');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  fs.writeFileSync(inputPgn,
    '[Event "x"]\n[Result "*"]\n[PuzzleId "X1"]\n[PuzzleRating "1000"]\n' +
    '[PuzzleThemes ""]\n[Annotator "e5"]\n' +
    '[Site "https://lichess.org/cccccccc#1"]\n[Opening ""]\n\n1. e4 *\n');
  const dataDir = path.join(inputDir, 'data');
  const buildScript = path.join(__dirname, 'build-index.js');
  execFileSync('node', [buildScript, inputPgn, dataDir], { stdio: 'pipe' });

  const wl = new Set([fenPositionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')]);
  const outDir = path.join(inputDir, 'data-filtered');
  const stats = F.runFilter({
    sourceDir: dataDir, outDir, whitelistSet: wl, dryRun: true,
  });
  check('dry-run: stats reported',
    stats.positionsKept === 1 && stats.bodiesKept === 1);
  check('dry-run: out dir not created',
    !fs.existsSync(outDir));
}

// ─── idempotency: re-run produces same output ───────────────────────────
section('runFilter — idempotency');
{
  const inputDir = path.join(tmpRoot, 'idem');
  fs.mkdirSync(inputDir, { recursive: true });
  const inputPgn = path.join(inputDir, 'input.pgn');
  fs.writeFileSync(inputPgn,
    '[Event "x"]\n[Result "*"]\n[PuzzleId "X1"]\n[PuzzleRating "1000"]\n' +
    '[PuzzleThemes ""]\n[Annotator "e5"]\n' +
    '[Site "https://lichess.org/dddddddd#1"]\n[Opening ""]\n\n1. e4 *\n');
  const dataDir = path.join(inputDir, 'data');
  execFileSync('node', [path.join(__dirname, 'build-index.js'), inputPgn, dataDir], { stdio: 'pipe' });

  const wl = new Set([fenPositionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')]);
  const outDir = path.join(inputDir, 'data-filtered');

  F.runFilter({ sourceDir: dataDir, outDir, whitelistSet: wl, dryRun: false });
  const indexHash1 = fs.readFileSync(path.join(outDir, 'index', fs.readdirSync(path.join(outDir, 'index'))[0]), 'utf8');
  const bodyHash1 = fs.readFileSync(path.join(outDir, 'puzzles', fs.readdirSync(path.join(outDir, 'puzzles'))[0]), 'utf8');

  // Run again — outDir should be wiped and rewritten
  F.runFilter({ sourceDir: dataDir, outDir, whitelistSet: wl, dryRun: false });
  const indexHash2 = fs.readFileSync(path.join(outDir, 'index', fs.readdirSync(path.join(outDir, 'index'))[0]), 'utf8');
  const bodyHash2 = fs.readFileSync(path.join(outDir, 'puzzles', fs.readdirSync(path.join(outDir, 'puzzles'))[0]), 'utf8');

  check('re-run: index byte-identical', indexHash1 === indexHash2);
  check('re-run: body byte-identical', bodyHash1 === bodyHash2);
}

// ─── source-dir validation ──────────────────────────────────────────────
section('runFilter — error handling');
{
  let threw = false;
  try {
    F.runFilter({
      sourceDir: '/nonexistent/path',
      outDir: path.join(tmpRoot, 'unused'),
      whitelistSet: new Set(['x']),
      dryRun: true,
    });
  } catch (e) { threw = true; }
  check('missing source dir: throws', threw);
}

// ─── cleanup ─────────────────────────────────────────────────────────────
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

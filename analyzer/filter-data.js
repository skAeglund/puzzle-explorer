#!/usr/bin/env node
/**
 * filter-data.js — Filter a built data directory through a position whitelist.
 *
 * Reads <source-dir> (default ./data/) and writes a filtered copy to
 * <out-dir> (default ./data-filtered/). The filter:
 *
 *   1. Walks index/<NNN>.json shards. Keeps only posKey buckets whose key
 *      is in the whitelist. Tracks the puzzleIds referenced by kept buckets.
 *   2. Walks puzzles/<NNN>.ndjson shards. Keeps only body lines whose id
 *      is in the kept-puzzleIds set.
 *   3. Copies meta.json with extra fields recording the filter:
 *        filteredFrom: <source-dir absolute path>
 *        filteredAt:   <ISO timestamp>
 *        filterStats:  { whitelistSize, indexShardsKept, indexShardsDropped,
 *                        positionsKept, positionsDropped, puzzlesReferenced,
 *                        bodyShardsKept, bodyShardsDropped, bodiesKept }
 *
 * The local source directory is NEVER modified — read-only walk. Re-running
 * the filter with a different whitelist just rewrites the output dir from
 * scratch. Repertoire change is decoupled from the build entirely: build
 * the full 5M+ once locally, filter+publish many times as your repertoire
 * evolves.
 *
 * Usage:
 *   node analyzer/filter-data.js <whitelist.txt>
 *     [--source-dir DIR]   default ./data
 *     [--out-dir DIR]      default ./data-filtered
 *     [--dry-run]          report stats without writing
 *
 * Exits non-zero if the whitelist is empty or unreadable, or if the source
 * dir is missing structure (we're paranoid — no point producing an empty
 * output silently).
 */

const fs = require('fs');
const path = require('path');
const { fenPositionKey } = require('../lib/posKey');
const RepertoireFilter = require('../lib/repertoireFilter');

// ─── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const pos = [];
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

// ─── pure: filter index shard JSON ───────────────────────────────────────
// Input: parsed shard object {posKey: [entry, ...]}.
// Output: { kept: {posKey: [entry...]}, droppedKeys, referencedPuzzleIds }.
//
// Each entry is [puzzleId, rating, color?, ply?, ...]. We collect puzzleId
// from every kept entry into the referenced set, which is then used to
// filter body shards.
function filterIndexShard(shardObj, whitelistSet) {
  const kept = Object.create(null);
  const referencedIds = new Set();
  let positionsKept = 0;
  let positionsDropped = 0;
  for (const posKey of Object.keys(shardObj)) {
    if (whitelistSet.has(posKey)) {
      const entries = shardObj[posKey];
      kept[posKey] = entries;
      positionsKept++;
      for (let i = 0; i < entries.length; i++) {
        // entries[i][0] is the puzzleId — first element of the tuple
        referencedIds.add(entries[i][0]);
      }
    } else {
      positionsDropped++;
    }
  }
  return {
    kept: kept,
    referencedPuzzleIds: referencedIds,
    positionsKept: positionsKept,
    positionsDropped: positionsDropped,
  };
}

// ─── pure: filter body shard ndjson ──────────────────────────────────────
// Input: full ndjson text + Set of puzzle ids to keep.
// Output: { text, bodiesKept, bodiesDropped }.
//
// Stream-parses line-by-line via string scan rather than split() — body
// shards can be megabytes at full scale, and split() allocates a giant
// array we'd discard immediately.
function filterBodyShard(ndjsonText, keepIds) {
  let out = '';
  let kept = 0;
  let dropped = 0;
  let lineStart = 0;
  while (lineStart < ndjsonText.length) {
    const lineEnd = ndjsonText.indexOf('\n', lineStart);
    const line = lineEnd === -1
      ? ndjsonText.slice(lineStart)
      : ndjsonText.slice(lineStart, lineEnd);
    if (line.length > 0) {
      // Fast-path id extraction without JSON.parse — body lines start with
      // {"id":"...". Avoids parsing the rest of the body.
      const idStart = line.indexOf('"id":"');
      if (idStart === -1) {
        // Malformed line — skip but log nothing (caller already wrote the
        // file at build time, garbage is not expected).
        dropped++;
      } else {
        const valStart = idStart + 6;
        const valEnd = line.indexOf('"', valStart);
        const id = valEnd === -1 ? null : line.slice(valStart, valEnd);
        if (id && keepIds.has(id)) {
          out += line + '\n';
          kept++;
        } else {
          dropped++;
        }
      }
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return { text: out, bodiesKept: kept, bodiesDropped: dropped };
}

// ─── orchestrator (exposed for testing) ──────────────────────────────────
// Pure-ish: reads from `sourceDir`, writes to `outDir`. Passing dryRun=true
// suppresses all writes. Returns a stats object.
function runFilter(opts) {
  const { sourceDir, outDir, whitelistSet, dryRun } = opts;
  const indexInDir = path.join(sourceDir, 'index');
  const puzzlesInDir = path.join(sourceDir, 'puzzles');
  const metaIn = path.join(sourceDir, 'meta.json');

  if (!fs.existsSync(indexInDir) || !fs.existsSync(puzzlesInDir)) {
    throw new Error(`source dir missing index/ or puzzles/: ${sourceDir}`);
  }

  // Output dir setup — wipe and recreate for repeatability. Skipped on
  // dry-run.
  if (!dryRun) {
    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true });
    }
    fs.mkdirSync(path.join(outDir, 'index'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'puzzles'), { recursive: true });
  }

  // ─── Pass 1: filter index ───
  const indexFiles = fs.readdirSync(indexInDir).filter(f => f.endsWith('.json'));
  let positionsKept = 0;
  let positionsDropped = 0;
  let indexShardsKept = 0;
  let indexShardsDropped = 0;
  // Union of ids referenced by ALL kept positions across ALL shards.
  // At full scale this set could hold ~5M strings — Set scales fine.
  const referencedIds = new Set();
  for (const f of indexFiles) {
    const text = fs.readFileSync(path.join(indexInDir, f), 'utf8');
    const obj = JSON.parse(text);
    const r = filterIndexShard(obj, whitelistSet);
    positionsKept += r.positionsKept;
    positionsDropped += r.positionsDropped;
    for (const id of r.referencedPuzzleIds) referencedIds.add(id);
    if (r.positionsKept > 0) {
      indexShardsKept++;
      if (!dryRun) {
        fs.writeFileSync(path.join(outDir, 'index', f), JSON.stringify(r.kept));
      }
    } else {
      indexShardsDropped++;
    }
  }

  // ─── Pass 2: filter bodies ───
  const bodyFiles = fs.readdirSync(puzzlesInDir).filter(f => f.endsWith('.ndjson'));
  let bodiesKept = 0;
  let bodiesDropped = 0;
  let bodyShardsKept = 0;
  let bodyShardsDropped = 0;
  for (const f of bodyFiles) {
    const text = fs.readFileSync(path.join(puzzlesInDir, f), 'utf8');
    const r = filterBodyShard(text, referencedIds);
    bodiesKept += r.bodiesKept;
    bodiesDropped += r.bodiesDropped;
    if (r.bodiesKept > 0) {
      bodyShardsKept++;
      if (!dryRun) {
        fs.writeFileSync(path.join(outDir, 'puzzles', f), r.text);
      }
    } else {
      bodyShardsDropped++;
    }
  }

  // ─── meta.json passthrough with filter annotations ───
  let metaOut = null;
  if (fs.existsSync(metaIn)) {
    const meta = JSON.parse(fs.readFileSync(metaIn, 'utf8'));
    meta.filteredFrom = path.resolve(sourceDir);
    meta.filteredAt = new Date().toISOString();
    meta.filterStats = {
      whitelistSize: whitelistSet.size,
      indexShardsKept,
      indexShardsDropped,
      positionsKept,
      positionsDropped,
      puzzlesReferenced: referencedIds.size,
      bodyShardsKept,
      bodyShardsDropped,
      bodiesKept,
      bodiesDropped,
    };
    metaOut = meta;
    if (!dryRun) {
      fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
    }
  }

  return {
    whitelistSize: whitelistSet.size,
    indexShardsKept, indexShardsDropped,
    positionsKept, positionsDropped,
    puzzlesReferenced: referencedIds.size,
    bodyShardsKept, bodyShardsDropped,
    bodiesKept, bodiesDropped,
    meta: metaOut,
  };
}

// ─── main ────────────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const WHITELIST = pos[0];
  if (!WHITELIST) {
    console.error('usage: node filter-data.js <whitelist.txt> [--source-dir DIR] [--out-dir DIR] [--dry-run]');
    process.exit(1);
  }
  const SOURCE = path.resolve(flags['source-dir'] || './data');
  const OUT = path.resolve(flags['out-dir'] || './data-filtered');
  const DRY = !!flags['dry-run'];

  const w = RepertoireFilter.loadFromFile(WHITELIST);
  if (w.count === 0) {
    console.error('whitelist contains zero valid positions; refusing to run.');
    process.exit(1);
  }

  console.log(`whitelist: ${w.count} positions from ${WHITELIST}`);
  if (w.errors.length > 0) console.warn(`  ${w.errors.length} parse errors in whitelist (ignored)`);
  if (w.dropped.length > 0) console.log(`  ${w.dropped.length} duplicate posKeys deduped`);
  console.log(`source:    ${SOURCE}`);
  console.log(`out:       ${OUT}${DRY ? '  (DRY RUN — no writes)' : ''}`);

  const stats = runFilter({
    sourceDir: SOURCE,
    outDir: OUT,
    whitelistSet: w.set,
    dryRun: DRY,
  });

  const dt = Date.now() - t0;
  console.log('\n─── filter complete ───');
  console.log(JSON.stringify({ ...stats, meta: undefined, durationMs: dt }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  filterIndexShard,
  filterBodyShard,
  runFilter,
};

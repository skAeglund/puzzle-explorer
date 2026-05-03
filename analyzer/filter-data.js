#!/usr/bin/env node
/**
 * filter-data.js — Filter a built data directory by position whitelist and/or
 * threshold filters (rating floor, emission ply cap, puzzle-start ply cap).
 *
 * Reads <source-dir> (default ./data/) and writes a filtered copy to
 * <out-dir> (default ./data-filtered/). The local source directory is
 * NEVER modified — read-only walk. Re-running the filter with different
 * thresholds rewrites the output dir from scratch.
 *
 * Filters compose as logical AND. An entry survives only if every active
 * filter accepts it.
 *
 *   1. Position whitelist (positional arg, optional):
 *        Keep posKey buckets whose key is in the whitelist file.
 *
 *   2. --rating-floor N:
 *        Drop index entries where rating < N. Drop bodies where rating < N.
 *
 *   3. --max-emission-ply N:
 *        Drop index entries where ply > N. Bodies kept iff some entry of
 *        theirs survives — i.e. iff puzzle's earliest occurrence is ≤ N.
 *        For a puzzle whose source-game runs to ply 100, capping at 24
 *        means it's still drillable from its starting position, just not
 *        findable by searching at deep mainline positions.
 *
 *   4. --max-puzzle-ply N:
 *        Drop the WHOLE puzzle (body + all index entries) if its starting
 *        position is past ply N. Starting ply is derived as the max ply
 *        across all index entries for that puzzleId — requires a pre-pass
 *        over the index, additive ~5min on a multi-GB build.
 *
 * Filters can be combined freely. Common recipes:
 *   - Repertoire-only:        node filter-data.js whitelist.txt
 *   - Size shrink:            node filter-data.js --rating-floor 1000 --max-emission-ply 24
 *   - Repertoire + shrink:    node filter-data.js whitelist.txt --rating-floor 1000
 *   - Drop deep middlegame:   node filter-data.js --max-puzzle-ply 50
 *
 * Each filtered run also annotates meta.json with `filterStats` recording
 * what was dropped and why, so the output is self-documenting.
 *
 * Usage:
 *   node analyzer/filter-data.js [whitelist.txt]
 *     [--source-dir DIR]         default ./data
 *     [--out-dir DIR]            default ./data-filtered
 *     [--rating-floor N]         drop entries (and bodies) below this rating
 *     [--max-emission-ply N]     drop entries past this ply
 *     [--max-puzzle-ply N]       drop puzzles whose start ply > N
 *     [--dry-run]                report stats without writing
 *
 * Exits non-zero if no filter is active (refuses to run as a no-op identity
 * copy), or if the source dir is missing structure.
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
// Input: parsed shard object {posKey: [entry, ...]} and a `criteria` bag.
// Output: { kept: {posKey: [entry...]}, referencedPuzzleIds, positionsKept,
//           positionsDropped, entriesKept, entriesDropped }.
//
// Each entry is [puzzleId, rating, color?, ply?, ...]. An entry survives iff:
//   - whitelistSet, if provided, contains its posKey
//   - rating ≥ ratingFloor (if active)
//   - ply ≤ maxEmissionPly (if active; entries lacking a ply field pass)
//   - puzzleId ∉ droppedPuzzleIds (if provided)
// A position survives iff it has at least one surviving entry.
//
// All filter inputs are optional. When all are nullish, the shard is passed
// through unchanged (every position kept) — this is the legacy whitelist-only
// path with the whitelistSet absent.
function filterIndexShard(shardObj, criteria) {
  // Backward-compat: callers passing a Set as the second arg get the old
  // whitelist-only behavior. Keeps existing tests and external callers
  // working without change.
  const c = (criteria instanceof Set)
    ? { whitelistSet: criteria }
    : (criteria || {});
  const whitelistSet = c.whitelistSet || null;
  const ratingFloor = (typeof c.ratingFloor === 'number') ? c.ratingFloor : null;
  const maxEmissionPly = (typeof c.maxEmissionPly === 'number') ? c.maxEmissionPly : null;
  const droppedPuzzleIds = c.droppedPuzzleIds || null;

  const kept = Object.create(null);
  const referencedIds = new Set();
  let positionsKept = 0;
  let positionsDropped = 0;
  let entriesKept = 0;
  let entriesDropped = 0;

  for (const posKey of Object.keys(shardObj)) {
    if (whitelistSet && !whitelistSet.has(posKey)) {
      positionsDropped++;
      entriesDropped += shardObj[posKey].length;
      continue;
    }
    const inEntries = shardObj[posKey];
    // Fast path: no entry-level filters → keep array as-is, skip per-entry
    // copy. Big win on legacy whitelist-only filtering at multi-GB scale.
    if (ratingFloor === null && maxEmissionPly === null && !droppedPuzzleIds) {
      kept[posKey] = inEntries;
      positionsKept++;
      entriesKept += inEntries.length;
      for (let i = 0; i < inEntries.length; i++) {
        referencedIds.add(inEntries[i][0]);
      }
      continue;
    }
    // Entry-level filtering path.
    const survivors = [];
    for (let i = 0; i < inEntries.length; i++) {
      const e = inEntries[i];
      const id = e[0];
      const rating = e[1];
      const ply = (e.length >= 4 && typeof e[3] === 'number') ? e[3] : null;
      if (droppedPuzzleIds && droppedPuzzleIds.has(id)) { entriesDropped++; continue; }
      if (ratingFloor !== null && typeof rating === 'number' && rating < ratingFloor) {
        entriesDropped++; continue;
      }
      if (maxEmissionPly !== null && ply !== null && ply > maxEmissionPly) {
        entriesDropped++; continue;
      }
      survivors.push(e);
      entriesKept++;
      referencedIds.add(id);
    }
    if (survivors.length > 0) {
      kept[posKey] = survivors;
      positionsKept++;
    } else {
      positionsDropped++;
    }
  }
  return {
    kept: kept,
    referencedPuzzleIds: referencedIds,
    positionsKept: positionsKept,
    positionsDropped: positionsDropped,
    entriesKept: entriesKept,
    entriesDropped: entriesDropped,
  };
}

// ─── pure: compute puzzle starting ply from index entries ────────────────
// For each puzzleId, the starting ply equals the MAX ply across all of its
// index entries. (build-index walks each source-game's mainline once and
// emits the puzzle's `fen` — its starting position — at the final ply.
// Earlier plies are positions the source game passed through before the
// blunder.) Updates `maxByIdMap` in place; entries without a ply field
// (legacy length-3 shards) contribute 0, which means the puzzle is treated
// as starting at ply 0 — never dropped by --max-puzzle-ply, which is the
// correct backward-compat behavior.
function collectMaxPlyPerPuzzle(shardObj, maxByIdMap) {
  for (const posKey of Object.keys(shardObj)) {
    const entries = shardObj[posKey];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const id = e[0];
      const ply = (e.length >= 4 && typeof e[3] === 'number') ? e[3] : 0;
      const prev = maxByIdMap.get(id);
      if (prev === undefined || ply > prev) maxByIdMap.set(id, ply);
    }
  }
}

// ─── pure: filter body shard ndjson ──────────────────────────────────────
// Input: full ndjson text + criteria { keepIds, ratingFloor? }.
// Output: { text, bodiesKept, bodiesDropped }.
//
// Stream-parses line-by-line via string scan rather than split() — body
// shards can be megabytes at full scale, and split() allocates a giant
// array we'd discard immediately.
//
// Two-stage filter per body line:
//   1. Fast-path id check via string scan (avoids JSON.parse for the common
//      "not in keepIds" reject case).
//   2. If id passes and ratingFloor is active, JSON.parse to check rating.
function filterBodyShard(ndjsonText, criteria) {
  // Backward-compat: callers passing a Set as the second arg get the old
  // id-only behavior. Keeps the body-shard tests and any external callers
  // working without change.
  const c = (criteria instanceof Set)
    ? { keepIds: criteria, ratingFloor: null }
    : (criteria || {});
  const keepIds = c.keepIds || null;
  const ratingFloor = (typeof c.ratingFloor === 'number') ? c.ratingFloor : null;

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
        let keep = id !== null && (keepIds === null || keepIds.has(id));
        if (keep && ratingFloor !== null) {
          // Parse to check rating. Rare path — only fires for ids that
          // already passed the keepIds gate, so per-call JSON.parse cost
          // scales with kept-puzzle count not total puzzle count.
          try {
            const body = JSON.parse(line);
            if (typeof body.rating === 'number' && body.rating < ratingFloor) {
              keep = false;
            }
          } catch (e) {
            keep = false;
          }
        }
        if (keep) {
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
// Reads from `sourceDir`, writes to `outDir`. Passing dryRun=true suppresses
// all writes. Returns a stats object.
//
// Filters: any combination of whitelistSet, ratingFloor, maxEmissionPly,
// maxPuzzlePly. At least one must be set or runFilter throws (no-op identity
// copies are refused — they're never what the caller wanted).
function runFilter(opts) {
  const {
    sourceDir, outDir, dryRun,
    whitelistSet,
    ratingFloor,
    maxEmissionPly,
    maxPuzzlePly,
  } = opts;
  const indexInDir = path.join(sourceDir, 'index');
  const puzzlesInDir = path.join(sourceDir, 'puzzles');
  const metaIn = path.join(sourceDir, 'meta.json');

  if (!fs.existsSync(indexInDir) || !fs.existsSync(puzzlesInDir)) {
    throw new Error(`source dir missing index/ or puzzles/: ${sourceDir}`);
  }

  // Refuse to run as identity copy — caller almost certainly forgot a filter.
  const hasWhitelist = whitelistSet && whitelistSet.size > 0;
  const hasRating = (typeof ratingFloor === 'number') && ratingFloor > 0;
  const hasEmissionPly = (typeof maxEmissionPly === 'number') && maxEmissionPly > 0;
  const hasPuzzlePly = (typeof maxPuzzlePly === 'number') && maxPuzzlePly > 0;
  if (!hasWhitelist && !hasRating && !hasEmissionPly && !hasPuzzlePly) {
    throw new Error('no filter active; refusing to run as identity copy');
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

  const indexFiles = fs.readdirSync(indexInDir).filter(f => f.endsWith('.json'));

  // ─── Optional pre-pass: build puzzleId → maxPly map ───
  // Only triggered by --max-puzzle-ply since deriving puzzle-start ply from
  // index entries requires seeing every entry for each puzzle. ~140MB peak
  // RSS at 5.86M scale; tolerable.
  let droppedPuzzleIds = null;
  let puzzleStartPlyMap = null;
  if (hasPuzzlePly) {
    puzzleStartPlyMap = new Map();
    for (const f of indexFiles) {
      const text = fs.readFileSync(path.join(indexInDir, f), 'utf8');
      const obj = JSON.parse(text);
      collectMaxPlyPerPuzzle(obj, puzzleStartPlyMap);
    }
    droppedPuzzleIds = new Set();
    for (const [id, maxPly] of puzzleStartPlyMap) {
      if (maxPly > maxPuzzlePly) droppedPuzzleIds.add(id);
    }
  }

  // ─── Pass 1: filter index ───
  let positionsKept = 0;
  let positionsDropped = 0;
  let entriesKept = 0;
  let entriesDropped = 0;
  let indexShardsKept = 0;
  let indexShardsDropped = 0;
  // Union of ids referenced by ALL kept entries across ALL shards.
  // At full scale this set could hold ~5M strings — Set scales fine.
  const referencedIds = new Set();
  const indexCriteria = {
    whitelistSet: hasWhitelist ? whitelistSet : null,
    ratingFloor: hasRating ? ratingFloor : null,
    maxEmissionPly: hasEmissionPly ? maxEmissionPly : null,
    droppedPuzzleIds: droppedPuzzleIds,
  };
  for (const f of indexFiles) {
    const text = fs.readFileSync(path.join(indexInDir, f), 'utf8');
    const obj = JSON.parse(text);
    const r = filterIndexShard(obj, indexCriteria);
    positionsKept += r.positionsKept;
    positionsDropped += r.positionsDropped;
    entriesKept += r.entriesKept;
    entriesDropped += r.entriesDropped;
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
  // Body must be in referencedIds (Pass 1 found at least one surviving
  // entry for it) AND pass the rating floor (defense in depth — Pass 1
  // already drops sub-floor entries, so a body whose only entries were
  // sub-floor won't be in referencedIds. But we still apply the floor to
  // bodies in case future filter additions don't propagate cleanly.)
  const bodyFiles = fs.readdirSync(puzzlesInDir).filter(f => f.endsWith('.ndjson'));
  let bodiesKept = 0;
  let bodiesDropped = 0;
  let bodyShardsKept = 0;
  let bodyShardsDropped = 0;
  const bodyCriteria = {
    keepIds: referencedIds,
    ratingFloor: hasRating ? ratingFloor : null,
  };
  for (const f of bodyFiles) {
    const text = fs.readFileSync(path.join(puzzlesInDir, f), 'utf8');
    const r = filterBodyShard(text, bodyCriteria);
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
      whitelistSize: hasWhitelist ? whitelistSet.size : null,
      ratingFloor: hasRating ? ratingFloor : null,
      maxEmissionPly: hasEmissionPly ? maxEmissionPly : null,
      maxPuzzlePly: hasPuzzlePly ? maxPuzzlePly : null,
      puzzlesDroppedByPuzzlePly: droppedPuzzleIds ? droppedPuzzleIds.size : 0,
      indexShardsKept,
      indexShardsDropped,
      positionsKept,
      positionsDropped,
      entriesKept,
      entriesDropped,
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
    whitelistSize: hasWhitelist ? whitelistSet.size : 0,
    ratingFloor: hasRating ? ratingFloor : null,
    maxEmissionPly: hasEmissionPly ? maxEmissionPly : null,
    maxPuzzlePly: hasPuzzlePly ? maxPuzzlePly : null,
    puzzlesDroppedByPuzzlePly: droppedPuzzleIds ? droppedPuzzleIds.size : 0,
    indexShardsKept, indexShardsDropped,
    positionsKept, positionsDropped,
    entriesKept, entriesDropped,
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
  const WHITELIST = pos[0] || null;
  const SOURCE = path.resolve(flags['source-dir'] || './data');
  const OUT = path.resolve(flags['out-dir'] || './data-filtered');
  const DRY = !!flags['dry-run'];
  const RATING_FLOOR = flags['rating-floor'] != null ? parseInt(flags['rating-floor'], 10) : null;
  const MAX_EMISSION_PLY = flags['max-emission-ply'] != null ? parseInt(flags['max-emission-ply'], 10) : null;
  const MAX_PUZZLE_PLY = flags['max-puzzle-ply'] != null ? parseInt(flags['max-puzzle-ply'], 10) : null;

  // Validate any provided numeric flags up front.
  for (const [name, val] of [
    ['rating-floor', RATING_FLOOR],
    ['max-emission-ply', MAX_EMISSION_PLY],
    ['max-puzzle-ply', MAX_PUZZLE_PLY],
  ]) {
    if (val !== null && (!Number.isFinite(val) || val < 1)) {
      console.error(`--${name} must be a positive integer (got ${val})`);
      process.exit(1);
    }
  }

  // Need at least one filter
  if (!WHITELIST && RATING_FLOOR === null && MAX_EMISSION_PLY === null && MAX_PUZZLE_PLY === null) {
    console.error('usage: node filter-data.js [whitelist.txt] [--source-dir DIR] [--out-dir DIR]');
    console.error('                            [--rating-floor N] [--max-emission-ply N]');
    console.error('                            [--max-puzzle-ply N] [--dry-run]');
    console.error('At least one filter must be specified.');
    process.exit(1);
  }

  let whitelistSet = null;
  if (WHITELIST) {
    const w = RepertoireFilter.loadFromFile(WHITELIST);
    if (w.count === 0) {
      console.error('whitelist contains zero valid positions; refusing to run.');
      process.exit(1);
    }
    whitelistSet = w.set;
    console.log(`whitelist: ${w.count} positions from ${WHITELIST}`);
    if (w.errors.length > 0) console.warn(`  ${w.errors.length} parse errors in whitelist (ignored)`);
    if (w.dropped.length > 0) console.log(`  ${w.dropped.length} duplicate posKeys deduped`);
  } else {
    console.log('whitelist: (none — threshold filters only)');
  }
  if (RATING_FLOOR !== null) console.log(`rating floor:        ${RATING_FLOOR}`);
  if (MAX_EMISSION_PLY !== null) console.log(`max emission ply:    ${MAX_EMISSION_PLY}`);
  if (MAX_PUZZLE_PLY !== null) console.log(`max puzzle-start ply: ${MAX_PUZZLE_PLY}`);
  console.log(`source:    ${SOURCE}`);
  console.log(`out:       ${OUT}${DRY ? '  (DRY RUN — no writes)' : ''}`);

  const stats = runFilter({
    sourceDir: SOURCE,
    outDir: OUT,
    whitelistSet,
    ratingFloor: RATING_FLOOR,
    maxEmissionPly: MAX_EMISSION_PLY,
    maxPuzzlePly: MAX_PUZZLE_PLY,
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
  collectMaxPlyPerPuzzle,
  runFilter,
};

#!/usr/bin/env node
/**
 * filter-data.js — Filter a built data directory by position whitelist and/or
 * threshold filters (rating floor, emission ply cap, puzzle-start ply cap),
 * and optionally stamp the puzzle-start-ply field (m[4]) on every index entry.
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
 *        position is past ply N. Starting ply is read from m[4] (canonical)
 *        if entries have it, else derived as max ply (m[3]) across all
 *        index entries for that puzzleId — requires a pre-pass over the
 *        index, additive ~5min on a multi-GB build.
 *
 * Operations (not filters — they don't drop anything):
 *
 *   --add-puzzle-ply:
 *        Stamp m[4] (puzzle-start ply) on length-4 index entries to upgrade
 *        them in-place to length-5 [id, rating, color, ply, startPly].
 *        Length-5+ entries pass through unchanged (m[4] already canonical).
 *        Length-3 entries pass through unchanged — they lack the anchoring
 *        m[3] field, and synthesizing one would amount to fabricating data
 *        we don't have. The stamping value comes from a pre-pass that
 *        computes max(m[3]) per puzzleId across the source dir's entries
 *        (or reads m[4] directly when input is already length-5).
 *
 *        IMPORTANT: source must be UNFILTERED build output (or filtered
 *        only by ratingFloor / maxPuzzlePly, which drop puzzles wholesale).
 *        Running against a source that's been emission-capped (filtered by
 *        --max-emission-ply) or position-whitelisted produces wrong m[4]
 *        values, because those filters drop SOME entries per puzzle —
 *        max(m[3]) over the survivors then clamps to the cap rather than
 *        reflecting the puzzle's true source-game start ply. The script
 *        detects this via meta.json's filterStats and refuses to run.
 *
 *        For non-transposing source games the derived value is exact (the
 *        puzzle's last emission IS its start ply); for transposing games
 *        max(m[3]) may underestimate by a few plies. A full rebuild via
 *        build-index.js gives canonical m[4] for all puzzles.
 *
 *        Bypasses the "no-op identity copy" refusal — running with only
 *        --add-puzzle-ply is a valid operation (stamps existing data
 *        without filtering anything else).
 *
 * Filters and operations can be combined freely. Common recipes:
 *   - Repertoire-only:        node filter-data.js whitelist.txt
 *   - Size shrink:            node filter-data.js --rating-floor 1000 --max-emission-ply 24
 *   - Repertoire + shrink:    node filter-data.js whitelist.txt --rating-floor 1000
 *   - Drop deep middlegame:   node filter-data.js --max-puzzle-ply 50
 *   - Filter + stamp m[4]:    node filter-data.js --source-dir ./data --rating-floor 1000 --max-emission-ply 22 --max-puzzle-ply 80 --add-puzzle-ply
 *   - Stamp m[4] only (must run on unfiltered build): node filter-data.js --source-dir ./data --out-dir ./data-stamped --add-puzzle-ply
 *
 * Each filtered run also annotates meta.json with `filterStats` recording
 * what was dropped/upgraded and why, so the output is self-documenting.
 *
 * Usage:
 *   node analyzer/filter-data.js [whitelist.txt]
 *     [--source-dir DIR]         default ./data
 *     [--out-dir DIR]            default ./data-filtered
 *     [--rating-floor N]         drop entries (and bodies) below this rating
 *     [--max-emission-ply N]     drop entries past this ply
 *     [--max-puzzle-ply N]       drop puzzles whose start ply > N
 *     [--add-puzzle-ply]         stamp m[4] (puzzle-start ply) on every entry
 *     [--dry-run]                report stats without writing
 *
 * Exits non-zero if no filter or operation is active (refuses to run as a
 * no-op identity copy), if source-dir == out-dir (would wipe input), or if
 * the source dir is missing structure.
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
//           positionsDropped, entriesKept, entriesDropped, entriesUpgraded }.
//
// Each entry is [puzzleId, rating, color?, ply?, startPly?, ...]. An entry
// survives iff:
//   - whitelistSet, if provided, contains its posKey
//   - rating ≥ ratingFloor (if active)
//   - ply ≤ maxEmissionPly (if active; entries lacking a ply field pass)
//   - puzzleId ∉ droppedPuzzleIds (if provided)
//
// Surviving entries are also UPGRADED in shape iff puzzleStartPlyMap is
// provided:
//   - length-4 entries [id, rating, color, ply] gain m[4] from the map →
//     length-5 [id, rating, color, ply, startPly]. Increments
//     entriesUpgraded.
//   - length-5+ entries pass through unchanged (m[4] already canonical).
//   - length-3 entries pass through unchanged (no m[3] to anchor on; we
//     don't synthesize a missing m[3] just to add m[4]).
//
// A position survives iff it has at least one surviving entry.
//
// All filter inputs are optional. When all are nullish AND no upgrade map
// is provided, the shard is passed through unchanged (every position kept,
// no per-entry copy) — fast path for the legacy whitelist-only case.
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
  const puzzleStartPlyMap = c.puzzleStartPlyMap || null;

  const kept = Object.create(null);
  const referencedIds = new Set();
  let positionsKept = 0;
  let positionsDropped = 0;
  let entriesKept = 0;
  let entriesDropped = 0;
  let entriesUpgraded = 0;

  // Per-entry walk needed iff there's filtering to do OR upgrading to do.
  // Without either, the shard pass-through fast path applies.
  const hasEntryFilter = (ratingFloor !== null) || (maxEmissionPly !== null) || !!droppedPuzzleIds;
  const hasUpgrade = !!puzzleStartPlyMap;

  for (const posKey of Object.keys(shardObj)) {
    if (whitelistSet && !whitelistSet.has(posKey)) {
      positionsDropped++;
      entriesDropped += shardObj[posKey].length;
      continue;
    }
    const inEntries = shardObj[posKey];
    // Fast path: no entry-level filters AND no upgrades → keep array as-is,
    // skip per-entry copy. Big win on legacy whitelist-only filtering at
    // multi-GB scale.
    if (!hasEntryFilter && !hasUpgrade) {
      kept[posKey] = inEntries;
      positionsKept++;
      entriesKept += inEntries.length;
      for (let i = 0; i < inEntries.length; i++) {
        referencedIds.add(inEntries[i][0]);
      }
      continue;
    }
    // Entry-level filtering and/or upgrade path.
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
      // Upgrade to length-5 if requested AND the entry needs it.
      let outE = e;
      if (hasUpgrade && e.length === 4) {
        const sp = puzzleStartPlyMap.get(id);
        if (typeof sp === 'number' && isFinite(sp) && sp > 0) {
          outE = [e[0], e[1], e[2], e[3], sp];
          entriesUpgraded++;
        }
        // If the map has no entry for this id (shouldn't happen — pre-pass
        // walks the same shards we're now reading) or has 0/non-numeric,
        // leave the entry length-4. Filter readers already pass-through
        // length-4 entries via filterByPly's missing-m[4] back-compat.
      }
      survivors.push(outE);
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
    entriesUpgraded: entriesUpgraded,
  };
}

// ─── pure: compute puzzle starting ply from index entries ────────────────
// For each puzzleId, derives the puzzle's source-game starting ply.
//
// Input shape preference, per-entry:
//   1. Length-5+ entry: read m[4] directly (canonical startPly from
//      build-index.js — exact, dedup-invariant, identical across all
//      entries of one puzzle, so the per-puzzle "max" reduces to the
//      single value).
//   2. Length-4 entry: read m[3] (per-position emission ply). MAX m[3]
//      across the puzzle's entries approximates startPly. Exact for
//      non-transposing source games (the overwhelming majority); for
//      transposing games (where the source mainline returns to an
//      earlier-seen position) max(m[3]) may underestimate by a few
//      plies because dedup-keeps-min-ply collapses re-visited positions
//      to their earliest emission. Acceptable for filter-data.js's use
//      cases (--max-puzzle-ply tolerates a few plies of imprecision;
//      --add-puzzle-ply backfill labels are good enough until full
//      rebuild).
//   3. Length-3 entry: contributes 0. Per --max-puzzle-ply's contract
//      (legacy entries are never dropped by puzzle-ply filtering),
//      and per --add-puzzle-ply's contract (length-3 entries don't
//      get upgraded — no anchoring m[3] to extend from).
//
// Updates `maxByIdMap` in place.
function collectMaxPlyPerPuzzle(shardObj, maxByIdMap) {
  for (const posKey of Object.keys(shardObj)) {
    const entries = shardObj[posKey];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const id = e[0];
      let ply = 0;
      if (e.length >= 5 && typeof e[4] === 'number' && isFinite(e[4])) {
        ply = e[4];          // canonical startPly
      } else if (e.length >= 4 && typeof e[3] === 'number' && isFinite(e[3])) {
        ply = e[3];          // approximate via emission ply
      }
      // Guard against NaN-contamination via isFinite above. NaN passes
      // typeof === 'number', and NaN > anything is always false — so a
      // single NaN entry would freeze the map value for that puzzle at
      // NaN forever. Treating non-finite values as 0 (legacy fallback)
      // keeps the map well-formed.
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
// maxPuzzlePly. Operations: addPuzzlePly. At least one filter or operation
// must be active or runFilter throws (no-op identity copies are refused —
// they're never what the caller wanted).
//
// outDir must not equal sourceDir — output prep wipes the dir, which would
// destroy the input. Resolved paths compared post-realpath.
function runFilter(opts) {
  const {
    sourceDir, outDir, dryRun,
    whitelistSet,
    ratingFloor,
    maxEmissionPly,
    maxPuzzlePly,
    addPuzzlePly,
  } = opts;
  const indexInDir = path.join(sourceDir, 'index');
  const puzzlesInDir = path.join(sourceDir, 'puzzles');
  const metaIn = path.join(sourceDir, 'meta.json');

  if (!fs.existsSync(indexInDir) || !fs.existsSync(puzzlesInDir)) {
    throw new Error(`source dir missing index/ or puzzles/: ${sourceDir}`);
  }

  // In-place wipe guard. Source is always realpath'd (must exist). Output
  // is realpath'd ONLY if it already exists — a non-existent path can't
  // be a symlink to source, and realpathSync would throw on missing paths.
  // Comparing canonical paths catches:
  //   - same string (./data-filtered ./data-filtered)
  //   - relative vs absolute (./data /home/.../data)
  //   - symlinked outDir pointing at source (rare, but rmSync follows
  //     directory symlinks recursively, which would wipe source)
  const resolvedSource = fs.realpathSync(sourceDir);
  const resolvedOut = fs.existsSync(outDir)
    ? fs.realpathSync(outDir)
    : path.resolve(outDir);
  if (resolvedSource === resolvedOut) {
    throw new Error(
      'sourceDir and outDir resolve to the same path; refusing to wipe input. ' +
      'Pick a different --out-dir, then move/replace the source dir manually.'
    );
  }

  // Refuse to run as identity copy — caller almost certainly forgot a filter
  // or operation. addPuzzlePly counts: it's not a filter (drops nothing)
  // but it transforms entries, which is a real operation.
  const hasWhitelist = whitelistSet && whitelistSet.size > 0;
  const hasRating = (typeof ratingFloor === 'number') && ratingFloor > 0;
  const hasEmissionPly = (typeof maxEmissionPly === 'number') && maxEmissionPly > 0;
  const hasPuzzlePly = (typeof maxPuzzlePly === 'number') && maxPuzzlePly > 0;
  const hasAddPuzzlePly = !!addPuzzlePly;
  if (!hasWhitelist && !hasRating && !hasEmissionPly && !hasPuzzlePly && !hasAddPuzzlePly) {
    throw new Error('no filter or operation active; refusing to run as identity copy');
  }

  // ─── Safety: --add-puzzle-ply requires unfiltered source ───
  // The pre-pass derives m[4] = max(m[3]) per puzzleId across entries
  // visible in the source dir. If the source has been emission-ply-capped
  // OR position-whitelisted, entries are MISSING per puzzle — and max
  // over the survivors clamps to whatever the cap was (or whatever the
  // whitelist let through). The result is wrong: every puzzle whose
  // deepest surviving emission hits the cap gets m[4] = cap, regardless
  // of its true start ply.
  //
  // ratingFloor and maxPuzzlePly are safe — they drop puzzles WHOLESALE
  // (rating is a per-puzzle property, so all entries of a sub-floor puzzle
  // drop together; maxPuzzlePly drops by puzzle id). Surviving puzzles
  // retain ALL their entries, so max(m[3]) is unaffected.
  //
  // Detect the unsafe case via meta.json's filterStats. If it shows the
  // input was emission-capped or whitelisted, refuse with the right recipe.
  if (hasAddPuzzlePly && fs.existsSync(metaIn)) {
    let srcMeta;
    try { srcMeta = JSON.parse(fs.readFileSync(metaIn, 'utf8')); } catch (e) { srcMeta = null; }
    const fs0 = srcMeta && srcMeta.filterStats;
    if (fs0) {
      const cap = (typeof fs0.maxEmissionPly === 'number') && fs0.maxEmissionPly > 0
        ? fs0.maxEmissionPly : null;
      const wlSize = (typeof fs0.whitelistSize === 'number') && fs0.whitelistSize > 0
        ? fs0.whitelistSize : 0;
      if (cap !== null || wlSize > 0) {
        const why = cap !== null
          ? `source was emission-capped at maxEmissionPly=${cap}`
          : `source was whitelist-filtered (whitelistSize=${wlSize})`;
        throw new Error(
          '--add-puzzle-ply: ' + why + '. Backfilling against partial-puzzle ' +
          'input clamps m[4] to the cap (or to whatever positions survived ' +
          'the whitelist), producing wrong values. Re-run from the unfiltered ' +
          'build output, applying all filters AND --add-puzzle-ply in one pass:\n' +
          '  node analyzer/filter-data.js \\\n' +
          '    --source-dir ./data \\\n' +
          '    --out-dir ./data-filtered \\\n' +
          '    --rating-floor N --max-emission-ply N --max-puzzle-ply N \\\n' +
          '    --add-puzzle-ply'
        );
      }
    }
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
  // Triggered by either:
  //   - --max-puzzle-ply: needs droppedPuzzleIds (which puzzles to drop
  //     wholesale)
  //   - --add-puzzle-ply: needs the map itself, threaded into
  //     filterIndexShard so length-4 entries can be upgraded to length-5
  //     by appending the map's value as m[4]
  // Both cases share the same pre-pass; running once. ~140MB peak RSS at
  // 5.86M scale; tolerable.
  let droppedPuzzleIds = null;
  let puzzleStartPlyMap = null;
  if (hasPuzzlePly || hasAddPuzzlePly) {
    puzzleStartPlyMap = new Map();
    for (const f of indexFiles) {
      const text = fs.readFileSync(path.join(indexInDir, f), 'utf8');
      const obj = JSON.parse(text);
      collectMaxPlyPerPuzzle(obj, puzzleStartPlyMap);
    }
    if (hasPuzzlePly) {
      droppedPuzzleIds = new Set();
      for (const [id, maxPly] of puzzleStartPlyMap) {
        if (maxPly > maxPuzzlePly) droppedPuzzleIds.add(id);
      }
    }
  }

  // ─── Pass 1: filter index ───
  let positionsKept = 0;
  let positionsDropped = 0;
  let entriesKept = 0;
  let entriesDropped = 0;
  let entriesUpgraded = 0;
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
    // Threading the map into filterIndexShard ONLY when --add-puzzle-ply
    // is set — keeps existing filter modes' output shape unchanged. Users
    // who want m[4] stamping must opt in explicitly.
    puzzleStartPlyMap: hasAddPuzzlePly ? puzzleStartPlyMap : null,
  };
  for (const f of indexFiles) {
    const text = fs.readFileSync(path.join(indexInDir, f), 'utf8');
    const obj = JSON.parse(text);
    const r = filterIndexShard(obj, indexCriteria);
    positionsKept += r.positionsKept;
    positionsDropped += r.positionsDropped;
    entriesKept += r.entriesKept;
    entriesDropped += r.entriesDropped;
    entriesUpgraded += r.entriesUpgraded || 0;
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
    const filteredAt = new Date().toISOString();
    meta.filteredFrom = path.resolve(sourceDir);
    meta.filteredAt = filteredAt;
    // Bump builtAt to filteredAt so the frontend's IDB shard cache sees a
    // fresh build-stamp and wipes its cached shards. Without this, existing
    // users keep serving stale shards from before the republish — the cache
    // invalidation key (lib/cache.js → checkBuildVersion(meta.builtAt))
    // would otherwise stay pinned to whatever build-index.js wrote, which
    // doesn't change across filter re-runs.
    //
    // Preserve the original timestamp under a new field for future code
    // that wants to know when the underlying PGN walk happened (vs. when
    // the latest filter pass ran). Existing callers (dataset-info label
    // at index.html:7886) already prefer `filteredAt` over `builtAt`, so
    // this is safe.
    if (meta.builtAt && !meta.buildIndexBuiltAt) {
      meta.buildIndexBuiltAt = meta.builtAt;
    }
    meta.builtAt = filteredAt;
    meta.filterStats = {
      whitelistSize: hasWhitelist ? whitelistSet.size : null,
      ratingFloor: hasRating ? ratingFloor : null,
      maxEmissionPly: hasEmissionPly ? maxEmissionPly : null,
      maxPuzzlePly: hasPuzzlePly ? maxPuzzlePly : null,
      addPuzzlePly: hasAddPuzzlePly,
      puzzlesDroppedByPuzzlePly: droppedPuzzleIds ? droppedPuzzleIds.size : 0,
      entriesUpgradedToLength5: entriesUpgraded,
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
    addPuzzlePly: hasAddPuzzlePly,
    puzzlesDroppedByPuzzlePly: droppedPuzzleIds ? droppedPuzzleIds.size : 0,
    entriesUpgradedToLength5: entriesUpgraded,
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
  const ADD_PUZZLE_PLY = !!flags['add-puzzle-ply'];

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

  // Need at least one filter or operation. --add-puzzle-ply alone is a
  // valid operation (stamps existing data without filtering anything else).
  if (!WHITELIST && RATING_FLOOR === null && MAX_EMISSION_PLY === null && MAX_PUZZLE_PLY === null && !ADD_PUZZLE_PLY) {
    console.error('usage: node filter-data.js [whitelist.txt] [--source-dir DIR] [--out-dir DIR]');
    console.error('                            [--rating-floor N] [--max-emission-ply N]');
    console.error('                            [--max-puzzle-ply N] [--add-puzzle-ply] [--dry-run]');
    console.error('At least one filter or operation must be specified.');
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
  if (ADD_PUZZLE_PLY)          console.log(`add puzzle-start ply: yes (stamping m[4] on length-4 entries)`);
  console.log(`source:    ${SOURCE}`);
  console.log(`out:       ${OUT}${DRY ? '  (DRY RUN — no writes)' : ''}`);

  const stats = runFilter({
    sourceDir: SOURCE,
    outDir: OUT,
    whitelistSet,
    ratingFloor: RATING_FLOOR,
    maxEmissionPly: MAX_EMISSION_PLY,
    maxPuzzlePly: MAX_PUZZLE_PLY,
    addPuzzlePly: ADD_PUZZLE_PLY,
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

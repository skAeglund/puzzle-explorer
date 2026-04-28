#!/usr/bin/env node
/**
 * build-index.js — Walk Han Schut's puzzle PGN, emit sharded index + bodies.
 *
 * Uses chess.js v1.x for build (~24x faster loadPgn than v0.10). The frontend
 * pins v0.10.3 separately via CDN; the build process is independent.
 *
 * Usage:
 *   node analyzer/build-index.js <input.pgn> [out_dir]
 *
 * Output:
 *   <out_dir>/index/<hex>.json     posKey -> [[puzzleId, rating], ...]
 *   <out_dir>/puzzles/<hex>.ndjson one puzzle body per line, keyed off puzzleId hash
 *   <out_dir>/meta.json            build stats
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Chess } = require('chess.js');
const { fenPositionKey, SHARD_HEX_LEN } = require('../lib/posKey');

// ─── config ─────────────────────────────────────────────────────────────
// SHARD_HEX_LEN comes from lib/posKey so it stays in sync with the runtime.

// Minimal CLI: positional args for input + output, flags with --key=value or --key value.
// Gated behind a require.main check so this file can also be `require()`d by
// tests for its pure helpers (normalizeExternalUrl) without the script
// trying to parse CLI args / call process.exit.
let SOURCE_PGN, OUT_DIR, LIMIT, MAX_PER_POSITION;
// Default cap on entries-per-position written to a shard. At full 1.2M+ scale
// the "after 1.e4" hot shard would otherwise grow to ~12MB raw / ~2MB gzipped;
// capping at 2000 (sorted by rating desc) drops it to ~150KB while losing
// nothing user-visible, since the UI already displays the top 100 by rating.
// Each puzzle is indexed at ~28-60 different position shards (every ply of
// its source game), so a puzzle dropped from one hot position is still
// discoverable at every other position in its game.
const MAX_PER_POSITION_DEFAULT = 2000;
if (require.main === module) {
  const _args = process.argv.slice(2);
  const _pos = [];
  const _flags = Object.create(null);
  for (let i = 0; i < _args.length; i++) {
    const a = _args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) _flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < _args.length && !_args[i + 1].startsWith('--')) _flags[a.slice(2)] = _args[++i];
      else _flags[a.slice(2)] = true;
    } else {
      _pos.push(a);
    }
  }
  SOURCE_PGN = _pos[0];
  OUT_DIR = _pos[1] || './data';
  LIMIT = _flags.limit ? parseInt(_flags.limit, 10) : 0;
  // 0 disables the cap; negative values are treated as 0 too. Anything else
  // is the per-position keep-N value.
  MAX_PER_POSITION = _flags['max-per-position'] != null
    ? Math.max(0, parseInt(_flags['max-per-position'], 10) || 0)
    : MAX_PER_POSITION_DEFAULT;

  if (!SOURCE_PGN) {
    console.error('usage: node build-index.js <input.pgn> [out_dir] [--limit N] [--max-per-position N]');
    process.exit(1);
  }
}

// ─── sharding ────────────────────────────────────────────────────────────
function shardId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, SHARD_HEX_LEN);
}

// ─── per-position cap ────────────────────────────────────────────────────
// Trim hot positions to the top-N entries by rating descending. Mutates the
// `grouped` map in place. Returns { entriesDropped, positionsCapped }.
//
// Sort is by rating desc (entry[1]) with stable tiebreaks (Array.sort is stable
// since ES2019). Entries below the cutoff are gone from THIS shard but the
// puzzle is still indexed at every other ply of its source game (~28-60 shards),
// so nothing is globally lost — only locally trimmed at hot positions.
//
// maxN <= 0 means "no cap" — for byte-equivalent rebuilds against pre-cap data.
function capPerPosition(grouped, maxN) {
  if (!maxN || maxN <= 0) return { entriesDropped: 0, positionsCapped: 0 };
  let dropped = 0, capped = 0;
  for (const arr of grouped.values()) {
    if (arr.length <= maxN) continue;
    arr.sort((a, b) => b[1] - a[1]);
    dropped += arr.length - maxN;
    arr.length = maxN;
    capped++;
  }
  return { entriesDropped: dropped, positionsCapped: capped };
}

// ─── URL normalization (issue #5) ────────────────────────────────────────
// Han Schut's PGN Site header is sometimes scheme-less (e.g.
// 'lichess.org/training/12345'). Without normalization, the frontend's
// <a href> would resolve it relative to the host page and 404. Mirror
// the frontend's normalizeExternalUrl so freshly-published datasets
// contain fully-qualified URLs (defense in depth — the frontend also
// normalizes at render-time, so older shards are fine too).
function normalizeExternalUrl(u) {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  if (!s) return '';
  if (s.indexOf('://') !== -1) return s;
  if (s.charAt(0) === '/' && s.charAt(1) === '/') return s;
  return 'https://' + s;
}

// ─── per-game processing ────────────────────────────────────────────────
function processGame(pgnText) {
  const game = new Chess();
  try { game.loadPgn(pgnText); }
  catch (e) { return { err: 'pgn_parse_failed' }; }

  const h = game.header();
  if (!h.PuzzleId) return { err: 'missing_puzzle_id' };

  // Verbose history gives us each ply's after-FEN and lan (UCI) directly —
  // no need for a separate replay loop.
  const verbose = game.history({ verbose: true });
  if (verbose.length === 0) return { err: 'empty_mainline', puzzleId: h.PuzzleId };
  const positions = verbose.map(m => fenPositionKey(m.after));
  // game.fen() === verbose[verbose.length-1].after === puzzle starting position

  // Convert Annotator (SAN solution) → UCI
  const annotator = (h.Annotator || '').trim();
  if (!annotator) return { err: 'missing_annotator', puzzleId: h.PuzzleId };
  const sanSolution = annotator.split(/\s+/);
  const solBoard = new Chess(game.fen());
  const solutionUci = [];
  for (const san of sanSolution) {
    let m;
    try { m = solBoard.move(san); }
    catch (e) { return { err: 'illegal_solution_san', puzzleId: h.PuzzleId, san }; }
    solutionUci.push(m.lan);
  }

  const themes = (h.PuzzleThemes || '').split(/\s+/).filter(Boolean);
  // The blunder: the mainline move whose `after` IS the puzzle starting
  // position. Storing both `before` (FEN) and `lan` (UCI) lets the UI play
  // a quick intro animation showing the move that creates the tactic.
  // Cost: ~75 chars/puzzle pre-gzip (~60% of which collapses post-gzip
  // since previousFen and fen share most of the board). Worth it for UX.
  const blunder = verbose[verbose.length - 1];
  const body = {
    id: h.PuzzleId,
    fen: game.fen(),
    moves: solutionUci,
    previousFen: blunder.before,
    previousMove: blunder.lan,
    rating: parseInt(h.PuzzleRating, 10) || 0,
    themes,
    gameUrl: normalizeExternalUrl(h.Site),
    opening: h.Opening || '',
    // mainline (full PGN) omitted for MVP (~60% body size reduction);
    // regenerate if a source-game viewer is added later.
  };
  return { body, positions };
}

// ─── main ────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  // PGN can be hundreds of MB (Han's set is 832MB) — past V8's ~512MB max
  // string length, so readFileSync is out. Stream line-by-line and emit one
  // game at a time when we see a blank-line-then-`[` boundary (which matches
  // the original /\r?\n\r?\n(?=\[)/ split semantics).
  console.log(`streaming game blocks from ${SOURCE_PGN}${LIMIT > 0 ? ` (limit ${LIMIT})` : ''}`);

  // ─── streaming setup ───
  // Phase 1 writes per-shard ndjson into a tmp dir (`<posKey>\t<JSON entry>`
  // per line), and per-shard ndjson body files directly into the final
  // location (bodies are already in their final form). Phase 2 reads each
  // index tmp file, groups by posKey, and emits the final JSON shard.
  // Memory footprint stays bounded by the flush batch size, not by the
  // total puzzle count — required for the full 1.2M build.
  const FLUSH_BATCH = 10000;

  const indexDir = path.join(OUT_DIR, 'index');
  const puzzlesDir = path.join(OUT_DIR, 'puzzles');
  const indexTmpDir = path.join(OUT_DIR, '.tmp-index');
  // Wipe prior shards — otherwise a smaller/different rebuild leaves stale
  // shards on disk that lookups will hit. We only wipe the index/, puzzles/,
  // and .tmp-index/ subdirs, not OUT_DIR itself, so any user-added files
  // (meta.json, etc.) survive.
  fs.rmSync(indexDir, { recursive: true, force: true });
  fs.rmSync(puzzlesDir, { recursive: true, force: true });
  fs.rmSync(indexTmpDir, { recursive: true, force: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(puzzlesDir, { recursive: true });
  fs.mkdirSync(indexTmpDir, { recursive: true });

  // shardId -> string[] of pending lines, drained on flush
  const indexBufs = new Map();
  const bodyBufs = new Map();
  const allIndexShards = new Set();
  const allBodyShards = new Set();

  function flushBuffers() {
    for (const [sid, buf] of indexBufs) {
      if (!buf.length) continue;
      fs.appendFileSync(path.join(indexTmpDir, sid + '.ndjson'), buf.join('\n') + '\n');
      buf.length = 0;
    }
    for (const [sid, buf] of bodyBufs) {
      if (!buf.length) continue;
      fs.appendFileSync(path.join(puzzlesDir, sid + '.ndjson'), buf.join('\n') + '\n');
      buf.length = 0;
    }
  }

  let parsed = 0;
  let positionEntries = 0;
  const errCounts = Object.create(null);

  // ─── Phase 1: stream PGN, parse one game at a time ───
  function processOneGame(gameText, idx) {
    const r = processGame(gameText);
    if (r.err) {
      errCounts[r.err] = (errCounts[r.err] || 0) + 1;
      return;
    }
    parsed++;
    const { body, positions } = r;
    // Index entry: [puzzleId, rating, color]. `color` is 'w' or 'b' — the
    // puzzle's starting side-to-move (i.e. who solves the tactic). The
    // frontend uses this to filter by board orientation: when the user
    // is set up from black's perspective, only black-to-move puzzles
    // match. Cost: 3 chars/entry pre-gzip; ~3.6MB at 1.2M scale.
    // Field is OPTIONAL by frontend convention — entries without it are
    // treated as "color unknown, pass through" so old data still works
    // until a republish.
    const colorChar = body.fen.split(' ')[1];  // 'w' or 'b'
    const previewEntry = [body.id, body.rating, colorChar];
    const previewJson = JSON.stringify(previewEntry);

    // Dedup positions within this game (transpositions in source game itself)
    const seen = new Set();
    for (const pos of positions) {
      if (seen.has(pos)) continue;
      seen.add(pos);
      const sid = shardId(pos);
      let buf = indexBufs.get(sid);
      if (!buf) { buf = []; indexBufs.set(sid, buf); allIndexShards.add(sid); }
      buf.push(pos + '\t' + previewJson);
      positionEntries++;
    }

    const bSid = shardId(body.id);
    let bBuf = bodyBufs.get(bSid);
    if (!bBuf) { bBuf = []; bodyBufs.set(bSid, bBuf); allBodyShards.add(bSid); }
    bBuf.push(JSON.stringify(body));

    if (idx === 99) {
      // Early heartbeat — confirms streaming is alive without waiting for
      // the first 10K flush (~100s in).
      console.log(`  100 processed`);
    }
    if ((idx + 1) % FLUSH_BATCH === 0) {
      flushBuffers();
      console.log(`  ${idx + 1} processed (flushed)`);
    }
  }

  const readline = require('readline');
  const rl = readline.createInterface({
    input: fs.createReadStream(SOURCE_PGN, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let gameBuf = '';
  let prevBlank = false;
  let gameCount = 0;
  let limitHit = false;
  for await (const line of rl) {
    // Boundary: previous line blank AND current starts with `[` (= new game header).
    if (prevBlank && line.startsWith('[') && gameBuf.trim().length > 0) {
      processOneGame(gameBuf, gameCount);
      gameCount++;
      gameBuf = '';
      if (LIMIT > 0 && gameCount >= LIMIT) {
        limitHit = true;
        break;
      }
    }
    gameBuf += line + '\n';
    prevBlank = (line.length === 0);
  }
  rl.close();
  // Trailing game (no `[` follows it) — only if we didn't hit the limit.
  if (!limitHit && gameBuf.trim().length > 0) {
    processOneGame(gameBuf, gameCount);
    gameCount++;
  }
  flushBuffers();
  console.log(`phase 1 complete: ${gameCount} game blocks streamed`);

  // ─── Phase 2: build final index JSON files from tmp ndjson ───
  let indexBytes = 0;
  let uniquePositions = 0;
  let totalEntriesDropped = 0;
  let totalPositionsCapped = 0;
  const shardSizes = [];
  for (const sid of allIndexShards) {
    const tmpFile = path.join(indexTmpDir, sid + '.ndjson');
    const text = fs.readFileSync(tmpFile, 'utf8');
    const grouped = new Map();
    // Walk lines without splitting into a giant array (large shards at
    // full 1.2M scale could be tens of MB).
    let lineStart = 0;
    while (lineStart < text.length) {
      const lineEnd = text.indexOf('\n', lineStart);
      const line = lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
      if (line.length > 0) {
        const tabIdx = line.indexOf('\t');
        const posKey = line.slice(0, tabIdx);
        const entry = JSON.parse(line.slice(tabIdx + 1));
        let arr = grouped.get(posKey);
        if (!arr) { arr = []; grouped.set(posKey, arr); }
        arr.push(entry);
      }
      if (lineEnd === -1) break;
      lineStart = lineEnd + 1;
    }
    // Cap hot positions before serialization (trims top-N by rating desc).
    const { entriesDropped, positionsCapped } = capPerPosition(grouped, MAX_PER_POSITION);
    totalEntriesDropped += entriesDropped;
    totalPositionsCapped += positionsCapped;
    // Build object from Map preserving insertion order — matches old build.
    const obj = {};
    for (const [k, v] of grouped) obj[k] = v;
    const json = JSON.stringify(obj);
    fs.writeFileSync(path.join(indexDir, sid + '.json'), json);
    uniquePositions += grouped.size;
    indexBytes += json.length;
    shardSizes.push({ sid, bytes: json.length });
  }

  // Tally body bytes from disk (bodies were streamed to final location).
  let bodyBytes = 0;
  for (const sid of allBodyShards) {
    bodyBytes += fs.statSync(path.join(puzzlesDir, sid + '.ndjson')).size;
  }

  // Clean up tmp dir
  fs.rmSync(indexTmpDir, { recursive: true, force: true });

  // shard size stats
  shardSizes.sort((a, b) => a.bytes - b.bytes);
  const minShard = shardSizes[0];
  const medShard = shardSizes[Math.floor(shardSizes.length / 2)];
  const maxShard = shardSizes[shardSizes.length - 1];

  const meta = {
    source: SOURCE_PGN,
    builtAt: new Date().toISOString(),
    shardHexLen: SHARD_HEX_LEN,
    expectedShardCount: 16 ** SHARD_HEX_LEN,
    actualIndexShardCount: allIndexShards.size,
    actualBodyShardCount: allBodyShards.size,
    gamesInFile: null,  // streaming reader doesn't pre-count
    gamesProcessed: gameCount,
    limit: LIMIT || null,
    maxPerPosition: MAX_PER_POSITION || null,
    puzzlesParsed: parsed,
    parseErrors: errCounts,
    positionEntries,
    uniquePositions,
    avgPuzzlesPerPosition: +(positionEntries / uniquePositions).toFixed(2),
    entriesDroppedByCap: totalEntriesDropped,
    positionsCapped: totalPositionsCapped,
    indexBytes,
    bodyBytes,
    indexShardBytes: { min: minShard?.bytes, median: medShard?.bytes, max: maxShard?.bytes },
    durationMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  console.log('\n─── build complete ───');
  console.log(JSON.stringify(meta, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { normalizeExternalUrl, capPerPosition };

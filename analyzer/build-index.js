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
const SOURCE_PGN = _pos[0];
const OUT_DIR = _pos[1] || './data';
const LIMIT = _flags.limit ? parseInt(_flags.limit, 10) : 0;

if (!SOURCE_PGN) {
  console.error('usage: node build-index.js <input.pgn> [out_dir] [--limit N]');
  process.exit(1);
}

// ─── sharding ────────────────────────────────────────────────────────────
function shardId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, SHARD_HEX_LEN);
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
  const body = {
    id: h.PuzzleId,
    fen: game.fen(),
    moves: solutionUci,
    rating: parseInt(h.PuzzleRating, 10) || 0,
    themes,
    gameUrl: h.Site || '',
    opening: h.Opening || '',
    // mainline omitted for MVP (~60% body size reduction); regenerate if needed
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
    const previewEntry = [body.id, body.rating];
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
    puzzlesParsed: parsed,
    parseErrors: errCounts,
    positionEntries,
    uniquePositions,
    avgPuzzlesPerPosition: +(positionEntries / uniquePositions).toFixed(2),
    indexBytes,
    bodyBytes,
    indexShardBytes: { min: minShard?.bytes, median: medShard?.bytes, max: maxShard?.bytes },
    durationMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  console.log('\n─── build complete ───');
  console.log(JSON.stringify(meta, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });

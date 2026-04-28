#!/usr/bin/env node
/**
 * fetch-deltas.js — Fetch Lichess source-game JSON for puzzles not already in
 * our index, and emit Han-format PGN entries for the analyzer.
 *
 * Use case: extend coverage past Han's 1.2M opening puzzles + mcognetta's Sept 2022
 * snapshot, picking up the ~2.9M puzzles added since then. For each PuzzleId in
 * the current Lichess CSV that's NOT in our existing data, fetch the source game
 * via `POST /api/games/export/_ids` (300 IDs per request, ndjson response, 1 req/sec).
 *
 * The API response shape is identical to mcognetta's per-line JSON, so we reuse
 * `convertOne` from import-mcognetta.js verbatim — no PGN-truncation logic
 * duplicated here.
 *
 * Resumability: every batch's gameIds are appended to `done-game-ids.txt` in the
 * checkpoint dir. On restart, those gameIds are skipped. The output PGN is
 * append-only, so a partial run survives a crash; just re-run with the same args.
 *
 * Usage:
 *   node analyzer/fetch-deltas.js <puzzle.csv|puzzle.csv.zst> <output.pgn>
 *     [--skip-data <data-dir>]    walk <data-dir>/puzzles/*.ndjson, skip those PuzzleIds
 *     [--skip-ids <file>]         additional line-delimited PuzzleIds to skip
 *     [--checkpoint <dir>]        where done-game-ids.txt lives (default: <output>.state/)
 *     [--rate <ms>]               min ms between requests (default 1100)
 *     [--batch-size <n>]          gameIds per request (default 300, hard max 300)
 *     [--limit-batches <n>]       stop after N API requests (dev/test)
 *     [--limit-puzzles <n>]       stop after collecting N candidate puzzles
 *     [--no-validate]             skip the round-trip self-check
 *     [--token <pat>]             optional Lichess API token (raises rate ceiling slightly)
 *
 * .zst input is decompressed by spawning `zstd -dc` (in-PATH binary required).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { convertOne, validateRoundTrip } = require('./import-mcognetta');
const { Chess } = require('chess.js');

// ─── CLI parsing ─────────────────────────────────────────────────────────
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

// ─── helpers ─────────────────────────────────────────────────────────────
// Lichess game URL → game ID. Examples:
//   https://lichess.org/sVgQxr8Q          → sVgQxr8Q
//   https://lichess.org/sVgQxr8Q/black#16 → sVgQxr8Q
//   https://lichess.org/wvPFkjF9#51       → wvPFkjF9
// Lichess game IDs are 8-char alphanumeric.
function gameIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/lichess\.org\/([a-zA-Z0-9]{8})(?:[/#?].*)?$/);
  return m ? m[1] : null;
}

// Lichess puzzle CSV is comma-separated with no quoted/embedded-comma fields
// (Themes is space-separated, OpeningTags has underscores instead of spaces).
// We parse by reading the header line and mapping columns by name, so a future
// reorder of CSV columns won't silently break us.
function parseCsvHeader(line) {
  return line.split(',').map(s => s.trim());
}
function parseCsvRow(line, cols) {
  const parts = line.split(',');
  if (parts.length < cols.length) return null;
  const row = Object.create(null);
  for (let i = 0; i < cols.length; i++) row[cols[i]] = parts[i];
  return row;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── input streaming (mirrors import-mcognetta.js for .bz2) ──────────────
function openInput(filePath) {
  if (filePath.endsWith('.zst')) {
    const proc = spawn('zstd', ['-dc', filePath], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.on('error', (e) => {
      console.error(`failed to spawn zstd: ${e.message}. Install zstd or pre-decompress the CSV.`);
      process.exit(1);
    });
    return proc.stdout;
  }
  return fs.createReadStream(filePath, { encoding: 'utf8' });
}

// ─── skip-id loading (shares pattern with import-mcognetta.js) ───────────
function extractIdFromBodyLine(line) {
  const idStart = line.indexOf('"id":"');
  if (idStart === -1) return null;
  const valStart = idStart + 6;
  const valEnd = line.indexOf('"', valStart);
  return valEnd === -1 ? null : line.slice(valStart, valEnd);
}

function loadSkipIds(dataDir, idsFile) {
  const skip = new Set();
  if (dataDir) {
    const puzzlesDir = path.join(dataDir, 'puzzles');
    if (!fs.existsSync(puzzlesDir)) {
      throw new Error(`--skip-data dir has no puzzles/ subdir: ${puzzlesDir}`);
    }
    const files = fs.readdirSync(puzzlesDir).filter(f => f.endsWith('.ndjson'));
    for (const f of files) {
      const text = fs.readFileSync(path.join(puzzlesDir, f), 'utf8');
      let lineStart = 0;
      while (lineStart < text.length) {
        const lineEnd = text.indexOf('\n', lineStart);
        const line = lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
        if (line.length > 0) {
          const id = extractIdFromBodyLine(line);
          if (id) skip.add(id);
        }
        if (lineEnd === -1) break;
        lineStart = lineEnd + 1;
      }
    }
    console.log(`  loaded ${skip.size} ids from ${files.length} body shards`);
  }
  if (idsFile) {
    const lines = fs.readFileSync(idsFile, 'utf8').split(/\r?\n/);
    let added = 0;
    for (const ln of lines) {
      const t = ln.trim();
      if (t && !skip.has(t)) { skip.add(t); added++; }
    }
    console.log(`  loaded ${added} additional ids from ${idsFile}`);
  }
  return skip;
}

// ─── checkpoint ──────────────────────────────────────────────────────────
function loadCheckpoint(checkpointDir) {
  fs.mkdirSync(checkpointDir, { recursive: true });
  const file = path.join(checkpointDir, 'done-game-ids.txt');
  if (!fs.existsSync(file)) return new Set();
  const text = fs.readFileSync(file, 'utf8');
  const set = new Set();
  let lineStart = 0;
  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = (lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd)).trim();
    if (line) set.add(line);
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return set;
}

function appendCheckpoint(checkpointDir, ids) {
  if (!ids.length) return;
  const file = path.join(checkpointDir, 'done-game-ids.txt');
  fs.appendFileSync(file, ids.join('\n') + '\n');
}

// ─── HTTP ────────────────────────────────────────────────────────────────
// Pluggable so tests can inject a mock without hitting the network.
async function defaultPostGameIds(ids, { token } = {}) {
  // pgnInJson=true: include the PGN string as a field in each ndjson line.
  // Without this, Lichess returns moves in the JSON `moves` field but no
  // `pgn` field, and convertOne errors out with no_game_pgn for every entry.
  const url = 'https://lichess.org/api/games/export/_ids?moves=true&pgnInJson=true&opening=true&clocks=false&evals=false';
  const headers = {
    'Content-Type': 'text/plain',
    'Accept': 'application/x-ndjson',
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const resp = await fetch(url, { method: 'POST', headers, body: ids.join(',') });
  return { status: resp.status, text: resp.status === 200 ? await resp.text() : '' };
}

// Drives one batch: dispatch POST, retry on 429/5xx, parse ndjson.
// Returns { games: object[], status: 'ok' | 'failed' }.
async function fetchBatch(ids, opts) {
  const { post, token, retries5xx } = opts;
  let last5xx = 0;
  while (true) {
    let resp;
    try { resp = await post(ids, { token }); }
    catch (e) {
      console.warn(`  network error (${e.message}), waiting 10s and retrying...`);
      await sleep(10000);
      continue;
    }
    if (resp.status === 200) {
      const games = [];
      const text = resp.text;
      let lineStart = 0;
      while (lineStart < text.length) {
        const lineEnd = text.indexOf('\n', lineStart);
        const line = lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
        if (line.length > 0) {
          try { games.push(JSON.parse(line)); } catch (e) { /* skip malformed line */ }
        }
        if (lineEnd === -1) break;
        lineStart = lineEnd + 1;
      }
      return { games, status: 'ok' };
    }
    if (resp.status === 429) {
      console.warn('  429 rate-limited — waiting 60s before retry');
      await sleep(60000);
      continue;
    }
    if (resp.status >= 500 && resp.status < 600) {
      last5xx++;
      if (last5xx >= retries5xx) {
        console.warn(`  ${resp.status} after ${retries5xx} retries — marking batch failed`);
        return { games: [], status: 'failed' };
      }
      console.warn(`  ${resp.status} server error — waiting 30s (retry ${last5xx}/${retries5xx})`);
      await sleep(30000);
      continue;
    }
    // Unexpected status code — log and treat as failed (don't crash the run)
    console.warn(`  unexpected status ${resp.status} — marking batch failed`);
    return { games: [], status: 'failed' };
  }
}

// ─── exposed driver (testable) ───────────────────────────────────────────
// Reads CSV, builds pending map, drives batches via opts.post, writes PGNs.
// Returns a meta object summarizing the run. Pure side effect on opts.outFd
// and opts.checkpointDir; no console.log here so tests stay quiet.
async function runFetch(opts) {
  const {
    inputCsv, outFd, checkpointDir,
    skipPuzzleIds, post, token,
    rateMs, batchSize, limitBatches, limitPuzzles,
    validate, retries5xx,
    onProgress,  // optional fn({phase, ...stats}) for progress logging
  } = opts;

  // ─── pass 1: stream CSV, build pending map ───
  const done = loadCheckpoint(checkpointDir);
  const input = openInput(inputCsv);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const pendingByGameId = new Map();   // gameId -> [puzzleRow, ...]
  let cols = null;
  let csvRows = 0;
  let candidatePuzzles = 0;
  let skippedByExisting = 0;
  let skippedByDone = 0;
  let badGameUrl = 0;

  for await (const line of rl) {
    if (!cols) {
      cols = parseCsvHeader(line);
      continue;
    }
    if (!line) continue;
    csvRows++;
    const row = parseCsvRow(line, cols);
    if (!row || !row.PuzzleId) continue;
    if (skipPuzzleIds.has(row.PuzzleId)) { skippedByExisting++; continue; }
    const gid = gameIdFromUrl(row.GameUrl);
    if (!gid) { badGameUrl++; continue; }
    if (done.has(gid)) { skippedByDone++; continue; }
    let arr = pendingByGameId.get(gid);
    if (!arr) { arr = []; pendingByGameId.set(gid, arr); }
    arr.push(row);
    candidatePuzzles++;
    if (limitPuzzles > 0 && candidatePuzzles >= limitPuzzles) break;
  }
  rl.close();

  // ─── pass 2: batch, fetch, convert, append ───
  const allGameIds = [...pendingByGameId.keys()];
  const batches = chunk(allGameIds, batchSize);

  if (onProgress) onProgress({
    phase: 'csv-scan-complete',
    csvRows, candidatePuzzles, skippedByExisting, skippedByDone, badGameUrl,
    pendingGameIds: allGameIds.length,
    plannedBatches: batches.length,
  });

  let written = 0, batchesDone = 0, batchesFailed = 0;
  let gamesReturned = 0, gamesMissing = 0;
  let validateFailures = 0;
  const errCounts = Object.create(null);

  const tRunStart = Date.now();

  for (const batchIds of batches) {
    if (limitBatches > 0 && batchesDone >= limitBatches) break;

    const tStart = Date.now();
    const { games, status } = await fetchBatch(batchIds, { post, token, retries5xx });
    batchesDone++;
    if (status === 'failed') { batchesFailed++; continue; }

    const seenIds = new Set();
    for (const g of games) {
      if (!g || typeof g !== 'object' || !g.id) continue;
      seenIds.add(g.id);
      const puzzles = pendingByGameId.get(g.id);
      if (!puzzles) continue;  // shouldn't happen, but be defensive
      gamesReturned++;
      for (const p of puzzles) {
        const r = convertOne({ puzzle: p, game: g });
        if (r.err) { errCounts[r.err] = (errCounts[r.err] || 0) + 1; continue; }
        if (validate) {
          const c = new Chess();
          let drillFen;
          try { c.loadPgn(r.pgn); drillFen = c.fen(); }
          catch (e) {
            validateFailures++;
            errCounts.validate_reparse = (errCounts.validate_reparse || 0) + 1;
            continue;
          }
          const ann = (r.pgn.match(/\[Annotator "([^"]*)"\]/) || [])[1] || '';
          const v = validateRoundTrip(r.pgn, drillFen, ann);
          if (!v.ok) {
            validateFailures++;
            const key = 'validate_' + v.reason.split(':')[0];
            errCounts[key] = (errCounts[key] || 0) + 1;
            continue;
          }
        }
        fs.writeSync(outFd, r.pgn + '\n');
        written++;
      }
    }
    gamesMissing += batchIds.length - seenIds.size;

    // Append all batch IDs to checkpoint, including missing ones — those games
    // simply don't exist on Lichess (deleted/private) and we shouldn't retry.
    appendCheckpoint(checkpointDir, batchIds);

    if (onProgress) onProgress({
      phase: 'batch-complete',
      batchesDone, batchesPlanned: batches.length, batchesFailed,
      written, gamesReturned, gamesMissing,
      elapsedMs: Date.now() - tRunStart,
    });

    // Rate limit: ensure rateMs has elapsed since batch start before next.
    const elapsed = Date.now() - tStart;
    if (rateMs > elapsed && batchesDone < batches.length) await sleep(rateMs - elapsed);
  }

  return {
    csvRows, candidatePuzzles, skippedByExisting, skippedByDone, badGameUrl,
    pendingGameIds: allGameIds.length,
    batchesPlanned: batches.length, batchesDone, batchesFailed,
    gamesReturned, gamesMissing,
    entriesWritten: written, validateFailures, parseErrors: errCounts,
  };
}

// ─── main ────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const INPUT = pos[0];
  const OUTPUT = pos[1];
  if (!INPUT || !OUTPUT) {
    console.error('usage: node fetch-deltas.js <puzzle.csv(.zst)?> <output.pgn>');
    console.error('       [--skip-data DIR] [--skip-ids FILE] [--checkpoint DIR]');
    console.error('       [--rate MS] [--batch-size N] [--limit-batches N] [--limit-puzzles N]');
    console.error('       [--no-validate] [--token PAT]');
    process.exit(1);
  }
  const SKIP_DATA = flags['skip-data'];
  const SKIP_IDS = flags['skip-ids'];
  const CHECKPOINT = flags['checkpoint'] || (OUTPUT + '.state');
  const RATE = flags.rate ? parseInt(flags.rate, 10) : 1100;
  const BATCH = Math.min(flags['batch-size'] ? parseInt(flags['batch-size'], 10) : 300, 300);
  const LIMIT_BATCHES = flags['limit-batches'] ? parseInt(flags['limit-batches'], 10) : 0;
  const LIMIT_PUZZLES = flags['limit-puzzles'] ? parseInt(flags['limit-puzzles'], 10) : 0;
  const VALIDATE = !flags['no-validate'];
  const TOKEN = flags.token || process.env.LICHESS_TOKEN || '';

  console.log(`reading CSV:   ${INPUT}`);
  console.log(`writing PGN:   ${OUTPUT}`);
  console.log(`checkpoint:    ${CHECKPOINT}`);
  console.log(`rate:          ${RATE}ms between batches, ${BATCH} ids/batch`);
  if (TOKEN) console.log('using auth token');

  if (SKIP_DATA || SKIP_IDS) console.log('loading skip-id set...');
  const skip = (SKIP_DATA || SKIP_IDS) ? loadSkipIds(SKIP_DATA, SKIP_IDS) : new Set();
  console.log(`skip-id set size: ${skip.size}`);

  fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true });
  const outFd = fs.openSync(OUTPUT, 'a');  // append-only — supports resume

  // Default progress logger: print after the CSV scan finishes (so the user
  // knows we got past pass 1) and every 10 batches thereafter (~11s at default
  // rate). Includes ETA based on rolling average pace.
  const progressLogger = (ev) => {
    if (ev.phase === 'csv-scan-complete') {
      console.log(`csv scan: ${ev.csvRows.toLocaleString()} rows read, ${ev.candidatePuzzles.toLocaleString()} candidate puzzles, ${ev.pendingGameIds.toLocaleString()} unique gameIds → ${ev.plannedBatches.toLocaleString()} batches planned`);
      console.log(`  skipped: ${ev.skippedByExisting.toLocaleString()} already in data, ${ev.skippedByDone.toLocaleString()} in checkpoint, ${ev.badGameUrl} bad URLs`);
      console.log('starting fetch...');
      return;
    }
    if (ev.phase === 'batch-complete' && ev.batchesDone % 10 === 0) {
      const pct = (100 * ev.batchesDone / ev.batchesPlanned).toFixed(1);
      const pace = ev.elapsedMs / ev.batchesDone;  // ms per batch
      const remaining = ev.batchesPlanned - ev.batchesDone;
      const etaMs = remaining * pace;
      const etaH = Math.floor(etaMs / 3600000);
      const etaM = Math.floor((etaMs % 3600000) / 60000);
      console.log(`  ${ev.batchesDone.toLocaleString()}/${ev.batchesPlanned.toLocaleString()} batches (${pct}%)  written=${ev.written.toLocaleString()}  failed=${ev.batchesFailed}  ETA ~${etaH}h${String(etaM).padStart(2,'0')}m`);
    }
  };

  const meta = await runFetch({
    inputCsv: INPUT, outFd, checkpointDir: CHECKPOINT,
    skipPuzzleIds: skip,
    post: defaultPostGameIds, token: TOKEN,
    rateMs: RATE, batchSize: BATCH,
    limitBatches: LIMIT_BATCHES, limitPuzzles: LIMIT_PUZZLES,
    validate: VALIDATE, retries5xx: 3,
    onProgress: progressLogger,
  });
  fs.closeSync(outFd);

  meta.input = INPUT;
  meta.output = OUTPUT;
  meta.skipSetSize = skip.size;
  meta.validated = VALIDATE;
  meta.durationMs = Date.now() - t0;

  console.log('\n─── fetch complete ───');
  console.log(JSON.stringify(meta, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  parseArgs,
  gameIdFromUrl,
  parseCsvHeader, parseCsvRow,
  chunk,
  loadCheckpoint, appendCheckpoint,
  fetchBatch,
  runFetch,
};

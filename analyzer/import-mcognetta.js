#!/usr/bin/env node
/**
 * import-mcognetta.js — Convert mcognetta's combined puzzle+game ndjson into
 * Han Schut-format PGN entries that build-index.js can consume.
 *
 * mcognetta's dataset (Sept 2022, CC0):
 *   https://github.com/mcognetta/lichess-combined-puzzle-game-db
 * Each line is `{"puzzle": {...CSV fields}, "game": {...Lichess API JSON, with embedded pgn}}`.
 *
 * Han's PGN format (what build-index.js expects):
 *   - Required headers: PuzzleId, Annotator (SAN solution starting AFTER the blunder)
 *   - Used headers:     PuzzleRating, PuzzleThemes, Site, Opening
 *   - Movetext:         mainline up through and including the blunder, terminated with `*`.
 *                       Last verbose move's `before`/`after`/`lan` become previousFen/previousMove
 *                       and the puzzle's drill-from FEN inside processGame.
 *
 * Mapping (per Lichess puzzle CSV semantics):
 *   - puzzle.GameUrl `#N` = "ply N about to be played" = N-1 plies played.
 *     Verified against two sample puzzles: a black-to-move puzzle at fullmove 8 (15 plies done)
 *     has #16 in URL, and a white-to-move puzzle at fullmove 26 (50 plies done) has #51.
 *   - puzzle.Moves[0]  = the blunder = ply N
 *   - puzzle.Moves[1..] = user's only-move solution = plies N+1, N+2, ...
 *   - So Han's mainline = first N plies of game (inclusive), Annotator = SAN(moves[1..]).
 *
 * Usage:
 *   node analyzer/import-mcognetta.js <input.ndjson|input.ndjson.bz2> <output.pgn>
 *     [--skip-data <data-dir>]   walk <data-dir>/puzzles/ *.ndjson, skip those PuzzleIds
 *     [--skip-ids <file>]        line-delimited PuzzleIds to skip (additive with --skip-data)
 *     [--limit N]                stop after N input lines (for dev)
 *     [--no-validate]            skip the round-trip self-check (faster, less safe)
 *
 * .bz2 input is decompressed by spawning `bunzip2 -dc` (in-PATH binary required).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
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

// ─── skip-id loading ─────────────────────────────────────────────────────
// Each puzzles ndjson line begins with `{"id":"XXXXX",...`. Extract by string
// scan rather than JSON.parse — at 1.2M+ scale, parse cost dominates.
function extractIdFromBodyLine(line) {
  // Expecting: {"id":"abc12",...
  const idStart = line.indexOf('"id":"');
  if (idStart === -1) return null;
  const valStart = idStart + 6;
  const valEnd = line.indexOf('"', valStart);
  if (valEnd === -1) return null;
  return line.slice(valStart, valEnd);
}

function loadSkipIds(dataDir, idsFile) {
  const skip = new Set();
  if (dataDir) {
    const puzzlesDir = path.join(dataDir, 'puzzles');
    if (!fs.existsSync(puzzlesDir)) {
      throw new Error(`--skip-data dir has no puzzles/ subdir: ${puzzlesDir}`);
    }
    const files = fs.readdirSync(puzzlesDir).filter(f => f.endsWith('.ndjson'));
    let scanned = 0;
    for (const f of files) {
      const text = fs.readFileSync(path.join(puzzlesDir, f), 'utf8');
      let lineStart = 0;
      while (lineStart < text.length) {
        const lineEnd = text.indexOf('\n', lineStart);
        const line = lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
        if (line.length > 0) {
          const id = extractIdFromBodyLine(line);
          if (id) skip.add(id);
          scanned++;
        }
        if (lineEnd === -1) break;
        lineStart = lineEnd + 1;
      }
    }
    console.log(`  loaded ${skip.size} ids from ${files.length} body shards (${scanned} lines scanned)`);
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

// ─── ply extraction ──────────────────────────────────────────────────────
// GameUrl examples: "https://lichess.org/wvPFkjF9#51", ".../sVgQxr8Q/black#16"
// `#N` is 1-indexed and means "ply N is about to be played" (= N-1 plies done).
// Returns null if the URL has no `#N` suffix.
function plyFromGameUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/#(\d+)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── movetext formatting ─────────────────────────────────────────────────
// Build standard PGN movetext from a verbose-history slice. Single line,
// no wrapping (chess.js parses long lines fine and Han's PGN doesn't wrap).
function formatMovetext(verboseSlice) {
  const tokens = [];
  for (let i = 0; i < verboseSlice.length; i++) {
    if (i % 2 === 0) tokens.push(`${Math.floor(i / 2) + 1}.`);
    tokens.push(verboseSlice[i].san);
  }
  tokens.push('*');
  return tokens.join(' ');
}

// ─── PGN tag escaping ────────────────────────────────────────────────────
// PGN tag values are double-quoted. Backslash and double-quote must be escaped.
// Newlines aren't legal inside tag values — collapse to space.
function escapeTagValue(s) {
  if (s == null) return '';
  return String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatHeaders(h) {
  const order = ['Event', 'Site', 'Result', 'PuzzleId', 'PuzzleRating', 'PuzzleThemes', 'Annotator', 'Opening'];
  const out = [];
  for (const k of order) {
    if (h[k] != null) out.push(`[${k} "${escapeTagValue(h[k])}"]`);
  }
  return out.join('\n');
}

// ─── PGN preprocessing ───────────────────────────────────────────────────
// chess.js v1.4 fails on TWO consecutive `{} {}` comments — and Lichess emits
// exactly that pattern when an eval/clock comment is followed by an opening-tag
// comment (e.g. `{ [%eval 0.21] [%clk 0:09:57] } { C47 Four Knights }`).
// Stripping all `{...}` comments before parsing avoids the issue and loses
// nothing we care about (comments are pure metadata; SAN moves remain).
// NAGs (?!, !?) and variations `(...)` parse fine, so we leave them alone.
function stripPgnComments(pgn) {
  // Non-greedy single-pass. Lichess doesn't nest `{` inside comments, and tag
  // values inside header lines (`[Tag "..."]`) never contain `}`, so this is safe.
  return pgn.replace(/\{[^}]*\}/g, '');
}

// ─── per-line conversion ─────────────────────────────────────────────────
function convertOne(obj) {
  const p = obj && obj.puzzle;
  const g = obj && obj.game;
  if (!p || typeof p !== 'object') return { err: 'no_puzzle' };
  if (!p.PuzzleId) return { err: 'missing_puzzle_id' };

  const blunderPly = plyFromGameUrl(p.GameUrl);
  if (blunderPly == null) return { err: 'no_ply', puzzleId: p.PuzzleId };

  if (!g || typeof g.pgn !== 'string' || !g.pgn.length) {
    return { err: 'no_game_pgn', puzzleId: p.PuzzleId };
  }

  const movesUci = (p.Moves || '').trim().split(/\s+/).filter(Boolean);
  // Han's format requires the Annotator to have the user's solution. Even a
  // single user move is fine (1-ply puzzle). Need at least blunder + 1 user move.
  if (movesUci.length < 2) return { err: 'too_few_moves', puzzleId: p.PuzzleId };

  // Parse the source game. Strip `{...}` comments first — chess.js v1.4 fails
  // on consecutive `{} {}` blocks which Lichess routinely emits.
  const game = new Chess();
  try { game.loadPgn(stripPgnComments(g.pgn)); }
  catch (e) { return { err: 'pgn_parse_failed', puzzleId: p.PuzzleId }; }

  const verbose = game.history({ verbose: true });
  if (verbose.length < blunderPly) {
    return { err: 'pgn_too_short', puzzleId: p.PuzzleId, have: verbose.length, need: blunderPly };
  }

  // Truncated mainline = first blunderPly plies. Last move's `after` is the
  // drill-from FEN; processGame will use this as game.fen() and as previousMove's
  // resulting position.
  const mainSlice = verbose.slice(0, blunderPly);
  const drillFen = mainSlice[mainSlice.length - 1].after;

  // Re-derive the SAN solution for moves[1..] from the drill position. We
  // re-derive (rather than slice from game's SAN) because the source game
  // may not actually play the puzzle solution past moves[0] verbatim — solver
  // play diverges in some cases — and because the puzzle CSV's UCI is the
  // canonical source of truth for the solution.
  const solBoard = new Chess(drillFen);
  const solutionSan = [];
  for (let i = 1; i < movesUci.length; i++) {
    const uci = movesUci[i];
    let m;
    try { m = solBoard.move(uci); }
    catch (e) { return { err: 'illegal_solution_uci', puzzleId: p.PuzzleId, uci, ply: i }; }
    if (!m) return { err: 'illegal_solution_uci', puzzleId: p.PuzzleId, uci, ply: i };
    solutionSan.push(m.san);
  }

  // Resolve opening name with fallbacks: game JSON > puzzle Family/Variation > empty.
  let openingName = '';
  if (g.opening && typeof g.opening.name === 'string') openingName = g.opening.name;
  else if (p.OpeningFamily || p.OpeningVariation) {
    openingName = [p.OpeningFamily, p.OpeningVariation].filter(Boolean).join(': ');
  } else if (p.OpeningTags) {
    openingName = String(p.OpeningTags);
  }

  const headers = {
    Event: 'mcognetta-import',
    Site: p.GameUrl,
    Result: '*',
    PuzzleId: p.PuzzleId,
    PuzzleRating: p.Rating != null ? String(p.Rating) : '0',
    PuzzleThemes: p.Themes || '',
    Annotator: solutionSan.join(' '),
    Opening: openingName,
  };

  const pgn = formatHeaders(headers) + '\n\n' + formatMovetext(mainSlice) + '\n';
  return { pgn };
}

// ─── round-trip validation ───────────────────────────────────────────────
// Re-parse the produced PGN to confirm it round-trips cleanly. Catches
// SAN/movenum formatting bugs that wouldn't be caught by static checks.
function validateRoundTrip(pgnText, expectedDrillFen, expectedAnnotator) {
  const c = new Chess();
  try { c.loadPgn(pgnText); }
  catch (e) { return { ok: false, reason: 'reparse_failed: ' + e.message }; }
  const got = c.fen();
  if (got !== expectedDrillFen) {
    return { ok: false, reason: `fen_mismatch: got ${got}, want ${expectedDrillFen}` };
  }
  // Replay the Annotator from the drill FEN to make sure it's legal SAN.
  const sBoard = new Chess(got);
  for (const san of expectedAnnotator.split(/\s+/).filter(Boolean)) {
    try { sBoard.move(san); }
    catch (e) { return { ok: false, reason: 'annotator_illegal: ' + san + ' (' + e.message + ')' }; }
  }
  return { ok: true };
}

// ─── input streaming ─────────────────────────────────────────────────────
// Returns a Readable that yields decompressed text. For .bz2, spawn bunzip2.
function openInput(filePath) {
  if (filePath.endsWith('.bz2')) {
    const proc = spawn('bunzip2', ['-dc', filePath], { stdio: ['ignore', 'pipe', 'inherit'] });
    proc.on('error', (e) => {
      console.error(`failed to spawn bunzip2: ${e.message}. Is the binary installed and in PATH?`);
      process.exit(1);
    });
    return proc.stdout;
  }
  return fs.createReadStream(filePath, { encoding: 'utf8' });
}

// ─── main ────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const INPUT = pos[0];
  const OUTPUT = pos[1];
  const SKIP_DATA = flags['skip-data'];
  const SKIP_IDS = flags['skip-ids'];
  const LIMIT = flags.limit ? parseInt(flags.limit, 10) : 0;
  const VALIDATE = !flags['no-validate'];

  if (!INPUT || !OUTPUT) {
    console.error('usage: node import-mcognetta.js <input.ndjson(.bz2)?> <output.pgn> [--skip-data DIR] [--skip-ids FILE] [--limit N] [--no-validate]');
    process.exit(1);
  }

  console.log(`reading: ${INPUT}`);
  console.log(`writing: ${OUTPUT}`);
  if (SKIP_DATA || SKIP_IDS) console.log('loading skip-id set...');
  const skip = (SKIP_DATA || SKIP_IDS) ? loadSkipIds(SKIP_DATA, SKIP_IDS) : new Set();
  console.log(`skip-id set size: ${skip.size}`);

  // Make sure output dir exists, then truncate output file (we always start fresh —
  // resumability is left as a future enhancement; mcognetta input runs in well
  // under an hour for the full 3M).
  fs.mkdirSync(path.dirname(path.resolve(OUTPUT)), { recursive: true });
  const outFd = fs.openSync(OUTPUT, 'w');

  const input = openInput(INPUT);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let lineIdx = 0;
  let written = 0;
  let skipped = 0;
  let validateFailures = 0;
  const errCounts = Object.create(null);

  for await (const rawLine of rl) {
    if (LIMIT > 0 && lineIdx >= LIMIT) break;
    lineIdx++;

    if (!rawLine || rawLine.length === 0) continue;
    let obj;
    try { obj = JSON.parse(rawLine); }
    catch (e) { errCounts.json_parse = (errCounts.json_parse || 0) + 1; continue; }

    if (skip.size > 0 && obj && obj.puzzle && skip.has(obj.puzzle.PuzzleId)) {
      skipped++;
      continue;
    }

    const r = convertOne(obj);
    if (r.err) {
      errCounts[r.err] = (errCounts[r.err] || 0) + 1;
      continue;
    }

    if (VALIDATE) {
      // Recompute drill FEN cheaply for the validation call.
      const c = new Chess();
      try { c.loadPgn(r.pgn); }
      catch (e) {
        validateFailures++;
        errCounts.validate_reparse = (errCounts.validate_reparse || 0) + 1;
        continue;
      }
      const drillFen = c.fen();
      const ann = (r.pgn.match(/\[Annotator "([^"]*)"\]/) || [])[1] || '';
      const v = validateRoundTrip(r.pgn, drillFen, ann);
      if (!v.ok) {
        validateFailures++;
        errCounts['validate_' + v.reason.split(':')[0]] = (errCounts['validate_' + v.reason.split(':')[0]] || 0) + 1;
        continue;
      }
    }

    fs.writeSync(outFd, r.pgn + '\n');
    written++;

    if (written === 100 || written % 10000 === 0) {
      console.log(`  ${written} written / ${lineIdx} read`);
    }
  }
  fs.closeSync(outFd);

  const meta = {
    input: INPUT,
    output: OUTPUT,
    linesRead: lineIdx,
    entriesWritten: written,
    skippedDueToSkipSet: skipped,
    skipSetSize: skip.size,
    parseErrors: errCounts,
    validated: VALIDATE,
    validateFailures,
    durationMs: Date.now() - t0,
  };
  console.log('\n─── import complete ───');
  console.log(JSON.stringify(meta, null, 2));
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  parseArgs,
  plyFromGameUrl,
  formatMovetext,
  formatHeaders,
  escapeTagValue,
  extractIdFromBodyLine,
  stripPgnComments,
  convertOne,
  validateRoundTrip,
};

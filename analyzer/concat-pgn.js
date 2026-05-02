#!/usr/bin/env node
/**
 * concat-pgn.js — Concatenate multiple puzzle PGNs into one, deduping by PuzzleId.
 *
 * Use case: combine Han Schut's set + fetch-deltas output into a single
 * input PGN for build-index. Streaming: never holds more than one game block
 * in memory; the dedup set is just PuzzleId strings (~10 bytes × 6M = ~60MB,
 * comfortable).
 *
 * Order: input files are processed in argv order. First-seen-wins on duplicate
 * PuzzleId — pass Han's PGN first to give it precedence on overlapping IDs
 * (Han's annotations have been validated longer; fetch-deltas may include
 * boundary puzzles that Han already has).
 *
 * Usage:
 *   node analyzer/concat-pgn.js <out.pgn> <input1.pgn> [input2.pgn ...]
 *
 * Stats printed to stderr; final summary to stdout as JSON for scripting.
 */

const fs = require('fs');
const readline = require('readline');

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: node concat-pgn.js <out.pgn> <input1.pgn> [input2.pgn ...]');
    process.exit(1);
  }
  const out = args[0];
  const inputs = args.slice(1);
  main(out, inputs).catch(e => {
    console.error('fatal:', e);
    process.exit(1);
  });
}

async function main(outPath, inputPaths) {
  // Verify inputs exist before opening output (avoid creating a truncated file
  // and then bailing on a missing input).
  for (const p of inputPaths) {
    if (!fs.existsSync(p)) {
      console.error(`input not found: ${p}`);
      process.exit(1);
    }
  }

  const seenIds = new Set();
  let totalGames = 0;
  let totalDuplicates = 0;
  let totalNoId = 0;
  let totalWritten = 0;
  const perInput = [];

  // Open output for write (truncating). Sync writes — keeps order deterministic
  // and avoids backpressure handling for what's effectively a one-shot script.
  const outFd = fs.openSync(outPath, 'w');

  try {
    for (const inputPath of inputPaths) {
      const stats = await processOne(inputPath, outFd, seenIds);
      perInput.push({ input: inputPath, ...stats });
      totalGames += stats.games;
      totalDuplicates += stats.duplicates;
      totalNoId += stats.noId;
      totalWritten += stats.written;
      console.error(`  ${inputPath}: ${stats.games} games, ${stats.written} written, ${stats.duplicates} dup, ${stats.noId} no-id`);
    }
  } finally {
    fs.closeSync(outFd);
  }

  const summary = {
    output: outPath,
    inputs: perInput,
    totalGames,
    totalWritten,
    totalDuplicates,
    totalNoId,
    uniquePuzzleIds: seenIds.size,
  };
  console.log(JSON.stringify(summary, null, 2));
}

// Process one input file, streaming game-blocks. Game boundary is detected
// the same way build-index.js detects it: a blank line followed by a line
// starting with `[` marks the start of a new game (i.e. the previous accumulated
// buffer is one complete game). This handles the blank line between headers
// and moves within a single game correctly — naive "blank line = flush" would
// split each game into two pieces.
async function processOne(inputPath, outFd, seenIds) {
  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let games = 0;
  let written = 0;
  let duplicates = 0;
  let noId = 0;
  let gameBuf = '';
  let prevBlank = false;

  function flush() {
    const text = gameBuf;
    gameBuf = '';
    if (text.trim().length === 0) return;
    games++;
    // Find PuzzleId — cheap prefix check before regex.
    let puzzleId = null;
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('[PuzzleId ')) {
        const m = line.match(/^\[PuzzleId\s+"([^"]*)"\]/);
        if (m) { puzzleId = m[1]; break; }
      }
    }
    if (!puzzleId) {
      noId++;
      return;
    }
    if (seenIds.has(puzzleId)) {
      duplicates++;
      return;
    }
    seenIds.add(puzzleId);
    // Ensure the block ends with exactly one blank line of separation.
    // build-index requires a blank line between game blocks for its boundary
    // detection, so we normalize trailing whitespace to '\n\n'.
    const normalized = text.replace(/\n*$/, '\n\n');
    fs.writeSync(outFd, normalized);
    written++;
  }

  for await (const line of rl) {
    // Boundary: previous line was blank AND current line starts with `[`,
    // AND we have a non-empty buffer to flush. Same rule as build-index.
    if (prevBlank && line.startsWith('[') && gameBuf.trim().length > 0) {
      flush();
    }
    gameBuf += line + '\n';
    prevBlank = (line.length === 0);
  }
  // Trailing block (no following `[` to trigger flush).
  flush();

  return { games, written, duplicates, noId };
}

module.exports = { processOne };

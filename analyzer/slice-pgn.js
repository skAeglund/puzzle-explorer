#!/usr/bin/env node
/**
 * slice-pgn.js — Extract the first N games from a PGN file into a standalone
 * fixture file. Useful for producing reproducible small samples from a large
 * source PGN for testing the analyzer / frontend.
 *
 * Usage:
 *   node analyzer/slice-pgn.js <input.pgn> <count> [output.pgn]
 *
 * If output.pgn is omitted, writes to stdout.
 */

const fs = require('fs');

const inputPath = process.argv[2];
const count = parseInt(process.argv[3], 10);
const outputPath = process.argv[4];

if (!inputPath || !Number.isFinite(count) || count <= 0) {
  console.error('usage: node slice-pgn.js <input.pgn> <count> [output.pgn]');
  process.exit(1);
}

const text = fs.readFileSync(inputPath, 'utf8');
// Same split as build-index.js: blank line followed by `[` of next game.
const games = text.split(/\r?\n\r?\n(?=\[)/).filter(g => g.trim().length > 0);
const total = games.length;
const slice = games.slice(0, count);

// Re-join with the canonical PGN game separator (CRLF blank line). The split
// strips the separator, so we re-emit it. Trailing CRLF after last game keeps
// a clean EOF — harmless if doubled, but most parsers expect line termination.
const output = slice.join('\r\n\r\n') + '\r\n';

if (outputPath) {
  fs.writeFileSync(outputPath, output);
  console.error(`wrote ${slice.length} of ${total} games to ${outputPath} (${output.length} bytes)`);
} else {
  process.stdout.write(output);
}

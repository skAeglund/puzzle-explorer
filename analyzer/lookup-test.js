#!/usr/bin/env node
// Round-trip sanity check: pick puzzles from a body shard, look each one up
// via its own start FEN, confirm the index returns it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Chess } = require('chess.js');
const { fenPositionKey, SHARD_HEX_LEN } = require('../lib/posKey');

function shardId(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, SHARD_HEX_LEN);
}

const DATA = process.argv[2] || './data';

// Pick first 5 puzzles from any non-empty body shard
const bodyDir = path.join(DATA, 'puzzles');
const firstShard = fs.readdirSync(bodyDir).find(f => f.endsWith('.ndjson'));
const lines = fs.readFileSync(path.join(bodyDir, firstShard), 'utf8').trim().split('\n');
const sample = lines.slice(0, Math.min(5, lines.length)).map(JSON.parse);

let allGood = true;
for (const p of sample) {
  const key = fenPositionKey(p.fen);
  const sid = shardId(key);
  const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index', `${sid}.json`), 'utf8'));
  const matches = idx[key] || [];
  const ids = matches.map(m => m[0]);
  const ok = ids.includes(p.id);
  console.log(`puzzle ${p.id}  shard ${sid}  matches:${matches.length}  found_self:${ok ? 'YES' : 'NO'}`);
  if (!ok) allGood = false;
}

// Also: pick a known opening position (after 1.e4 e5) and see how many puzzles it reaches
const c = new Chess();
c.move('e4'); c.move('e5');
const k = fenPositionKey(c.fen());
const sid = shardId(k);
const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index', `${sid}.json`), 'utf8'));
const matches = idx[k] || [];
console.log(`\nposition after 1.e4 e5  → shard ${sid}  → ${matches.length} matching puzzles`);
if (matches.length) {
  console.log('first 3 matches:', matches.slice(0, 3));
}

// Also verify the solution UCI by replaying one puzzle
const test = sample[1] || sample[0];
console.log(`\nreplay solution for puzzle ${test.id}:`);
const board = new Chess(test.fen);
console.log(`  start FEN: ${test.fen}`);
console.log(`  side to move: ${board.turn()}`);
for (const uci of test.moves) {
  const from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci[4];
  const m = board.move({ from, to, promotion: promo });
  console.log(`  ${uci}  →  ${m ? m.san : 'ILLEGAL'}`);
  if (!m) { allGood = false; break; }
}

console.log(allGood ? '\n✓ all checks passed' : '\n✗ some checks failed');
process.exit(allGood ? 0 : 1);

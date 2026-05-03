#!/usr/bin/env node
/**
 * size-stats.js — Analyze a built data/ dir, breaking down where the bytes go.
 *
 * Histograms over the index entries (entries-per-position, rating, ply) and
 * the body fields (which fields contribute what % of body bytes). Lets you
 * pick filter thresholds against real data instead of guessing.
 *
 * Usage:
 *   node analyzer/size-stats.js [data-dir]            (default ./data)
 *   node analyzer/size-stats.js [data-dir] --sample N (sample N shards instead of all 4096)
 *
 * Sample mode is for fast iteration on multi-GB data: a uniform-random sample
 * of N shards out of 4096 is statistically representative within ~3% margin
 * for N=200, ~1% for N=2000.
 */

const fs = require('fs');
const path = require('path');

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
    } else { pos.push(a); }
  }
  return { pos, flags };
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const DATA_DIR = pos[0] || './data';
const SAMPLE = flags.sample ? parseInt(flags.sample, 10) : 0;

if (!fs.existsSync(DATA_DIR)) {
  console.error('data dir not found: ' + DATA_DIR);
  process.exit(1);
}
const indexDir = path.join(DATA_DIR, 'index');
const puzzlesDir = path.join(DATA_DIR, 'puzzles');

// ─── pick shards ─────────────────────────────────────────────────────────
const allShards = fs.readdirSync(indexDir).filter(f => f.endsWith('.json'));
let shardsToScan = allShards;
if (SAMPLE > 0 && SAMPLE < allShards.length) {
  // Deterministic uniform sample by hash-mod (so reruns are comparable)
  shardsToScan = allShards.filter((_, i) => (i * 2654435761) % allShards.length < SAMPLE);
  shardsToScan = shardsToScan.slice(0, SAMPLE);
}
console.log(`Scanning ${shardsToScan.length} of ${allShards.length} index shards${SAMPLE ? ' (sampled)' : ''}`);
const sampleRatio = shardsToScan.length / allShards.length;
const projectedMul = 1 / sampleRatio;

// ─── histogram helpers ───────────────────────────────────────────────────
function bucket(value, edges) {
  for (let i = 0; i < edges.length; i++) {
    if (value <= edges[i]) return i;
  }
  return edges.length;
}
function histLabels(edges, unit) {
  const labels = [];
  for (let i = 0; i <= edges.length; i++) {
    if (i === 0) labels.push(`≤ ${edges[0]}${unit || ''}`);
    else if (i === edges.length) labels.push(`> ${edges[i - 1]}${unit || ''}`);
    else labels.push(`${edges[i - 1] + 1}–${edges[i]}${unit || ''}`);
  }
  return labels;
}

// ─── index analysis ──────────────────────────────────────────────────────
const entriesPerPosEdges = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const ratingEdges = [600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];
const plyEdges = [4, 8, 12, 16, 20, 24, 28, 32, 40, 50];

const entriesPerPosHist = new Array(entriesPerPosEdges.length + 1).fill(0);
const ratingHist = new Array(ratingEdges.length + 1).fill(0);
const plyHist = new Array(plyEdges.length + 1).fill(0);
const ratingByteContrib = new Array(ratingEdges.length + 1).fill(0); // approximate bytes that would be saved by floor at edge
let totalIndexBytes = 0;
let totalEntries = 0;
let totalPositions = 0;

let scanned = 0;
const t0 = Date.now();
for (const f of shardsToScan) {
  const fp = path.join(indexDir, f);
  const text = fs.readFileSync(fp, 'utf8');
  totalIndexBytes += text.length;
  const obj = JSON.parse(text);
  for (const k in obj) {
    const arr = obj[k];
    totalPositions++;
    entriesPerPosHist[bucket(arr.length, entriesPerPosEdges)]++;
    for (const e of arr) {
      totalEntries++;
      const rating = typeof e[1] === 'number' ? e[1] : 0;
      const ply = typeof e[3] === 'number' ? e[3] : null;
      ratingHist[bucket(rating, ratingEdges)]++;
      if (ply != null) plyHist[bucket(ply, plyEdges)]++;
      // Estimate bytes per entry: JSON-stringified length + 1 for the comma.
      const entryBytes = JSON.stringify(e).length + 1;
      ratingByteContrib[bucket(rating, ratingEdges)] += entryBytes;
    }
  }
  scanned++;
  if (scanned % 500 === 0) {
    const dt = (Date.now() - t0) / 1000;
    console.log(`  ${scanned}/${shardsToScan.length} (${dt.toFixed(0)}s)`);
  }
}

// ─── body analysis ───────────────────────────────────────────────────────
// Sample fewer body shards (they're slow to read line-by-line). Use first 50
// from shardsToScan; bodies are smaller anyway and field ratios are stable.
const bodyShardsToScan = shardsToScan.slice(0, Math.min(50, shardsToScan.length));
const fieldByteSum = Object.create(null);
let totalBodies = 0;
let totalBodyBytes = 0;
for (const f of bodyShardsToScan) {
  const fp = path.join(puzzlesDir, f.replace(/\.json$/, '.ndjson'));
  if (!fs.existsSync(fp)) continue;
  const text = fs.readFileSync(fp, 'utf8');
  totalBodyBytes += text.length;
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let body;
    try { body = JSON.parse(line); } catch (e) { continue; }
    totalBodies++;
    for (const k in body) {
      const v = body[k];
      // Approximate field bytes: key + value + JSON overhead. ~serialize
      // each key:value standalone to get a stable measurement.
      const bytes = JSON.stringify(k).length + JSON.stringify(v).length + 2;
      fieldByteSum[k] = (fieldByteSum[k] || 0) + bytes;
    }
  }
}

// ─── render ──────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + ' KB';
  return n + ' B';
}
function pct(n, total) { return ((n / total) * 100).toFixed(1) + '%'; }

function renderHist(name, hist, edges, unit) {
  const labels = histLabels(edges, unit);
  const total = hist.reduce((a, b) => a + b, 0);
  console.log(`\n--- ${name} ---`);
  for (let i = 0; i < hist.length; i++) {
    const count = hist[i];
    const bar = '█'.repeat(Math.round((count / total) * 40));
    console.log(`  ${labels[i].padStart(12)}: ${count.toString().padStart(12)} (${pct(count, total).padStart(6)})  ${bar}`);
  }
}

console.log('\n══════════════ SUMMARY ══════════════');
console.log(`Index bytes scanned:  ${fmtBytes(totalIndexBytes)}`);
console.log(`Index bytes (full):   ${fmtBytes(totalIndexBytes * projectedMul)} (projected from sample)`);
console.log(`Body bytes scanned:   ${fmtBytes(totalBodyBytes)} (${bodyShardsToScan.length} shards)`);
console.log(`Total positions:      ${totalPositions.toLocaleString()}`);
console.log(`Total entries:        ${totalEntries.toLocaleString()}`);
console.log(`Avg entries/position: ${(totalEntries / totalPositions).toFixed(2)}`);
console.log(`Total bodies sampled: ${totalBodies.toLocaleString()}`);

renderHist('Entries per position', entriesPerPosHist, entriesPerPosEdges);
renderHist('Rating distribution',  ratingHist, ratingEdges);
renderHist('Ply distribution',     plyHist, plyEdges);

// ─── projected savings tables ────────────────────────────────────────────
console.log('\n--- Projected savings: rating floor ---');
console.log('  (assumes uniform impact across both index entries and bodies)');
let cumBytes = 0;
let cumEntries = 0;
for (let i = 0; i < ratingEdges.length; i++) {
  cumBytes += ratingByteContrib[i];
  cumEntries += ratingHist[i];
  const indexSaved = cumBytes * projectedMul;
  const bodyFractionDropped = cumEntries / totalEntries;
  // Bodies don't scale linearly with index entries (body count = unique
  // puzzles, not entries — entries-per-position-per-puzzle multiplies).
  // Use cumulative-fraction-of-puzzles-below-rating as the body proxy.
  // Approximation: rating floor at edge[i] drops bodies for puzzles where
  // ALL entries are below floor — equivalent to puzzles whose own rating is
  // below floor, which is what we want.
  const bodySavedApprox = bodyFractionDropped * (totalBodyBytes / sampleRatio);
  console.log(`  floor at ${ratingEdges[i]}: ~${fmtBytes(indexSaved)} index + ~${fmtBytes(bodySavedApprox)} body`);
}

console.log('\n--- Projected savings: emission ply cap ---');
let cumPly = 0;
const totalWithPly = plyHist.reduce((a, b) => a + b, 0);
for (let i = plyEdges.length - 1; i >= 0; i--) {
  cumPly += plyHist[i + 1];  // entries strictly above this ply edge
  const cutFrac = cumPly / totalWithPly;
  const indexSaved = cutFrac * (totalIndexBytes * projectedMul);
  console.log(`  cap at ply ${plyEdges[i]}: ${pct(cumPly, totalWithPly)} of entries dropped, ~${fmtBytes(indexSaved)} saved`);
}

console.log('\n--- Body field byte breakdown ---');
const sortedFields = Object.entries(fieldByteSum).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sortedFields) {
  console.log(`  ${k.padEnd(15)}: ${fmtBytes(v).padStart(10)} (${pct(v, totalBodyBytes)})`);
}

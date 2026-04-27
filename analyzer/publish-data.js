#!/usr/bin/env node
// Force-push ./data/ to the puzzle-explorer-data sibling repo.
//
// Why a sibling repo: each rebuild rewrites all 4096 shards. Force-pushing a
// fresh tree on every rebuild keeps .git at ~working-tree size (~2.4GB at
// full scale) instead of accumulating 2.4GB of pack delta per build.
//
// First-time setup (do once, manually):
//   1. Create empty public repo skAeglund/puzzle-explorer-data on github.com
//      (no README, no license, no .gitignore — must be empty).
//   2. Settings → Pages → Source: Deploy from a branch → main / root → Save.
//   3. Extend the existing fine-grained PAT to include the new repo with
//      Contents: Read and write. (Or generate a separate PAT.)
//   4. cd data
//      git init -b main
//      git remote add origin https://<PAT>@github.com/skAeglund/puzzle-explorer-data.git
//
// Then on every rebuild: node analyzer/publish-data.js
//
// The ./data dir lives inside the puzzle-explorer working tree but is its own
// git repo (data/ is gitignored by the parent so they don't collide).

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: DATA_DIR, stdio: opts.silent ? 'pipe' : 'inherit', encoding: 'utf8' });
}

if (!fs.existsSync(DATA_DIR)) {
  fail('./data does not exist; run analyzer/build-index.js first.');
}
if (!fs.existsSync(path.join(DATA_DIR, 'index')) || !fs.existsSync(path.join(DATA_DIR, 'puzzles'))) {
  fail('./data is missing index/ or puzzles/; run analyzer/build-index.js first.');
}
if (!fs.existsSync(path.join(DATA_DIR, '.git'))) {
  fail([
    './data is not initialized as a git repo. First-time setup:',
    '  cd data',
    '  git init -b main',
    '  git remote add origin https://<PAT>@github.com/skAeglund/puzzle-explorer-data.git',
    '',
    'Then re-run this script.',
  ].join('\n'));
}

let remote;
try {
  remote = run('git remote get-url origin', { silent: true }).trim();
} catch (e) {
  fail('origin remote not configured in ./data. See script header for setup steps.');
}
// Mask PAT in display.
console.log(`pushing ./data → ${remote.replace(/\/\/[^@]+@/, '//<PAT>@')}`);

run('git add -A');

const stamp = new Date().toISOString().replace('T', ' ').replace(/\..*/, '');
const commitCmd = [
  'git',
  '-c', 'user.name=skAeglund',
  '-c', 'user.email=skaeglund@users.noreply.github.com',
  'commit', '-m', `"data: rebuild ${stamp}"`,
].join(' ');
try {
  run(commitCmd);
} catch (e) {
  // No-op when the working tree is clean (e.g. running script twice without rebuilding).
  console.log('(nothing to commit — pushing existing HEAD)');
}

run('git push --force origin main');
console.log('\n✓ data pushed.');

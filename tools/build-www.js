#!/usr/bin/env node
/**
 * build-www.js — assemble the Capacitor web root (./www) from the app source.
 *
 * The repo has no bundler; the "build" is a copy. Capacitor copies whatever is
 * in webDir (./www, per capacitor.config.json) into the native project's assets
 * on `npx cap sync`, so www must contain the full app shell: index.html, the
 * lib/ tree (incl. vendor), icons/, sounds/, and the manifest. analyzer/, data/,
 * tests, node_modules and the like are deliberately excluded — they're build-
 * time/Node-only and have no business in the APK.
 *
 * sw.js is intentionally NOT copied: the native build serves the shell from the
 * APK and skips SW registration (see index.html), so shipping a service worker
 * would be dead weight at best.
 *
 * Run:  node tools/build-www.js   (then: npx cap sync android)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');

// Files + directories that make up the shippable app shell.
const FILES = ['index.html', 'manifest.webmanifest'];
const DIRS  = ['lib', 'icons', 'sounds'];

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

let count = 0;
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.error('  ! missing: ' + f); process.exit(1); }
  fs.copyFileSync(src, path.join(OUT, f));
  count++;
}
for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (!fs.existsSync(src)) { console.error('  ! missing dir: ' + d); process.exit(1); }
  copyDir(src, path.join(OUT, d));
}

console.log('www assembled → ' + OUT);
console.log('  ' + count + ' top-level files + dirs: ' + DIRS.join(', '));
console.log('  next: npx cap sync android');

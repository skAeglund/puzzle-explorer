#!/usr/bin/env node
/**
 * publish-bundle.js — produce an OTA web bundle + manifest for the native app.
 *
 * The installed APK checks a static manifest on launch (lib/liveUpdate.js) and,
 * if a newer bundle exists, downloads + applies it on the next launch — no APK
 * rebuild needed for web-layer changes. This script produces the two artifacts
 * that drive that, ready to upload to the data Pages repo:
 *
 *   dist-bundle/app/app-manifest.json     { version, url, sha256, builtAt, minNative }
 *   dist-bundle/app/bundles/<version>.zip the zipped web bundle (index.html at root)
 *
 * Steps:
 *   1. bump bundle-version.json (integer +1) unless --no-bump
 *   2. assemble www/ (runs build-www.js logic) so the bundle carries the new
 *      bundle-version.json
 *   3. zip the CONTENTS of www/ → bundles/<version>.zip
 *   4. write app-manifest.json pointing at that zip's public URL
 *
 * Then upload dist-bundle/app/* to the puzzle-explorer-data repo under app/ and
 * push (Pages serves it with ACAO:* so the WebView can read the manifest; the
 * native plugin downloads the zip directly).
 *
 * IMPORTANT: build a fresh APK only when native changes (a new Capacitor plugin
 * or capacitor.config edit). For web-only changes, just run this and upload —
 * the APK's built-in bundle already carries whatever version it was built with,
 * and resetWhenUpdate:true means a future APK install supersedes OTA cleanly.
 *
 * Run:  node tools/publish-bundle.js [--no-bump] [--base-url <url>]
 *   --base-url defaults to the data Pages repo. The manifest url is
 *   <base-url>/app/bundles/<version>.zip.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
let AdmZip;
try { AdmZip = require('adm-zip'); }
catch (e) { console.error('Missing dep: run `npm install` (adm-zip).'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'bundle-version.json');
const WWW = path.join(ROOT, 'www');
const OUT = path.join(ROOT, 'dist-bundle', 'app');

const args = process.argv.slice(2);
const noBump = args.indexOf('--no-bump') !== -1;
const baseIdx = args.indexOf('--base-url');
const BASE_URL = (baseIdx !== -1 && args[baseIdx + 1])
  ? args[baseIdx + 1].replace(/\/+$/, '')
  : 'https://skaeglund.github.io/puzzle-explorer-data';

// 1. version
let vf;
try { vf = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); }
catch (e) { console.error('cannot read bundle-version.json'); process.exit(1); }
if (typeof vf.version !== 'number') { console.error('bundle-version.json: version must be a number'); process.exit(1); }
if (!noBump) { vf.version += 1; fs.writeFileSync(VERSION_FILE, JSON.stringify(vf, null, 2) + '\n'); }
const version = vf.version;
console.log('bundle version: ' + version + (noBump ? ' (not bumped)' : ' (bumped)'));

// 2. assemble www (delegates to build-www.js so there's one source of truth)
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-www.js')], { stdio: 'inherit' });

// 3. zip contents of www/ (index.html must sit at the zip root)
fs.rmSync(path.join(ROOT, 'dist-bundle'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'bundles'), { recursive: true });
const zip = new AdmZip();
zip.addLocalFolder(WWW);            // adds www/* at the archive root
const zipName = version + '.zip';
const zipPath = path.join(OUT, 'bundles', zipName);
zip.writeZip(zipPath);
const buf = fs.readFileSync(zipPath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
console.log('bundle zip: ' + zipPath + '  (' + (buf.length / 1024).toFixed(0) + ' KB)');

// 4. manifest
const manifest = {
  version: version,
  url: BASE_URL + '/app/bundles/' + zipName,
  sha256: sha256,
  builtAt: new Date().toISOString(),
  minNative: 1   // forward hook; not enforced at runtime yet (see lib/liveUpdate.js)
};
fs.writeFileSync(path.join(OUT, 'app-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('\nmanifest → ' + path.join(OUT, 'app-manifest.json'));
console.log(JSON.stringify(manifest, null, 2));
console.log('\nNext: copy dist-bundle/app/* into the puzzle-explorer-data repo under app/ and push.');
console.log('The installed APK will pick up v' + version + ' on its next launch.');

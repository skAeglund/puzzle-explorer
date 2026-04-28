#!/usr/bin/env node
/**
 * url-normalize-test.js — Lock the gameUrl normalization behavior added
 * in issue #5. Han Schut's PGN sometimes emits scheme-less Site headers
 * (e.g. 'lichess.org/training/...'), which the frontend's <a href>
 * resolved as relative-to-host and 404'd. The analyzer now prepends
 * https:// at build time; the frontend duplicates the same logic at
 * render time as defense in depth.
 *
 * Run: node analyzer/url-normalize-test.js
 */

const { normalizeExternalUrl } = require('./build-index');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

section('normalizeExternalUrl — bug fix path (scheme-less)');
{
  check('lichess.org/training/123 → https://...',
    normalizeExternalUrl('lichess.org/training/123') === 'https://lichess.org/training/123');
  check('lichess.org → https://lichess.org',
    normalizeExternalUrl('lichess.org') === 'https://lichess.org');
  check('example.com/path?query=1 → https://...',
    normalizeExternalUrl('example.com/path?query=1') === 'https://example.com/path?query=1');
}

section('normalizeExternalUrl — already-qualified URLs are passed through');
{
  check('https URL unchanged',
    normalizeExternalUrl('https://lichess.org/training/123') === 'https://lichess.org/training/123');
  check('http URL unchanged (no HSTS upgrade)',
    normalizeExternalUrl('http://lichess.org/training/123') === 'http://lichess.org/training/123');
  check('protocol-relative // unchanged',
    normalizeExternalUrl('//lichess.org/training/123') === '//lichess.org/training/123');
  check('exotic scheme passed through',
    normalizeExternalUrl('ftp://example.com/file') === 'ftp://example.com/file');
}

section('normalizeExternalUrl — defensive edge cases');
{
  check('empty string → empty', normalizeExternalUrl('') === '');
  check('whitespace-only → empty', normalizeExternalUrl('   ') === '');
  check('null → empty', normalizeExternalUrl(null) === '');
  check('undefined → empty', normalizeExternalUrl(undefined) === '');
  check('number → empty', normalizeExternalUrl(42) === '');
  check('object → empty', normalizeExternalUrl({}) === '');
  check('array → empty', normalizeExternalUrl([]) === '');
  check('leading whitespace trimmed',
    normalizeExternalUrl('  lichess.org/x  ') === 'https://lichess.org/x');
  check('whitespace + qualified URL trimmed but kept',
    normalizeExternalUrl('  https://lichess.org/x  ') === 'https://lichess.org/x');
}

section('normalizeExternalUrl — ambiguous inputs we just prepend');
{
  // We're not in the URL-validation business — if Han's data emits
  // garbage, we still produce SOMETHING, and the user sees a 404 in
  // a new tab rather than getting silently routed to a wrong path on
  // the host. Better than the bug in #5.
  check('hostname only → https://hostname',
    normalizeExternalUrl('localhost') === 'https://localhost');
  check('path-only without host → https://path  (best-effort)',
    normalizeExternalUrl('/training/123') === 'https:///training/123');
}

console.log('\n' + (fail === 0 ? '✓' : '✗') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);

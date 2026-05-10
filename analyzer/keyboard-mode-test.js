#!/usr/bin/env node
/**
 * keyboard-mode-test.js — Verify lib/keyboardMode.js classifies keys
 * into the four logical actions and ignores anything else.
 *
 * Run: node analyzer/keyboard-mode-test.js
 */

const KbMode = require('../lib/keyboardMode');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else      { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

// ─── action constants exist and are distinct ─────────────────────────────
section('action constants');
{
  const A = KbMode.ACTION;
  check('advance defined',      typeof A.advance === 'string' && A.advance.length > 0);
  check('markSuccess defined',  typeof A.markSuccess === 'string' && A.markSuccess.length > 0);
  check('markFail defined',     typeof A.markFail === 'string' && A.markFail.length > 0);
  check('hint defined',         typeof A.hint === 'string' && A.hint.length > 0);
  // All four must be distinct, otherwise the caller can't distinguish them.
  const set = new Set([A.advance, A.markSuccess, A.markFail, A.hint]);
  check('all four actions distinct', set.size === 4);
}

// ─── digit ring: 1=success, 2=advance, 4=fail ────────────────────────────
section('digit ring (1 / 2 / 4)');
{
  check('"1" → markSuccess', KbMode.classifyKey('1') === KbMode.ACTION.markSuccess);
  check('"2" → advance',     KbMode.classifyKey('2') === KbMode.ACTION.advance);
  check('"4" → markFail',    KbMode.classifyKey('4') === KbMode.ACTION.markFail);
  // 3 is intentionally unbound — confirms the project's spec ("Key 1/2/4
  // only") and ensures we haven't accidentally bound it to something else.
  check('"3" is unbound',    KbMode.classifyKey('3') === null);
}

// ─── media ring: prev=fail, pause=advance, next=success ─────────────────
section('media ring');
{
  check('MediaTrackPrevious → markFail',
    KbMode.classifyKey('MediaTrackPrevious') === KbMode.ACTION.markFail);
  check('MediaPlayPause → advance',
    KbMode.classifyKey('MediaPlayPause')     === KbMode.ACTION.advance);
  check('MediaTrackNext → markSuccess',
    KbMode.classifyKey('MediaTrackNext')     === KbMode.ACTION.markSuccess);
}

// ─── hint binding ────────────────────────────────────────────────────────
section('hint binding');
{
  check('AudioVolumeUp → hint',
    KbMode.classifyKey('AudioVolumeUp') === KbMode.ACTION.hint);
  // Volume DOWN is unbound — it's the natural counterpart but has no
  // assigned semantic, so it must NOT classify (defensive check against
  // a future change accidentally extending the mapping).
  check('AudioVolumeDown is unbound',
    KbMode.classifyKey('AudioVolumeDown') === null);
  check('AudioVolumeMute is unbound',
    KbMode.classifyKey('AudioVolumeMute') === null);
}

// ─── consistency between maps ────────────────────────────────────────────
// digit-ring success and media-ring success must classify to the same
// ACTION constant — otherwise the caller's switch statement would have
// to know about both vocabularies, defeating the whole point.
section('cross-vocabulary consistency');
{
  check('1 and MediaTrackNext both → markSuccess',
    KbMode.classifyKey('1') === KbMode.classifyKey('MediaTrackNext'));
  check('2 and MediaPlayPause both → advance',
    KbMode.classifyKey('2') === KbMode.classifyKey('MediaPlayPause'));
  check('4 and MediaTrackPrevious both → markFail',
    KbMode.classifyKey('4') === KbMode.classifyKey('MediaTrackPrevious'));
}

// ─── unbound / pass-through behavior ─────────────────────────────────────
// Caller relies on null for "key isn't ours, fall through to existing
// handlers." These are the keys most likely to coexist with kb mode in
// practice, so failure here would silently break Escape, arrow nav, etc.
section('unbound keys (caller falls through)');
{
  const unbound = [
    'Escape', 'Enter', 'Tab', ' ', 'Backspace',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Home', 'End', 'PageUp', 'PageDown',
    'a', 'z', 'A', 'Z', '0', '5', '9',
    'F1', 'F5', 'Shift', 'Control', 'Alt', 'Meta'
  ];
  let allNull = true;
  let firstNonNull = null;
  for (const k of unbound) {
    if (KbMode.classifyKey(k) !== null) { allNull = false; firstNonNull = k; break; }
  }
  check('common unbound keys all → null', allNull,
    firstNonNull ? `unexpected binding for "${firstNonNull}"` : '');
}

// ─── defensive input handling ────────────────────────────────────────────
section('defensive inputs');
{
  check('null input → null',       KbMode.classifyKey(null) === null);
  check('undefined input → null',  KbMode.classifyKey(undefined) === null);
  check('empty string → null',     KbMode.classifyKey('') === null);
  check('number input → null',     KbMode.classifyKey(1) === null);
  check('object input → null',     KbMode.classifyKey({}) === null);
  // Prototype keys must NOT classify — a naive `key in KEY_MAP` lookup
  // would bind 'toString' etc. The implementation uses hasOwnProperty
  // to guard against this; verify behaviorally.
  check('"toString" → null',       KbMode.classifyKey('toString') === null);
  check('"hasOwnProperty" → null', KbMode.classifyKey('hasOwnProperty') === null);
  check('"__proto__" → null',      KbMode.classifyKey('__proto__') === null);
}

// ─── case sensitivity ────────────────────────────────────────────────────
// event.key for media keys uses exact casing ('MediaTrackNext'). Lower-
// or upper-case variants would never appear in real DOM events; assert
// they don't sneak in via fuzzy matching.
section('case sensitivity');
{
  check('"mediatracknext" (lowercase) → null',
    KbMode.classifyKey('mediatracknext') === null);
  check('"MEDIATRACKNEXT" (uppercase) → null',
    KbMode.classifyKey('MEDIATRACKNEXT') === null);
  check('"audiovolumeup" → null',
    KbMode.classifyKey('audiovolumeup') === null);
}

// ─── KEY_MAP exposure ────────────────────────────────────────────────────
// The map is exposed for tests + tooling. Verify shape (every value is
// one of the ACTION constants).
section('KEY_MAP shape');
{
  const validValues = new Set([
    KbMode.ACTION.advance,
    KbMode.ACTION.markSuccess,
    KbMode.ACTION.markFail,
    KbMode.ACTION.hint
  ]);
  let allValid = true;
  let badKey = null;
  for (const k in KbMode.KEY_MAP) {
    if (!Object.prototype.hasOwnProperty.call(KbMode.KEY_MAP, k)) continue;
    if (!validValues.has(KbMode.KEY_MAP[k])) { allValid = false; badKey = k; break; }
  }
  check('every KEY_MAP value is an ACTION constant', allValid,
    badKey ? `bad mapping for "${badKey}"` : '');
}

// ─── summary ─────────────────────────────────────────────────────────────
console.log('\n— summary —');
console.log('  passed: ' + pass);
console.log('  failed: ' + fail);
process.exit(fail === 0 ? 0 : 1);

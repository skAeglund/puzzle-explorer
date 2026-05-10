/**
 * keyboardMode.js — Pure key→action mapper for the no-mouse drill flow.
 *
 * Mode B (self-graded study): the user navigates a puzzle entirely from
 * a Bluetooth ring or keyboard. Three logical actions:
 *   - advance: play the next correct user move (silent — no attempt logged)
 *   - mark_success: at completion, "I knew it" → markSeen / Easy (no
 *                   wrong, no hint). Hint flips to Hard via the existing
 *                   hint-cap rule downstream.
 *   - mark_fail:    at completion, "I missed it" → recordReview(Again).
 *   - hint:         reveal the from-square of the next move.
 *
 * Two ring vocabularies are supported in parallel — number keys 1/2/4
 * for the digit ring, MediaTrackPrevious / MediaPlayPause / MediaTrackNext
 * for the media ring. AudioVolumeUp is bound for hint as a best-effort:
 * most browser/OS combos swallow Volume keys at the OS layer and the
 * keydown event never fires, but on the rigs that DO surface it, hint
 * works for free.
 *
 * This module does NO state inspection — the caller decides whether the
 * action is currently legal (e.g. mark_success is only valid when the
 * puzzle is complete). classifyKey returns the user's intent; the caller
 * gates on game state.
 *
 * Media-ring mapping: prev=fail, next=success. Forward arrow = "move on,
 * I knew it" matches how people instinctively skip media tracks they're
 * happy with, and pairs the two extreme keys with the two extreme grades.
 *
 * Dual-mode load (Node + browser):
 *   Node:    const KbMode = require('../lib/keyboardMode');
 *   Browser: <script src="lib/keyboardMode.js"></script>  (defines window.KeyboardMode)
 */
(function (root) {
  'use strict';

  // Action identifiers. Strings (not numbers) so log lines + test failures
  // are self-describing without a separate enum lookup.
  var ACTION = {
    advance: 'advance',
    markSuccess: 'mark_success',
    markFail: 'mark_fail',
    hint: 'hint'
  };

  // event.key strings → action. Branch on event.key (not event.code) for
  // cross-keyboard compat: Digit1 and Numpad1 both produce '1' on .key,
  // and the media keys only have .key strings.
  //
  // Single object so adding/changing a binding is a one-line edit and
  // tests have a single source of truth to assert against.
  var KEY_MAP = {
    // Digit ring
    '1': ACTION.markSuccess,
    '2': ACTION.advance,
    '4': ACTION.markFail,
    // Media ring — prev=fail, next=success per the design note above.
    'MediaTrackPrevious': ACTION.markFail,
    'MediaPlayPause':     ACTION.advance,
    'MediaTrackNext':     ACTION.markSuccess,
    // Hint — best-effort; usually absorbed by the OS, see file header.
    'AudioVolumeUp':      ACTION.hint
  };

  // classifyKey(key) → action string | null
  // Returns null for any key the mode doesn't bind, so the caller can
  // fall through to its existing handlers (Escape, arrow nav, etc.).
  function classifyKey(key) {
    if (typeof key !== 'string' || !key) return null;
    return Object.prototype.hasOwnProperty.call(KEY_MAP, key) ? KEY_MAP[key] : null;
  }

  // Convenience for tests + caller switch statements.
  var api = {
    ACTION: ACTION,
    KEY_MAP: KEY_MAP,
    classifyKey: classifyKey
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.KeyboardMode = api;
  }
})(typeof self !== 'undefined' ? self : this);

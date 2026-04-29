/**
 * sound.js — minimal audio playback for puzzle-explorer.
 *
 * Drilling-only sound surface: move / capture / check / wrong-move / completion.
 * Search mode is intentionally silent (would feel chatty during position setup).
 *
 * Pure classifier (classifyMove) is testable in Node; the rest is browser-only
 * (Audio API). Following the same dual-mode IIFE pattern as posKey/fsrs/drill/
 * progress, but the play()/init() side-effecting bits no-op gracefully under
 * Node since `typeof Audio === 'undefined'`.
 *
 * Sounds bundled under sounds/ — see README for licensing (Lichess + Enigmahack,
 * AGPLv3+). Only mp3 is shipped; modern browsers (incl. Safari) handle mp3 fine,
 * so the .ogg fallbacks would just double bundle size for no benefit.
 *
 *   move          standard/Move.mp3
 *   capture       standard/Capture.mp3
 *   check         sfx/Check.mp3        (also used for mate)
 *   error         standard/Error.mp3   (wrong move)
 *   confirmation  standard/Confirmation.mp3  (puzzle solved)
 *
 * Note: the lila standard set ships Check.mp3 as a symlink to Silence.mp3
 * (Lichess plays nothing on check by default). Our bundle pulls Check from
 * the sfx set instead, where it's a real sound, same composer (Enigmahack).
 *
 * Toggle persists in localStorage as 'puzzle_explorer_sound' = '1' | '0'.
 * Default is on. Defensive: localStorage failure / autoplay rejection /
 * missing Audio constructor all degrade silently.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'puzzle_explorer_sound';
  var SOUND_FILES = {
    move:         'sounds/Move.mp3',
    capture:      'sounds/Capture.mp3',
    check:        'sounds/Check.mp3',
    error:        'sounds/Error.mp3',
    confirmation: 'sounds/Confirmation.mp3'
  };
  var VOLUME = 0.4;  // matches Lichess's quietish default; nothing scientific

  var audioMap = null;       // populated by init() in browser; null in Node
  var enabled = true;        // overridden by localStorage in init()

  // ─── pure classifier ────────────────────────────────────────────────────
  // Returns the sound key for a chess move. Inputs:
  //   move         — chess.js move object (must have .flags); falsy → null
  //   inCheck      — boolean: is the side-to-move now in check?
  //   inCheckmate  — boolean: is it checkmate?
  // Priority: mate/check > capture > move. Mate and check share the 'check'
  // key (Checkmate.mp3 is symlinked to Check.mp3 in lila's sfx set anyway,
  // and we want the completion fanfare to carry the "puzzle solved" weight,
  // not a separate mate sound). Castling falls through to 'move' — the
  // standard set has no dedicated castle sound.
  function classifyMove(move, inCheck, inCheckmate) {
    if (!move) return null;
    if (inCheckmate || inCheck) return 'check';
    var flags = move.flags || '';
    if (flags.indexOf('c') !== -1 || flags.indexOf('e') !== -1) return 'capture';
    return 'move';
  }

  // ─── browser-only side effects ──────────────────────────────────────────
  function init() {
    // Load persisted toggle, if available. Defensive against private mode
    // / disabled storage — keep `enabled = true` default on any failure.
    try {
      if (typeof localStorage !== 'undefined') {
        var saved = localStorage.getItem(STORAGE_KEY);
        if (saved === '0') enabled = false;
      }
    } catch (e) { /* no-op */ }

    // Preload Audio elements. No-op outside browser (Node tests, etc.).
    if (typeof Audio === 'undefined') return;
    audioMap = {};
    Object.keys(SOUND_FILES).forEach(function (key) {
      try {
        var a = new Audio(SOUND_FILES[key]);
        a.preload = 'auto';
        a.volume = VOLUME;
        audioMap[key] = a;
      } catch (e) { /* skip — playback for this key will just no-op */ }
    });
  }

  function play(key) {
    if (!enabled) return;
    if (!audioMap || !audioMap[key]) return;
    var a = audioMap[key];
    try {
      // Reset to 0 so rapid repeat plays (e.g. user move → opp reply within
      // 400ms) re-trigger from the start instead of being ignored as
      // "already playing".
      a.currentTime = 0;
      var p = a.play();
      // Browser autoplay-blocking returns a rejected Promise — swallow it
      // so we don't pollute the console with unhandled rejections. Once
      // the user has clicked anything (e.g. a result row), subsequent
      // play() calls will resolve fine.
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* no-op */ }
  }

  function playForMove(move, inCheck, inCheckmate) {
    var key = classifyMove(move, inCheck, inCheckmate);
    if (key) play(key);
  }

  function setEnabled(v) {
    enabled = !!v;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
      }
    } catch (e) { /* quota / private mode — toggle still works for the session */ }
  }

  function isEnabled() { return enabled; }

  var api = {
    classifyMove: classifyMove,
    init: init,
    play: play,
    playForMove: playForMove,
    setEnabled: setEnabled,
    isEnabled: isEnabled
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Sound = api;
  }
})(typeof self !== 'undefined' ? self : this);

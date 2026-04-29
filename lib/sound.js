/**
 * sound.js — minimal audio playback for puzzle-explorer.
 *
 * Drilling-only sound surface, physical moves only: move / capture / check /
 * castle. No meta-feedback chimes (no wrong-move ding, no completion fanfare).
 * Search mode is intentionally silent (would feel chatty during position setup).
 *
 * Pure classifier (classifyMove) is testable in Node; the rest is browser-only
 * (Audio API). Following the same dual-mode IIFE pattern as posKey/fsrs/drill/
 * progress, but the play()/init() side-effecting bits no-op gracefully under
 * Node since `typeof Audio === 'undefined'`.
 *
 * Sounds bundled under sounds/ — see README for licensing. Mixed sources:
 *   move      Move.mp3      (lila standard, AGPLv3+)
 *   capture   Capture.mp3   (lila standard, AGPLv3+)
 *   check     Check.mp3     (chess.com default theme)
 *   castle    Castle.mp3    (chess.com default theme)
 *
 * Toggle persists in localStorage as 'puzzle_explorer_sound' = '1' | '0'.
 * Default is on. Defensive: localStorage failure / autoplay rejection /
 * missing Audio constructor all degrade silently.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'puzzle_explorer_sound';
  var SOUND_FILES = {
    move:    'sounds/Move.mp3',
    capture: 'sounds/Capture.mp3',
    check:   'sounds/Check.mp3',
    castle:  'sounds/Castle.mp3'
  };
  var VOLUME = 0.4;  // matches Lichess's quietish default; nothing scientific

  var audioMap = null;       // populated by init() in browser; null in Node
  var enabled = true;        // overridden by localStorage in init()

  // ─── pure classifier ────────────────────────────────────────────────────
  // Returns the sound key for a chess move. Inputs:
  //   move         — chess.js move object (must have .flags); falsy → null
  //   inCheck      — boolean: is the side-to-move now in check?
  //   inCheckmate  — boolean: is it checkmate?
  // Priority: mate/check > castle > capture > move. Check wins over castle
  // because castling-into-check (e.g. O-O+ vacating a rank for a discovered
  // check) is rare but real, and the check status is more meaningful to the
  // player than the move type. Mate and check share the 'check' key.
  function classifyMove(move, inCheck, inCheckmate) {
    if (!move) return null;
    if (inCheckmate || inCheck) return 'check';
    var flags = move.flags || '';
    if (flags.indexOf('k') !== -1 || flags.indexOf('q') !== -1) return 'castle';
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

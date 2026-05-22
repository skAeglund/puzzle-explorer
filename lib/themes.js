/**
 * themes.js — canonical Lichess puzzle-theme vocabulary + integer codec +
 * the curated subset exposed in the theme-filter UI. Shared between the
 * Node-side pipeline (build-index.js, filter-data.js) and the browser-side
 * runtime (the #sessionPanel theme chips).
 *
 * Loaded in Node via:    const Themes = require('../lib/themes');
 * Loaded in browser via: <script src="lib/themes.js"></script>  (global `Themes`)
 *
 * ─── how themes flow through the system ───
 * Bodies carry the FULL theme list as strings (build-index.js splits the
 * PuzzleThemes PGN header). The INDEX carries a compact, CURATED-ONLY array
 * of integer codes per entry at m[5] — see encodeThemes(). Runtime theme
 * filtering (Session.filterByTheme) is a pure integer-set intersection over
 * m[5]; it never needs this module. This module is needed only at the two
 * ends: encoding (build/filter) and the UI (curated chips + key→code).
 *
 * ─── the one hard rule: THEME_LIST IS APPEND-ONLY ───
 * A theme's CODE is its index in THEME_LIST. The published index stores
 * those codes. Reordering or removing an entry silently remaps every code
 * in every already-published shard. So:
 *   - NEVER reorder THEME_LIST.
 *   - NEVER remove an entry.
 *   - New themes go at the END only.
 * Curation (which themes the UI exposes) is separate and free to change —
 * it only affects what gets encoded on the NEXT --add-themes/republish, and
 * it references stable codes, so widening CURATED later just needs a cheap
 * `filter-data.js --add-themes` re-run, not a vocabulary change.
 */
(function (root) {
  'use strict';

  // ─── canonical vocabulary (APPEND-ONLY — see header) ───
  // The full Lichess puzzle-theme key set. Index = code. Themes seen in the
  // data that are NOT in this list are dropped at encode time (counted by
  // the caller) rather than assigned an unstable code. Phase/length/eval and
  // exotic-mate themes are included so they have stable codes even though
  // most aren't currently curated — widening CURATED later then needs no
  // change here.
  var THEME_LIST = [
    'advancedPawn',        // 0
    'advantage',           // 1
    'anastasiaMate',       // 2
    'arabianMate',         // 3
    'attackingF2F7',       // 4
    'attraction',          // 5
    'backRankMate',        // 6
    'bishopEndgame',       // 7
    'bodenMate',           // 8
    'capturingDefender',   // 9
    'castling',            // 10
    'clearance',           // 11
    'crushing',            // 12
    'defensiveMove',       // 13
    'deflection',          // 14
    'discoveredAttack',    // 15
    'doubleBishopMate',    // 16
    'doubleCheck',         // 17
    'dovetailMate',        // 18
    'endgame',             // 19
    'enPassant',           // 20
    'equality',            // 21
    'exposedKing',         // 22
    'fork',                // 23
    'hangingPiece',        // 24
    'hookMate',            // 25
    'interference',        // 26
    'intermezzo',          // 27
    'kingsideAttack',      // 28
    'knightEndgame',       // 29
    'long',                // 30
    'master',              // 31
    'masterVsMaster',      // 32
    'mate',                // 33
    'mateIn1',             // 34
    'mateIn2',             // 35
    'mateIn3',             // 36
    'mateIn4',             // 37
    'mateIn5',             // 38
    'middlegame',          // 39
    'oneMove',             // 40
    'opening',             // 41
    'pawnEndgame',         // 42
    'pin',                 // 43
    'promotion',           // 44
    'queenEndgame',        // 45
    'queenRookEndgame',    // 46
    'queensideAttack',     // 47
    'quietMove',           // 48
    'rookEndgame',         // 49
    'sacrifice',           // 50
    'short',               // 51
    'skewer',              // 52
    'smotheredMate',       // 53
    'superGM',             // 54
    'trappedPiece',        // 55
    'underPromotion',      // 56
    'veryLong',            // 57
    'xRayAttack',          // 58
    'zugzwang'             // 59
    // ↑ APPEND new themes here, never reorder/remove the above.
  ];

  // key → code, built once from THEME_LIST.
  var CODE_BY_KEY = Object.create(null);
  for (var i = 0; i < THEME_LIST.length; i++) CODE_BY_KEY[THEME_LIST[i]] = i;

  // ─── curated UI groups ───
  // What the theme-filter chips actually expose. Tactical motifs + the
  // common mate patterns + game phase. Order within a group = display order.
  // Every key here MUST exist in THEME_LIST (asserted below in dev).
  var GROUPS = [
    {
      name: 'Tactics',
      keys: [
        'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck',
        'sacrifice', 'deflection', 'attraction', 'clearance', 'interference',
        'intermezzo', 'hangingPiece', 'trappedPiece', 'capturingDefender',
        'xRayAttack', 'quietMove', 'defensiveMove', 'zugzwang',
        'advancedPawn', 'promotion', 'underPromotion'
      ]
    },
    {
      name: 'Mates',
      keys: [
        'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mateIn5',
        'smotheredMate', 'backRankMate'
      ]
    },
    {
      name: 'Phase',
      keys: ['opening', 'middlegame', 'endgame']
    }
  ];

  // Flat curated key list + membership set, derived from GROUPS.
  var CURATED = [];
  for (var g = 0; g < GROUPS.length; g++) {
    for (var k = 0; k < GROUPS[g].keys.length; k++) CURATED.push(GROUPS[g].keys[k]);
  }
  var CURATED_SET = Object.create(null);
  for (var c = 0; c < CURATED.length; c++) CURATED_SET[CURATED[c]] = true;

  // Human labels for the chips. Anything without an explicit label falls
  // back to a prettified key (camelCase → "Camel case").
  var LABELS = {
    fork: 'Fork',
    pin: 'Pin',
    skewer: 'Skewer',
    discoveredAttack: 'Discovered attack',
    doubleCheck: 'Double check',
    sacrifice: 'Sacrifice',
    deflection: 'Deflection',
    attraction: 'Attraction',
    clearance: 'Clearance',
    interference: 'Interference',
    intermezzo: 'Zwischenzug',
    hangingPiece: 'Hanging piece',
    trappedPiece: 'Trapped piece',
    capturingDefender: 'Capture the defender',
    xRayAttack: 'X-ray attack',
    quietMove: 'Quiet move',
    defensiveMove: 'Defensive move',
    zugzwang: 'Zugzwang',
    advancedPawn: 'Advanced pawn',
    promotion: 'Promotion',
    underPromotion: 'Underpromotion',
    mateIn1: 'Mate in 1',
    mateIn2: 'Mate in 2',
    mateIn3: 'Mate in 3',
    mateIn4: 'Mate in 4',
    mateIn5: 'Mate in 5',
    smotheredMate: 'Smothered mate',
    backRankMate: 'Back-rank mate',
    opening: 'Opening',
    middlegame: 'Middlegame',
    endgame: 'Endgame'
  };

  function isCurated(key) { return CURATED_SET[key] === true; }

  function codeFor(key) {
    var v = CODE_BY_KEY[key];
    return (typeof v === 'number') ? v : -1;
  }
  function keyForCode(code) {
    return (code >= 0 && code < THEME_LIST.length) ? THEME_LIST[code] : null;
  }

  function prettify(key) {
    if (typeof key !== 'string' || !key) return '';
    var spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
  }
  function labelFor(key) {
    return Object.prototype.hasOwnProperty.call(LABELS, key) ? LABELS[key] : prettify(key);
  }

  /**
   * encodeThemes(themeStrings) → sorted unique int code array, CURATED-ONLY.
   *
   * Input is a puzzle's theme string array (from a body). Output is what gets
   * stamped at index m[5]: only curated themes are kept (keeps the index
   * lean — non-curated themes can't be filtered on anyway), mapped to their
   * stable codes, deduped, and sorted ascending (determinism + better gzip).
   * Unknown / non-curated / non-string inputs are skipped silently; callers
   * that care about drop counts can diff input vs output length.
   */
  function encodeThemes(themeStrings) {
    if (!Array.isArray(themeStrings)) return [];
    var seen = Object.create(null);
    var codes = [];
    for (var n = 0; n < themeStrings.length; n++) {
      var key = themeStrings[n];
      if (typeof key !== 'string') continue;
      if (CURATED_SET[key] !== true) continue;       // curated-only
      var code = CODE_BY_KEY[key];
      if (typeof code !== 'number') continue;          // not in vocabulary
      if (seen[code]) continue;
      seen[code] = true;
      codes.push(code);
    }
    codes.sort(function (a, b) { return a - b; });
    return codes;
  }

  /** decodeThemes(codes) → theme key array (drops out-of-range codes). */
  function decodeThemes(codes) {
    if (!Array.isArray(codes)) return [];
    var keys = [];
    for (var m = 0; m < codes.length; m++) {
      var key = keyForCode(codes[m]);
      if (key) keys.push(key);
    }
    return keys;
  }

  /**
   * encodeSelection(themeKeys) → int code array for a UI selection.
   * Like encodeThemes but used on the filter side: maps selected curated
   * keys to codes. Order/dedup not important for filtering, but we dedup
   * anyway. Returns [] for empty/invalid selection (⇒ no-op filter).
   */
  function encodeSelection(themeKeys) {
    return encodeThemes(themeKeys);
  }

  // Dev assertion (cheap, runs once at load): every curated key resolves to
  // a code. Catches a typo in GROUPS that would otherwise silently make a
  // chip un-encodable. Throws loudly per the lib convention.
  for (var ci = 0; ci < CURATED.length; ci++) {
    if (codeFor(CURATED[ci]) < 0) {
      throw new Error('themes.js: curated key not in THEME_LIST: ' + CURATED[ci]);
    }
  }

  var api = {
    THEME_LIST: THEME_LIST,
    GROUPS: GROUPS,
    CURATED: CURATED,
    LABELS: LABELS,
    isCurated: isCurated,
    codeFor: codeFor,
    keyForCode: keyForCode,
    labelFor: labelFor,
    encodeThemes: encodeThemes,
    decodeThemes: decodeThemes,
    encodeSelection: encodeSelection
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Themes = api;
  }
})(typeof self !== 'undefined' ? self : this);

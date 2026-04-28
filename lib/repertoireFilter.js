/**
 * repertoireFilter.js — Build-time whitelist for puzzle inclusion.
 *
 * Loads a list of FENs (one per line, # for comments) into a Set of
 * canonical position keys, then provides a fast intersection test for the
 * source-game position list emitted by build-index's mainline replay.
 *
 * Used by import-mcognetta.js and fetch-deltas.js to drop puzzles whose
 * source game never passed through any position the user has marked as
 * "in my repertoire." Existing Han data is unaffected — these importers
 * only generate the delta on top.
 *
 * Why FEN-set rather than opening-name matching:
 *   - Lichess opening tags stop at the moment a game leaves theory; rare
 *     transpositions get tagged by their landing-zone, not their starting
 *     line. A whitelist by canonical position key correctly captures any
 *     game that REACHED a position you care about, regardless of move order.
 *   - Position keys go through fenPositionKey (the same canonicalization
 *     the runtime uses), so EP-square idiosyncrasies between FEN sources
 *     don't cause spurious misses.
 *
 * Loaded in Node via:    const { ... } = require('../lib/repertoireFilter');
 * Loaded in browser via: <script src="lib/repertoireFilter.js"></script>
 *   (browser load supported for symmetry, but no runtime caller today —
 *    filter is build-time-only.)
 */
(function (root) {
  'use strict';

  // posKey resolution: in Node, require the canonical impl; in the browser
  // it should already be a global from posKey.js loaded earlier.
  var fenPositionKey;
  if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
    fenPositionKey = require('./posKey').fenPositionKey;
  } else {
    fenPositionKey = root.fenPositionKey;
  }

  // ─── parse ───────────────────────────────────────────────────────────────
  // Whitelist file format:
  //   - One FEN per line.
  //   - Lines starting with '#' (after optional leading whitespace) are comments.
  //   - Blank lines ignored.
  //   - Trailing whitespace stripped.
  //   - Lines with garbage (something that isn't a FEN) recorded in errors[].
  //
  // The parse is permissive: bad lines don't abort the load, they just get
  // logged. If the file ends up with zero valid FENs, the caller decides
  // what to do (typically: refuse to start the run rather than silently
  // pass everything).
  function parseFenListText(text) {
    var fens = [];
    var errors = [];
    if (typeof text !== 'string') return { fens: fens, errors: ['input not a string'] };
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.replace(/\s+$/, '');
      if (!line) continue;
      var stripped = line.replace(/^\s+/, '');
      if (stripped.charAt(0) === '#') continue;
      // A FEN has 6 space-separated fields normally, but the canonical key
      // only cares about 4. Be permissive: anything with at least 4 fields
      // and a board-ish first field passes through. fenPositionKey itself
      // does no validation, so we do a light shape check here.
      var parts = stripped.split(/\s+/);
      if (parts.length < 4) {
        errors.push({ line: i + 1, text: stripped, reason: 'fewer than 4 fields' });
        continue;
      }
      // Board field (parts[0]) must look like FEN ranks: 8 '/' separators
      // with rank chars. We don't validate piece counts — chess.js can do
      // that downstream. This is just to reject obvious garbage like a URL.
      if (parts[0].split('/').length !== 8) {
        errors.push({ line: i + 1, text: stripped, reason: 'board field not 8 ranks' });
        continue;
      }
      fens.push(stripped);
    }
    return { fens: fens, errors: errors };
  }

  // ─── build the lookup ────────────────────────────────────────────────────
  // Each whitelist FEN is canonicalized via fenPositionKey before insertion,
  // so the Set lookup matches the same key that build-index emits during
  // mainline replay. Keys collapse EP square when no enemy pawn can capture,
  // so e.g. "after 1.e4" with `e3` and "after 1.e4" with `-` (rare but
  // possible from different FEN sources) end up at the same key.
  //
  // Returns { set: Set<string>, count, errors, dropped }.
  // `dropped` lists whitelist entries whose canonical key collided (i.e.
  // duplicates in the source list); informational, not an error.
  function buildWhitelist(text) {
    var parsed = parseFenListText(text);
    var set = new Set();
    var dropped = [];
    for (var i = 0; i < parsed.fens.length; i++) {
      var key = fenPositionKey(parsed.fens[i]);
      if (set.has(key)) {
        dropped.push({ fen: parsed.fens[i], reason: 'duplicate posKey' });
        continue;
      }
      set.add(key);
    }
    return {
      set: set,
      count: set.size,
      errors: parsed.errors,
      dropped: dropped,
    };
  }

  // ─── matching ────────────────────────────────────────────────────────────
  // Given a list of posKeys (one per ply of the source game's mainline,
  // as build-index already computes), return true iff any key is in the
  // whitelist set.
  //
  // Empty set → returns true (no filter active; pass everything through).
  // This is intentional: callers that load a missing/empty whitelist file
  // get a useful "nothing to do" rather than "drop everything."
  function matchesAnyPosition(set, posKeys) {
    if (!set || set.size === 0) return true;
    if (!posKeys || posKeys.length === 0) return false;
    for (var i = 0; i < posKeys.length; i++) {
      if (set.has(posKeys[i])) return true;
    }
    return false;
  }

  // ─── convenience: load from file path (Node only) ────────────────────────
  function loadFromFile(filePath) {
    if (typeof require !== 'function') {
      throw new Error('loadFromFile is Node-only');
    }
    var fs = require('fs');
    var text = fs.readFileSync(filePath, 'utf8');
    return buildWhitelist(text);
  }

  var api = {
    parseFenListText: parseFenListText,
    buildWhitelist: buildWhitelist,
    matchesAnyPosition: matchesAnyPosition,
    loadFromFile: loadFromFile,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PuzzleExplorerRepertoireFilter = api;
  }
})(typeof self !== 'undefined' ? self : this);

/**
 * posKey.js — canonical position key + shard config, shared between the
 * Node-side analyzer and the browser-side runtime.
 *
 * MUST be byte-identical in both environments. Any change here changes the
 * keys produced by the build, so the build must be re-run.
 *
 * Loaded in Node via:    const { fenPositionKey, SHARD_HEX_LEN } = require('../lib/posKey');
 * Loaded in browser via: <script src="lib/posKey.js"></script>  (defines globals)
 */
(function (root) {
  'use strict';

  // Number of hex chars used as the shard prefix. Must match the build.
  // 3 → 4096 shards.
  var SHARD_HEX_LEN = 3;

  // First 4 FEN fields, with EP square stripped if no enemy pawn can actually
  // capture EP from an adjacent square. Defensive against malformed input —
  // missing EP field, wrong-rank EP, garbage EP all collapse to '-'.
  function fenPositionKey(fen) {
    var parts = fen.split(' ');
    var board = parts[0];
    var side = parts[1];
    var castling = parts[2];
    var ep = parts[3] || '-';

    if (ep !== '-' && ep.length >= 2) {
      // EP target square: rank 6 if white-to-move (black just double-pushed),
      // rank 3 if black-to-move (white just double-pushed). Anything else is
      // invalid for the side-to-move and gets stripped.
      var expectedEpRank = side === 'w' ? '6' : '3';
      if (ep[1] !== expectedEpRank) {
        ep = '-';
      } else {
        // The capturing pawn would sit one rank closer to its own side.
        //   white-to-move → ep on rank 6 → white pawn must be on rank 5
        //   black-to-move → ep on rank 3 → black pawn must be on rank 4
        var file = ep.charCodeAt(0) - 97;            // 0..7
        var captureRank = side === 'w' ? 5 : 4;      // 1..8
        var rowIdx = 8 - captureRank;                // FEN rank 8 = row index 0
        var ranks = board.split('/');
        var row = [];
        var rowStr = ranks[rowIdx] || '';
        for (var i = 0; i < rowStr.length; i++) {
          var ch = rowStr[i];
          if (ch >= '1' && ch <= '8') {
            for (var j = 0; j < (ch.charCodeAt(0) - 48); j++) row.push(null);
          } else {
            row.push(ch);
          }
        }
        var wantPawn = side === 'w' ? 'P' : 'p';
        var canEP =
          (file > 0 && row[file - 1] === wantPawn) ||
          (file < 7 && row[file + 1] === wantPawn);
        if (!canEP) ep = '-';
      }
    } else {
      ep = '-';
    }
    return board + ' ' + side + ' ' + castling + ' ' + ep;
  }

  var api = {
    fenPositionKey: fenPositionKey,
    SHARD_HEX_LEN: SHARD_HEX_LEN
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PuzzleExplorerPosKey = api;
    root.fenPositionKey = fenPositionKey;
    root.SHARD_HEX_LEN = SHARD_HEX_LEN;
  }
})(typeof self !== 'undefined' ? self : this);

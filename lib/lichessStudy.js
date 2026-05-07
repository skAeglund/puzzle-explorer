/**
 * lichessStudy.js — Parse a Lichess study PGN and emit FENs for repertoire
 * import.
 *
 * Usage flow (from the UI):
 *   1. extractStudyId(input)   — accept a URL, slug, or bare 8-char ID
 *   2. fetch(studyPgnUrl(id))  — caller does the HTTP (browser) or test
 *                                 fixture supplies the text directly
 *   3. parseStudyPgn(text)     — split into chapters with headers + moveText
 *   4. walkChapter(chapter, { Chess, userColor, plyMin, plyMax })
 *      → [{ fen, ply, sanLine }, ...]
 *   5. walkStudy(study, opts)  — convenience wrapper that walks every
 *      selected chapter and concatenates the results
 *
 * Why a custom walker instead of chess.js v1.x's loadPgn:
 *   - The frontend pins chess.js v0.10.3 (rule #11), which only parses
 *     mainlines. Studies live and die by their sidelines, so we need a
 *     variation-aware walker either way.
 *   - This walker is Chess-version-agnostic: pass in whatever constructor
 *     you have. The only API touched on the Chess instance is move(),
 *     undo(), load(), fen(), and turn(), all stable across v0.10 and v1.x.
 *     Illegal-move handling differs (v0.10 returns null, v1.x throws) —
 *     we wrap in try/catch and treat both as illegal (rule #11 again).
 *
 * Loaded in Node via:    const LichessStudy = require('../lib/lichessStudy');
 * Loaded in browser via: <script src="lib/lichessStudy.js"></script>
 *                         (defines window.LichessStudy)
 */
(function (root) {
  'use strict';

  // ─── ID extraction ────────────────────────────────────────────────────────
  // Lichess study IDs are exactly 8 chars, [A-Za-z0-9]. Studies and chapters
  // share the URL space:
  //   https://lichess.org/study/abcd1234              (study root)
  //   https://lichess.org/study/abcd1234/wxyz5678     (specific chapter)
  //   https://lichess.org/study/abcd1234.pgn          (PGN export — already
  //                                                    a download URL)
  // We always normalize to the bare study ID — the PGN export endpoint
  // returns ALL chapters when given just the study ID, which is what we want.
  function extractStudyId(input) {
    if (typeof input !== 'string') return null;
    var s = input.trim();
    if (!s) return null;
    // Bare 8-char ID
    if (/^[A-Za-z0-9]{8}$/.test(s)) return s;
    // URL forms — match /study/<ID> with optional trailing /<chapterId> or .pgn
    var m = s.match(/lichess\.org\/study\/([A-Za-z0-9]{8})(?:[\/\.].*)?$/);
    if (m) return m[1];
    return null;
  }

  function studyPgnUrl(studyId) {
    if (typeof studyId !== 'string' || !/^[A-Za-z0-9]{8}$/.test(studyId)) {
      throw new Error('invalid study id');
    }
    // The /study/<id>.pgn endpoint serves the full multi-chapter PGN. Default
    // query options return mainline + variations + comments, which is what
    // we want. (clocks=false would strip clock annotations but they're
    // already absent from study moves; comments=true keeps comments which
    // we just skip during tokenization.)
    return 'https://lichess.org/api/study/' + studyId + '.pgn';
  }

  // ─── PGN splitting ────────────────────────────────────────────────────────
  // A study PGN is a concatenation of chapters. Each chapter is a standard
  // PGN game: a header block ([Tag "value"] lines), a blank line, the move
  // text, and a result token. Chapters are separated by blank lines.
  //
  // splitChapters returns an array of raw text blobs, one per chapter.
  // Robust to:
  //   - Trailing whitespace
  //   - Mixed CRLF / LF line endings
  //   - Multiple blank lines between chapters
  //   - A trailing chapter without a final result token (rare but real)
  function splitChapters(text) {
    if (typeof text !== 'string' || !text) return [];
    // Normalize line endings; keeps the rest of the parser line-based.
    var normalized = text.replace(/\r\n?/g, '\n');
    // Chapter boundary heuristic: a blank line followed by a [Tag line.
    // We can't just split on \n\n because the blank line BETWEEN headers
    // and movetext is part of every chapter. The reliable signal is
    // "[Tag" at the start of a line preceded by a blank line, except for
    // the very first chapter (which starts at file start).
    var lines = normalized.split('\n');
    var chapters = [];
    var current = [];
    var prevBlank = true; // file start counts as "after blank"
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (prevBlank && /^\[[A-Za-z]/.test(line) && current.length > 0) {
        // Start of a new chapter; flush the current one.
        chapters.push(current.join('\n'));
        current = [];
      }
      current.push(line);
      prevBlank = (line.trim() === '');
    }
    if (current.length > 0) {
      var blob = current.join('\n');
      if (blob.trim()) chapters.push(blob);
    }
    return chapters;
  }

  // ─── header parsing ───────────────────────────────────────────────────────
  // Extract the [Tag "value"] header block from a chapter blob. Lenient on
  // whitespace and quote escaping — Lichess uses straight ASCII quotes and
  // backslash-escaping for embedded quotes, which we honor.
  //
  // Returns { headers: { Tag: 'value', ... }, moveText: '...' }
  function parseHeaders(chapterBlob) {
    var headers = {};
    var moveTextLines = [];
    var lines = chapterBlob.split('\n');
    var inMoves = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!inMoves) {
        // Still in header block. Empty line transitions us into movetext.
        if (line.trim() === '') {
          inMoves = true;
          continue;
        }
        var m = line.match(/^\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:[^"\\]|\\.)*)"\]\s*$/);
        if (m) {
          // Unescape backslash sequences (\\ → \, \" → ")
          headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
        }
        // Garbage lines in the header block are silently ignored — Lichess
        // never emits them, but a hand-edited PGN might.
      } else {
        moveTextLines.push(line);
      }
    }
    return { headers: headers, moveText: moveTextLines.join('\n').trim() };
  }

  // ─── chapter assembly ─────────────────────────────────────────────────────
  // Walk a Lichess study PGN end to end, producing a list of chapter records:
  //   {
  //     index:        0-based chapter number within the study,
  //     studyName:    everything before ": " in [Event], or full Event if no colon,
  //     chapterName:  everything after ": ", or '' if no colon,
  //     orientation:  'white' | 'black' | null  (from [Orientation] tag if present),
  //     startFen:     null for standard start, or the FEN string from [FEN] tag,
  //     headers:      raw header map (for caller inspection),
  //     moveText:     the unparsed PGN body
  //   }
  function parseStudyPgn(text) {
    var chapters = [];
    var blobs = splitChapters(text);
    for (var i = 0; i < blobs.length; i++) {
      var parsed = parseHeaders(blobs[i]);
      var event = parsed.headers.Event || '';
      var studyName = event;
      var chapterName = '';
      var sep = event.indexOf(': ');
      if (sep >= 0) {
        studyName = event.slice(0, sep);
        chapterName = event.slice(sep + 2);
      }
      var orientation = null;
      var rawOrient = (parsed.headers.Orientation || '').toLowerCase();
      if (rawOrient === 'white' || rawOrient === 'black') orientation = rawOrient;
      // [SetUp "1"] is the canonical signal that [FEN] is meaningful; in
      // practice Lichess only emits [FEN] when SetUp is also "1", so we
      // accept either.
      var startFen = null;
      if (parsed.headers.FEN && /\S/.test(parsed.headers.FEN)) {
        startFen = parsed.headers.FEN.trim();
      }
      chapters.push({
        index: i,
        studyName: studyName,
        chapterName: chapterName,
        orientation: orientation,
        startFen: startFen,
        headers: parsed.headers,
        moveText: parsed.moveText
      });
    }
    return chapters;
  }

  // ─── tokenizer ────────────────────────────────────────────────────────────
  // Convert PGN movetext to a stream of meaningful tokens. We emit:
  //   { type: 'move', san: '...' }
  //   { type: 'open' }       — variation start '('
  //   { type: 'close' }      — variation end ')'
  //   { type: 'result' }     — '1-0' / '0-1' / '1/2-1/2' / '*'
  //
  // Skipped silently:
  //   - Move numbers ('1.', '12...')
  //   - Comments ('{ ... }' and ';...\n')
  //   - NAGs ('$1', '$5')
  //   - Whitespace
  //
  // SAN range covered: pawn moves (e4, exd5, e8=Q+, e8=Q#), piece moves
  // (Nf3, Nbd7, N1c3, Nxe5+), castling (O-O, O-O-O), check/mate suffixes,
  // promotion. We are LENIENT — anything that doesn't match a known
  // discardable pattern AND looks like it starts with an uppercase piece
  // letter or a-h pawn letter is treated as a move. The Chess instance
  // itself rejects illegal SAN downstream.
  function tokenize(moveText) {
    var tokens = [];
    if (typeof moveText !== 'string') return tokens;
    var i = 0;
    var n = moveText.length;
    while (i < n) {
      var c = moveText.charAt(i);
      // Whitespace
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
        continue;
      }
      // Brace comment { ... } — find matching '}'. Lichess doesn't nest
      // braces (PGN spec says they don't nest), so a single scan suffices.
      if (c === '{') {
        var end = moveText.indexOf('}', i + 1);
        i = (end === -1) ? n : end + 1;
        continue;
      }
      // Line comment ; ... to end of line
      if (c === ';') {
        var nl = moveText.indexOf('\n', i + 1);
        i = (nl === -1) ? n : nl + 1;
        continue;
      }
      // Variation open
      if (c === '(') { tokens.push({ type: 'open' }); i++; continue; }
      if (c === ')') { tokens.push({ type: 'close' }); i++; continue; }
      // NAG
      if (c === '$') {
        i++;
        while (i < n && /[0-9]/.test(moveText.charAt(i))) i++;
        continue;
      }
      // Result tokens
      if (c === '*') { tokens.push({ type: 'result' }); i++; continue; }
      // 1-0, 0-1, 1/2-1/2 — peek ahead
      if (c === '1' || c === '0') {
        // Try to match a result first
        if (moveText.substr(i, 7) === '1/2-1/2') {
          tokens.push({ type: 'result' });
          i += 7;
          continue;
        }
        if (moveText.substr(i, 3) === '1-0' || moveText.substr(i, 3) === '0-1') {
          tokens.push({ type: 'result' });
          i += 3;
          continue;
        }
        // Otherwise, fall through — could be the start of a move number
        // like "12." or a numeric Annotation; we'll consume digits + dots
        // below as a move-number token (skipped).
      }
      // Move number: digits followed by one or more '.' (and optionally more
      // dots like "12..."). Skip silently.
      if (/[0-9]/.test(c)) {
        var start = i;
        while (i < n && /[0-9]/.test(moveText.charAt(i))) i++;
        // Optional trailing dots
        if (i < n && moveText.charAt(i) === '.') {
          while (i < n && moveText.charAt(i) === '.') i++;
          continue;
        }
        // Pure number with no trailing dot — unusual in PGN, but skip.
        // If this was actually a result like "1-0" we'd have caught it
        // above. Be permissive.
        // Walk back if we consumed nothing useful — defensive against
        // pathological input.
        if (i === start) i++;
        continue;
      }
      // Move token: starts with an uppercase piece letter (NBRQK), 'O' for
      // castling, or a lowercase pawn letter (a-h). Read until whitespace
      // or one of (){};$/.
      if (/[NBRQKOa-h]/.test(c)) {
        var moveStart = i;
        while (i < n) {
          var ch = moveText.charAt(i);
          if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
          if (ch === '(' || ch === ')' || ch === '{' || ch === ';' || ch === '$') break;
          i++;
        }
        var san = moveText.substring(moveStart, i);
        // Strip trailing punctuation that isn't part of SAN (e.g. ',').
        // Standard SAN-final chars: + (check), # (mate), ! ? for annotations.
        // PGN spec allows !? ?! !! ?? at move end as suffix annotations —
        // chess.js v0.10 doesn't accept those, so strip them defensively.
        san = san.replace(/[!?]+$/, '');
        if (san) tokens.push({ type: 'move', san: san });
        continue;
      }
      // Unknown char: advance to avoid infinite loop. Permissive — exotic
      // PGN extensions (rare in study output) won't crash us.
      i++;
    }
    return tokens;
  }

  // ─── SAN sequence formatting ──────────────────────────────────────────────
  // Format an array of SAN moves as a PGN-style move-numbered string, e.g.
  // ['e4','c6','d4','d5'] starting at ply 1 → '1.e4 c6 2.d4 d5'.
  // ['Nd2','dxe4','Nxe4'] starting at ply 5 → '3.Nd2 dxe4 4.Nxe4'.
  // ['e5','Nc3','d6']     starting at ply 2 → '1...e5 2.Nc3 d6'.
  //
  // Used by the import UI to label items by their "key moves" — the
  // moves that distinguish a variation from the chapter mainline. The
  // walker emits a `branchStart` index per fen record; the caller passes
  // sanLine.slice(branchStart || 0) and (branchStart || 0) + 1 as the
  // starting ply.
  //
  // Exposed on the module API so the same formatting is reused in the
  // browser UI without re-implementing the move-numbering logic.
  function formatSanSequence(sans, startPly) {
    if (!Array.isArray(sans) || !sans.length) return '';
    if (typeof startPly !== 'number' || startPly < 1) startPly = 1;
    var out = '';
    for (var i = 0; i < sans.length; i++) {
      var ply = startPly + i;            // 1-indexed
      var moveNumber = Math.floor((ply + 1) / 2);
      var isWhite = (ply % 2 === 1);     // ply 1 = white's first move
      if (isWhite) {
        if (out) out += ' ';
        out += moveNumber + '.' + sans[i];
      } else if (i === 0) {
        // First move in the slice is black — needs the "1...d5" form so
        // the move number isn't ambiguous.
        out += moveNumber + '...' + sans[i];
      } else {
        out += ' ' + sans[i];
      }
    }
    return out;
  }

  // Walk a parsed chapter's movetext, replaying every move (including
  // variations) on a chess.js instance. Emit a record for every position
  // reached BY a user-color move within [plyMin, plyMax] (inclusive).
  //
  // Required opts:
  //   Chess          constructor (browser: window.Chess; node: require('chess.js').Chess)
  //   userColor      'w' or 'b'
  //
  // Optional opts:
  //   plyMin         lower bound on source-game ply (1-indexed). Default 1.
  //   plyMax         upper bound. Default Infinity.
  //
  // Returns:
  //   { fens: [{ fen, ply, sanLine }, ...], errors: [{ san, ply, message }] }
  //
  // Notes:
  //   - "ply" is 1-indexed and counts moves from the chapter's start
  //     position. It increments for variation moves the same way as for
  //     mainline moves (i.e. depth in the local line, not source-game ply).
  //     This matches what users intuitively want from a study: "moves 1-15
  //     of any line."
  //   - sanLine is the SAN sequence leading to this position, useful as
  //     a UI label.
  //   - Dedup is the caller's job (Repertoires.addItem already dedupes on
  //     fenPositionKey). We may emit the same FEN twice (e.g. transpositions
  //     across variations) and that's fine.
  //   - Illegal SAN gets recorded in errors[] but doesn't abort the walk.
  //     The variation containing the bad move is skipped to its closing ')'
  //     so we don't desync the stack.
  function walkChapter(chapter, opts) {
    var Chess = opts && opts.Chess;
    if (typeof Chess !== 'function') {
      throw new Error('walkChapter: opts.Chess (constructor) is required');
    }
    var userColor = opts && opts.userColor;
    if (userColor !== 'w' && userColor !== 'b') {
      throw new Error('walkChapter: opts.userColor must be "w" or "b"');
    }
    var plyMin = (opts && typeof opts.plyMin === 'number') ? opts.plyMin : 1;
    var plyMax = (opts && typeof opts.plyMax === 'number') ? opts.plyMax : Infinity;

    var fens = [];
    var errors = [];

    // Initialize chess instance. v0.10 and v1.x both accept (fen) but only
    // v1.x throws on bad FEN; v0.10 returns false from .load(). Construct
    // fresh and load explicitly so we can detect failure uniformly.
    var chess;
    try {
      chess = new Chess();
    } catch (e) {
      throw new Error('walkChapter: Chess constructor failed: ' + (e && e.message ? e.message : e));
    }
    if (chapter.startFen) {
      var loaded;
      try { loaded = chess.load(chapter.startFen); } catch (e) { loaded = false; }
      if (loaded === false) {
        // Bad starting FEN — abort with a clear error rather than silently
        // walking from the standard position.
        return { fens: fens, errors: [{ ply: 0, san: null, message: 'invalid startFen: ' + chapter.startFen }] };
      }
    }

    var tokens = tokenize(chapter.moveText);

    // Stack of { fen, ply, sanLine, prevFen, branchStart } snapshots, one
    // per open '(' we're currently inside. On '(' we save the state we'll
    // restore at ')' and rewind chess to BEFORE the most recent move (the
    // variation is an alternative to that move). We can't use chess.undo()
    // for the rewind because chess.load() (used inside ')' handling) resets
    // the engine's move history — so undo would be a no-op after returning
    // from a sister variation. Instead we track prevFen explicitly.
    //
    // prevFen invariant: at any point during the walk, prevFen is the FEN
    // that chess was at immediately before the most recent move-token was
    // applied. Updated before each chess.move(), and restored from the
    // snapshot on ')' so a sequence like (var1) (var2) on the same branch
    // point correctly rewinds twice from the same parent FEN.
    //
    // branchStart invariant: index in sanLine where the OUTERMOST current
    // variation begins, or null when on the chapter mainline. When entering
    // a top-level variation (stack was empty), branchStart is set to
    // sanLine.length AFTER the rewind — that's where the new variation's
    // moves will be appended. Nested variations don't overwrite it (the
    // user-facing label always describes the outermost divergence from the
    // chapter mainline). On ')', branchStart is restored from the snapshot,
    // which captured the OUTER level's value pre-entry, so popping back to
    // mainline naturally restores branchStart to null. Used by callers to
    // build per-position labels: the "key moves" of a variation are
    // sanLine.slice(branchStart), formatted with move numbers offset to
    // start at the divergence ply.
    var stack = [];
    var ply = 0;
    var sanLine = []; // array of SAN tokens for the current line
    var prevFen = chess.fen(); // pre-move FEN; equals start position before any move
    var branchStart = null;

    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];
      if (tok.type === 'result') {
        // End of mainline; any subsequent tokens would be malformed.
        // Continue processing in case the PGN is concatenated weirdly.
        continue;
      }
      if (tok.type === 'open') {
        // Variation alternative: snapshot the post-move state we'll return
        // to at ')', then rewind chess to BEFORE the most recent move.
        var enteringTopLevelVariation = (stack.length === 0);
        stack.push({
          fen: chess.fen(),
          ply: ply,
          sanLine: sanLine.slice(),
          prevFen: prevFen,
          branchStart: branchStart
        });
        if (ply > 0) {
          var rewound;
          try { rewound = chess.load(prevFen); } catch (e) { rewound = false; }
          if (rewound !== false) {
            ply--;
            sanLine.pop();
            // No further "previous" available without recursion through the
            // stack — but the next move at this level will set prevFen
            // before applying, and another '(' before any move at this
            // depth would be malformed PGN. Leave prevFen at the rewound
            // position as a safe-ish default.
            prevFen = chess.fen();
          }
        }
        // Set branchStart only when entering a TOP-level variation. Nested
        // variations preserve the existing branchStart so labels describe
        // the outermost divergence from the chapter mainline. branchStart
        // is the sanLine index where the variation moves will be appended,
        // i.e. sanLine.length AFTER the rewind.
        if (enteringTopLevelVariation) {
          branchStart = sanLine.length;
        }
        // Edge case: '(' at ply 0 (variation before any mainline move).
        // Lichess shouldn't emit that, but if it does, the stack still
        // restores correctly on ')'. ply just stays 0.
        continue;
      }
      if (tok.type === 'close') {
        if (stack.length === 0) {
          // Unbalanced ')' — record an error and continue. Walk doesn't
          // abort because the rest of the chapter may still be parseable.
          errors.push({ ply: ply, san: null, message: 'unbalanced ")" at token ' + ti });
          continue;
        }
        var snap = stack.pop();
        try { chess.load(snap.fen); } catch (e) { /* tolerate */ }
        ply = snap.ply;
        sanLine = snap.sanLine;
        prevFen = snap.prevFen;
        branchStart = snap.branchStart;
        continue;
      }
      if (tok.type === 'move') {
        var mover = chess.turn(); // whose turn BEFORE the move
        var fenBefore = chess.fen(); // captured before move attempt for prevFen update
        var moveResult;
        try {
          moveResult = chess.move(tok.san);
        } catch (e) {
          moveResult = null;
        }
        if (!moveResult) {
          // Illegal SAN. Record and skip to the closing ')' of the current
          // variation (or end of token stream if we're in the mainline).
          // Skipping to ')' avoids cascading rejections — without it, every
          // subsequent legal move would also fail (chess state is wrong
          // for them).
          errors.push({ ply: ply + 1, san: tok.san, message: 'illegal SAN' });
          // Find the matching ')' if we're inside a variation. If we're at
          // the top level, give up the rest of the chapter.
          if (stack.length === 0) {
            break;
          }
          // Skip until we close THIS variation level (depth back to current
          // stack height - 1).
          var depth = 1;
          while (++ti < tokens.length) {
            if (tokens[ti].type === 'open') depth++;
            else if (tokens[ti].type === 'close') {
              depth--;
              if (depth === 0) break;
            }
          }
          // Now ti points at the matching ')'; let the loop's continue
          // re-process it through the close handler.
          ti--;
          continue;
        }
        ply++;
        sanLine.push(moveResult.san || tok.san);
        prevFen = fenBefore;
        if (mover === userColor && ply >= plyMin && ply <= plyMax) {
          fens.push({
            fen: chess.fen(),
            ply: ply,
            sanLine: sanLine.slice(),
            branchStart: branchStart  // null = mainline; integer = sanLine index of divergence
          });
        }
        continue;
      }
    }

    return { fens: fens, errors: errors };
  }

  // ─── multi-chapter walker ─────────────────────────────────────────────────
  // Convenience wrapper. Walks every chapter in `chapters` (typically the
  // output of parseStudyPgn) using the per-chapter user color when
  // configured to 'auto', or a fixed user color when overridden.
  //
  // opts:
  //   Chess          constructor (required)
  //   userColor      'auto' | 'w' | 'b' (default 'auto')
  //   plyMin, plyMax see walkChapter
  //   chapterFilter  optional function(chapter) → boolean (skip when false)
  //   defaultColor   fallback color when chapter has no orientation and
  //                  userColor === 'auto' (default 'w')
  //
  // Returns:
  //   {
  //     chapters: [
  //       {
  //         chapter: <ref into input>,
  //         color:   'w' | 'b',     // resolved color used
  //         skipped: <bool>,        // true if filter rejected
  //         fens:    [...],
  //         errors:  [...]
  //       }, ...
  //     ],
  //     totalFens: <int>,
  //     totalErrors: <int>
  //   }
  function walkStudy(chapters, opts) {
    if (!Array.isArray(chapters)) throw new Error('walkStudy: chapters must be an array');
    var Chess = opts && opts.Chess;
    if (typeof Chess !== 'function') {
      throw new Error('walkStudy: opts.Chess (constructor) is required');
    }
    var mode = (opts && opts.userColor) || 'auto';
    if (mode !== 'auto' && mode !== 'w' && mode !== 'b') {
      throw new Error('walkStudy: opts.userColor must be "auto", "w", or "b"');
    }
    var defaultColor = (opts && opts.defaultColor === 'b') ? 'b' : 'w';
    var filter = (opts && typeof opts.chapterFilter === 'function') ? opts.chapterFilter : null;

    var out = { chapters: [], totalFens: 0, totalErrors: 0 };

    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i];
      if (filter && !filter(ch)) {
        out.chapters.push({ chapter: ch, color: null, skipped: true, fens: [], errors: [] });
        continue;
      }
      var color;
      if (mode === 'auto') {
        if (ch.orientation === 'white') color = 'w';
        else if (ch.orientation === 'black') color = 'b';
        else color = defaultColor;
      } else {
        color = mode;
      }
      var result = walkChapter(ch, {
        Chess: Chess,
        userColor: color,
        plyMin: opts.plyMin,
        plyMax: opts.plyMax
      });
      out.chapters.push({
        chapter: ch,
        color: color,
        skipped: false,
        fens: result.fens,
        errors: result.errors
      });
      out.totalFens += result.fens.length;
      out.totalErrors += result.errors.length;
    }
    return out;
  }

  var api = {
    extractStudyId: extractStudyId,
    studyPgnUrl: studyPgnUrl,
    splitChapters: splitChapters,
    parseHeaders: parseHeaders,
    parseStudyPgn: parseStudyPgn,
    tokenize: tokenize,
    formatSanSequence: formatSanSequence,
    walkChapter: walkChapter,
    walkStudy: walkStudy
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.LichessStudy = api;
  }
})(typeof self !== 'undefined' ? self : this);

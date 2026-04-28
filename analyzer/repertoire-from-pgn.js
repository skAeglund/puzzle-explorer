#!/usr/bin/env node
/**
 * repertoire-from-pgn.js — Walk a PGN file and emit canonical FENs for every
 * position reached in the mainline AND in all variations.
 *
 * Output: one FEN per line (deduped via fenPositionKey, with the FEN itself
 * preserved for human readability of the whitelist file). Format compatible
 * with lib/repertoireFilter.js's buildWhitelist().
 *
 * Why a custom walker rather than chess.js loadPgn:
 *   chess.js v1.4 silently drops variations during loadPgn — only the mainline
 *   becomes part of the loaded game. Repertoire PGNs commonly use variations
 *   for alternatives ("if 2.d4 then ...") which we MUST capture or the
 *   whitelist is incomplete. So we tokenize manually and recurse on `(...)`.
 *
 * Usage:
 *   node analyzer/repertoire-from-pgn.js <input.pgn> [--out <file>]
 *     [--min-ply N]    skip positions reached at ply < N from each game's
 *                      starting position (default 0 — emit everything)
 *
 * --min-ply: useful when your repertoire shares early plies with non-
 *   repertoire openings. Example: you play 1.Nf3 d5 2.g3 (always); positions
 *   after 1.Nf3 and after 1.Nf3 d5 are shared with anyone who plays 1.Nf3,
 *   so they'd let unrelated puzzles into your delta. --min-ply 3 would
 *   skip these and only emit your specific 2.g3 variation onward.
 *
 * The min-ply applies to EACH variation's depth from its parent's branch
 * point, not absolute. So a variation entered at ply 5 and going 3 plies
 * deep emits positions at "from-game-start ply" 6, 7, 8 — and a min-ply
 * of 3 keeps all of them, since they're well past depth 3.
 */

const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');
const { fenPositionKey } = require('../lib/posKey');

// ─── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const pos = [];
  const flags = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

// ─── PGN preprocessing ───────────────────────────────────────────────────
// Strip headers and braced comments. Keeps movetext including `(` `)` for
// variation handling.
function stripHeaders(pgn) {
  // PGN header tags are `[Tag "value"]` lines. Remove all of them.
  return pgn.replace(/^\s*\[[^\]]*\]\s*$/gm, '');
}
function stripComments(pgn) {
  // `{...}` braced comments. Same fix import-mcognetta uses.
  return pgn.replace(/\{[^}]*\}/g, '');
}
function stripNAGs(text) {
  // NAGs: `$1`, `$5`, etc. Also informal `?!`, `!?`, `!`, `?`, `??`, `!!`
  // appended to moves. The chess.js move parser tolerates `?!` etc., but
  // when WE parse the tokens we want clean SAN. Strip them.
  return text
    .replace(/\$\d+/g, ' ')
    .replace(/[?!]+/g, ' ');
}
function stripMoveNumbers(text) {
  // "1." "1..." "23..." — purely positional, redundant once we're tracking turn.
  return text.replace(/\b\d+\.+/g, ' ');
}
function stripResults(text) {
  // Game termination markers: 1-0, 0-1, 1/2-1/2, *
  // Bound by whitespace or end-of-string rather than \b — \b doesn't match
  // around `*` (non-word char both sides) and the result marker is always
  // at the end of the movetext after a space anyway.
  return text.replace(/(^|\s)(1-0|0-1|1\/2-1\/2|\*)(?=\s|$)/g, '$1 ');
}

// ─── tokenize movetext into [SAN, "(", ")", ...] ────────────────────────
// After stripping headers, comments, NAGs, move numbers, and results, what
// remains is SAN tokens and parentheses separated by whitespace.
function tokenize(cleaned) {
  const tokens = [];
  let i = 0;
  while (i < cleaned.length) {
    const c = cleaned[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(' || c === ')') { tokens.push(c); i++; continue; }
    // Read a SAN token: continue until whitespace or paren.
    let j = i;
    while (j < cleaned.length) {
      const cc = cleaned[j];
      if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '\r' || cc === '(' || cc === ')') break;
      j++;
    }
    if (j > i) tokens.push(cleaned.slice(i, j));
    i = j;
  }
  return tokens;
}

// ─── walk variations recursively ────────────────────────────────────────
// State: chess.js instance representing the current line's tail position.
// On `(` we save current state (FEN), then UNDO the last mainline move
// (per PGN convention: a variation is an alternative TO the previous move),
// then walk into the variation. On `)` we restore.
//
// emitFn(posKey, ply) is called for every move played, where ply is the
// absolute distance from the game's starting position (ply 1 = white's
// first move = first move of the game).
function walkTokens(tokens, chess, emitFn, errors) {
  // PGN variation semantics: a `(...)` group represents an alternative TO
  // the most recently played move. So on `(` we revert to the position
  // that existed BEFORE that last move.
  //
  // chess.js's own undo() is unreliable here: chess.load(fen) wipes the
  // internal move history, so undo() following a load returns null. Any
  // walker that nests variations will hit a `)` (which reloads) followed
  // eventually by another `(` (which can no longer undo). So we maintain
  // pre-move state ourselves.
  //
  // State per move:
  //   prevFen / prevPly — snapshot of the position BEFORE the most recent
  //                       move. Used to revert on `(`.
  //
  // Stack frame on `(` saves both:
  //   { postFen, postPly } — parent's TAIL state (where `)` returns to)
  //   { prevFen, prevPly } — parent's PRE-move state (where `(` after `)`
  //                          re-reverts to for chained variations)
  //
  // Without saving the pre-move state, chained `(...)(...)` after a single
  // parent move would fail because prevFen/prevPly mutate inside the
  // first variation, leaving the wrong revert target for the second.
  const stack = [];
  let ply = chess.history().length;
  let prevFen = chess.fen();
  let prevPly = ply;

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok === '(') {
      stack.push({
        postFen: chess.fen(), postPly: ply,
        prevFen: prevFen,     prevPly: prevPly,
      });
      // Revert to before the parent's last move. Edge case: variation at
      // the very start of a game (no parent move). prevFen === current
      // fen, ply === prevPly. Reload is a no-op, harmless.
      chess.load(prevFen);
      ply = prevPly;
      // Inside the new variation, prev is whatever we just loaded — this
      // gets overwritten by the variation's first SAN move below.
      prevFen = chess.fen();
      prevPly = ply;
    } else if (tok === ')') {
      const saved = stack.pop();
      if (!saved) {
        errors.push('unbalanced ")" at token ' + idx);
        continue;
      }
      chess.load(saved.postFen);
      ply = saved.postPly;
      // Restore parent's PRE-move snapshot too. Critical for chained
      // `(...)(...)` — the next `(` needs the SAME revert target the
      // first one used, not whatever was set inside the first variation.
      prevFen = saved.prevFen;
      prevPly = saved.prevPly;
    } else {
      // Regular SAN: snapshot pre-move state, play move, advance ply.
      prevFen = chess.fen();
      prevPly = ply;
      let m;
      try { m = chess.move(tok); }
      catch (e) {
        errors.push(`illegal/unparseable SAN "${tok}" at token ${idx} (ply ${ply + 1}, position ${chess.fen()})`);
        continue;
      }
      if (!m) {
        errors.push(`null move from "${tok}" at token ${idx}`);
        continue;
      }
      ply += 1;
      const posKey = fenPositionKey(m.after);
      emitFn(posKey, m.after, ply);
    }
  }
  if (stack.length > 0) {
    errors.push(`unbalanced "(" — ${stack.length} unmatched at end of input`);
  }
}

// ─── walk a single PGN game ──────────────────────────────────────────────
// Returns { positions: [{posKey, fen, minPly}], errors: [] }.
// minPly is the smallest ply at which this position was reached across
// the mainline + all variations — used so we know whether to emit it
// when --min-ply N is in effect (a position reached at ply 4 in the
// mainline AND ply 6 in a variation has minPly=4, so it survives even
// strict floors that would have dropped the variation occurrence alone).
function walkGame(pgn) {
  const errors = [];
  let body = pgn;
  body = stripHeaders(body);
  body = stripComments(body);
  body = stripNAGs(body);
  body = stripMoveNumbers(body);
  body = stripResults(body);
  const tokens = tokenize(body);

  const chess = new Chess();
  // Map<posKey, { fen, minPly }>
  // Keep the SHALLOWEST occurrence of each key — a position reached early
  // in any line is reached early.
  const positions = new Map();

  walkTokens(tokens, chess, (posKey, fen, ply) => {
    const existing = positions.get(posKey);
    if (!existing || ply < existing.minPly) {
      positions.set(posKey, { fen, minPly: ply });
    }
  }, errors);

  return { positions, errors };
}

// ─── walk a multi-game PGN file ─────────────────────────────────────────
// Splits on header-block boundaries (a `[Event ...]` line preceded by a
// blank line OR the file start). Returns merged positions across all
// games and a flat errors list.
function walkPgnFile(text) {
  // Split games by "blank line + [": the canonical PGN game separator.
  // First game has no leading blank line, so split on /\n\s*\n(?=\[)/ to
  // keep the split aware of header blocks.
  const rawSplits = text.split(/\n\s*\n(?=\[)/);
  const allErrors = [];
  // Map<posKey, { fen, minPly }> — across all games
  const allPositions = new Map();

  for (let g = 0; g < rawSplits.length; g++) {
    const game = rawSplits[g].trim();
    if (!game) continue;
    const { positions, errors } = walkGame(game);
    for (const e of errors) allErrors.push(`game ${g + 1}: ${e}`);
    for (const [k, v] of positions) {
      const existing = allPositions.get(k);
      if (!existing || v.minPly < existing.minPly) {
        allPositions.set(k, v);
      }
    }
  }
  return { positions: allPositions, errors: allErrors };
}

// ─── main ────────────────────────────────────────────────────────────────
async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const INPUT = pos[0];
  const OUT = flags.out || null;
  const MIN_PLY = flags['min-ply'] != null
    ? Math.max(0, parseInt(flags['min-ply'], 10) || 0)
    : 0;

  if (!INPUT) {
    console.error('usage: node repertoire-from-pgn.js <input.pgn> [--out FILE] [--min-ply N]');
    process.exit(1);
  }

  const text = fs.readFileSync(INPUT, 'utf8');
  const { positions, errors } = walkPgnFile(text);

  // Filter by min-ply.
  const kept = [];
  let dropped = 0;
  for (const [posKey, info] of positions) {
    if (info.minPly < MIN_PLY) { dropped++; continue; }
    kept.push({ posKey, fen: info.fen, minPly: info.minPly });
  }
  // Sort by minPly ascending, then FEN — deterministic output.
  kept.sort((a, b) => a.minPly - b.minPly || (a.fen < b.fen ? -1 : a.fen > b.fen ? 1 : 0));

  // Emit. Header is a comment so the file is round-trip-loadable by
  // lib/repertoireFilter (which skips '#' lines).
  const header = [
    `# Generated from ${INPUT} on ${new Date().toISOString()}`,
    `# ${kept.length} unique positions, ${dropped} dropped (min-ply ${MIN_PLY})`,
    `# ${errors.length} parse errors during walk`,
    '',
  ].join('\n');
  const body = kept.map(k => k.fen).join('\n') + '\n';
  const output = header + body;

  if (OUT) {
    fs.writeFileSync(OUT, output);
    console.log(`wrote ${kept.length} FENs to ${OUT}`);
    if (dropped > 0) console.log(`(${dropped} dropped due to --min-ply ${MIN_PLY})`);
    if (errors.length > 0) {
      console.warn(`${errors.length} parse errors:`);
      for (const e of errors.slice(0, 10)) console.warn('  ' + e);
      if (errors.length > 10) console.warn(`  ... and ${errors.length - 10} more`);
    }
  } else {
    process.stdout.write(output);
    if (errors.length > 0) {
      console.error(`\n${errors.length} parse errors during walk (use --out to suppress this):`);
      for (const e of errors.slice(0, 10)) console.error('  ' + e);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  stripHeaders, stripComments, stripNAGs, stripMoveNumbers, stripResults,
  tokenize,
  walkTokens, walkGame, walkPgnFile,
};

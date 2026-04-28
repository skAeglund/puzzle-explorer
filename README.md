# Puzzle Explorer

Personal training tool: drill Lichess opening puzzles filtered by FEN, with
FSRS-5 spaced repetition. Search the full source-game position graph (not just
puzzle starting positions) to find every puzzle whose game passed through a
given line.

Built on **[Han Schut's CC0 1.2M-puzzle PGN dump][han]**, which already does the
puzzle ↔ source-game join. Credit and thanks to Han.

[han]: https://lichess.org/@/HanSchut/blog/the-lichess-opening-puzzles-with-games-makes-them-searchable-from-any-position/BUHE9eQ3

## Stack

- Single `index.html` monolith, vanilla JS, no build tools
- jQuery 3.7.1, chess.js 0.10.3, chessboard.js 1.0.0 from CDN
- Build-time: chess.js 1.x for ~24× faster `loadPgn` (npm dep, see `package.json`)
- IndexedDB for the position→puzzle index (planned), localStorage for FSRS progress
- Deployed via GitHub Pages

## Build the index

```sh
npm install
node analyzer/build-index.js path/to/puzzles.pgn ./data
# Or a quick subset:
node analyzer/build-index.js path/to/puzzles.pgn ./data --limit 5000
```

Outputs sharded JSON to `data/index/<hex>.json` and ndjson bodies to
`data/puzzles/<hex>.ndjson`. Re-run when the puzzle set updates; build is
idempotent (wipes prior shards).

## Publish data

`./data/` is gitignored here and lives in a sibling repo
[`puzzle-explorer-data`](https://github.com/skAeglund/puzzle-explorer-data),
served via its own GitHub Pages site. Each rebuild force-pushes a fresh tree
so history doesn't accumulate.

First-time setup is documented in the header of `analyzer/publish-data.js`.
After setup, every rebuild is one command:

```sh
node analyzer/publish-data.js
```

For datasets larger than the GitHub Pages 1GB cap (~3M+ puzzles after the
per-position rating cap), publish to a Cloudflare R2 bucket instead — same
ETag-based skip-unchanged behavior, no quota concerns, free egress via
Cloudflare's CDN. Set R2 credentials in env (`R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) or a `.env.r2` file alongside the
data dir, then point `DATA_BASE_URL` in `index.html` at the bucket's public
URL. See `analyzer/publish-r2.js` header for full setup details.

```sh
node analyzer/publish-r2.js [--dry-run] [--prefix v1]
```

## Extend the puzzle set

Han's set covers ~1.2M opening puzzles through Sept 2022. To extend coverage
through the current Lichess CSV (~5.88M puzzles), use the importers:

```sh
# 1. Convert mcognetta's combined puzzle+game ndjson (Sept 2022 snapshot)
#    into Han-format PGN, skipping puzzles already in our data:
node analyzer/import-mcognetta.js mcognetta.ndjson.bz2 mcognetta-delta.pgn \
    --skip-data ./data

# 2. Fetch source-game JSON via the Lichess API for everything not yet
#    covered, with checkpoint-based resumability across multi-hour runs:
node analyzer/fetch-deltas.js lichess_db_puzzle.csv.zst api-delta.pgn \
    --skip-data ./data
```

Concatenate the resulting PGNs into one input file and re-run
`build-index.js` to produce the full set.

## Slice a sample fixture

```sh
node analyzer/slice-pgn.js path/to/puzzles.pgn 5000 fixtures/sample.pgn
```

## Run the tests

```sh
node analyzer/fsrs-test.js
node analyzer/drill-test.js
node analyzer/lookup-test.js ./data    # requires built data/
```

## Develop the frontend

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

## License

CC0 — same as the upstream puzzle data.

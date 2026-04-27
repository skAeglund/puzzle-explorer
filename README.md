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

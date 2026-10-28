# Local authoring assets — not session storage

These files are optional local inputs/checkpoints, **not** the website's public dataset:

- `uv run python import_puzzles.py` legally imports the complete official archive, builds `puzzle-index.sqlite3` (disk-backed exact-rating sort and overlap lookup), and publishes schema-2 puzzle shards to **`public/training/`**. Its completed index is reused when the compressed source SHA-256 is unchanged.
- `uv run python expand_corpus.py --workers 7` samples 60,000 real games into `expanded/games.pgn` (plus games needed to retain existing positions), then targets **30,000 fully graded ordinary positions** at 100,000 nodes/root. Inputs and checkpoints live under `expanded/`. A full replacement is published only after the target qualifies.
- `uv run python snapshot_corpus.py --publish` publishes all currently completed, qualifying checkpoint records without running Stockfish or waiting for 30,000. It verifies configuration fingerprints, legal move coverage, distinct games, and puzzle overlap, and marks partial counts explicitly. `--snapshot-root` freezes a manifest plus its referenced shards for stable Git staging even while workers continue. Publication is locked against other updated exporters; evaluation/checkpoint writing continues normally.
- `expanded/static-checkpoints/` contains resumable evaluations/rejections for that expansion. If a detached run is active, progress is in `expand-corpus.log`; `expand-corpus.pid` identifies its launcher. The public manifest's count is the completed/published count, not the in-progress target. Re-run the same command after interruption; do not launch a second writer against these paths.
- `uv run python prepare.py` creates `manifest.json`, `puzzles.json`, `positions.json` (only a two-line filter), and the sampled `games.pgn` corpus. Defaults: 2,000 qualifying real games, 10,000 puzzles, and 1,000 preliminary ordinary positions.
- `uv run python export_static.py --positions 1000` independently grades every legal move, re-filters, and writes the deployable corpus to **`public/training/`**. It can sample replacements from unused games in `games.pgn`.
- `static-checkpoints/` contains reusable completed evaluations and rejections, fingerprinted by candidate, engine, node budget, and exporter version. Keep it if you want fast resumption. It is not published.
- `cache/` contains downloaded archives and unpacked PGNs; it may be removed after preparation to reclaim space, but preserving it supports reproducibility. `games.pgn` is needed if final grading requires replacement candidates.

Everything here except this README and `.gitkeep` is gitignored. Do not run multiple exporters against the same directories or replace preparation inputs while an export is running. See the main README for commands and GitHub Pages publishing instructions.

The website uses browser-memory sessions only. No session data or summaries are written here.

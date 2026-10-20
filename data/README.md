# Local authoring assets — not session storage

These files are optional local inputs/checkpoints, **not** the website's public dataset:

- `uv run python prepare.py` creates `manifest.json`, `puzzles.json`, `positions.json` (only a two-line filter), and the sampled `games.pgn` corpus. Defaults: 2,000 qualifying real games, 10,000 puzzles, and 1,000 preliminary ordinary positions.
- `uv run python export_static.py --positions 1000` independently grades every legal move, re-filters, and writes the deployable corpus to **`public/training/`**. It can sample replacements from unused games in `games.pgn`.
- `static-checkpoints/` contains reusable completed evaluations and rejections, fingerprinted by candidate, engine, node budget, and exporter version. Keep it if you want fast resumption. It is not published.
- `cache/` contains downloaded archives and unpacked PGNs; it may be removed after preparation to reclaim space, but preserving it supports reproducibility. `games.pgn` is needed if final grading requires replacement candidates.

Everything here except this README and `.gitkeep` is gitignored. Do not run multiple exporters against the same directories or replace preparation inputs while an export is running. See the main README for commands and GitHub Pages publishing instructions.

The website uses browser-memory sessions only. No session data or summaries are written here.

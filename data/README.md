# Local corpus, release caches, and authoring state

Everything here except this README and `.gitkeep` is ignored by Git. **Ignored does not mean disposable.** No website session state is stored here; sessions exist only in browser memory.

## Prepared data and release artifacts

- `training/prepared/`: immutable schema-3 groups, inventories, startup manifest, and `conversion-report.json` from a frozen authoritative corpus. Legacy conversion preserves every published record/grade and compares independent before/after signatures before promotion.
- `training/releases/`: deterministic `puzzles-<version>.zip`, `ordinary-<version>.zip`, and `release-candidate.json`. These are **candidates, not proof of public publication**. No engine or raw download is used by conversion/packaging.
- `training/site/`: explicit local-release hydration target. Use `npm run build -- --training-dir data/training/site --local` for an unmistakably unpinned preview while initial remote publication is blocked.
- `training/archives/<full-archive-sha256>.zip`: verified production hydration cache. Cache hits are rehashed; `--offline` fails safely on missing/corrupt archives. Release URLs come only from root `training-data.lock.json`, created after owner publication.
- `training/backups/<unique-timestamp>/`: independently copied authoritative `public/training/`, authoring inputs/caches/index/checkpoints, and full verification inventory. The migration baseline is `20261028T101223Z` (48,283 verified files, 3,229,877,970 bytes). Do not use `dist/training` as the authority.
- `training/snapshots/<unique-name>/public/training/`: frozen inventories and shards from completed checkpoint snapshots. Later publication cannot alter the frozen versions. Package these as release artifacts; staging them in Git is not publication.
- `training/measurements/`: controlled cold-load reports, browser logs, and build/distribution sizes. These distinguish observations from budgets. `training/baseline/` preserves the old build used for before measurements.

No tool automatically prunes local backups, archives, old groups, indexes, or evaluations. The build allowlist governs **deployment retention**, not local deletion. A copy on the same disk is not disaster recovery; maintain an additional independently verified storage backup for costly data.

## Expensive authoring inputs — preserve before replacement

- `puzzle-index.sqlite3`: full legally replayed puzzle source, disk-backed `(rating,id)` order and overlap index. Import records the compressed raw SHA-256 and reuses a completed matching index. Keep the matching raw `cache/lichess_db_puzzle.csv.zst` and provenance; the official URL is a moving snapshot.
- `manifest.json`, `puzzles.json`, `positions.json`, `games.pgn`: original preparation settings/sample. Preliminary positions contain only a filter, not necessarily complete grades.
- `static-checkpoints/`: original successful evaluations **and rejections**, fingerprinted by candidate, engine, nodes, threshold, exporter version. Existing fingerprint bytes remain unchanged.
- `expanded/manifest.json`, `expanded/games.pgn`, `expanded/positions.json`, preparation inputs: reusable expanded sample; retain its source grading/provenance.
- `expanded/static-checkpoints/`: expansion evaluations/rejections, separate from the original tree. Interrupted progress is not a completed 30,000-position publication.
- `cache/`: raw archives and unpacked sources needed to reproduce samples or obtain replacement candidates. Do not clear this merely to reduce application Git/build size.
- Logs/PID files: useful diagnostics, not authoritative proof a process is running. Recheck actual processes and the selected manifest.

## Authoring commands

Use isolated outputs during migration; see [CORPUS.md](../CORPUS.md) for full commands and manual publication gates.

```sh
uv run python import_puzzles.py --output data/training/prepared
uv run python expand_corpus.py --output data/training/prepared --workers 7 --build
uv run python snapshot_corpus.py --output data/training/prepared --snapshot-root data/training/snapshots/<unique-name>
uv run python package_corpus.py pack --input data/training/prepared --output data/training/releases
```

Import defaults to 256-record exact-rating puzzle shards and preserves nonoverlapping ordinary records through shared legacy/schema-3 readers. Expansion targets 30,000 fully graded distinct-game positions at 100,000 nodes **per legal root move**; it publishes only when its requested target qualifies. `--build` uses the selected output as an explicit local dataset. Snapshots do no engine work, validate checkpoint fingerprints/legal grades/uniqueness/overlap, preserve already published records, refuse shrinkage, and regenerate only ordinary groups for schema 3. `--publish` explicitly updates the selected prepared output in addition to freezing it.

Recheck processes before changing code/inputs. Coordinate a checkpoint-safe pause of old writers before using the new directory lock protocol. Do not terminate/resume jobs automatically or run competing authoring jobs against the same inputs/index. New Python and Node publishers share `<resolved-output>.publication-lock`, diagnostics and bounded waits; **never automatically steal a lock**. Confirm a writer is gone and obtain operator confirmation before manual removal. Do not treat a stale PID file as permission to delete data.

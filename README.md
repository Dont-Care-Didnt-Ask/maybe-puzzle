# Maybe Puzzle

Chess training without knowing whether there is a tactic. Solve a Lichess puzzle, or make a sound move in an ordinary game position. The board does not tell you which kind you are seeing.

**A fully static website:** vanilla JavaScript, Chessground, chess.js, and precomputed Stockfish move grades. No backend, browser engine, accounts, analytics, or saved session history. Python/Stockfish are optional **authoring** tools, never build/deployment requirements.

The preserved official Lichess snapshot contains **6,157,341 puzzles**, including **832,903 rated 2100–2700**, with no popularity, play-count, or rating cutoff. It also contains **19,664 fully graded ordinary positions** from distinct games. Ordinary grades use **Stockfish 19, 100,000 nodes per legal root move**. The 30,000-position expansion target is not a claim of completed publication; the selected manifest always reports the actual available count.

## Try locally

Requirements: **Node.js 24**, `npm ci`, and prepared release data. Data is retrieved explicitly, not generated or downloaded implicitly by a build.

### Pinned releases (after the owner completes the first release)

```sh
npm ci
npm run data:hydrate                 # download and verify the pinned prepared archives
npm run data:check                   # full offline integrity/record/overlap checks
npm test
npm run build                       # strict offline, pinned build
npm run preview
```

Subsequent hydration can be entirely offline:

```sh
npm run data:hydrate -- --offline    # requires all pinned archives in the verified cache
```

**Bootstrap status:** No public release URLs or production `training-data.lock.json` have been fabricated. Until the owner uploads the locally prepared archives and pins their actual immutable URLs, the production hydration/build and Pages workflow deliberately fail with instructions. The original tracked `public/training/` remains intact during this gate. See [CORPUS.md](CORPUS.md) for the exact owner procedure and recovery rules.

### Local prepared data / unpublished release candidate

An author or recipient of the prepared candidate can work without a public release:

```sh
npm ci
npm run data:hydrate -- --local-release data/training/releases --output data/training/site --offline
npm run data:check -- --local --training-dir data/training/site
npm run build -- --training-dir data/training/site --local
npm run preview
```

This build is visibly marked **UNPINNED LOCAL PREVIEW**, not a production deployment. It still validates all group inventories, file hashes, records, ordinary move coverage, exact ratings, IDs, games, and overlap. Do not substitute synthetic fixtures or stale `dist` for missing data.

For normal development, run `npm run dev` after explicit hydration to `public/training`. During bootstrap keep using the isolated site above and its production preview; this avoids changing the formerly tracked manifest. Source downloads are generated during a build, not by the Vite development server. Do not open the app as a `file://` URL.

## Publication and GitHub Pages

Application sources and prepared data have separate release cycles. See [CORPUS.md](CORPUS.md) for conversion, deterministic archives, verified URLs, pinning, retention, and rollback.

1. Validate/package a frozen corpus locally. This does **not** upload anything.
2. The owner chooses a public release repository/tag and uploads the exact immutable `puzzles-<version>.zip` and `ordinary-<version>.zip` files, without rebuilding them.
3. Pin the candidate using the **actual** URLs, then download into an empty verification cache and recheck/build/test. Only then review the retrieval lock and application changes for publication.
4. Enable **Settings → Pages → GitHub Actions** on the public application repository. The workflow hydrates verified prepared archives, runs mandatory real-corpus tests, builds offline, and runs desktop/mobile correctness and controlled performance checks before uploading `dist`.

The workflow has read-only build permissions and a separate Pages deployment permission scope. It never runs Python, Stockfish, raw Lichess downloads, or release uploads. URLs resolve relative to the site base, including repository subpaths.

An ordinary-only update uploads only its new ordinary archive and reuses the pinned puzzle archive. Pages artifacts include the current and immediately previous **distinct version of each group**, deduplicating unchanged versions. Every whole-site deployment carries those bytes again. The build fails above **900 MiB** rather than silently dropping retention. Remote release assets must remain available after Pages retention expires.

Retention is version-based, not a time guarantee. Expired tabs may receive a 404; the board, score, revision, and reserved draw remain unchanged. Finish still works; then reload to use the new catalog. **The first schema-3 deployment does not retain legacy schema-1/2 flat paths:** existing legacy tabs may need to finish and reload.

No staging, commits, pushes, release publication, or history rewrites are performed by these tools. Deleting current generated files later does not erase historical Git blobs or immediately shrink existing clones. Historical cleanup requires separate, coordinated owner authorization.

## Training and scoring

- Choose a fixed puzzle probability from 0–100%, or **Surprise me**. Random mode draws a fresh hidden probability uniformly on [0, 1) for each item, then independently chooses its kind. Outcomes have 50% marginal puzzle probability; there is no single hidden session-wide ratio.
- Puzzle difficulty is **anchor ± margin**, e.g. **1700 ± 300**. Selection is exactly uniform over eligible prepared records, not rating buckets or shards. The sparse without-replacement deck retains its cycle-boundary non-repeat behavior.
- Both kinds show the preceding opponent move, then let you move. Type, source, rating, and solution are hidden in the UI until the attempt is scored.
- Click/drag or enter UCI notation (`e2e4`, `e1g1`, `a7a8n`). Underpromotion, board flipping (**F** outside text inputs), and post-attempt line replay are supported. Touch dragging enlarges the held artwork and highlights its destination; mouse/tap behavior is unchanged.
- **Board & pieces** offers Brown, Blue, Green, Grey and Cburnett, Merida, Chessnut. Themes are bundled locally and tab-local, without changing an active board or score.
- **Puzzles:** play every user move in the exact published Lichess solution; opponent replies are automatic. Equivalent alternatives can be rejected.
- **Ordinary:** one legal move within **50 centipawns / 0.5 pawns** of the precomputed best is sufficient. Every legal move was searched offline at the same budget, and at least two qualify.
- A wrong legal move, skip, or reveal is unsuccessful. Retries do not restore first-attempt credit. Illegal input does not consume an attempt.
- Finish reports presented counts and successes/attempts/rates by kind and overall. Zero-attempt rates display **—**. Untouched items are excluded; a started unfinished puzzle is unsuccessful.
- Sessions exist only in this tab's memory. Refreshing/closing loses them. No cookies, localStorage, sessionStorage, analytics, or network session API are used.
- UI concealment is not security: deliberate DevTools inspection can reveal answers. This is voluntary unrated training.

## Compact, verified lazy loading

Schema 3 has one small startup `manifest.json`: counts, exact-rating counts, independent puzzle/ordinary versions, and the original provenance/grading metadata. There is no per-shard list or arbitrary path. Default puzzle shards hold **256 records** (supported authoring sizes 128–256), homogeneous by exact rating; ordinary shards hold **64**. Partial final shards are preserved. Schemas 1 and 2 remain readable for legacy inputs and tests; production exporters emit schema 3 only.

The application makes **one manifest request before Start**, then loads the selected shard and prefetches at most one upcoming item. Counts-based ranges use O(number of eligible ratings) startup memory, not O(records/shards); deck swaps grow only with draws. Both kinds share an eight-entry cache keyed by complete versioned relative path. HTTP-transparent gzip decoding and explicit `.gz` bodies both work.

Fetch deadlines cover response bodies. Failed entries are evicted for retry, without resampling, skipping, or scoring. Finish needs no next-shard request. No grading/session implementation was changed for the new references.

Inventories are build/hydration integrity metadata, **not browser startup requests**. Their exact bytes define full SHA-256 group versions and include every file hash/size/count plus canonical logical-record digests. Complete validation checks all shards and ordinary legal grades; `--deep` additionally replays every puzzle (very slow for the full archive). See [CORPUS.md](CORPUS.md) for the normative contract. [HOSTING.md](HOSTING.md) distinguishes measured results from budgets and historical observations.

## Optional local authoring

Requirements: **Python 3.11+**, [uv](https://docs.astral.sh/uv/), and Stockfish for new grading only. Preserve raw sources, preparation manifests/inputs, `data/puzzle-index.sqlite3`, and **both** checkpoint trees. Git does not protect ignored files. Keep an independently verified backup before replacing anything expensive.

### Convert existing prepared data without an engine

```sh
uv run python package_corpus.py convert --input <frozen-backup>/public/training --output data/training/prepared
uv run python package_corpus.py pack --input data/training/prepared --output data/training/releases
```

These commands do not construct Stockfish, grade moves, download raw sources, or alter checkpoints. Conversion disk-sorts legacy records, preserves every published field/grade, legally adds only missing puzzle position keys, and compares before/after counts, exact ratings, and canonical digests **before publication**. Packaging is streamed, deterministic, and stores existing gzip shards rather than recompressing them.

### Import or expand

```sh
uv sync
uv run python import_puzzles.py --output data/training/prepared
# To import a fixed local source instead of the moving official URL:
# uv run python import_puzzles.py --source /path/to/lichess_db_puzzle.csv.zst --output data/training/prepared
uv run python expand_corpus.py --output data/training/prepared --positions 30000 --games 60000 --workers 7 --build
```

Import legally replays the complete source, records its raw SHA-256/statistics/position keys, and reuses a completed matching SQLite index. Ordinary records overlapping new puzzles are excluded. The default source is a moving snapshot: preserve the exact cached archive for reproducibility.

Expansion samples 60,000 rated standard games plus those needed to retain published ordinary records, from the August 2025 [Lichess Elite archive](https://database.nikonoel.fr/). Both players must meet the 1800 minimum; the archive's stronger 2500+/2300+, non-bullet prefilter means it is **not representative of all 1800+ play**. Local/broader PGNs are supported. Complete grading costs hours or days, not a deployment step. `--build` explicitly builds the chosen output as a local prepared preview, without requiring a newly published lock.

Evaluations/rejections are checkpointed under `data/expanded/static-checkpoints/`; original checkpoints remain under `data/static-checkpoints/`. Ctrl+C is checkpoint-safe, and the launcher forwards interruption. Same configuration/input reuses evaluations; worker count changes do not invalidate them. Engine name, node budget, input, threshold, or exporter version changes do. `export_static.VERSION` and grading fingerprint serialization remain unchanged. Set `STOCKFISH=/path/to/stockfish` when needed.

Do not automatically restart an interrupted job. Check processes/logs, coordinate a safe pause before changing authoring inputs/code, and never run old/new publication protocols together. The directory lock is reentrant in Python and shared with Node, has ownership diagnostics, and is **never automatically stolen**.

### Snapshot completed checkpoints

```sh
uv run python snapshot_corpus.py --output data/training/prepared --snapshot-root data/training/snapshots/<unique-name>
# Explicitly add --publish to update the selected prepared directory too.
```

Snapshots require matching index/grading provenance, preserve published records, verify every ordinary legal move/review line, exclude duplicate games/positions and puzzle overlaps, and refuse shrinkage. They freeze inventories and shards, so later publications cannot change them. Only the ordinary group is regenerated for schema-3 snapshots. Package the frozen `public/training` directory into release archives; Git staging is not a corpus publication mechanism. See each tool's `--help` for legacy conversion and alternate paths.

## Tests and performance budgets

```sh
npm test                               # synthetic tests work with no corpus
REQUIRE_TRAINING_DATA=1 TRAINING_DIR=data/training/site npm test
npm run data:check -- --local --training-dir data/training/site
npm run validate:data -- data/training/site --deep  # optional full puzzle replay
npm run build -- --training-dir data/training/site --local
npx playwright install chromium
npm run test:e2e                        # desktop/mobile, actual built artifact
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
```

The real-data Node test is mandatory under `REQUIRE_TRAINING_DATA=1`; it must fail, not skip, if missing. Browser tests retain real-corpus scoring, hidden metadata, retry, subpath, no-backend/no-engine assertions, plus version-retention simulations. ZIP tests require corresponding sources/retrieval tools and forbid corpus shards, raw archives, SQLite, caches, and checkpoints.

Budgets: manifest **64 KiB raw / 24 KiB gzip**, every compressed shard **64 KiB**, manifest plus initial selected/prefetched shard bodies **192 KiB**, source ZIP **10 MiB**, complete selected Pages artifact **900 MiB**. Performance uses five fresh Chromium contexts per desktop/mobile, disabled HTTP cache, reduced motion, 100 ms latency, 1.6 Mbit/s bandwidth, 4× CPU slowdown. Median setup readiness must be ≤3 s and Start→playable ≤1.5 s. Reports record medians/maxima, bytes/requests, versions, environment, and JS/CSS growth (>10% flagged). Local controlled measurements are not actual Pages smoke results.

## Structure and licensing

```text
index.html, web/            static UI, rules, sessions, compact lazy loader
training-data.lock.json    real prepared release pins (only after owner publication)
public/training/           hydration target; legacy tracked files temporarily retained at bootstrap
scripts/                   verified hydration, offline build, validation, source ZIP
training_assets.py         deterministic groups, inventories, freezing, locks
package_corpus.py          engine-free conversion/release archives
prepare.py, engine.py      optional raw sampling/Stockfish authoring
export_static.py           checkpointed complete grading
import_puzzles.py          complete legal import / SQLite index
expand_corpus.py            preparation reuse and grading launcher
snapshot_corpus.py          frozen completed evaluations, no engine
CORPUS.md, data/README.md   retrieval/publication/recovery/preservation contract
data/                      ignored prepared data, releases, caches, backups, evaluations
tests/, .github/            correctness/performance and Pages workflow
```

“Ordinary” is an engine/budget filter, not proof of no tactics; the 0.5-pawn boundary is not authoritative analysis. There are no accounts, ratings, hints, free engine analysis, or persistent results.

The frontend is **GPL-3.0-or-later**; see [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md). The streamed `source.zip` includes application, authoring/build/hydration tools, tests, documentation, production retrieval lock, themes/notices, and the retained dependency source/license subsets. It **excludes generated training data**, raw archives, SQLite, caches, and checkpoints. CC0 corpus retrieval is separate; omitting duplicate CC0 data does not remove the GPL obligation to supply corresponding frontend source. This project is not affiliated with Lichess.

# Free static hosting: feasibility and measurements

Status: **the static migration and schema-3 release tooling are implemented**. This file retains historical feasibility measurements and adds a separately identified controlled full-corpus migration measurement below. See [README.md](README.md) and [CORPUS.md](CORPUS.md) for current retrieval/deployment instructions. Python is authoring-only, with no FastAPI runtime. Prepared release [v0.1](https://github.com/Dont-Care-Didnt-Ask/maybe-puzzle/releases/tag/v0.1) is public and pinned; fresh remote retrieval, production build, and desktop/mobile browser checks passed. An actual public Pages smoke measurement remains separate from these local controlled checks.

## Recommendation: precompute all legal-move grades and serve a static app

**Adopted decision:** For the first GitHub Pages version, keep Python/Stockfish only as offline preparation tools. Move session logic into the browser, reuse a JavaScript rules library, and export a score for **every legal move** in each ordinary position. Keep the current published-line grading for puzzles. Load small, versioned data shards and prefetch upcoming items while the current position is displayed. Do not ship PGNs or raw source archives to the website.

**Alternatives:** Run a browser engine; combine cached moves with on-demand browser searches; keep a backend on a free-tier hosting provider.

**Reason:** A complete move table is small and gives deterministic, immediate feedback on every device without engine download/startup, CPU/battery use, search latency, or backend costs. The trade-off is author-side preparation time and a finite precomputed corpus. The two currently stored approved moves are **not** a complete list of acceptable moves: accepting only those two would incorrectly reject other sound moves. A static exporter must also re-sort and re-filter the finished score table; newly searched moves can alter which moves lie within the 50-centipawn threshold.

## Static hosting changes the secrecy and session guarantees

**Adopted decision:** Hide the sampled fraction, position kind, and solutions in the UI until the appropriate point, but explicitly describe this as UI concealment, not a security boundary. Keep session state in browser memory by default; without storage, reloading would lose the active session.

**Alternatives:** Retain a small backend for real secrets/reload recovery, or store a session in sessionStorage/localStorage.

**Reason:** A static site cannot securely conceal data it needs to use on a user's own device. Someone deliberately inspecting DevTools can find the fraction and answers. This is normally acceptable for voluntary, unrated self-training, but differs from the original server-side secret. A backend would be required to preserve that stronger guarantee. Persistence is a separate choice; the original no-session-storage preference need not be relaxed to use Pages.

## Implemented export: actual complete corpus

The first completed static export contains **10,000 puzzles and 1,000 ordinary positions from separate games**, including grades for **33,094 legal moves**. Stockfish 19, one thread per worker, 100,000 nodes per independently searched root move. All records pass Node validation for legality, complete move coverage, final two-good-move eligibility, exact rating indexes, source-game uniqueness, and puzzle-position overlap.

| Published component | Actual bytes | Notes |
| --- | ---: | --- |
| Puzzle shards | 593,816 | Gzip, 157 shards |
| Ordinary shards | 229,297 | Gzip, 16 shards |
| Manifest | 59,224 raw / 23,886 gzip | Exact rating index, no FENs/solutions |
| Application JavaScript | About 94,850 raw / 33,930 gzip | No engine |

**0.82 MB is the whole shard corpus, not the initial download.** Startup fetches only application assets and the manifest; the selected shard loads on Start, with the next item prefetched. HTTP compression of HTML/JS/CSS/manifest depends on the host; the explicit gzip training shards do not require special headers.

The complete first export took approximately **85 minutes of wall time with three workers** on the local fanless M3, including interruption/resumption checks and concurrent test/build work. It checked 1,325 candidates: 891 of the initial 1,000 remained eligible after complete scoring, and 109 replacements came from unused source games. Some fallback rejections use only the cheap two-line prefilter. Checkpoint resume reused completed evaluations rather than repeating them.

This is an observed end-to-end run, **not an isolated sustained CPU benchmark**. Do not infer linear worker speedup or treat the small warm-engine benchmark below as a promise. The exporter deliberately does more work than the prototype, rejected positions also cost CPU, and a fanless laptop throttles under sustained parallel load. At the time of this historical measurement, deployments used committed prepared assets and did none of this work. The release-artifact contract below supersedes that source-Git distribution mechanism; new builds explicitly hydrate verified prepared archives, still without engine work.

## Measurements: original preparation inputs

The original local input files (not the published shards), measured with gzip for size comparison (decimal MB):

| Asset | Records | JSON | Gzip |
| --- | ---: | ---: | ---: |
| Puzzles | 10,000 | 2.845 MB | 0.700 MB |
| Ordinary positions, only two cached lines | 1,000 | 0.404 MB | 0.116 MB |

The second row is **not enough for engine-free grading**; the implemented exporter now produces complete tables. A prototype record containing the setup FEN/move, scores for all legal moves, one review line, and a source URL measured 525 bytes of JSON / 220 gzip bytes per position across eight positions. This is an estimate, not a production export. Its sample had 27.1 legal moves/position; the complete current ordinary-position pool averages 33.0, so allow headroom:

| Ordinary-position pool | Estimated JSON | Estimated compressed data |
| --- | ---: | ---: |
| 1,000 | 0.5–0.8 MB | 0.2–0.3 MB |
| 10,000 | 5–8 MB | 2–3 MB |
| 100,000 | 50–80 MB | 20–30 MB |

These are total-corpus sizes, **not initial downloads**. Initial loading should include only application code, a compact index/manifest, and the first small shard. Sharding also avoids putting a very large individual file in Git. Explicit gzip shards with client decompression are an option if relying on a host's automatic JSON compression is undesirable.

## Measurements: preparation throughput

Reproduce without changing the dataset:

```sh
uv run python benchmark.py --games 50 --grade-positions 8 --nodes 100000
```

The benchmark follows the current one-position-per-game policy: up to four random plies in the 20–160 window, a two-line ordinary-position filter, then separate searches for every other legal move. The benchmark reuses the two prepared scores. The production exporter instead re-searches those two as well for a uniform budget, and re-filters the finished table, so it does slightly more work than this benchmark. Neither analyzes every move of every game.

Measured on one Stockfish thread, Hash=64 MB, at the current 100,000-node budget:

| Phase | Sample | Elapsed | Extrapolated throughput |
| --- | --- | ---: | ---: |
| Current ordinary-position filter | 50 games, 100 candidate attempts, 43 retained | 18.55 s | 9,704 games/h; 8,346 retained positions/h |
| Score all legal moves | 8 positions, mean 27.1 moves | 44.27 s | 651 positions/h |
| Filter plus complete move scoring | Above phases combined | — | About 604 fully scored candidate positions/h |

For planning, budget **roughly 500–600 fully scored positions/hour on one thread** at this search budget, or around two hours for the current 1,000-position pool. These are small, warm-engine samples, not sustained-throughput guarantees. They exclude archive download/scanning, final table re-filter losses, and export overhead. The larger corpus has more legal moves on average, and sustained laptop workloads can thermally throttle. More search nodes increase preparation time substantially. Multiple independent engine processes can help, but speedup on a fanless laptop must be measured rather than assumed linear.

The current budget is an MVP accuracy/latency compromise, not a guarantee that every 0.5-pawn boundary is reliable. Offline work allows increasing it later, at a corresponding CPU cost.

## Browser-engine alternative

[Stockfish.js 19](https://github.com/nmrugg/stockfish.js) documents these approximate JS+WASM sizes:

- Lite single-threaded: **1.7 MB**, no cross-origin isolation required.
- Full single-threaded: **94 MB**, no cross-origin isolation required.
- Multithreaded builds require cross-origin isolation/SharedArrayBuffer. Ordinary GitHub Pages cannot simply be configured with arbitrary COOP/COEP response headers; use a single-threaded build rather than making a service-worker header workaround part of the MVP.

A lite engine in a Web Worker is a viable fully free option: lazy-load/cache it, begin analysis while the user thinks, and avoid blocking the UI. But instant grading cannot be guaranteed for fast moves or slow phones. Lite uses a different, weaker network; its scores must not be blindly compared with cached full-engine scores. Recompute the baseline with the same browser engine, or prepare data using that exact engine/build. Analyze/present positions consistently so readiness indicators do not reveal their kind.

These engine sizes come from the upstream README, **not** a browser-speed benchmark on this laptop or on phones.

## GitHub Pages constraints and migration work

[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), checked during this investigation:

- GitHub Free supports Pages for a **public repository**.
- Pages serves static content, not a Python API or native Stockfish process.
- Published site size limit: **1 GB**; soft bandwidth limit: **100 GB/month**.
- Heavy corpus preparation should run locally, not inside the deployment workflow. The workflow should just build the frontend and publish prepared assets.

Implemented migration components:

1. A resumable offline exporter that grades all legal moves, validates/refilters positions, and creates a manifest plus shards.
2. Browser-side session/grading code, using an existing chess-rules library alongside Chessground.
3. Relative/base-path-safe asset URLs for `/chess-puzzle-not-puzzle/`.
4. A GitHub Actions Pages workflow and a generated static GPL `source.zip`/license file replacing the dynamic source-download endpoint.
5. Browser tests against a plain static server, including hidden-in-UI probability, scoring, deployment under a subpath, and the chosen reload behavior.

Follow README.md and CORPUS.md for current manual release bootstrap, explicit hydration, offline builds, and Pages deployment. There is no paid hosting dependency.

## Schema-3 full-corpus migration — observed local results (2026-10-28)

These are new measurements, not scout estimates or promised public Pages performance. Historical sections above remain historical. Before was an isolated build of HEAD `b61868d` using the authoritative backup, not stale `dist`; after was the first validated schema-3 **unpinned local preview** from the same preserved records. Source-only documentation/concurrency-test updates after this run can change source-ZIP/site bytes slightly; latest exact artifacts are recorded in the ignored JSON reports and build log.

### Preservation and dataset identity

- Authoritative frozen corpus: **6,157,341 puzzles / 19,664 fully graded ordinary positions**; 832,903 puzzles at 2400 ± 300; 2,796 exact rating counts. No records dropped, no grades recomputed, no expansion resumed.
- Backup: `data/training/backups/20261028T101223Z`, with all raw caches, preparation inputs, SQLite index and both checkpoint trees independently copied. 48,283 files / 3,229,877,970 bytes verified against original SHA-256 inventory. A second complete original/backup verification passed after implementation (`data/training/preservation-verification.json`). This is same-disk migration protection, not off-machine disaster recovery.
- Conversion report: `data/training/prepared/conversion-report.json`; before/after counts, exact ratings and canonical logical digests match. Puzzle logical SHA-256: `772fde89079ec5daa31e2e12a8442f84f43dcdaf78ded58c3ffa9321b88c49ed`; ordinary: `79c3bb5e43b55b07053acb69ab5b6da51b84063ea8c08497ee2e128d6b59c5e2`.
- Before catalog: schema 2, `c3d59f32f6d48d26fedc`. After: schema 3, `e39e25edb913a3599bc0`.
- Puzzle version: `6c20166466d934565358fd0c910fef818b30c47bbc2cadecdbf21c6fb96fb62f`.
- Ordinary version: `2940fd5fc1744b5947d6e4b08646c515e52c8dd5ac4a40811295f2eb4d5c5de7`.

### Distribution byte observations and enforced targets

All sizes below are bytes, not rounded filesystem allocation. Gzip manifest size uses Node's default gzip settings, as recorded by the measurement script; build validation also enforces the gzip budget. The selected site here contains current groups only: there is no previous schema-3 release yet. Synthetic tests cover current+previous allowlisting, deduplication, budget failure, and frozen-lock reuse.

| Measurement | Before | First measured schema-3 build | Gate |
| --- | ---: | ---: | ---: |
| Startup manifest, raw | 322,462 | 32,831 | ≤65,536 |
| Startup manifest, gzip | 81,578 | 12,820 | ≤24,576 |
| Largest compressed shard | 128,663 | 17,805 | ≤65,536 |
| Initial manifest + shards, desktop maximum | 461,721 | 64,952 | ≤196,608 |
| Initial manifest + shards, mobile maximum | 510,209 | 64,152 | ≤196,608 |
| Source ZIP | 365,896,562 | 449,178 | ≤10,485,760 |
| Whole selected site | 730,878,208 | 382,111,567 | ≤943,718,400 (900 MiB) |
| Training files including inventories/manifest | 4,773 | 25,863 | allowlisted |
| Training bytes including inventories/manifest | 364,672,101 | 381,347,403 | included in site gate |
| Minified application JS | 98,263 | 102,346 (+4.16%) | flag >10% growth |
| Application CSS | 28,205 | 28,205 (unchanged) | flag >10% growth |

Smaller shards increase file count and compression overhead; the corpus itself is not smaller. Most site-size reduction comes from removing the duplicate CC0 corpus from `source.zip`, **not** dropping records or frontend corresponding source. The ZIP was inspected for application/retrieval/build/test/theme/dependency sources and licenses, and absence of training shards/raw archives/SQLite/checkpoints/caches. A production source archive requires the real retrieval lock; this local archive clearly identifies its unpinned status.

All ten after samples made exactly **one manifest request before Start**, no shard/inventory requests at setup, and one selected shard plus at most one prefetch after Start. No backend/engine/external requests, HTTP cache hits or service-worker responses occurred. The browser never downloaded inventories.

### Controlled timings

Protocol: five **fresh Chromium contexts for each desktop/mobile profile**, disabled HTTP cache, bypassed service workers, reduced motion, CDP **100 ms latency, 1.6 Mbit/s download/upload, 4× CPU slowdown**. Navigation→setup ready and Start click→playable board are measured separately in-page. Initial training bytes include completed prefetch bodies, but prefetch is not added to the playable timer. Draws retain the application's real randomized mixture; samples are not a fixed puzzle-only microbenchmark.

Environment: Apple M3, macOS arm64, 8 CPUs, Node **v24.22.0**, Chromium **156.0.8078.4**. Desktop Chrome and iPhone 13 viewport/touch emulation both use Chromium. Tests run sequentially with no active authoring workers. This does not simulate all mobile hardware or real CDN compression/cache behavior.

| Profile / phase | Before median / max | After median / max | Initial median gate |
| --- | ---: | ---: | ---: |
| Desktop navigation→setup | 2,649.2 / 2,652.2 ms | 1,211.3 / 1,217.4 ms | ≤3,000 ms |
| Mobile navigation→setup | 2,648.5 / 2,651.1 ms | 1,209.3 / 1,219.0 ms | ≤3,000 ms |
| Desktop Start→playable | 259.6 / 813.2 ms | 255.9 / 261.3 ms | ≤1,500 ms |
| Mobile Start→playable | 271.7 / 651.3 ms | 261.9 / 272.6 ms | ≤1,500 ms |

Observed setup latency improved in this controlled local run; first-playable medians were already small and should not be generalized into a large gameplay-speed claim. All after byte/request/timing gates passed. Before correctly records failures against today's manifest/shard/source/initial-body budgets without treating historical behavior as a new-build failure.

Reports (ignored): `data/training/measurements/{before,after}-{desktop,mobile}.json`, with every sample, resource body/wire bytes, request counts/paths, versions, environment and maxima. `tests/performance-baseline.json` retains the measured original JS/CSS sizes for future CI growth gates; timing baselines are not portable across machines. Source/script changes should be reviewed with fresh reports, not assumed faster because they are lazy.

Reproduce:

```sh
npm run build -- --training-dir data/training/site --local
npx playwright test tests/browser.spec.js tests/themes.spec.js
PERF_BASELINE_REPORT='data/training/measurements/before-{project}.json' npx playwright test tests/performance.spec.js
```

Use `PLAYWRIGHT_DIST`, `PLAYWRIGHT_PORT`, `PLAYWRIGHT_BASE_PATH`, `PERF_PROFILE`, and `PERF_REPORT_DIR` for isolated runs. Historical `PERF_PROFILE=before` records budgets without gating. New measurements gate by default. Full puzzle `--deep` replay is supported and tested separately; routine full-corpus validation checks every authenticated puzzle structure/key/rating/ID and fully replays every ordinary record, not all puzzle lines.

### Public hosting and migration boundaries

**Actual Pages smoke measurement: not performed.** Public release upload and real immutable URL pinning are not authorized/available yet; clean-clone/CI retrieval remains intentionally blocked. Do not describe local archive hydration as fresh remote verification.

The 900 MiB built-site budget leaves margin below the documented Pages limit. Every future artifact carries current plus immediately previous distinct versions of each group, deduplicated independently. If that selection exceeds the budget, fail and require explicit owner retention review; do not silently discard previous bytes. Remote release assets outlive Pages retention. One previous version is not a time guarantee; an expired tab can 404, retaining its current state and allowing Finish before reload. The first schema-3 deployment does **not** retain legacy flat shard paths, so announce that legacy tabs may need to finish/reload.

Only after the owner uploads exact prepared archives, pins actual URLs, and verifies fresh empty-cache download/hydration/build/browser tests may generated files be removed from source and `/public/training/` ignored. Current originals and history remain unchanged by this implementation. Deleting current files later does not remove historical blobs; any history cleanup is separate, manual, and coordinated.

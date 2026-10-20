# Free static hosting: feasibility and measurements

Status: **the static migration described below is implemented**. This file retains the original feasibility measurements; see [README.md](README.md) for current setup/deployment instructions and [DECISIONS.md](DECISIONS.md), sections 13 onward, for adopted implementation choices. Python is now offline-only; there is no FastAPI runtime. No GitHub repository or public deployment has been created by the implementation.

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

This is an observed end-to-end run, **not an isolated sustained CPU benchmark**. Do not infer linear worker speedup or treat the small warm-engine benchmark below as a promise. The exporter deliberately does more work than the prototype, rejected positions also cost CPU, and a fanless laptop throttles under sustained parallel load. Normal clones/deployments use the already committed public assets and do none of this work.

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

Follow the step-by-step instructions in README.md to create a public repository, push, enable Pages with GitHub Actions, and run the deployment. There is no paid hosting dependency.

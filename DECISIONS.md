# Design decisions

**Static-site migration:** Decisions 13 onward supersede the server-specific parts of decisions 1, 2, 7, 8, and 9. **Corpus distribution migration:** Decisions 24–27 supersede the source-Git, schema-2 packaging, and staging/publication portions of decisions 15, 20, and 23. Earlier decisions are retained as historical rationale, not current operational instructions; none of the new decisions changes grading.

Each section records a choice, alternatives, and the reason for the MVP default.

## 1. Small server-rendered shell with a reusable chessboard

**Decision:** Use Python 3.11+, FastAPI, python-chess, a local Stockfish executable, and vanilla JavaScript with Chessground. Vite only bundles browser assets; FastAPI serves the built application. License the project under GPL-3.0-or-later, compatible with the reused chess components.

**Alternatives:** React/Next.js, a browser-only Stockfish worker, or a custom chessboard/rules implementation.

**Reason:** One application server, no frontend framework, and established chess libraries keep the implementation small. Server-side chess logic also avoids sending solutions or the hidden session fraction to the browser. A local engine avoids dependence on a rate-limited analysis service.

## 2. Ephemeral sessions with server-side secrets

**Decision:** Keep active sessions only in process memory, addressed by an unguessable token. Sample a randomized puzzle fraction once per session with a uniform draw on [0, 1); independently draw each item using that fraction. Reveal the sampled fraction and group statistics only when the user explicitly finishes. Clear finished sessions and expire idle sessions after six hours. Run one application worker.

**Alternatives:** Browser-only state, a database, or an exactly balanced/shuffled deck.

**Reason:** Browser-only state exposes the hidden fraction and upcoming answers. A database is unnecessary for this MVP. Independent draws avoid a predictable quota; the realized fraction can differ from the configured/sampled probability. No session data is written to disk.

## 3. Engine definition of an ordinary position and an okay move

**Decision:** Prepare ordinary positions with at least two legal moves within 50 centipawns of Stockfish's best move. At runtime accept a legal move within the same 50-centipawn threshold, evaluated at a fixed search budget. Reject positions whose best line has a forced mate or a very large material advantage (more than 5 pawns).

**Alternatives:** Treat every sampled game position as ordinary, use human move agreement, or use a win-probability-loss threshold.

**Reason:** Random game positions can themselves be tactics. The two-move filter implements the agreed MVP definition; the additional exclusions reduce trivial/mating positions and ambiguous mate-score comparisons. This is an engine/budget-dependent approximation, not a guarantee that a position contains no tactical ideas. The threshold is an evaluation loss, not necessarily literal material lost.

## 4. Puzzle difficulty uses anchor ± margin

**Decision:** Expose an anchor puzzle rating (default 1700) and a nonnegative margin (default 300). Select puzzles whose Lichess ratings lie in the inclusive anchor ± margin interval. Require at least one matching puzzle before starting a session that can contain puzzles.

**Alternatives:** Lower/upper rating inputs, adaptive ratings, or sampling all puzzle difficulties.

**Reason:** Anchor ± margin matches the requested control and is easy to understand. Adaptive ratings would require an additional model and are outside this MVP.

## 5. Real datasets, reproducible preparation, and sampling bias

**Decision:** Default to the August 2025 Lichess Elite PGN archive (about 78 MB compressed) and the official Lichess puzzle CSV (about 293 MB compressed at implementation time). Reservoir-sample 2,000 qualifying games across the entire game archive, explicitly checking both ratings ≥1800. Save the sampled games as PGN. Shuffle their order, sample a random eligible ply per game, and engine-filter until 1,000 distinct ordinary positions are retained, at most one per game. Reservoir-sample 10,000 puzzles across the entire puzzle CSV. Use a configurable random seed. Allow local PGN/CSV inputs and configurable sample sizes.

**Alternatives:** Multi-gigabyte monthly Lichess archives, live game APIs, hand-written examples, or taking the first N records.

**Reason:** The Elite archive is linked by Lichess and much smaller than the full database. Its stronger prefilter (2500+ versus 2300+, excluding bullet) satisfies but is not representative of the requested 1800+ population; this bias is disclosed. Custom full-database inputs can remove that bias. Whole-file reservoir sampling avoids chronological-prefix bias. Raw downloads and prepared position datasets are local reusable assets, not session storage. No fabricated games or placeholder puzzles are used.

## 6. First-attempt scoring, retries, and unfinished positions

**Decision:** Count a position as successful only if all required moves are correct on the first attempt. The first wrong legal move, skipping, or showing the answer records a failure exactly once; retries can complete the line but never restore credit. Merely displayed, untouched positions do not enter the success denominator. Finishing after a correct partial puzzle attempt counts that unfinished attempt as a failure. The summary separately reports presented counts, attempted counts, successes, and untouched positions.

**Alternatives:** Give credit after unlimited retries, silently discard partial attempts, or count every displayed position as a failure.

**Reason:** Honest calculation needs a meaningful first-attempt score. Excluding untouched positions avoids penalizing the next position merely being on screen when a session ends. Counting started-but-unfinished attempts prevents selective abandonment from inflating the score.

## 7. Puzzle solutions and identical initial presentation

**Decision:** Follow the published Lichess solution exactly, including automatic opponent replies. An incorrect move can be retried, and the user can reveal/replay the full solution after forfeiting credit. Ordinary positions require one acceptable move. Both kinds first show and animate the preceding opponent move; neither kind exposes its source, rating, evaluation, or identity before the first attempt. No hints are provided in the MVP.

**Alternatives:** Engine-accept alternative puzzle solutions, show different instructions by item kind, or add Lichess's rating/account features.

**Reason:** The curated solution is simpler and more consistent than re-adjudicating puzzle alternatives at shallow depth. Uniform presentation avoids an obvious context cue. Source links and review information are available only after the attempt is scored. Exact-line grading is a documented limitation, particularly for equivalent mating moves.

## 8. Bounded searches and ordinary-position sampling

**Decision:** Use one Stockfish thread, a 64 MB hash, and 100,000 search nodes per analysis by default. Store the preparation budget and the top two lines/scores with each ordinary position. Those two moves retain their prepared scores; other submitted moves receive a fresh root-restricted search with the same budget. Clear the hash for independent searches. Start from plies 20–160 (after moves 10–80), trying up to four randomly ordered eligible plies per sampled game and retaining at most one accepted position per game. Exclude duplicate positions and positions also present in the prepared puzzle pool.

**Alternatives:** Unbounded/deep searches, fixed-depth searches, re-search every position on delivery, or sample all plies including opening theory and very late endings.

**Reason:** A node budget makes preparation and interactive latency practical on ordinary hardware. Cached approved moves ensure every ordinary position really has at least two accepted moves under the MVP's rule. Other moves can still be affected by search noise. The ply window avoids mostly opening recall and excessively long/terminal endings; both window bounds and the search budget are preparation parameters. A higher budget and re-preparation are recommended before using this for serious assessment.

## 9. Session transport, concurrency, and reuse

**Decision:** Use a session-only HttpOnly, SameSite=Strict cookie, not localStorage or a token in URLs. Reloading restores an active session. Validate a monotonically increasing revision on every action, and serialize actions per session. Serialize engine searches through one engine process. Limit active sessions to 500 and discard idle sessions on subsequent API activity. Draw without repeats within each group until that group's pool is exhausted, then reshuffle it without changing the session's Bernoulli probability.

**Alternatives:** Put the complete session in browser storage, use bearer tokens in URLs, add Redis/multiple workers, or silently rebalance the mixture when a pool is exhausted.

**Reason:** Cookies keep secrets out of page source, URL logs, and persistent browser storage. Revision checks prevent double clicks, stale tabs, and retried requests from double-scoring or moving the wrong position. One engine is adequate for an MVP; a large public deployment would need engine workers, admission/rate limits, and shared session storage. Pool cycling keeps the chosen probability intact.

## 10. Puzzle quality and source snapshots

**Decision:** Import puzzles with nonnegative Lichess popularity and at least 100 plays, validate each sampled solution's legality, and otherwise preserve the archive's broad rating/theme distribution. Cache downloaded sources; preparation records source URLs, date, seed, engine version, search budget, and corpus counts. Reusing the same cached inputs and engine is necessary for reproducibility; the official puzzle URL is a moving snapshot.

**Alternatives:** Import every puzzle, impose a narrow rating/theme filter during preparation, or fetch fresh data on every server start.

**Reason:** A small quality floor avoids mostly untested/disliked puzzles without encoding a particular training curriculum. Rating filtering belongs to session configuration. Preparation is intentionally offline; the running trainer makes no third-party API calls and does not download new data behind the user's back.

## 11. Accessible input and deliberate progression

**Decision:** Support Chessground click/drag input, a UCI text field, explicit promotion choice (including underpromotion), board flipping, and post-attempt line replay. Require an explicit next/skip action rather than automatically advancing. Use the same setup-move animation for both groups and respect reduced-motion preferences.

**Alternatives:** A drag-only board, automatic queen promotion, automatic next-position loading, or a complete screen-reader chess UI.

**Reason:** Reusing Chessground gets the familiar Lichess interaction cheaply. A UCI field provides a keyboard-only fallback without duplicating chess rules in JavaScript. Explicit advancement gives time to review and makes skip scoring clear. Full board accessibility and free engine analysis remain outside this MVP.

## 12. Compare actual MultiPV scores, not engine output order

**Decision:** After a bounded two-line search, reject mate scores, sort the returned lines by their actual side-to-move centipawn scores, then apply the 50-centipawn gap and ±5-pawn best-score filters. Validate that prepared datasets maintain those invariants before serving them.

**Alternatives:** Trust MultiPV line-number order, use fixed-depth rather than fixed-node searches, or extend every interrupted iteration until all lines share a depth.

**Reason:** A node limit can interrupt iterative deepening: reported line 2 can temporarily have a higher score than line 1. Trusting line order can mistakenly accept a position whose two scores are more than 50 centipawns apart. Sorting enforces the intended filter under the recorded evaluations while preserving a bounded search budget. It does not eliminate the underlying search uncertainty.

## 13. Fully static runtime; Python only for offline preparation

**Decision:** Replace the FastAPI runtime with browser-local session logic, chess.js for rules/notation, and complete precomputed move-score tables. Keep Chessground and the existing interface. Publish Vite's static output on GitHub Pages. Retire the old server and its server-only dependencies/tests rather than maintain two applications.

**Alternatives:** Browser Stockfish, a free-tier API, or preserving parallel server/static implementations.

**Reason:** The user selected offline precomputation. It gives immediate grading, no engine download or battery use, no hosting bill, and one small application to maintain. Python remains a local dataset-authoring tool only.

## 14. Complete, checkpointed, consistent offline grading

**Decision:** Add an exporter that independently searches every legal root move at the preparation node budget, using one Stockfish thread per worker. Do not reuse shallower MultiPV scores in the final table. Re-sort all scores, reject forced-win/forced-loss best positions and positions beyond ±5 pawns, and require two moves within 50 centipawns of the final best score. Keep losing-mate moves as explicitly unsuccessful choices. Store one review PV from the final best move. Checkpoint each candidate (including rejections) with a fingerprint of its input, engine, budget, and exporter version. Default to three independent worker processes, configurable. Reuse checkpoints across interrupted runs.

**Alternatives:** Cache only two approved moves, reuse mixed-budget MultiPV scores, recompute every run, or run many engine threads per position.

**Reason:** Every legal move must be judged fairly without a runtime engine. Comparing uniformly searched root moves avoids known depth/order inconsistencies. Final re-filtering can shrink the pool; the exporter must report this honestly and never label a unique-good-move position ordinary. Independent workers speed up local preparation while bounding laptop CPU/memory use. Checkpoints make a lengthy preparation safe to interrupt.

## 15. Small content-addressed gzip shards and exact rating filtering

**Decision:** Export public training assets under `public/training/`: a compact manifest and gzip JSON shards (64 positions each by default). Keep puzzle ratings in the manifest so anchor ± margin selection is exact and uniformly sampled across matching records, without downloading their FENs/solutions. Fetch only needed shards, prefetch one upcoming item, and bound the shard cache. Use fflate for portable gzip decoding and for generating a static source archive at build time. Commit the exported assets, not raw archives, PGNs, or evaluation checkpoints. GitHub Actions only validates/builds/publishes; it does not run Stockfish.

**Alternatives:** Download the full corpus at startup, rely on host-specific compression headers, bucket difficulty approximately, or perform expensive preparation in CI.

**Reason:** Small independent files keep first-load and next-position latency low and work at a GitHub Pages repository subpath. Content hashes avoid stale mixed datasets. Portable decoding requires no custom HTTP headers, and also accepts already decoded JSON if a host supplies HTTP-level gzip decoding. The build still verifies the stored gzip files and their hashes. Exact rating metadata avoids empty/biased narrow difficulty ranges. Publishing precomputed assets avoids repeating author-side CPU work for users or deployments.

## 16. UI concealment and tab-local, nonpersistent sessions

**Decision:** Sample the mixture once with browser cryptographic randomness and keep it out of the rendered session view until Finish. The data and fraction are inspectable in DevTools; no security claim is made. Store sessions only in JavaScript memory: no cookies, localStorage, sessionStorage, analytics, or network session API. Reloading loses the session; display that warning before starting and while training. Each tab has its own independent session. Preserve first-attempt scoring, untouched/unfinished rules, revision guards, and without-replacement decks.

**Alternatives:** Retain a backend secret, persist sessions in browser storage, or disguise client data as if encrypted secrets were secure.

**Reason:** These static-site differences were disclosed and accepted. This is voluntary self-training, not an adversarial rated competition. Memory-only state preserves the no-session-storage preference. Prefetched but never displayed items do not affect counts, attempts, or the sampled probability.

## 17. One portable static build and public source availability

**Decision:** Build with relative asset URLs so the same output works at `/` or `/chess-puzzle-not-puzzle/`. Provide an Actions workflow with read-only build permissions and a separate Pages deployment permission scope. Generate a static GPL source ZIP during the build, including application/preparation/test sources, dependency locks, and installed browser dependency sources/assets. Publish a separate readable license/notice file alongside the app. Test against a plain static server at a repository subpath, with API/engine requests forbidden.

**Alternatives:** Hardcode an account/repository URL, keep a Python source-download endpoint, or test only at the web root.

**Reason:** Deployment should require only creating a public repository, choosing Actions in Pages settings, and pushing. A static source archive works before the final repository URL is known and preserves GPL source access without backend routes. Subpath tests catch the most common Pages deployment failures.

## 18. Bounded data-fetch waits without changing the reserved draw

**Decision:** Abort manifest/shard network reads after ten seconds (including body download), clear failed cache entries, and retain the current item and reserved next reference for retry. Background prefetch failures remain nonintrusive until the data is actually requested.

**Alternatives:** Unbounded fetch waits, selecting another item on failure, or adding a more complex cancelable navigation/session controller.

**Reason:** A tiny static shard should not lock session controls indefinitely on a broken connection. A bounded wait preserves a simple action model; retrying the same reference prevents network failures from biasing the sampled mixture or silently scoring a skip.

## 19. Try separate fallback games before additional plies from the same game

**Decision:** After the initial position pool, try one candidate per unused sampled game first, then revisit the remaining three sampled plies only if needed. The parent still accepts at most one position per game.

**Alternatives:** Submit four consecutive plies from each game, or permanently discard the other three after trying the first.

**Reason:** Parallel workers should not spend full all-move searches on several positions from a game that can contribute only one. Deferring—not dropping—the remaining candidates improves useful throughput while preserving the ability to fill a difficult corpus.

## 20. Complete puzzle archive with a compact exact-rating catalog

**Decision:** Replace the 10,000-puzzle sample with all 6,157,341 records in the official cached snapshot, including 832,903 at 2400 ± 300. Apply no popularity/play-count/rating filter. Legally replay every complete line in the importer, retain normalized post-setup keys for overlap validation, and record the source SHA-256 and import counts. Use a disk-backed SQLite sort/index rather than a multi-million-object Python list. Schema 2 stores one exact rating per homogeneous puzzle shard (up to 2,048 records), keeping the full manifest around 307 KB; schema 1 remains readable.

**Alternatives:** Merely increase the reservoir sample, restrict the import to high ratings, put millions of ratings into the startup manifest, or load the full corpus into browser memory.

**Reason:** The request is for everything Lichess publishes, especially around 2400, without changing the existing default difficulty. Virtual shard ranges plus a sparse lazy Fisher–Yates deck retain exact uniform, without-replacement selection with startup memory proportional to shards, not puzzle count. Runtime loading/cache/prefetch behavior remains bounded. Routine builds check all hashes/record structures/IDs/ratings/overlaps and fully replay ordinary positions. Puzzles are fully replayed at import and again when selected; an explicit `--deep` build validator can additionally replay the entire archive in JavaScript. The source ZIP is streamed and stores existing gzip shards without recompression.

## 21. Thirty-thousand-position offline expansion without lowering search quality

**Decision:** Sample 60,000 real rated games, add games required to retain existing positions, and target 30,000 distinct-game positions with the existing 100,000-node-per-root full move grading. Exclude positions against the complete puzzle index. Reuse published complete grades only when engine name, node budget, threshold, and exporter version match exactly. Checkpoint every completed candidate/rejection, and publish only a complete target. Keep CPU-heavy work local and resumable; seven single-threaded engines can run concurrently on the current eight-core machine.

**Alternatives:** Lower the node budget to finish quickly, use only two MultiPV moves as if they covered all legal choices, duplicate positions/games, publish a partial count labeled as 30,000, or run Stockfish in deployment CI.

**Reason:** Corpus size should not silently weaken move grading or change first-attempt semantics. This is an hours/overnight/multi-day authoring operation. The current public manifest reports completed/published records, while logs/checkpoints report in-progress work; the prior corpus remains usable until the complete replacement is ready.

## 22. Locally bundled, license-audited themes and minimal text removal

**Decision:** Preserve the existing Brown/Cburnett defaults. Add Blue/Green/Grey checkerboard palettes and the freely redistributable Merida (GPL-2.0-or-later) and Chessnut (Apache-2.0) SVG sets from a pinned public Lichess revision. Bundle assets, upstream attribution, and full license texts locally. Exclude noncommercial/restricted sets. A compact collapsed “Board & pieces” control works before and during training; choices live only in the current tab. Remove only “Calculate without the guarantee.” and “The position doesn't tell you.” from the page copy.

**Alternatives:** Hotlink Lichess assets, copy every theme without checking licenses, change the default appearance/difficulty, persist new preferences in storage, or redesign unrelated parts of the page.

**Reason:** Themes should work on a static repository subpath without third-party requests or additional persistence. The remainder of the layout, copy, training behavior, scoring, and defaults stays unchanged.

## 23. Commit completed checkpoint snapshots while expansion continues

**Decision:** Add an explicit checkpoint-only snapshot tool, separate from the normal full-target exporter. Reuse only completed grades whose candidate/configuration fingerprints match; recheck legal move coverage, ordinary-position invariants, unique games/positions, and complete-puzzle overlap. Preserve already published positions and label the snapshot with its actual qualified count and whether the 30,000 target is complete. Never run Stockfish or commit raw checkpoint files during snapshot creation.

**Reason:** Waiting for the full expansion previously prevented shipping thousands of usable results. A shared, reentrant publication lock serializes only manifest/shard updates, not CPU evaluation. Freeze the published manifest and referenced shards with hardlinks (or copies across filesystems), then stage that immutable tree with an alternate Git worktree. A later exporter publication cannot remove files from the snapshot or produce a mixed dataset in the commit. Include mobile touch-drag changes in their own semantic commit, preserve backlog edits, and continue excluding the commit script itself.

## 24. Separately versioned immutable prepared release groups

**Decision:** Move generated training data out of application-source Git only after verified preservation and retrieval gates. Use schema 3: a compact startup catalog with independent full SHA-256 puzzle/ordinary versions, counts, shard sizes, and sorted exact-rating count pairs. Derive every shard path. Default puzzle size is 256 (supported 128–256), ordinary size 64. Keep schema-1/2 input readers and validators, but emit schema 3 from new exporters. Record-uniform counts-based pools have one range per eligible rating; preserve Deck, Session, grading, prefetch and failure semantics unchanged.

**Alternatives:** Keep schema-2 per-shard startup lists, add a required auxiliary browser index, commit generated shards, use LFS, or download moving raw sources during builds.

**Reason:** Exact rating counts eliminate per-shard startup overhead without biasing selection or changing checkpoints. Group inventories authenticate full compressed-file hashes/lengths/counts, canonical logical digests and stable group-specific provenance, while staying out of browser startup. An ordinary snapshot must not change puzzle identity/archive bytes. Deterministic engine-free conversion preserves every published record/grade and compares independent before/after signatures; separate deterministic streamed archives preserve the complete prepared corpus without duplicating it in application source.

## 25. Cross-language manifest-last publication and frozen offline builds

**Decision:** Share a diagnostic exclusive directory lock between Python and Node, retain Python reentrancy, bound waits, and never automatically steal a lock. Coordinate old writers before the protocol migration. Stage and validate complete groups separately, verify captured inputs are still current, promote immutable directories, and replace only the manifest atomically last. Never edit old versions or prune previous groups during publication. Freeze the selected input/lock under the same lock before full validation and build. Disable Vite public copying and explicitly copy non-training assets and the selected corpus allowlist.

**Alternatives:** File locks unavailable to Node CI, deleting unreferenced files on export, reading a moving live tree during Vite, silently overwriting a competing publication, or implicit network repair during builds.

**Reason:** Snapshot/release stability is a filesystem/integrity contract, not a Git staging operation. Interrupted evaluations, checkpoints and preparation samples remain reusable. Existing corrupt immutable directories require operator recovery; a failed hydration must preserve previous live data. Production builds are strictly offline and require an exact real retrieval lock. Explicit local prepared builds remain usable before publication, with a visible unpinned-preview marker. The exporter grading version/fingerprint bytes remain unchanged; packaging uses a separate format version.

## 26. Verified release pins, bounded Pages retention, and manual bootstrap

**Decision:** The root retrieval lock pins the exact current manifest, current archive descriptors, and at most one immediately previous distinct version per group, including actual immutable public URLs and full SHA-256/size/count/provenance. Hydration verifies cached/downloaded archives, enforces safe streamed extraction limits and complete staged-catalog validation, then publishes manifest-last. Local-release candidates are explicitly separate from production locks. Release uploads and the first real pin require owner action; never invent URLs or claim an unpublished release is retrievable.

**Alternatives:** Mutable latest URLs, trusting cache names, retaining files only on an earlier Pages deployment, keeping every version forever in Pages, or automatic release publication/history rewriting.

**Reason:** Whole-site replacement requires current and retained groups in every artifact. One previous version is bounded by versions, not elapsed time; frequent releases can expire tabs. Expired requests preserve current board/score/revision/reserved draw and allow Finish, then reload. The first schema-3 deployment does not retain legacy flat paths; disclose that migration limitation. Remote release assets outlive Pages retention. A 900 MiB total-site budget fails rather than silently dropping declared retention. Local backups/archives/index/evaluations are not automatically pruned. Generated source removal is blocked until verified backup, usable local archives, and empty-cache remote retrieval/build/browser gates pass; historical blob cleanup is separately authorized and not implemented here.

## 27. Corresponding frontend source without a duplicate CC0 corpus; measured budgets

**Decision:** Stream corresponding frontend source, tools, tests, lockfiles, docs, theme assets/notices, the real production retrieval lock and the existing dependency source/license subsets into `source.zip`, excluding generated `public/training/**`. Retrieve the CC0 corpus via its verified lock/tools instead of bundling it twice. Keep frontend GPL source availability unchanged. Gate compact-manifest, per-shard, initial-request/body, source-ZIP and selected-site byte budgets; add five-context controlled desktop/mobile timing measurements and separately identify actual deployed smoke measurements.

**Alternatives:** A source ZIP as large as the entire site, omitting GPL frontend source, claiming lazy loading alone proves acceptable latency, or presenting targets/historical scout observations as measured improvements.

**Reason:** CC0 data distribution is independent of supplying the GPL application's corresponding source. Enforced budgets (64/24 KiB manifest raw/gzip, 64 KiB shards, 192 KiB initial training bodies, 10 MiB source, 900 MiB site) make full-corpus distribution auditable. Record median/max setup and first-playable timings, bytes/requests, dataset versions and environment under 100 ms / 1.6 Mbit/s / 4× CPU / disabled-cache conditions. Initial median timing gates are 3 s setup and 1.5 s first playable; flag >10% JS/CSS growth. Preserve historical measurements in HOSTING.md and clearly distinguish new observations, local controlled tests, and public Pages smoke tests.

# Prepared corpus contract and release operations

The application sources and the prepared CC0 training corpus are separately distributed. This document is normative for schema 3 and the release/hydration protocol. Grading, source eligibility, checkpoint fingerprints, and session/scoring semantics are unchanged.

## Bootstrap status and safety

The first release is **not yet public or pinned**. Do not invent URLs or commit a lock claiming assets exist. Until manual publication and fresh remote verification succeed, retain the original tracked `public/training/` unchanged and work in ignored `data/training/prepared`, `data/training/releases`, and `data/training/site`.

Before changing authoring inputs/publication code, recheck processes, locks, worktree, branch, and actual remote refs. Do not interrupt Stockfish/import/export/snapshot jobs automatically. Coordinate a checkpoint-safe pause; old writers used a different lock and cannot safely run alongside new writers.

Copy authoritative `public/training` (not stale `dist/training`) under its existing publication lock. Keep a full SHA-256 inventory, copied manifest, counts, provenance, grading configuration, and verified byte-for-byte copy. Independently copy and verify `data/puzzle-index.sqlite3`, raw caches, preparation manifests/PGNs/inputs, and both checkpoint trees. These ignored assets are not recoverable from application Git. A local copy protects this migration, but is not off-machine disaster recovery; owners should maintain an additional independent storage backup.

The implementation's migration backup is `data/training/backups/20261028T101223Z/`: `public/training/`, `authoring/`, and `backup-inventory.json`. It verifies 48,283 copied files totaling 3,229,877,970 bytes. No authoring workers were active when it was taken. Historical process/commit observations are not a guarantee of the state at the next operation.

## Startup manifest — schema 3

Shape (numbers/versions here describe fields, not an available release):

```json
{
  "schema": 3,
  "tolerance_cp": 50,
  "dataset_id": "catalog identity",
  "engine": "Stockfish 19",
  "nodes": 100000,
  "sampled_games": 60757,
  "puzzles": {
    "version": "<full lowercase SHA-256 of puzzle inventory bytes>",
    "count": 6157341,
    "shard_size": 256,
    "rating_counts": [[399, 1], [400, 12]]
  },
  "ordinary": {
    "version": "<independent full lowercase SHA-256>",
    "count": 19664,
    "shard_size": 64
  }
}
```

Keep existing top-level provenance/grading metadata (`puzzle_import`, raw source SHA-256, source URLs/seed, preparation details, exporter version, engine/nodes, snapshot qualification). The illustrative `rating_counts` above is incomplete: actual pairs are generated from the entire frozen input, never copied from documentation.

- `rating_counts` is an ascending array of unique `[integer rating, positive safe-integer count]` pairs summing exactly to `count`. Imported ratings are not restricted by UI-selectable limits; signed safe integer ratings are accepted.
- All counts, sums, indices, part/row numbers, and offsets are safe integers (≤2⁵³−1). No floating point count arithmetic may silently overflow.
- Puzzle shard size defaults to **256**, supported authoring interval **128–256** inclusive; ordinary size is **64**. An over-budget shard requires a supported smaller puzzle size and a regenerated version, never record deletion or weaker grading.
- Puzzles are disk-sorted by `(rating,id)`, ordinary by `id`. Each puzzle shard has one exact rating. Only the final part for a rating/group can be smaller.
- There are no arbitrary paths, URL templates, per-record entries, or per-shard lists in the startup manifest. Compact group objects have exactly the shown fields.
- Paths are derived from validated kind/version/integers:

```text
puzzles/<64-hex-version>/<exact-rating>/<zero-based-part>.json.gz
ordinary/<64-hex-version>/<zero-based-part>.json.gz
```

For a record index within its exact-rating range, `offset=index-range.start`, `part=floor(offset/shard_size)`, `row=offset%shard_size`. Ordinary uses the same quotient/remainder over its total count. Browser pools hold one cumulative range per matching rating, exposing `.length`/`.at(index)` without materializing millions of references. Reference versions are group-specific; references from a foreign group version are rejected. Final shard length and selected puzzle exact rating are checked. The shared eight-entry cache uses complete versioned paths.

Startup fetches exactly one manifest; the browser never needs an inventory/index request. Relative URL resolution, receiver-safe fetch, transparent HTTP gzip decoding, response-body deadlines, failed-entry eviction/retry, one-item prefetch, reserved draws, and scoring are preserved. Schemas **1 and 2 remain validated readable inputs**, including legacy filename hash checks; all new production exports are schema 3.

## Immutable integrity inventories

Each group contains `<kind>/<version>/inventory.json`. The inventory is Python-compatible canonical JSON: UTF-8, sorted keys by Unicode code point, compact separators, ASCII escapes as `json.dumps(..., sort_keys=True, separators=(',', ':'))`, no trailing newline. Gzip uses level 6, mtime 0, no filename, and fixed OS byte 255. Compression library/version is part of the reproducibility environment.

```text
{
  format: 1,
  kind: "puzzles" | "ordinary",
  count, shard_size,
  rating_counts: [[rating,count], ...],   // puzzle inventory only
  provenance: { stable, group-specific metadata },
  logical_sha256: "<full SHA-256>",
  shards: [{path, count, bytes, sha256}, ...]
}
```

`path` is relative to the group directory (`1400/0.json.gz`, or `0.json.gz`), so inventory identity is not circular. The **full SHA-256 of the exact inventory bytes is the version**. All compressed shard hashes are full SHA-256, with exact compressed byte lengths and record counts. Inventories contain exactly the derived shard set, in canonical part order, and no unlisted files/directories/links are allowed inside a group.

`logical_sha256` hashes canonical record JSON followed by LF for each record in canonical `(rating,id)` / `id` order. Conversion compares independent disk-backed source signatures to authenticated staged destination records before promotion. The sole normalization is legally adding a missing puzzle `position_key` to a legacy record; every preexisting record field, score, review line, ID, FEN, move, URL and provenance is preserved.

Puzzle provenance includes `source_puzzles` and `puzzle_import`. Ordinary provenance includes engine/nodes/threshold/exporter version, source games/seed, sampled-games count, and eligibility/ply settings. Packaging/publication timestamps and unrelated group metadata are excluded. Adding an ordinary snapshot cannot change puzzle version/archive bytes. Identical records/settings reproduce gzip, inventory, group version, and ZIP bytes. Top-level publication provenance may still change the catalog `dataset_id` without changing either group.

Node validation checks inventory identity/descriptors, exact file sets, full hashes/lengths, counts, record structure/order/IDs/ratings, ordinary legal grades/review lines, unique ordinary positions/games, and puzzle/ordinary overlap. `--deep` additionally legally replays every puzzle. Normal validation trusts legally imported puzzle position keys authenticated by the inventory; selected puzzles are also replayed by the browser.

## Locks, frozen reads, and publication

Python `training_assets.py` and Node `scripts/data-integrity.mjs` use the same physical resolved output path plus `.publication-lock` as an exclusive directory. `owner.json` records process/host/start diagnostics; waits are bounded. Python nested calls are reentrant within the owning thread. **No automatic stale-lock stealing.** If a writer crashed, inspect ownership and processes, get operator confirmation, and only then remove that lock manually. PID reuse or elapsed time is not proof of abandonment.

Readers that must freeze a corpus acquire the same lock and freeze manifest, inventories, and referenced shards by hardlink or copy. Published groups are immutable; later writers cannot edit them. Conversion/hydration/export prepare separate staging directories and validate first. Under the lock they verify the captured input/live manifest (and lock/candidate where applicable) is still current, promote complete new version directories, and atomically replace `manifest.json` **last**. Conflicting writers fail safely rather than overwrite an unseen publication. Existing corrupt immutable versions require operator recovery, not in-place repair. No publisher deletes previous live groups.

`export_static.VERSION=1` and existing `encoded`/`digest` checkpoint serialization remain unchanged; packaging has its own format version. `export_static` reexports shared encoding/digest/lock helpers for callers. Reuse requires the original engine/budget/config/input fingerprint. Worker count is not part of the grading fingerprint. `--puzzle-catalog` retains the same-output-directory restriction and requires a matching SQLite index; convert legacy catalogs explicitly before reuse.

## Engine-free conversion and archive preparation

```sh
uv run python package_corpus.py convert \
  --input data/training/backups/<timestamp>/public/training \
  --output data/training/prepared

uv run python package_corpus.py pack \
  --input data/training/prepared \
  --output data/training/releases
```

Never download the current upstream CSV to reconstruct a frozen publication. Conversion disk-sorts legacy input using SQLite rather than retaining millions of puzzle objects. `conversion-report.json` records before/after counts, exact ratings, logical digests, and source/destination manifest hashes. It is tool metadata, not a startup dependency.

Packaging emits:

```text
puzzles-<puzzle-version>.zip
ordinary-<ordinary-version>.zip
release-candidate.json
```

ZIP entries include `<kind>/<version>/inventory.json` and exactly its shard paths. ZIP metadata is fixed (1980-01-01, regular 0644 files, fixed platform flags, no archive timestamps/comments); gzip entries are stored, not recompressed. Creation and extraction stream shard bodies. Candidate format:

```text
{format:1, manifest:<exact schema-3 manifest>, archives:{puzzles:<descriptor>,ordinary:<descriptor>}}
descriptor = {kind,version,file,sha256,bytes,file_count,extracted_bytes,count,provenance}
```

Conversion/packaging never construct an engine, grade, download raw data, or alter preparation/checkpoint trees. `snapshot_corpus.py` may assemble completed compatible grades without Stockfish; schema-3 snapshots generate only ordinary groups, preserve all published records, and refuse shrinkage. Freeze with `--snapshot-root`; `--publish` separately updates the selected prepared output. Package this frozen release, not a Git staging worktree.

## Manual release bootstrap — blocking owner action

1. Inspect conversion report, archive descriptors, validation, correctness/performance reports, and full backup inventory.
2. Choose the **actual public release repository and immutable tag**. Authorize the two archive uploads explicitly. No tool here publishes releases.
3. Upload the already prepared versioned archives **without rebuilding them**. Keep release assets permanently available, even when no longer retained on Pages.
4. Pin using actual published URLs (replace shell variables with real values; these are not placeholder URLs):

```sh
npm run data:pin -- --candidate data/training/releases/release-candidate.json \
  --puzzles-url "$ACTUAL_PUZZLE_ARCHIVE_URL" --ordinary-url "$ACTUAL_ORDINARY_ARCHIVE_URL"
```

5. Verify remote retrieval in an **empty new cache/output**, not the local release or old cache:

```sh
npm run data:hydrate -- --cache-dir data/training/remote-verification/archives --output data/training/remote-verification/site
npm run data:check -- --training-dir data/training/remote-verification/site
REQUIRE_TRAINING_DATA=1 TRAINING_DIR=data/training/remote-verification/site npm test
npm run build -- --training-dir data/training/remote-verification/site
npm run test:e2e
```

Pin verifies the local candidate/archives and validates explicit HTTPS versioned URLs, but **does not prove those URLs are published/retrievable**. Fresh remote hydration is a distinct mandatory owner gate. Never write a production lock if those assets have not actually been published. While unavailable, stop at a locally validated candidate and retain tracked originals.

## Production lock, hydration, and local bootstrap

`training-data.lock.json` belongs at the application repository root once real release inputs exist:

```text
{format:1, manifest:<exact current schema-3 startup object>, archives:{
  puzzles:{current:<descriptor + actual url>, previous?:<descriptor + actual url>},
  ordinary:{current:<descriptor + actual url>, previous?:<descriptor + actual url>}
}}
```

At most one immediately previous **distinct** version per group is retained; unchanged groups are deduplicated independently. Pinning carries the prior current slot forward on a group change. Reusing a version with different archive metadata is an error. An ordinary-only release uploads only its ordinary archive, keeping the puzzle descriptor/URL. Pin needs access to both candidate archives for local verification; unchanged archives need not be uploaded twice.

```sh
npm run data:hydrate
npm run data:hydrate -- --offline
npm run data:check
# Explicit unpublished local bootstrap, no remote lock:
npm run data:hydrate -- --local-release data/training/releases --output data/training/site --offline
npm run data:check -- --local --training-dir data/training/site
```

Hydration caches by **full archive SHA-256** at `data/training/archives/<sha256>.zip`, reverifies size/hash even on cache hits, and streams bounded retry/deadline downloads through attempt-specific temporary files. Offline mode never downloads. Local release mode validates candidate metadata and local archives without fake URLs or a production lock.

Extraction rejects absolute/traversal/backslash/drive/NUL paths, duplicate entries, unexpected kind/version prefixes, symlinks/special files, unlisted files, inconsistent ZIP headers/CRC/sizes, and excess file/extracted-byte limits. Only regular files are materialized in fresh staging. Inventories/full hashes/counts and assembled catalog overlap are checked before manifest-last publication. Failure leaves previous live data intact and discards only attempt-specific staging. Corrupt caches can be reacquired online; offline corrupt/missing caches fail safely. No automatic pruning of backups, prior archives, indexes, or evaluations occurs.

## Offline builds and retention

```sh
npm run build                                         # requires hydrated matching root lock
npm run build -- --training-dir data/training/site --local
```

Builds never hydrate implicitly. Under the lock they freeze selected current/previous inventories/shards and the exact lock; they validate those frozen bytes, run Vite with public copying disabled, explicitly copy only non-training public assets and the frozen training allowlist, and produce source/notices. Stale versions and legacy shards present in a live directory cannot leak into a Pages artifact. Local builds are visibly marked unpinned; `--deep` optionally adds complete puzzle replay in either mode.

Pages whole-site replacement requires both current and retained bytes in **every artifact**. Retention is not based on files surviving a prior deployment. Current-plus-previous and all app/source/theme bytes must fit **900 MiB**; otherwise fail and require an explicit operator retention decision. One previous version is not an elapsed-time guarantee. A tab's pinned A references keep requesting A after B deployment while A is retained. If A expires, a 404 must not resample, score, change the current board/revision, or lose its pending draw; Finish remains available and the user is instructed to reload afterward.

**First migration limitation:** legacy schema-1/2 flat shard paths are not included in the first schema-3 artifact. Announce that existing tabs may need to finish and reload. Reading legacy inputs is not a promise of retaining their deployment paths.

Budgets: startup manifest ≤64 KiB raw / ≤24 KiB gzip, each compressed shard ≤64 KiB, exactly one training request before Start, initial selected+at most one prefetched shard, those bodies plus manifest ≤192 KiB, `source.zip` ≤10 MiB, entire selected Pages artifact ≤900 MiB. Controlled timing profile and observed results live in [HOSTING.md](HOSTING.md); targets are not measurements.

## Source availability and recovery

`source.zip` excludes only generated `public/training/**` from the public application assets. It includes frontend sources, authoring/build/hydration tools, tests, lockfiles, theme assets/attributions, notices, this document, and the production retrieval lock. Existing dependency source/license subsets are retained. Local-preview source archives identify their unpinned status rather than invent a retrieval lock. CC0 data need not be duplicated inside the GPL frontend source ZIP; corresponding frontend source must still be supplied.

Rollback by restoring a previously reviewed lock with real available archives, hydrating/verifying into a fresh directory, and building/test-deploying that selection. Do not mutate immutable archives/groups or erase the independent backup. For corruption, preserve diagnostics and move operator-selected corrupt material aside only after verifying a replacement in a fresh output; tools never silently replace a published immutable directory.

Only **after** backup verification, usable local archives, and empty-cache remote download/build/browser verification pass should the owner add `/public/training/` to `.gitignore` and prepare reviewed filesystem deletions of generated source files. Leave recording deletions to normal owner review; tools do not stage/commit/push. Until that removal is recorded, use `data/training/site` plus explicit local build paths, avoiding restoring the old tracked manifest accidentally.

Deleting current files does not remove historical blobs or shrink old clones immediately. Optional history cleanup is a separate manual operation: verify remote refs, back up repository refs independently of ignored datasets, coordinate collaborators if shared history changes, validate a clean replacement clone and real retrieval lock, and authorize any remote update separately. Immutable prepared release artifacts are preferred here over introducing Git LFS/quota/retrieval machinery.

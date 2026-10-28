"""Expand ordinary positions to 30,000 with sustained, resumable offline CPU work.

First run import_puzzles.py. Then:
  uv run python expand_corpus.py --workers 7
This samples 60,000 real rated games (plus any games needed to retain old positions),
then fully grades every legal move at 100,000 nodes/root using export_static.py.
"""

import argparse
import json
import os
import random
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

import chess.pgn

from prepare import GAMES_URL, ROOT, download, reservoir_add, save_json, unpack_pgn
from training_assets import (
    check_manifest,
    file_digest,
    frozen_catalog,
    publication_lock,
    read_group,
)


def prepare_games(
    source: Path, directory: Path, output: Path, count=60_000, seed=2026, source_label=None
):
    config = {
        "games": count,
        "seed": seed,
        "source": str(source.resolve()),
        "source_label": source_label or str(source.resolve()),
        "source_size": source.stat().st_size,
        "source_mtime_ns": source.stat().st_mtime_ns,
    }
    marker = directory / "manifest.json"
    if marker.exists():
        cached = json.loads(marker.read_text())
        if cached.get("expansion_config") == config and "source_grading" in cached:
            print(f"Using prepared expansion inputs: {directory}", flush=True)
            return
    source_fingerprint = file_digest(source)
    with frozen_catalog(output) as frozen:
        manifest = frozen.manifest
        expected_catalog = frozen.manifest_sha256
        positions = list(read_group(frozen.directory, manifest["ordinary"], "ordinary"))
    required = {p["url"].split("#")[0] for p in positions}
    rng, spans, preserved, seen = random.Random(seed), [], {}, 0
    print(
        f"Sampling {count:,} rated games; preserving {len(required):,} existing games", flush=True
    )
    with source.open(encoding="utf-8-sig") as stream:
        while True:
            start = stream.tell()
            headers = chess.pgn.read_headers(stream)
            end = stream.tell()
            if headers is None:
                break
            try:
                rating = min(int(headers.get("WhiteElo", "0")), int(headers.get("BlackElo", "0")))
            except ValueError:
                continue
            if (
                rating < 1800
                or headers.get("Variant", "Standard") != "Standard"
                or "Rated" not in headers.get("Event", "")
            ):
                continue
            url = (headers.get("LichessURL") or headers.get("Site", "")).split("#")[0]
            if not url.startswith("https://lichess.org/"):
                continue
            seen += 1
            span = (start, end)
            reservoir_add(spans, span, seen, count, rng)
            if url in required:
                preserved[url] = span
    if len(spans) < count:
        raise ValueError(f"Only {seen:,} qualifying games, need {count:,}")
    spans = sorted(set(spans) | set(preserved.values()))
    rng.shuffle(spans)

    def check_source(*, deep=False):
        if (source.stat().st_size, source.stat().st_mtime_ns) != (
            config["source_size"],
            config["source_mtime_ns"],
        ) or (deep and file_digest(source) != source_fingerprint):
            raise ValueError("Source PGN changed during sampling; retry with frozen source games")

    check_source()
    directory.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with (
            source.open("rb") as stream,
            tempfile.NamedTemporaryFile(
                prefix=".games-", suffix=".pgn.tmp", dir=directory, delete=False
            ) as destination,
        ):
            temporary = Path(destination.name)
            for start, end in spans:
                stream.seek(start)
                content = stream.read(end - start)
                if len(content) != end - start:
                    raise ValueError(
                        "Source PGN truncated during copying; previous inputs unchanged"
                    )
                destination.write(content)
                destination.write(b"\n\n")
        check_source(deep=True)
        with publication_lock(output):
            check_manifest(output, expected_catalog)
            check_source()
            temporary.replace(directory / "games.pgn")
            save_json(directory / "positions.json", positions)
            save_json(
                marker,
                {
                    "expansion_config": config,
                    "source_grading": {
                        "engine": manifest.get("engine"),
                        "nodes": manifest.get("nodes"),
                        "version": manifest.get("exporter_version"),
                        "tolerance_cp": manifest.get("tolerance_cp"),
                    },
                    "prepared_at": datetime.now(UTC).isoformat(),
                    "seed": seed,
                    "games_source": source_label or str(source.resolve()),
                    "puzzles_source": manifest["source_puzzles"],
                    "eligible_games": seen,
                    "sampled_games": len(spans),
                    "min_rating": 1800,
                    "min_ply": 20,
                    "max_ply": 160,
                    "nodes": 100_000,
                },
            )
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(f"Prepared {len(spans):,} of {seen:,} games for full grading", flush=True)


def puzzles_ready(output: Path, index: Path) -> bool:
    """Only a complete index matching the published import provenance is ready.

    Read just the small manifest/completion marker, not the full corpus. An
    absent catalog or a concurrently incomplete SQLite file means keep waiting;
    mode=ro must never create a missing index as a side effect of polling.
    """
    try:
        with publication_lock(output):
            manifest = json.loads((Path(output) / "manifest.json").read_bytes())
        if not isinstance(manifest, dict) or manifest.get("schema") != 3:
            return False
        expected = manifest.get("puzzle_import")
        if not isinstance(expected, dict) or not expected:
            return False
        with closing(
            sqlite3.connect(f"{Path(index).resolve().as_uri()}?mode=ro", uri=True)
        ) as database:
            rows = database.execute("SELECT value FROM metadata").fetchall()
        return len(rows) == 1 and json.loads(rows[0][0]) == expected
    except (FileNotFoundError, sqlite3.Error, json.JSONDecodeError, TypeError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games-source", default=GAMES_URL)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data/expanded")
    parser.add_argument("--output", type=Path, default=ROOT / "public/training")
    parser.add_argument("--puzzle-index", type=Path, default=ROOT / "data/puzzle-index.sqlite3")
    parser.add_argument("--games", type=int, default=60_000)
    parser.add_argument("--positions", type=int, default=30_000)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument(
        "--build",
        action="store_true",
        help="After successful publication, validate and rebuild dist/ with npm",
    )
    parser.add_argument(
        "--wait-for-puzzles",
        action="store_true",
        help="Wait for a concurrent full-archive importer before grading",
    )
    args = parser.parse_args()
    if not 0 < args.positions <= args.games or args.workers < 1:
        parser.error("Require 0 < positions <= games and workers > 0")
    cache = ROOT / "data/cache"
    cache.mkdir(parents=True, exist_ok=True)
    source = unpack_pgn(download(args.games_source, cache), cache)
    prepare_games(source, args.data_dir, args.output, args.games, args.seed, args.games_source)
    if args.prepare_only:
        return
    if args.wait_for_puzzles:
        print("Waiting for the full puzzle catalog/index before grading…", flush=True)
        while not puzzles_ready(args.output, args.puzzle_index):
            time.sleep(5)
    command = [
        sys.executable,
        "-u",
        str(ROOT / "export_static.py"),
        "--data-dir",
        str(args.data_dir),
        "--output",
        str(args.output),
        "--positions",
        str(args.positions),
        "--workers",
        str(args.workers),
        "--puzzle-catalog",
        str(args.output),
        "--puzzle-index",
        str(args.puzzle_index),
    ]
    print("Starting resumable full grading: " + " ".join(command), flush=True)
    with subprocess.Popen(command) as process:

        def stop(_signum, _frame):
            # Forward a checkpoint-safe interrupt to the exporter, not SIGTERM to
            # its individual engines. Killing this launcher PID is safe as well.
            if process.poll() is None:
                process.send_signal(signal.SIGINT)

        previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
        try:
            result = process.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        if result:
            raise SystemExit(result)
    if args.build:
        subprocess.run(
            ["npm", "run", "build", "--", "--training-dir", str(args.output.resolve()), "--local"],
            cwd=ROOT,
            check=True,
        )


if __name__ == "__main__":
    main()

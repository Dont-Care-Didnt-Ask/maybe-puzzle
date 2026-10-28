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
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import chess.pgn

from import_puzzles import read_group
from prepare import GAMES_URL, ROOT, download, reservoir_add, save_json, unpack_pgn


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
    manifest = json.loads((output / "manifest.json").read_text())
    positions = list(read_group(output, manifest["ordinary"]))
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
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / "games.pgn.tmp"
    with source.open("rb") as stream, temporary.open("wb") as destination:
        for start, end in spans:
            stream.seek(start)
            destination.write(stream.read(end - start))
            destination.write(b"\n\n")
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
    print(f"Prepared {len(spans):,} of {seen:,} games for full grading", flush=True)


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
        while True:
            manifest = json.loads((args.output / "manifest.json").read_text())
            if manifest["schema"] == 2 and args.puzzle_index.exists():
                break
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
        subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()

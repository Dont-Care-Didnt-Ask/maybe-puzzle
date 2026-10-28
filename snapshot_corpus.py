"""Freeze completed checkpoint results for publication/committing, without Stockfish.

uv run python snapshot_corpus.py --publish --snapshot-root /tmp/chess-snapshot
The snapshot root contains public/training/ for staging with an alternate worktree.
Engine workers can keep running; only the short publication section is locked.
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import chess

from export_static import VERSION, digest, export_assets, publication_lock
from import_puzzles import read_group
from prepare import ROOT, position_key, save_json


def validated_key(record):
    """Check complete legal-move coverage and ordinary-position invariants."""
    if not isinstance(record.get("id"), str) or not record["id"] or len(record["moves"]) != 1:
        raise ValueError("Invalid checkpoint position")
    board = chess.Board(record["fen"])
    if not board.is_valid():
        raise ValueError("Invalid checkpoint FEN")
    board.push_uci(record["moves"][0])
    board = chess.Board(board.fen())
    if board.is_game_over(claim_draw=True):
        raise ValueError("Terminal checkpoint position")
    if set(record["scores"]) != {move.uci() for move in board.legal_moves}:
        raise ValueError("Incomplete checkpoint move grades")
    finite = []
    for score in record["scores"].values():
        if type(score) is int:
            finite.append(score)
        elif not (
            isinstance(score, str) and re.fullmatch(r"M-?\d+", score) and int(score[1:]) <= 0
        ):
            raise ValueError("Invalid/mating checkpoint score")
    finite.sort(reverse=True)
    if (
        len(finite) < 2
        or finite[0] != record["best_cp"]
        or abs(finite[0]) > 500
        or finite[0] - finite[1] > 50
    ):
        raise ValueError("Checkpoint does not have two acceptable moves")
    line = record["line"]
    if not line or record["scores"].get(line[0]) != record["best_cp"]:
        raise ValueError("Invalid checkpoint review line")
    variation = board.copy()
    for move in line:
        variation.push_uci(move)
    return position_key(board)


def completed_records(directory, published, config):
    yield from published
    # List only completed atomic JSON files, not in-progress .tmp writes. Later
    # checkpoints belong to the next snapshot; existing files are immutable.
    for path in sorted((directory / "static-checkpoints").glob("*.json")):
        checkpoint = json.loads(path.read_text())
        record = checkpoint.get("record")
        if record is None:
            continue
        source = {key: record[key] for key in ("id", "fen", "moves", "url")}
        fingerprints = {
            digest({"config": config, "source": source}),
            digest({"config": config, "source": {**source, "prefilter": True}}),
        }
        if path.stem == checkpoint.get("fingerprint") and path.stem in fingerprints:
            yield record


def freeze_files(output, destination, manifest):
    destination.mkdir(parents=True)
    for group in ("puzzles", "ordinary"):
        for shard in manifest[group]["shards"]:
            source, target = output / shard["file"], destination / shard["file"]
            try:
                os.link(source, target)
            except OSError:
                shutil.copyfile(source, target)
    save_json(destination / "manifest.json", manifest)


def snapshot_corpus(directory, output, index, snapshot_root, *, publish=False, target=30_000):
    destination = snapshot_root / "public/training"
    if destination.exists():
        raise ValueError("Snapshot public/training directory must not already exist")
    source = json.loads((directory / "manifest.json").read_text())
    with publication_lock(output):
        catalog = json.loads((output / "manifest.json").read_text())
        if catalog["schema"] != 2 or catalog["exporter_version"] != VERSION:
            raise ValueError("Snapshot requires a compatible full puzzle catalog")
        config = {
            "engine": catalog["engine"],
            "nodes": source["nodes"],
            "version": VERSION,
            "tolerance_cp": 50,
        }
        if config["nodes"] != catalog["nodes"]:
            raise ValueError("Published and checkpoint search budgets do not match")
        accepted, keys, games, ids = [], set(), set(), set()
        with sqlite3.connect(f"{index.resolve().as_uri()}?mode=ro", uri=True) as database:
            stats = json.loads(database.execute("SELECT value FROM metadata").fetchone()[0])
            if stats != catalog["puzzle_import"]:
                raise ValueError("Puzzle overlap index does not match the public catalog")
            published = read_group(output, catalog["ordinary"])
            for record in completed_records(directory, published, config):
                key = validated_key(record)
                game = record.get("url", "").split("#")[0]
                if key in keys or record["id"] in ids or (game and game in games):
                    continue
                if database.execute(
                    "SELECT 1 FROM puzzles WHERE position_key=? LIMIT 1", (key,)
                ).fetchone():
                    continue
                accepted.append(record)
                keys.add(key)
                ids.add(record["id"])
                if game:
                    games.add(game)
        if len(accepted) < catalog["ordinary"]["count"]:
            raise ValueError("Snapshot would shrink the published ordinary corpus")
        accepted.sort(key=lambda record: record["id"])
        metadata = {
            key: value
            for key, value in catalog.items()
            if key not in {"schema", "dataset_id", "puzzles", "ordinary"}
        }
        metadata.update(
            prepared_at=datetime.now(UTC).isoformat(),
            sampled_games=source["sampled_games"],
            source_games=source["games_source"],
            source_seed=source["seed"],
            source_prepared_at=source["prepared_at"],
            min_rating=source["min_rating"],
            min_ply=source["min_ply"],
            max_ply=source["max_ply"],
            checkpoint_snapshot={
                "target": target,
                "qualified": len(accepted),
                "complete": len(accepted) >= target,
            },
        )
        if publish:
            manifest = export_assets(
                output,
                None,
                accepted,
                metadata,
                compact_ratings=True,
                puzzle_group=catalog["puzzles"],
            )
            # Hardlinks keep these exact bytes available even if a running exporter
            # later replaces the live manifest and deletes its obsolete shards.
            freeze_files(output, destination, manifest)
        else:
            destination.mkdir(parents=True)
            for shard in catalog["puzzles"]["shards"]:
                try:
                    os.link(output / shard["file"], destination / shard["file"])
                except OSError:
                    shutil.copyfile(output / shard["file"], destination / shard["file"])
            manifest = export_assets(
                destination,
                None,
                accepted,
                metadata,
                compact_ratings=True,
                puzzle_group=catalog["puzzles"],
            )
    print(
        f"Frozen {len(accepted):,}/{target:,} qualified ordinary positions and "
        f"{manifest['puzzles']['count']:,} puzzles in {destination}",
        flush=True,
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data/expanded")
    parser.add_argument("--output", type=Path, default=ROOT / "public/training")
    parser.add_argument("--puzzle-index", type=Path, default=ROOT / "data/puzzle-index.sqlite3")
    parser.add_argument("--snapshot-root", type=Path)
    parser.add_argument(
        "--publish", action="store_true", help="Also update the live public dataset"
    )
    args = parser.parse_args()
    if not args.publish and args.snapshot_root is None:
        parser.error("Use --publish and/or --snapshot-root to retain the snapshot")
    with tempfile.TemporaryDirectory(prefix="chess-corpus-snapshot-") as temporary:
        snapshot_corpus(
            args.data_dir,
            args.output,
            args.puzzle_index,
            args.snapshot_root or Path(temporary),
            publish=args.publish,
        )


if __name__ == "__main__":
    main()

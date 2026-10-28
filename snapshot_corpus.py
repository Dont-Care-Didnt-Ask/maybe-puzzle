"""Freeze completed grades without Stockfish, downloads, Git, or checkpoint writes.

uv run python snapshot_corpus.py --output data/training/local --snapshot-root /tmp/chess-snapshot
The snapshot contains public/training/ with both complete immutable groups and a
manifest. Only the ordinary group is regenerated; the puzzle version is reused.
"""

import argparse
import hashlib
import json
import re
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import chess

from export_static import VERSION
from prepare import ROOT, position_key
from training_assets import (
    KINDS,
    atomic_bytes,
    check_manifest,
    copy_group,
    digest,
    encoded,
    export_assets,
    file_digest,
    frozen_catalog,
    publication_lock,
    read_group,
)


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
    # Only atomically completed files in this fixed list belong to this snapshot.
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
    """Retain exact immutable inventories/shards for both groups, manifest last."""
    destination.mkdir(parents=True)
    with publication_lock(output):
        for kind in KINDS:
            copy_group(output, destination, manifest[kind], kind)
        atomic_bytes(destination / "manifest.json", encoded(manifest) + b"\n")


def snapshot_corpus(directory, output, index, snapshot_root, *, publish=False, target=30_000):
    directory, output, index, snapshot_root = map(Path, (directory, output, index, snapshot_root))
    destination = snapshot_root / "public/training"
    if destination.exists():
        raise ValueError("Snapshot public/training directory must not already exist")
    source_path = directory / "manifest.json"
    source_raw = source_path.read_bytes()
    source = json.loads(source_raw)
    source_fingerprint = hashlib.sha256(source_raw).hexdigest()
    with frozen_catalog(output) as frozen:
        catalog = frozen.manifest
        if catalog["schema"] != 3 or catalog.get("exporter_version") != VERSION:
            raise ValueError(
                "Snapshot requires a compatible schema-3 full puzzle catalog; "
                "convert legacy catalogs with package_corpus.py convert first"
            )
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
            published = read_group(frozen.directory, catalog["ordinary"], "ordinary")
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
            if key not in {"schema", "dataset_id", *KINDS}
        }
        metadata.update(
            prepared_at=datetime.now(UTC).isoformat(),
            sampled_games=source["sampled_games"],
            source_games=source["games_source"],
            source_seed=source["seed"],
            source_prepared_at=source["prepared_at"],
            min_rating=source["min_rating"],
            min_ply=source.get("min_ply", 20),
            max_ply=source.get("max_ply", 160),
            checkpoint_snapshot={
                "target": target,
                "qualified": len(accepted),
                "complete": len(accepted) >= target,
            },
        )

        def check_inputs():
            check_manifest(output, frozen.manifest_sha256)
            if file_digest(source_path) != source_fingerprint:
                raise ValueError("Authoring input manifest changed during snapshot; retry")

        if publish:
            manifest = export_assets(
                output,
                None,
                accepted,
                metadata,
                puzzle_group=catalog["puzzles"],
                expected_manifest_digest=frozen.manifest_sha256,
                pre_promote=check_inputs,
            )
            freeze_files(output, destination, manifest)
        else:
            destination.mkdir(parents=True)
            copy_group(frozen.directory, destination, catalog["puzzles"], "puzzles")
            manifest = export_assets(
                destination,
                None,
                accepted,
                metadata,
                puzzle_group=catalog["puzzles"],
                expected_manifest_digest=None,
                pre_promote=check_inputs,
                source_directories=[output],
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
    parser.add_argument("--publish", action="store_true", help="Also update --output")
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

"""Import the COMPLETE official Lichess puzzle archive into a compact static catalog.

uv run python import_puzzles.py
No popularity/play-count/rating filter. Every retained solution is legally replayed.
Uses an on-disk SQLite sort/index rather than keeping millions of records in RAM.
"""

import argparse
import csv
import json
import sqlite3
import sys
import tempfile
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

import chess

from prepare import PUZZLES_URL, ROOT, download, position_key, text_source
from training_assets import (
    MAX_SAFE_INTEGER,
    PUZZLE_SHARD_SIZE,
    check_manifest,
    encoded,
    export_assets,
    file_digest,
    frozen_catalog,
    publication_lock,
)
from training_assets import read_group as read_group


def _index_snapshot(destination: Path):
    """Read the completion marker and identity of an immutable published inode.

    Callers hold publication_lock(destination). Reading metadata is cheap even for
    multi-gigabyte indexes; published databases are replaced, never edited in place.
    """
    try:
        status = destination.stat()
    except FileNotFoundError:
        return None, None
    identity = (status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns)
    with closing(
        sqlite3.connect(f"{destination.as_uri()}?mode=ro&immutable=1", uri=True)
    ) as database:
        rows = database.execute("SELECT value FROM metadata").fetchall()
    if len(rows) != 1:
        raise ValueError("Puzzle index has no unique completion metadata; previous index unchanged")
    stats = json.loads(rows[0][0])
    if (
        not isinstance(stats, dict)
        or type(stats.get("retained")) is not int
        or stats["retained"] <= 0
    ):
        raise ValueError("Puzzle index has incomplete metadata; previous index unchanged")
    return identity, stats


def _index_changed():
    return ValueError("Puzzle index changed during indexing; nothing replaced, retry")


def _reuse_index(stats):
    print(f"Using complete puzzle index: {stats['retained']:,} puzzles", flush=True)
    return stats


def build_index(source: Path, destination: Path) -> dict:
    destination = Path(destination).resolve()
    # Snapshot before the potentially very long source hash. A concurrent winner
    # must not be overwritten, including when we would otherwise reuse this index.
    with publication_lock(destination):
        initial = _index_snapshot(destination)
    fingerprint = file_digest(source)
    with publication_lock(destination):
        current = _index_snapshot(destination)
        if current[1] is not None and current[1].get("source_sha256") == fingerprint:
            if (
                initial[1] is not None
                and initial[1].get("source_sha256") == fingerprint
                and current[1] != initial[1]
            ):
                raise _index_changed()
            # Another importer may have completed this same frozen archive
            # during our source hash. Do not needlessly replay it all again.
            return _reuse_index(current[1])
        if current != initial:
            raise _index_changed()
    stats = {
        "source_sha256": fingerprint,
        "source_rows": 0,
        "retained": 0,
        "invalid": 0,
        "quality_filter": "none",
        "validation": "full legal replay (python-chess)",
    }
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{destination.name}-", suffix=".building", dir=destination.parent, delete=False
        ) as stream:
            temporary = Path(stream.name)
        _populate_index(source, temporary, stats)
        if file_digest(source) != fingerprint:
            raise ValueError("Puzzle archive changed while indexing; retry with a frozen source")
        with publication_lock(destination):
            current = _index_snapshot(destination)
            if current != initial:
                if current[1] == stats:
                    return _reuse_index(current[1])
                raise _index_changed()
            temporary.replace(destination)
        return stats
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _populate_index(source: Path, temporary: Path, stats: dict):
    with closing(sqlite3.connect(temporary)) as database, database:
        database.execute("PRAGMA journal_mode=OFF")
        database.execute("PRAGMA synchronous=OFF")
        database.execute("PRAGMA cache_size=-65536")
        database.execute(
            "CREATE TABLE puzzles (id TEXT PRIMARY KEY, rating INTEGER NOT NULL, "
            "position_key TEXT NOT NULL, record TEXT NOT NULL)"
        )
        with text_source(source) as stream:
            for row in csv.DictReader(stream):
                stats["source_rows"] += 1
                try:
                    record = {
                        "id": row["PuzzleId"],
                        "fen": row["FEN"],
                        "moves": row["Moves"].split(),
                        "rating": int(row["Rating"]),
                        "url": f"https://lichess.org/training/{row['PuzzleId']}",
                    }
                    board = chess.Board(record["fen"])
                    if (
                        not record["id"]
                        or not board.is_valid()
                        or len(record["moves"]) < 2
                        or not -MAX_SAFE_INTEGER <= record["rating"] <= MAX_SAFE_INTEGER
                    ):
                        raise ValueError("Invalid puzzle")
                    board.push_uci(record["moves"][0])
                    key = position_key(board)
                    for uci in record["moves"][1:]:
                        board.push_uci(uci)
                except KeyError as exc:
                    raise ValueError("Unexpected Lichess puzzle CSV format") from exc
                except ValueError:
                    stats["invalid"] += 1
                    continue
                database.execute(
                    "INSERT INTO puzzles VALUES (?, ?, ?, ?)",
                    (record["id"], record["rating"], key, encoded(record).decode()),
                )
                stats["retained"] += 1
                if stats["source_rows"] % 100_000 == 0:
                    database.commit()
                    print(f"Legally verified {stats['source_rows']:,} puzzles", flush=True)
        if not stats["retained"]:
            raise ValueError("Archive contains no valid puzzles; public assets were not changed")
        print("Indexing exact ratings and puzzle/ordinary overlap…", flush=True)
        database.execute("CREATE INDEX puzzle_rating ON puzzles(rating, id)")
        database.execute("CREATE INDEX puzzle_position ON puzzles(position_key)")
        stats["min_rating"], stats["max_rating"] = database.execute(
            "SELECT MIN(rating), MAX(rating) FROM puzzles"
        ).fetchone()
        stats["around_2400"] = database.execute(
            "SELECT COUNT(*) FROM puzzles WHERE rating BETWEEN 2100 AND 2700"
        ).fetchone()[0]
        database.execute("CREATE TABLE metadata (value TEXT NOT NULL)")
        database.execute("INSERT INTO metadata VALUES (?)", (json.dumps(stats),))


def publish(index: Path, output: Path, source: str, stats: dict, shard_size=PUZZLE_SHARD_SIZE):
    with (
        frozen_catalog(output) as frozen,
        sqlite3.connect(f"{index.resolve().as_uri()}?mode=ro", uri=True) as database,
    ):
        previous = frozen.manifest
        actual_stats = json.loads(database.execute("SELECT value FROM metadata").fetchone()[0])
        if actual_stats != stats:
            raise ValueError("Puzzle index changed before publication; retry")
        positions = []
        for record in read_group(frozen.directory, previous["ordinary"], "ordinary"):
            board = chess.Board(record["fen"])
            board.push_uci(record["moves"][0])
            overlap = database.execute(
                "SELECT 1 FROM puzzles WHERE position_key=? LIMIT 1", (position_key(board),)
            ).fetchone()
            if not overlap:
                positions.append(record)
        if not positions:
            raise ValueError("No non-overlapping ordinary positions; previous assets unchanged")
        metadata = {
            k: v
            for k, v in previous.items()
            if k not in {"schema", "dataset_id", "puzzles", "ordinary"}
        }
        metadata.update(
            source_puzzles=source, puzzle_import=stats, prepared_at=datetime.now(UTC).isoformat()
        )

        def records():
            for payload, key in database.execute(
                "SELECT record, position_key FROM puzzles ORDER BY rating, id"
            ):
                record = json.loads(payload)
                record["position_key"] = key
                yield record

        manifest = export_assets(
            output,
            records(),
            positions,
            metadata,
            puzzle_shard_size=shard_size,
            expected_manifest_digest=frozen.manifest_sha256,
            pre_promote=lambda: check_manifest(output, frozen.manifest_sha256),
        )
    print(
        f"Published {manifest['puzzles']['count']:,} puzzles "
        f"({stats['around_2400']:,} at 2400 ± 300), "
        f"{manifest['ordinary']['count']:,} ordinary positions. "
        f"Excluded {stats['invalid']} invalid archive rows.",
        flush=True,
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=PUZZLES_URL)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--output", type=Path, default=ROOT / "public/training")
    parser.add_argument(
        "--shard-size", type=int, choices=range(128, 257), default=PUZZLE_SHARD_SIZE
    )
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    cache = args.data_dir / "cache"
    cache.mkdir(exist_ok=True)
    source = download(args.source, cache)
    index = args.data_dir / "puzzle-index.sqlite3"
    stats = build_index(source, index)
    publish(index, args.output.resolve(), args.source, stats, args.shard_size)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(f"Puzzle import failed: {exc}", file=sys.stderr)
        sys.exit(1)

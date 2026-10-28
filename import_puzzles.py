"""Import the COMPLETE official Lichess puzzle archive into a compact static catalog.

uv run python import_puzzles.py
No popularity/play-count/rating filter. Every retained solution is legally replayed.
Uses an on-disk SQLite sort/index rather than keeping millions of records in RAM.
"""

import argparse
import csv
import gzip
import hashlib
import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

import chess

from export_static import encoded, export_assets
from prepare import PUZZLES_URL, ROOT, download, position_key, text_source


def file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build_index(source: Path, destination: Path) -> dict:
    fingerprint = file_digest(source)
    if destination.exists():
        with sqlite3.connect(destination) as database:
            stats = json.loads(database.execute("SELECT value FROM metadata").fetchone()[0])
        if stats.get("source_sha256") == fingerprint:
            print(f"Using complete puzzle index: {stats['retained']:,} puzzles", flush=True)
            return stats
    temporary = destination.with_suffix(".building")
    temporary.unlink(missing_ok=True)
    stats = {
        "source_sha256": fingerprint,
        "source_rows": 0,
        "retained": 0,
        "invalid": 0,
        "quality_filter": "none",
        "validation": "full legal replay (python-chess)",
    }
    with sqlite3.connect(temporary) as database:
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
                    if not record["id"] or not board.is_valid() or len(record["moves"]) < 2:
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
    temporary.replace(destination)
    return stats


def read_group(directory: Path, group: dict):
    for shard in group["shards"]:
        yield from json.loads(gzip.decompress((directory / shard["file"]).read_bytes()))


def publish(index: Path, output: Path, source: str, stats: dict, shard_size=2048):
    previous = json.loads((output / "manifest.json").read_text())
    with sqlite3.connect(index) as database:
        positions = []
        for record in read_group(output, previous["ordinary"]):
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

        records = records()
        manifest = export_assets(
            output, records, positions, metadata, compact_ratings=True, puzzle_shard_size=shard_size
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
    parser.add_argument("--shard-size", type=int, default=2048)
    args = parser.parse_args()
    if args.shard_size <= 0:
        parser.error("shard-size must be positive")
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

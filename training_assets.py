"""Immutable, content-addressed training groups and the shared publication protocol.

This module deliberately does not import the engine or authoring/checkpoint code.
Readers support legacy schema 1/2; all new publications use schema 3. Published
versions are never garbage-collected here: a manifest is the only mutable pointer.
"""

import gzip
import hashlib
import io
import json
import os
import re
import shutil
import socket
import sqlite3
import tempfile
import threading
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

import chess

SCHEMA = 3
MAX_SAFE_INTEGER = 9_007_199_254_740_991
PUZZLE_SHARD_SIZE = 256
MIN_PUZZLE_SHARD_SIZE = 128
MAX_PUZZLE_SHARD_SIZE = 256
ORDINARY_SHARD_SIZE = 64
MAX_SHARD_BYTES = 64 * 1024
MAX_INFLATED_SHARD_BYTES = 16 * 1024 * 1024
MAX_INVENTORY_BYTES = 32 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_MANIFEST_GZIP_BYTES = 24 * 1024
KINDS = ("puzzles", "ordinary")
_PUBLICATION_LOCKS = threading.local()
_UNSPECIFIED = object()
_HEX256 = re.compile(r"[0-9a-f]{64}\Z")


def encoded(value) -> bytes:
    """The original export_static encoding (also used by checkpoint fingerprints)."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def digest(value) -> str:
    return hashlib.sha256(encoded(value)).hexdigest()


def file_digest(path: Path) -> str:
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def manifest_digest(directory: Path) -> str | None:
    path = Path(directory) / "manifest.json"
    return file_digest(path) if path.exists() else None


def check_manifest(directory: Path, expected: str | None):
    if manifest_digest(directory) != expected:
        raise ValueError(
            f"Input manifest changed during this operation: {directory}. "
            "Nothing was published; retry against the new frozen input."
        )


@contextmanager
def publication_lock(output: Path, *, timeout=30.0, poll_interval=0.05):
    """Cross-language mkdir lock; bounded waiting, diagnostics, and no stale stealing.

    Node and Python use exactly ``output.resolve() + '.publication-lock'``.
    Reentrancy is local to the current thread, not the process: another thread
    must still wait. An abandoned directory is intentionally a manual recovery.
    """
    if timeout < 0 or poll_interval <= 0:
        raise ValueError("Lock timeout must be nonnegative and poll interval positive")
    output = Path(output).resolve()
    key = str(output)
    held = getattr(_PUBLICATION_LOCKS, "held", None)
    if held is None or getattr(_PUBLICATION_LOCKS, "pid", None) != os.getpid():
        held = _PUBLICATION_LOCKS.held = set()
        _PUBLICATION_LOCKS.pid = os.getpid()
    if key in held:
        yield
        return
    lock = Path(key + ".publication-lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            if time.monotonic() >= deadline:
                try:
                    owner = (lock / "owner.json").read_text().strip()
                except OSError:
                    owner = "owner.json unavailable (another writer may be starting)"
                raise TimeoutError(
                    f"Timed out waiting for publication lock {lock}; owner: {owner}. "
                    "Wait for that writer to finish. If it crashed, verify no writer is "
                    "running before manually removing this lock directory; locks are never stolen."
                ) from None
            time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))
    try:
        (lock / "owner.json").write_bytes(
            encoded(
                {
                    "pid": os.getpid(),
                    "hostname": socket.gethostname(),
                    "started_at": datetime.now(UTC).isoformat(),
                    "output": key,
                }
            )
        )
        held.add(key)
        try:
            yield
        finally:
            held.remove(key)
    finally:
        (lock / "owner.json").unlink(missing_ok=True)
        lock.rmdir()


def atomic_bytes(path: Path, content: bytes):
    """Replace just this pointer/file, never an existing version directory."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def relative_path(value: str) -> Path:
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise ValueError(f"Unsafe training asset path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {".", ".."} for part in value.split("/")):
        raise ValueError(f"Unsafe training asset path: {value!r}")
    if str(path) != value:
        raise ValueError(f"Noncanonical training asset path: {value!r}")
    return Path(*path.parts)


def regular_file(directory: Path, relative: Path) -> Path:
    """Refuse symlinks/special files in group trees, including parent components."""
    current = Path(directory)
    if not current.is_dir() or current.is_symlink():
        raise ValueError(f"Unsafe training directory: {directory}")
    relative = relative_path(relative.as_posix())
    for index, part in enumerate(relative.parts):
        current = current / part
        if current.is_symlink() or not (
            current.is_file() if index == len(relative.parts) - 1 else current.is_dir()
        ):
            raise ValueError(f"Not a regular training asset path: {relative}")
    return current


def _decode_shard(content: bytes, path: Path):
    with gzip.GzipFile(fileobj=io.BytesIO(content)) as stream:
        raw = stream.read(MAX_INFLATED_SHARD_BYTES + 1)
    if len(raw) > MAX_INFLATED_SHARD_BYTES:
        raise ValueError(f"Inflated shard exceeds the 16 MiB limit: {path}")
    return json.loads(raw)


def _integer(value, *, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE_INTEGER


def _rating_counts(value, expected_count):
    """The wire contract is sorted, unique integer [[rating, positive count], ...]."""
    if not isinstance(value, list):
        raise ValueError("Invalid exact rating counts: expected an array of integer pairs")
    previous, total = None, 0
    for pair in value:
        if not isinstance(pair, list) or len(pair) != 2:
            raise ValueError("Invalid exact rating counts: expected integer pairs")
        rating, count = pair
        if (
            not _integer(rating, minimum=-MAX_SAFE_INTEGER)
            or not _integer(count, minimum=1)
            or (previous is not None and rating <= previous)
        ):
            raise ValueError("Invalid exact rating counts: ratings must be safe, sorted and unique")
        previous, total = rating, total + count
        if not _integer(total):
            raise ValueError(
                "Invalid exact rating counts: count sum exceeds the safe integer limit"
            )
    if total != expected_count:
        raise ValueError("Rating counts do not match inventory count")
    return value


def _record_order(record, kind):
    if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not record["id"]:
        raise ValueError("Training records require a nonempty string id")
    if kind == "puzzles":
        if not _integer(record.get("rating"), minimum=-MAX_SAFE_INTEGER):
            raise ValueError("Puzzle rating must be a safe integer")
        return record["rating"], record["id"]
    return record["id"]


def inventory_path(group: dict, kind: str | None = None) -> Path:
    """The manifest stores identity/counts only; inventory paths are fixed by schema."""
    if not isinstance(group, dict):
        raise ValueError("Invalid compact manifest group")
    kind = kind or ("puzzles" if "rating_counts" in group else "ordinary")
    version = group.get("version")
    if kind not in KINDS or not isinstance(version, str) or not _HEX256.fullmatch(version):
        raise ValueError("Invalid inventory kind/version")
    return Path(kind) / version / "inventory.json"


def read_inventory(directory: Path, group: dict, kind: str | None = None) -> dict:
    """Read and authenticate the canonical inventory derived from a schema-3 group."""
    path = inventory_path(group, kind)
    version = group["version"]
    if not isinstance(version, str) or not _HEX256.fullmatch(version):
        raise ValueError("Invalid group version")
    filename = regular_file(directory, path)
    if filename.stat().st_size > MAX_INVENTORY_BYTES:
        raise ValueError("Inventory exceeds the 32 MiB limit")
    raw = filename.read_bytes()
    if hashlib.sha256(raw).hexdigest() != version:
        raise ValueError(f"Inventory SHA-256 mismatch: {path}")
    inventory = json.loads(raw)
    if encoded(inventory) != raw:
        raise ValueError(f"Inventory is not canonical JSON: {path}")
    if not isinstance(inventory, dict):
        raise ValueError("Invalid inventory object")
    actual_kind = inventory.get("kind")
    if actual_kind not in KINDS or (kind is not None and actual_kind != kind):
        raise ValueError("Inventory kind mismatch")
    group_keys = {"version", "count", "shard_size"}
    if actual_kind == "puzzles":
        group_keys.add("rating_counts")
    if (
        set(group) != group_keys
        or not _integer(group.get("count"))
        or not _integer(group.get("shard_size"), minimum=1)
    ):
        raise ValueError("Invalid compact manifest group fields")
    if actual_kind == "puzzles":
        _rating_counts(group["rating_counts"], group["count"])
    if path.as_posix() != f"{actual_kind}/{version}/inventory.json":
        raise ValueError("Inventory path does not match its kind/version")
    required = {"format", "kind", "count", "shard_size", "provenance", "logical_sha256", "shards"}
    if actual_kind == "puzzles":
        required.add("rating_counts")
    if (
        set(inventory) != required
        or type(inventory["format"]) is not int
        or inventory["format"] != 1
    ):
        raise ValueError("Unsupported inventory format/fields")
    if not _integer(inventory["count"]) or not isinstance(inventory["provenance"], dict):
        raise ValueError("Invalid inventory count/provenance")
    if not isinstance(inventory["logical_sha256"], str) or not _HEX256.fullmatch(
        inventory["logical_sha256"]
    ):
        raise ValueError("Invalid logical SHA-256")
    size = inventory["shard_size"]
    if actual_kind == "puzzles":
        if not _integer(size) or not MIN_PUZZLE_SHARD_SIZE <= size <= MAX_PUZZLE_SHARD_SIZE:
            raise ValueError("Puzzle shard size must be between 128 and 256")
        ratings = _rating_counts(inventory["rating_counts"], inventory["count"])
        expected_count = sum((count + size - 1) // size for _, count in ratings)
        expected = (
            (f"{rating}/{index}.json.gz", min(size, count - index * size))
            for rating, count in ratings
            for index in range((count + size - 1) // size)
        )
    else:
        if not _integer(size) or size != ORDINARY_SHARD_SIZE:
            raise ValueError("Ordinary shard size must be 64")
        expected_count = (inventory["count"] + size - 1) // size
        expected = (
            (f"{index}.json.gz", min(size, inventory["count"] - index * size))
            for index in range(expected_count)
        )
    shards = inventory["shards"]
    if not isinstance(shards, list) or len(shards) != expected_count:
        raise ValueError("Inventory shard count mismatch")
    for shard, (name, count) in zip(shards, expected, strict=True):
        if not isinstance(shard, dict) or set(shard) != {"path", "count", "bytes", "sha256"}:
            raise ValueError("Invalid shard descriptor fields")
        relative_path(shard["path"])
        if (
            shard["path"] != name
            or not _integer(shard["count"], minimum=1)
            or shard["count"] != count
        ):
            raise ValueError("Inventory shard path/count mismatch")
        if not _integer(shard["bytes"], minimum=1) or shard["bytes"] > MAX_SHARD_BYTES:
            raise ValueError("Shard exceeds the 64 KiB compressed limit")
        if not isinstance(shard["sha256"], str) or not _HEX256.fullmatch(shard["sha256"]):
            raise ValueError("Invalid shard SHA-256")
    for key in ("count", "shard_size", "rating_counts"):
        if key in inventory and group.get(key) != inventory[key]:
            raise ValueError(f"Manifest/inventory {key} mismatch")
    return inventory


def _shard_bytes(directory, relative, shard):
    filename = regular_file(directory, relative)
    if filename.stat().st_size > MAX_SHARD_BYTES:
        raise ValueError(f"Shard exceeds the 64 KiB compressed limit: {relative}")
    content = filename.read_bytes()
    if len(content) != shard["bytes"] or hashlib.sha256(content).hexdigest() != shard["sha256"]:
        raise ValueError(f"Shard bytes/SHA-256 mismatch: {relative}")
    return content


def read_group(directory: Path, group: dict, kind: str | None = None):
    """Stream records, checking all schema-3 hashes, ordering, and exact counts."""
    directory = Path(directory)
    if "version" not in group:
        if not _integer(group.get("count")) or not isinstance(group.get("shards"), list):
            raise ValueError("Invalid legacy group count/shards")
        total = 0
        for shard in group["shards"]:
            if not isinstance(shard, dict) or not _integer(shard.get("count"), minimum=1):
                raise ValueError("Invalid legacy shard count")
            path = relative_path(shard["file"])
            content = regular_file(directory, path).read_bytes()
            match = re.fullmatch(r"([pn])-([0-9a-f]{20})\.json\.gz", path.as_posix())
            if not match or hashlib.sha256(content).hexdigest()[:20] != match[2]:
                raise ValueError(f"Legacy shard filename/SHA-256 mismatch: {path}")
            if kind is not None and match[1] != ("p" if kind == "puzzles" else "n"):
                raise ValueError("Legacy shard kind mismatch")
            records = _decode_shard(content, path)
            if not isinstance(records, list) or len(records) != shard["count"]:
                raise ValueError(f"Legacy shard count mismatch: {path}")
            total += len(records)
            if not _integer(total) or total > group["count"]:
                raise ValueError("Legacy group count mismatch")
            for record in records:
                _record_order(record, "puzzles" if match[1] == "p" else "ordinary")
                yield record
        if total != group["count"]:
            raise ValueError("Legacy group count mismatch")
        return
    inventory = read_inventory(directory, group, kind)
    base = inventory_path(group, kind).parent
    logical, previous, total = hashlib.sha256(), None, 0
    for shard in inventory["shards"]:
        path = base / relative_path(shard["path"])
        records = _decode_shard(_shard_bytes(directory, path, shard), path)
        if not isinstance(records, list) or len(records) != shard["count"]:
            raise ValueError(f"Shard record count mismatch: {path}")
        for record in records:
            order = _record_order(record, inventory["kind"])
            if previous is not None and order <= previous:
                raise ValueError("Records are not in strictly increasing canonical order")
            if (
                inventory["kind"] == "puzzles"
                and str(record["rating"]) != shard["path"].split("/")[0]
            ):
                raise ValueError("Puzzle rating does not match its shard directory")
            previous = order
            logical.update(encoded(record) + b"\n")
            total += 1
            yield record
    if total != inventory["count"] or logical.hexdigest() != inventory["logical_sha256"]:
        raise ValueError("Group logical SHA-256/count mismatch")


def assert_group_tree(directory: Path, group: dict, inventory: dict):
    base = inventory_path(group, inventory["kind"]).parent
    expected = {"inventory.json", *(shard["path"] for shard in inventory["shards"])}
    expected_directories = {str(PurePosixPath(name).parent) for name in expected} - {"."}
    for current, directories, filenames in os.walk(Path(directory) / base):
        parent = Path(current)
        for name in directories:
            path = parent / name
            if (
                path.is_symlink()
                or path.relative_to(Path(directory) / base).as_posix() not in expected_directories
            ):
                raise ValueError(f"Unlisted/symlink directory in immutable group: {path}")
        for name in filenames:
            path = parent / name
            relative = path.relative_to(Path(directory) / base).as_posix()
            if path.is_symlink() or not path.is_file() or relative not in expected:
                raise ValueError(f"Unlisted/special file in immutable group: {path}")
            expected.remove(relative)
    if expected:
        raise ValueError(f"Missing inventory files: {sorted(expected)[:3]}")


def group_files(directory: Path, group: dict, kind: str | None = None):
    if "version" in group:
        inventory = read_inventory(directory, group, kind)
        assert_group_tree(directory, group, inventory)
        path = inventory_path(group, kind)
        yield path
        for shard in inventory["shards"]:
            yield path.parent / relative_path(shard["path"])
    else:
        for shard in group["shards"]:
            yield relative_path(shard["file"])


def copy_group(source: Path, destination: Path, group: dict, kind: str | None = None):
    for path in group_files(source, group, kind):
        target = Path(destination) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        filename = regular_file(source, path)
        try:
            os.link(filename, target)
        except OSError:
            shutil.copyfile(filename, target)


@dataclass(frozen=True)
class FrozenCatalog:
    directory: Path
    manifest: dict
    manifest_bytes: bytes
    source: Path
    manifest_sha256: str


@contextmanager
def frozen_catalog(directory: Path):
    """Freeze the manifest and *both* groups while holding the writers' lock."""
    directory = Path(directory).resolve()
    with tempfile.TemporaryDirectory(prefix="chess-frozen-corpus-") as temporary:
        destination = Path(temporary)
        with publication_lock(directory):
            raw = (directory / "manifest.json").read_bytes()
            manifest = json.loads(raw)
            if manifest.get("schema") not in (1, 2, 3):
                raise ValueError("Unsupported training manifest schema")
            for kind in KINDS:
                copy_group(directory, destination, manifest[kind], kind)
            (destination / "manifest.json").write_bytes(raw)
        yield FrozenCatalog(destination, manifest, raw, directory, hashlib.sha256(raw).hexdigest())


def group_provenance(metadata: dict, kind: str) -> dict:
    """Stable, group-specific origin/search metadata, never publication timestamps."""
    keys = (
        ("source_puzzles", "puzzle_import")
        if kind == "puzzles"
        else (
            "engine",
            "nodes",
            "tolerance_cp",
            "exporter_version",
            "source_games",
            "source_seed",
            "sampled_games",
            "min_rating",
            "min_ply",
            "max_ply",
        )
    )
    return {key: metadata[key] for key in keys if key in metadata}


def canonical_record(record: dict, kind: str) -> dict:
    """Preserve every field; add only a missing puzzle overlap key via legal replay."""
    _record_order(record, kind)
    if kind == "puzzles":
        if "position_key" not in record:
            board = chess.Board(record["fen"])
            moves = record["moves"]
            if not board.is_valid() or not isinstance(moves, list) or len(moves) < 2:
                raise ValueError("Invalid legacy puzzle FEN/solution")
            board.push_uci(moves[0])
            key = " ".join(board.fen().split()[:4])
            for move in moves[1:]:
                board.push_uci(move)
            return {**record, "position_key": key}
    return record


def deterministic_gzip(content: bytes, *, compresslevel=6) -> bytes:
    # GzipFile writes a fixed OS=255 header even on Python 3.11 (gzip.compress
    # delegates mtime=0 to platform zlib on that version).
    output = io.BytesIO()
    with gzip.GzipFile(
        fileobj=output, mode="wb", filename="", compresslevel=compresslevel, mtime=0
    ) as stream:
        stream.write(content)
    return output.getvalue()


@dataclass
class PreparedGroup:
    directory: Path
    descriptor: dict
    inventory: dict


def _prepare_group(work: Path, records, kind: str, metadata: dict, size: int) -> PreparedGroup:
    """Disk sort, then bounded (at most one shard) JSON/gzip buffers."""
    directory = work / f".{kind}-preparing"
    directory.mkdir()
    spool = work / f"{kind}.sqlite3"
    with sqlite3.connect(spool) as database:
        database.execute("PRAGMA journal_mode=OFF")
        database.execute("PRAGMA synchronous=OFF")
        database.execute("PRAGMA cache_size=-16384")
        database.execute(
            "CREATE TABLE records (id TEXT PRIMARY KEY, rating INTEGER NOT NULL, payload BLOB)"
        )
        for index, record in enumerate(records):
            record = canonical_record(record, kind)
            try:
                database.execute(
                    "INSERT INTO records VALUES (?, ?, ?)",
                    (
                        record["id"],
                        record.get("rating", 0) if kind == "puzzles" else 0,
                        encoded(record),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"Duplicate {kind} record id: {record['id']}") from exc
            if index % 10_000 == 0:
                database.commit()
        database.commit()
        database.execute("CREATE INDEX record_order ON records(rating, id)")
        count = database.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        if not _integer(count):
            raise ValueError("Group count exceeds the safe integer limit")
        ratings = (
            [
                list(pair)
                for pair in database.execute(
                    "SELECT rating, COUNT(*) FROM records GROUP BY rating ORDER BY rating"
                )
            ]
            if kind == "puzzles"
            else None
        )
        if ratings is not None:
            _rating_counts(ratings, count)
        logical, shards = hashlib.sha256(), []
        batch, rating, shard_index = [], None, 0

        def flush():
            raw = b"[" + b",".join(batch) + b"]"
            if len(raw) > MAX_INFLATED_SHARD_BYTES:
                raise ValueError(f"{kind} shard exceeds the 16 MiB inflated limit")
            content = deterministic_gzip(raw)
            name = (
                f"{rating}/{shard_index}.json.gz" if kind == "puzzles" else f"{shard_index}.json.gz"
            )
            if len(content) > MAX_SHARD_BYTES:
                raise ValueError(
                    f"{kind} shard {name} is {len(content)} bytes, above the 64 KiB limit; "
                    "reduce the puzzle shard size (supported: 128..256) "
                    "or inspect oversized records"
                )
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            shards.append(
                {
                    "path": name,
                    "count": len(batch),
                    "bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            )

        for next_rating, payload in database.execute(
            "SELECT rating, payload FROM records ORDER BY rating, id"
        ):
            if batch and (len(batch) == size or next_rating != rating):
                flush()
                batch = []
                shard_index = shard_index + 1 if next_rating == rating else 0
            rating = next_rating
            logical.update(payload + b"\n")
            batch.append(payload)
        if batch:
            flush()
    spool.unlink()
    inventory = {
        "format": 1,
        "kind": kind,
        "count": count,
        "shard_size": size,
        **({"rating_counts": ratings} if ratings is not None else {}),
        "provenance": group_provenance(metadata, kind),
        "logical_sha256": logical.hexdigest(),
        "shards": shards,
    }
    raw = encoded(inventory)
    if len(raw) > MAX_INVENTORY_BYTES:
        raise ValueError("Inventory exceeds the 32 MiB limit")
    version = hashlib.sha256(raw).hexdigest()
    (directory / "inventory.json").write_bytes(raw)
    destination = work / kind / version
    destination.parent.mkdir()
    directory.replace(destination)
    descriptor = {
        "version": version,
        "count": count,
        "shard_size": size,
        **({"rating_counts": inventory["rating_counts"]} if ratings is not None else {}),
    }
    return PreparedGroup(destination, descriptor, inventory)


def check_manifest_budget(raw: bytes):
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ValueError("Schema-3 manifest exceeds the 64 KiB raw limit")
    if len(deterministic_gzip(raw, compresslevel=9)) > MAX_MANIFEST_GZIP_BYTES:
        raise ValueError("Schema-3 manifest exceeds the 24 KiB gzip limit")


def export_assets(
    output: Path,
    puzzles,
    positions,
    metadata: dict,
    shard_size=ORDINARY_SHARD_SIZE,
    *,
    compact_ratings=False,
    puzzle_shard_size=None,
    puzzle_group=None,
    expected_manifest_digest=_UNSPECIFIED,
    pre_promote=None,
    post_prepare=None,
    source_directories=(),
):
    """Prepare immutable groups; check inputs under lock; replace the manifest last.

    ``compact_ratings`` is a backwards-compatible no-op: schema 3 always groups
    puzzles by exact rating. Tiny legacy test shard sizes are intentionally not
    supported. Reusing a legacy catalog requires explicit ``convert_corpus``.
    ``post_prepare(directory, manifest)`` can authenticate the complete staged
    catalog with the normal readers before any immutable group is promoted.
    """
    del compact_ratings
    output = Path(output).resolve()
    puzzle_size = PUZZLE_SHARD_SIZE if puzzle_shard_size is None else puzzle_shard_size
    if type(shard_size) is not int or shard_size != ORDINARY_SHARD_SIZE:
        raise ValueError("Ordinary shard size must be 64")
    if (
        type(puzzle_size) is not int
        or not MIN_PUZZLE_SHARD_SIZE <= puzzle_size <= MAX_PUZZLE_SHARD_SIZE
    ):
        raise ValueError("Puzzle shard size must be between 128 and 256")
    with publication_lock(output):
        if expected_manifest_digest is _UNSPECIFIED:
            expected_manifest_digest = manifest_digest(output)
        if puzzle_group is not None:
            if "version" not in puzzle_group:
                raise ValueError(
                    "Legacy puzzle catalog: run package_corpus.py convert before catalog reuse"
                )
            inventory = read_inventory(output, puzzle_group, "puzzles")
            assert_group_tree(output, puzzle_group, inventory)
    metadata = {
        key: value for key, value in metadata.items() if key not in {"schema", "dataset_id", *KINDS}
    }
    metadata = json.loads(encoded({"tolerance_cp": 50, **metadata}))
    if puzzle_group is not None:
        puzzle_group = json.loads(encoded(puzzle_group))
        # Reuse the version, not unverified content. Immutable groups can be
        # authenticated outside the short promotion lock without rewriting them.
        for _record in read_group(output, puzzle_group, "puzzles"):
            pass
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".corpus-building-", dir=output) as temporary:
        work = Path(temporary)
        prepared = []
        if puzzle_group is None:
            prepared.append(_prepare_group(work, puzzles, "puzzles", metadata, puzzle_size))
            puzzle_group = prepared[-1].descriptor
        prepared.append(_prepare_group(work, positions, "ordinary", metadata, shard_size))
        manifest = {
            "schema": SCHEMA,
            **metadata,
            "puzzles": puzzle_group,
            "ordinary": prepared[-1].descriptor,
        }
        manifest["dataset_id"] = digest(manifest)[:20]
        raw_manifest = encoded(manifest) + b"\n"
        check_manifest_budget(raw_manifest)
        if post_prepare:
            if not any(group.inventory["kind"] == "puzzles" for group in prepared):
                copy_group(output, work, puzzle_group, "puzzles")
            post_prepare(work, manifest)
        with ExitStack() as stack:
            directories = {output, *(Path(path).resolve() for path in source_directories)}
            for directory in sorted(directories, key=str):
                stack.enter_context(publication_lock(directory))
            check_manifest(output, expected_manifest_digest)
            if pre_promote:
                pre_promote()
            for group in prepared:
                kind, version = group.inventory["kind"], group.descriptor["version"]
                destination = output / kind / version
                destination.parent.mkdir(exist_ok=True)
                if destination.parent.is_symlink() or destination.is_symlink():
                    raise ValueError(f"Symlink in immutable output group: {destination}")
                if destination.exists():
                    # Never overwrite an immutable version, even to repair corruption.
                    existing_inventory = read_inventory(output, group.descriptor, kind)
                    assert_group_tree(output, group.descriptor, existing_inventory)
                    for _record in read_group(output, group.descriptor, kind):
                        pass
                else:
                    group.directory.replace(destination)
            atomic_bytes(output / "manifest.json", raw_manifest)
    return manifest

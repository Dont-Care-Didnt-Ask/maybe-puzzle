"""Convert legacy training directories and package immutable groups without Stockfish.

  uv run python package_corpus.py convert --input public/training --output data/training/local
  uv run python package_corpus.py pack --input data/training/local --output /tmp/release

Conversion preserves all record fields (adding legally replayed position_key to
legacy puzzles if absent). Packaging only reads frozen schema-3 bytes. Neither
operation reads/writes engine checkpoints, downloads archives, or invokes npm/Git.
"""

import argparse
import hashlib
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from contextlib import ExitStack
from pathlib import Path

from training_assets import (
    KINDS,
    MAX_SAFE_INTEGER,
    PUZZLE_SHARD_SIZE,
    atomic_bytes,
    canonical_record,
    check_manifest,
    check_manifest_budget,
    encoded,
    export_assets,
    file_digest,
    frozen_catalog,
    inventory_path,
    manifest_digest,
    publication_lock,
    read_group,
    read_inventory,
    relative_path,
)

ROOT = Path(__file__).resolve().parent


def _before_signature(database, kind):
    """Hash the independent, disk-sorted canonical source spool, not writer metadata."""
    count = database.execute("SELECT COUNT(*) FROM records WHERE kind=?", (kind,)).fetchone()[0]
    if not 0 <= count <= MAX_SAFE_INTEGER:
        raise ValueError("Conversion source count exceeds the safe integer limit")
    logical = hashlib.sha256()
    for (payload,) in database.execute(
        "SELECT payload FROM records WHERE kind=? ORDER BY rating, id", (kind,)
    ):
        logical.update(payload + b"\n")
    return {
        "count": count,
        **(
            {
                "rating_counts": [
                    list(pair)
                    for pair in database.execute(
                        "SELECT rating, COUNT(*) FROM records WHERE kind=? "
                        "GROUP BY rating ORDER BY rating",
                        (kind,),
                    )
                ]
            }
            if kind == "puzzles"
            else {}
        ),
        "logical_sha256": logical.hexdigest(),
    }


def _after_signature(directory, group, kind):
    """Read authenticated destination bytes, counting exact ratings independently."""
    logical, count, ratings = hashlib.sha256(), 0, []
    for record in read_group(directory, group, kind):
        logical.update(encoded(record) + b"\n")
        count += 1
        if count > MAX_SAFE_INTEGER:
            raise ValueError("Conversion destination count exceeds the safe integer limit")
        if kind == "puzzles":
            if not ratings or ratings[-1][0] != record["rating"]:
                ratings.append([record["rating"], 0])
            ratings[-1][1] += 1
    return {
        "count": count,
        **({"rating_counts": ratings} if kind == "puzzles" else {}),
        "logical_sha256": logical.hexdigest(),
    }


def convert_corpus(source: Path, output: Path, *, puzzle_shard_size=PUZZLE_SHARD_SIZE):
    """Engine-free conversion, verified before promotion; the source is never replaced.

    A disk-backed source signature is compared with the authenticated staged
    destination's counts, exact ratings and canonical logical SHA-256. The only
    normalization is adding a missing puzzle position_key by legal replay. A
    successful conversion writes non-group tool metadata conversion-report.json.
    """
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output:
        raise ValueError("Conversion requires separate input/output directories to preserve source")
    with publication_lock(output):
        expected_output = manifest_digest(output)
    with (
        frozen_catalog(source) as frozen,
        tempfile.TemporaryDirectory(prefix="chess-conversion-signatures-") as temporary,
        sqlite3.connect(Path(temporary) / "before.sqlite3") as database,
    ):
        database.execute("PRAGMA journal_mode=OFF")
        database.execute("PRAGMA synchronous=OFF")
        database.execute("PRAGMA cache_size=-16384")
        database.execute("PRAGMA temp_store=FILE")
        database.execute(
            "CREATE TABLE records (kind TEXT, id TEXT, rating INTEGER NOT NULL, "
            "payload BLOB, PRIMARY KEY(kind, id))"
        )

        def records(kind):
            for index, record in enumerate(
                read_group(frozen.directory, frozen.manifest[kind], kind)
            ):
                record = canonical_record(record, kind)
                try:
                    database.execute(
                        "INSERT INTO records VALUES (?, ?, ?, ?)",
                        (
                            kind,
                            record["id"],
                            record["rating"] if kind == "puzzles" else 0,
                            encoded(record),
                        ),
                    )
                except sqlite3.IntegrityError as exc:
                    raise ValueError(f"Duplicate source {kind} record id: {record['id']}") from exc
                if index % 10_000 == 0:
                    database.commit()
                yield record
            database.commit()

        report = None

        def verify_prepared(directory, proposed):
            nonlocal report
            database.execute("CREATE INDEX record_order ON records(kind, rating, id)")
            before = {kind: _before_signature(database, kind) for kind in KINDS}
            after = {kind: _after_signature(directory, proposed[kind], kind) for kind in KINDS}
            for kind in KINDS:
                if before[kind] != after[kind]:
                    changed = ", ".join(
                        key for key in before[kind] if before[kind][key] != after[kind][key]
                    )
                    raise ValueError(f"Conversion {kind} verification mismatch: {changed}")
            report = {
                "format": 1,
                "verified": True,
                "verification": "authenticated staged destination, before manifest promotion",
                "normalization": "add missing puzzle position_key by legal replay only",
                "source": {
                    "schema": frozen.manifest["schema"],
                    "dataset_id": frozen.manifest.get("dataset_id"),
                    "manifest_sha256": frozen.manifest_sha256,
                },
                "destination": {
                    "schema": proposed["schema"],
                    "dataset_id": proposed["dataset_id"],
                    "manifest_sha256": hashlib.sha256(encoded(proposed) + b"\n").hexdigest(),
                },
                "before": before,
                "after": after,
            }

        metadata = {
            key: value
            for key, value in frozen.manifest.items()
            if key not in {"schema", "dataset_id", *KINDS}
        }
        manifest = export_assets(
            output,
            records("puzzles"),
            records("ordinary"),
            metadata,
            puzzle_shard_size=puzzle_shard_size,
            expected_manifest_digest=expected_output,
            pre_promote=lambda: check_manifest(source, frozen.manifest_sha256),
            post_prepare=verify_prepared,
            source_directories=[source],
        )
        with publication_lock(output):
            check_manifest(output, report["destination"]["manifest_sha256"])
            atomic_bytes(output / "conversion-report.json", encoded(report) + b"\n")
    return manifest


def _zip_info(name: str, size: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.create_version = 20
    info.extract_version = 20
    info.external_attr = 0o100644 << 16
    info.internal_attr = 0
    info.file_size = size
    return info


def _write_archive(directory: Path, group: dict, inventory: dict, target: Path) -> dict:
    path = inventory_path(group, inventory["kind"])
    base = path.parent
    paths = [(path, None)] + [
        (base / relative_path(shard["path"]), shard) for shard in inventory["shards"]
    ]
    extracted = 0
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for path, shard in paths:
            source = directory / path
            size = source.stat().st_size
            if not 0 <= size <= MAX_SAFE_INTEGER or extracted + size > MAX_SAFE_INTEGER:
                raise ValueError("Archive size exceeds the safe integer limit")
            if shard is not None and (
                size != shard["bytes"] or file_digest(source) != shard["sha256"]
            ):
                raise ValueError(f"Frozen shard changed while packaging: {path}")
            with (
                source.open("rb") as stream,
                archive.open(_zip_info(path.as_posix(), size), "w") as out,
            ):
                shutil.copyfileobj(stream, out, length=1024 * 1024)
            extracted += size
    archive_bytes = target.stat().st_size
    if archive_bytes > MAX_SAFE_INTEGER or len(paths) > MAX_SAFE_INTEGER:
        raise ValueError("Archive size/file count exceeds the safe integer limit")
    return {
        "kind": inventory["kind"],
        "version": group["version"],
        "file": f"{inventory['kind']}-{group['version']}.zip",
        "sha256": file_digest(target),
        "bytes": archive_bytes,
        "file_count": len(paths),
        "extracted_bytes": extracted,
        "count": inventory["count"],
        "provenance": inventory["provenance"],
    }


def pack_corpus(training_dir: Path, output: Path) -> dict:
    """Stream deterministic stored ZIPs and publish release-candidate.json last.

    Existing release files and previous group versions are retained. candidate's
    manifest is the exact frozen manifest object, not a reconstructed subset.
    """
    training_dir, output = Path(training_dir).resolve(), Path(output).resolve()
    candidate_path = output / "release-candidate.json"

    def candidate_bytes():
        try:
            return candidate_path.read_bytes()
        except FileNotFoundError:
            return None

    with publication_lock(output):
        expected_candidate = candidate_bytes()
    with frozen_catalog(training_dir) as frozen:
        if frozen.manifest["schema"] != 3:
            raise ValueError("Packaging requires schema 3; run package_corpus.py convert first")
        check_manifest_budget(frozen.manifest_bytes)
        if any(frozen.manifest[kind]["count"] <= 0 for kind in KINDS):
            raise ValueError("Release packaging requires nonempty puzzle and ordinary groups")
        output.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".corpus-pack-", dir=output) as temporary:
            work, archives = Path(temporary), {}
            for kind in KINDS:
                group = frozen.manifest[kind]
                inventory = read_inventory(frozen.directory, group, kind)
                # Authenticate logical contents, not just filenames or gzip/ZIP CRCs.
                for _record in read_group(frozen.directory, group, kind):
                    pass
                archives[kind] = _write_archive(
                    frozen.directory, group, inventory, work / f"{kind}.zip"
                )
            candidate = {"format": 1, "manifest": frozen.manifest, "archives": archives}
            proposed_candidate = encoded(candidate)
            # Acquire multiple publication locks in a fixed order to avoid an
            # opposite-direction pack/convert deadlock between cooperating tools.
            with ExitStack() as stack:
                for directory in sorted({training_dir, output}, key=str):
                    stack.enter_context(publication_lock(directory))
                check_manifest(training_dir, frozen.manifest_sha256)
                # A slower pack of another snapshot must not roll back a newer
                # release. Identical concurrent publication is safe/idempotent.
                if candidate_bytes() not in (expected_candidate, proposed_candidate):
                    raise ValueError(
                        "Release candidate changed during packaging; nothing published, retry"
                    )
                for kind, descriptor in archives.items():
                    destination = output / descriptor["file"]
                    if destination.exists():
                        if file_digest(destination) != descriptor["sha256"]:
                            raise ValueError(f"Existing immutable archive differs: {destination}")
                    else:
                        (work / f"{kind}.zip").replace(destination)
                atomic_bytes(candidate_path, proposed_candidate)
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    convert = commands.add_parser("convert", help="Convert a frozen legacy/schema-3 directory")
    convert.add_argument(
        "--input", "--source", "--training-dir", dest="source", type=Path, required=True
    )
    convert.add_argument("--output", type=Path, required=True)
    convert.add_argument("--puzzle-shard-size", type=int, default=PUZZLE_SHARD_SIZE)
    pack = commands.add_parser("pack", help="Package a frozen schema-3 directory")
    pack.add_argument(
        "--input", "--training-dir", "--source", dest="training_dir", type=Path, required=True
    )
    pack.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "convert":
        manifest = convert_corpus(
            args.source, args.output, puzzle_shard_size=args.puzzle_shard_size
        )
        print(
            f"Converted {manifest['puzzles']['count']:,} puzzles and "
            f"{manifest['ordinary']['count']:,} ordinary positions to {args.output}"
        )
    else:
        candidate = pack_corpus(args.training_dir, args.output)
        print(
            f"Packaged {candidate['manifest']['dataset_id']} in "
            f"{args.output / 'release-candidate.json'}"
        )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, sqlite3.Error, zipfile.BadZipFile) as exc:
        print(f"Corpus packaging failed: {exc}", file=sys.stderr)
        sys.exit(1)

"""Deterministic, tiny cross-process importer races; never touch the real corpus."""

import csv
import json
import os
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import chess
import pytest

import import_puzzles
from import_puzzles import build_index

ROOT = Path(__file__).resolve().parents[1]
WORKER = """
import json
import sqlite3
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import import_puzzles

source, index, ready, release = map(Path, sys.argv[1:5])
phase = sys.argv[5]
original_digest = import_puzzles.file_digest
original_source = import_puzzles.text_source
hashes = 0


def pause():
    ready.touch()
    deadline = time.monotonic() + 20
    while not release.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("test gate was not released")
        time.sleep(0.01)


def file_digest(path):
    global hashes
    result = original_digest(path)
    if Path(path) == source:
        hashes += 1
        if phase == f"hash{hashes}":
            pause()
    return result


@contextmanager
def text_source(path):
    with original_source(path) as stream:
        if phase == "read":
            pause()
        yield stream


import_puzzles.file_digest = file_digest
import_puzzles.text_source = text_source
try:
    stats = import_puzzles.build_index(source, index)
except (ValueError, OSError, sqlite3.Error) as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(2)
print(json.dumps(stats), flush=True)
"""


def archive(path, label="puzzle", *, rating=2400, invalid=False):
    with path.open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=["PuzzleId", "FEN", "Moves", "Rating"])
        writer.writeheader()
        for number in range(2):
            writer.writerow(
                {
                    "PuzzleId": f"{label}-{number}",
                    "FEN": chess.STARTING_FEN,
                    "Moves": "e2e4 e7e4" if invalid else "e2e4 e7e5",
                    "Rating": rating + number,
                }
            )


@contextmanager
def paused_import(source, index, tmp_path, name, phase):
    ready, release = tmp_path / f"{name}.ready", tmp_path / f"{name}.release"
    process = subprocess.Popen(
        [sys.executable, "-c", WORKER, str(source), str(index), str(ready), str(release), phase],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 15
        while not ready.exists():
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                pytest.fail(f"Importer exited before test gate: {stdout}\n{stderr}")
            assert time.monotonic() < deadline, "Importer did not reach test gate"
            time.sleep(0.01)
        yield process, release
    finally:
        release.touch()
        try:
            process.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


def finish(process, release, *, success=True):
    release.touch()
    stdout, stderr = process.communicate(timeout=20)
    assert process.returncode == (0 if success else 2), (stdout, stderr)
    return json.loads(stdout.splitlines()[-1]) if success else stderr


@pytest.mark.parametrize("second_fails", [False, True])
def test_concurrent_partial_index_cannot_replace_another_attempts_complete_staging(
    tmp_path, second_fails
):
    source, index = tmp_path / "puzzles.csv", tmp_path / "index.sqlite3"
    archive(source)
    second_source = source
    if second_fails:
        second_source = tmp_path / "invalid.csv"
        archive(second_source, invalid=True)
    foreign = index.with_suffix(".building")
    foreign.write_bytes(b"another writer's legacy temporary file")
    with paused_import(source, index, tmp_path, "first", "hash2") as (first, first_release):
        with paused_import(second_source, index, tmp_path, "second", "read") as (
            second,
            second_release,
        ):
            # First has finished SQLite and is rehashing; second has only created
            # its tables. Both must retain their own independent staging inode.
            staging = list(tmp_path.glob(f".{index.name}-*.building"))
            assert len(staging) == 2
            assert len({path.stat().st_ino for path in staging}) == 2
            assert not index.exists()
            stats = finish(first, first_release)
            with sqlite3.connect(f"{index.as_uri()}?mode=ro", uri=True) as database:
                assert database.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0] == 2
                actual = json.loads(database.execute("SELECT value FROM metadata").fetchone()[0])
                assert actual == stats
            winner_bytes, winner_inode = index.read_bytes(), index.stat().st_ino
            result = finish(second, second_release, success=not second_fails)
            if second_fails:
                assert "no valid puzzles" in result
            else:
                assert result == stats
            assert index.read_bytes() == winner_bytes
            assert index.stat().st_ino == winner_inode
    assert foreign.read_bytes() == b"another writer's legacy temporary file"
    assert not list(tmp_path.glob(f".{index.name}-*.building"))


@pytest.mark.parametrize("phase", ["hash1", "hash2"])
def test_conflicting_concurrent_publication_is_preserved_during_initial_or_final_hash(
    tmp_path, phase
):
    original, contender, newer = (tmp_path / name for name in ("old.csv", "slow.csv", "new.csv"))
    index = tmp_path / "index.sqlite3"
    archive(original, "old", rating=1400)
    build_index(original, index)
    # hash1 also exercises the completed-index reuse path: the initial matching
    # inode ceases to be current while its source fingerprint is being computed.
    source = original if phase == "hash1" else contender
    if source == contender:
        archive(contender, "slow", rating=2000)
    archive(newer, "new", rating=2700)
    with paused_import(source, index, tmp_path, "slow", phase) as (process, release):
        winner = build_index(newer, index)
        winner_bytes, winner_inode = index.read_bytes(), index.stat().st_ino
        assert "Puzzle index changed" in finish(process, release, success=False)
        assert index.read_bytes() == winner_bytes
        assert index.stat().st_ino == winner_inode
        with sqlite3.connect(f"{index.as_uri()}?mode=ro", uri=True) as database:
            actual = json.loads(database.execute("SELECT value FROM metadata").fetchone()[0])
            assert actual == winner
    assert not list(tmp_path.glob(f".{index.name}-*.building"))


@pytest.mark.parametrize("has_previous", [False, True])
def test_index_completed_during_initial_source_hash_is_reused_without_replaying_again(
    tmp_path, has_previous
):
    source, index = tmp_path / "puzzles.csv", tmp_path / "index.sqlite3"
    if has_previous:
        previous = tmp_path / "old.csv"
        archive(previous, "old", rating=1400)
        build_index(previous, index)
    archive(source)
    with paused_import(source, index, tmp_path, "slow", "hash1") as (process, release):
        winner = build_index(source, index)
        before, inode = index.read_bytes(), index.stat().st_ino
        assert finish(process, release) == winner
        stdout, _stderr = process.communicate()
        assert "Using complete puzzle index" in stdout
        assert "Indexing exact ratings" not in stdout
        assert index.read_bytes() == before
        assert index.stat().st_ino == inode
    assert not list(tmp_path.glob(f".{index.name}-*.building"))


def test_completed_index_reuse_reads_locked_metadata_without_hashing_the_index(
    tmp_path, monkeypatch
):
    source, index = tmp_path / "source.csv", tmp_path / "index.sqlite3"
    archive(source)
    stats = build_index(source, index)
    before, inode = index.read_bytes(), index.stat().st_ino
    original_digest, original_snapshot = import_puzzles.file_digest, import_puzzles._index_snapshot
    hashed, snapshots = [], []
    owner = Path(str(index) + ".publication-lock") / "owner.json"

    def checked_snapshot(path):
        assert json.loads(owner.read_bytes())["pid"] == os.getpid()
        snapshots.append(path)
        return original_snapshot(path)

    def checked_digest(path):
        assert path == source, "Do not hash a multi-gigabyte existing index"
        assert not owner.exists(), "Do not hold a publication lock during the source hash"
        hashed.append(path)
        return original_digest(path)

    def forbidden(*args):
        pytest.fail("A completed matching index must be reused")

    monkeypatch.setattr(import_puzzles, "_index_snapshot", checked_snapshot)
    monkeypatch.setattr(import_puzzles, "file_digest", checked_digest)
    monkeypatch.setattr(import_puzzles, "_populate_index", forbidden)
    assert build_index(source, index) == stats
    assert hashed == [source]
    assert snapshots == [index, index]
    assert index.read_bytes() == before
    assert index.stat().st_ino == inode


def test_source_change_preserves_previous_index_and_only_cleans_own_temporary(
    tmp_path, monkeypatch
):
    previous, source, index = tmp_path / "old.csv", tmp_path / "new.csv", tmp_path / "index.sqlite3"
    archive(previous, "old")
    build_index(previous, index)
    before, inode = index.read_bytes(), index.stat().st_ino
    archive(source, "new")
    foreign = tmp_path / f".{index.name}-someone-else.building"
    foreign.write_bytes(b"do not delete")
    original_digest, hashes = import_puzzles.file_digest, 0

    def changed_digest(path):
        nonlocal hashes
        hashes += 1
        if hashes == 2:
            archive(source, "changed")
        return original_digest(path)

    monkeypatch.setattr(import_puzzles, "file_digest", changed_digest)
    with pytest.raises(ValueError, match="Puzzle archive changed"):
        build_index(source, index)
    assert index.read_bytes() == before
    assert index.stat().st_ino == inode
    assert foreign.read_bytes() == b"do not delete"
    assert list(tmp_path.glob(f".{index.name}-*.building")) == [foreign]

import gzip
import hashlib
import json
import multiprocessing
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

import chess
import pytest

import export_static
import training_assets as assets
from training_assets import (
    MAX_SAFE_INTEGER,
    canonical_record,
    digest,
    encoded,
    export_assets,
    frozen_catalog,
    group_files,
    inventory_path,
    publication_lock,
    read_group,
    read_inventory,
)


def puzzle(identifier="p", rating=1400, **extra):
    return {
        "id": identifier,
        "fen": chess.STARTING_FEN,
        "moves": ["e2e4", "e7e5"],
        "rating": rating,
        "url": f"https://lichess.org/training/{identifier}",
        **extra,
    }


def test_checkpoint_version_and_encoded_digest_reexports_are_byte_compatible():
    value = {"z": [False, None, 1.5, "é♞😀"], "a": {"b": "line\n"}}
    expected = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    assert export_static.VERSION == 1
    assert export_static.encoded is encoded
    assert export_static.digest is digest
    assert export_static.publication_lock is publication_lock
    assert encoded(value) == expected
    assert digest(value) == hashlib.sha256(expected).hexdigest()


@pytest.mark.parametrize("size", [128, 192, 256])
def test_inventory_and_logical_hash_are_deterministic_sorted_and_bounded(tmp_path, size):
    puzzles = [
        puzzle(f"{i:04}", 1400 if i < 260 else 2400, themes=["pin"], note="é") for i in range(263)
    ]
    positions = [{"id": f"n{i:03}", "extra": {"all": [i, None]}} for i in range(65)]
    metadata = {"engine": "Fixture", "nodes": 100000, "source_puzzles": "puzzles.csv"}
    random.Random(1).shuffle(puzzles)
    random.Random(2).shuffle(positions)
    one, two = tmp_path / "one", tmp_path / "two"
    first = export_assets(one, iter(puzzles), iter(positions), metadata, puzzle_shard_size=size)
    second = export_assets(
        two, reversed(puzzles), reversed(positions), metadata, puzzle_shard_size=size
    )
    assert first == second
    for kind, source in (("puzzles", puzzles), ("ordinary", positions)):
        group = first[kind]
        raw = (one / inventory_path(group, kind)).read_bytes()
        inventory = read_inventory(one, group, kind)
        assert raw == encoded(inventory)
        assert not raw.endswith(b"\n")
        assert group["version"] == hashlib.sha256(raw).hexdigest()
        ordered = sorted(
            (canonical_record(p, kind) for p in source),
            key=lambda p: (p["rating"], p["id"]) if kind == "puzzles" else p["id"],
        )
        assert list(read_group(one, group, kind)) == ordered
        expected = hashlib.sha256(b"".join(encoded(p) + b"\n" for p in ordered)).hexdigest()
        assert inventory["logical_sha256"] == expected
        for relative in group_files(one, group, kind):
            assert (one / relative).read_bytes() == (two / relative).read_bytes()
        for shard in inventory["shards"]:
            content = (one / inventory_path(group, kind).parent / shard["path"]).read_bytes()
            assert len(content) == shard["bytes"] <= 64 * 1024
            assert hashlib.sha256(content).hexdigest() == shard["sha256"]
            assert content[4:8] == b"\0" * 4  # gzip mtime
            assert content[9] == 255  # independent of Python/platform gzip header defaults
            assert len(json.loads(gzip.decompress(content))) == shard["count"]
    assert first["puzzles"]["rating_counts"] == [[1400, 260], [2400, 3]]
    assert first["ordinary"]["shard_size"] == 64


@pytest.mark.parametrize("size", [0, 1, 127, 257, True])
def test_unsupported_puzzle_sizes_fail_without_publication(tmp_path, size):
    with pytest.raises(ValueError, match="between 128 and 256"):
        export_assets(tmp_path / "output", [], [], {}, puzzle_shard_size=size)
    assert not (tmp_path / "output/manifest.json").exists()


def test_only_changed_group_gets_a_version_and_old_versions_are_retained(tmp_path):
    metadata = {
        "engine": "Fixture",
        "nodes": 100000,
        "prepared_at": "one",
        "source_puzzles": "archive",
        "puzzle_import": {"source_sha256": "hash"},
    }
    first = export_assets(tmp_path, [puzzle()], [{"id": "a", "scores": {"x": 1}}], metadata)
    before = {kind: list(group_files(tmp_path, first[kind], kind)) for kind in assets.KINDS}
    times = {
        path: (tmp_path / path).stat().st_mtime_ns for paths in before.values() for path in paths
    }
    second = export_assets(
        tmp_path, [puzzle()], [{"id": "a", "scores": {"x": 2}}], {**metadata, "prepared_at": "two"}
    )
    assert first["puzzles"] == second["puzzles"]
    assert first["ordinary"]["version"] != second["ordinary"]["version"]
    assert all((tmp_path / path).stat().st_mtime_ns == modified for path, modified in times.items())
    assert list(read_group(tmp_path, first["ordinary"])) == [{"id": "a", "scores": {"x": 1}}]
    unchanged = export_assets(
        tmp_path,
        [puzzle()],
        [{"id": "a", "scores": {"x": 2}}],
        {**metadata, "prepared_at": "three"},
    )
    assert unchanged["puzzles"] == second["puzzles"]
    assert unchanged["ordinary"] == second["ordinary"]
    assert unchanged["dataset_id"] != second["dataset_id"]


def test_failed_shard_size_check_does_not_replace_manifest_or_delete_old_files(tmp_path):
    first = export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    old = (tmp_path / "manifest.json").read_bytes()
    rng = random.Random(1)
    noise = rng.randbytes(100_000).hex()
    with pytest.raises(ValueError, match="64 KiB"):
        export_assets(tmp_path, [puzzle(note=noise)], [{"id": "b"}], {})
    assert (tmp_path / "manifest.json").read_bytes() == old
    assert list(read_group(tmp_path, first["ordinary"])) == [{"id": "a"}]
    assert not list(tmp_path.glob(".corpus-building-*"))


def test_input_manifest_change_aborts_before_group_promotion(tmp_path):
    first = export_assets(tmp_path, [], [{"id": "a"}], {})
    marker = encoded({"another": "publisher"})

    def changed_input():
        (tmp_path / "manifest.json").write_bytes(marker)
        yield {"id": "b"}

    groups = set((tmp_path / "ordinary").iterdir())
    with pytest.raises(ValueError, match="Input manifest changed"):
        export_assets(tmp_path, [], changed_input(), {})
    assert (tmp_path / "manifest.json").read_bytes() == marker
    assert set((tmp_path / "ordinary").iterdir()) == groups
    assert list(read_group(tmp_path, first["ordinary"])) == [{"id": "a"}]


def test_frozen_catalog_retains_exact_old_manifest_and_both_groups(tmp_path):
    output = tmp_path / "output"
    first = export_assets(output, [puzzle()], [{"id": "a"}], {})
    old_manifest = (output / "manifest.json").read_bytes()
    with frozen_catalog(output) as frozen:
        export_assets(output, [puzzle("new")], [{"id": "b"}], {})
        assert frozen.manifest_bytes == old_manifest
        assert frozen.manifest == first
        assert frozen.manifest_sha256 == hashlib.sha256(old_manifest).hexdigest()
        for kind in assets.KINDS:
            assert list(read_group(frozen.directory, first[kind], kind))
        temporary = frozen.directory
    assert not temporary.exists()


def test_legacy_catalog_reuse_is_explicit_and_missing_replay_keys_are_legal(tmp_path):
    old = {"count": 0, "shards": []}
    with pytest.raises(ValueError, match="convert"):
        export_assets(tmp_path, None, [], {}, puzzle_group=old)
    record = puzzle(extra={"retained": True})
    canonical = canonical_record(record, "puzzles")
    assert "position_key" not in record
    assert {key: value for key, value in canonical.items() if key != "position_key"} == record
    with pytest.raises(ValueError):
        canonical_record(puzzle(moves=["e2e4", "e7e4"]), "puzzles")


def test_duplicate_ids_and_corrupt_reused_immutable_groups_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="Duplicate puzzles"):
        export_assets(tmp_path, [puzzle(), puzzle(rating=2000)], [], {})
    first = export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    inventory = read_inventory(tmp_path, first["ordinary"])
    path = inventory_path(first["ordinary"]).parent / inventory["shards"][0]["path"]
    (tmp_path / path).write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="SHA-256"):
        export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    assert json.loads((tmp_path / "manifest.json").read_bytes()) == first


def test_abandoned_lock_is_never_stolen_and_timeout_has_owner_diagnostics(tmp_path):
    output = tmp_path / "corpus"
    lock = Path(str(output.resolve()) + ".publication-lock")
    lock.mkdir()
    owner = {"pid": -1, "hostname": "fixture-dead-writer"}
    (lock / "owner.json").write_bytes(encoded(owner))
    with pytest.raises(TimeoutError, match="never stolen") as caught:
        with publication_lock(output, timeout=0.02, poll_interval=0.005):
            pytest.fail("stole abandoned lock")
    assert "fixture-dead-writer" in str(caught.value)
    assert str(lock) in str(caught.value)
    assert json.loads((lock / "owner.json").read_bytes()) == owner


def test_lock_is_reentrant_canonical_and_released_on_exception(tmp_path):
    output = tmp_path / "corpus"
    lock = Path(str(output.resolve()) + ".publication-lock")
    with pytest.raises(RuntimeError, match="test"):
        with publication_lock(output):
            assert json.loads((lock / "owner.json").read_bytes())["pid"] == os.getpid()
            with publication_lock(output / "../corpus", timeout=0):
                raise RuntimeError("test")
    assert not lock.exists()


def wait_for(path, process):
    deadline = time.monotonic() + 10
    while not path.exists() and process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert path.exists()


@pytest.mark.skipif(not shutil.which("node"), reason="Node is optional for Python tests")
def test_node_directory_lock_blocks_python_without_stealing(tmp_path):
    output, ready, release = tmp_path / "output", tmp_path / "ready", tmp_path / "release"
    code = """
      import fs from 'node:fs';
      import { acquirePublicationLock } from './scripts/data-integrity.mjs';
      const [output, ready, release] = process.argv.slice(1);
      const unlock = await acquirePublicationLock(output);
      fs.writeFileSync(ready, '');
      const timer = setInterval(() => {
        if (!fs.existsSync(release)) return;
        clearInterval(timer); unlock();
      }, 10);
    """
    process = subprocess.Popen(
        ["node", "--input-type=module", "-e", code, str(output), str(ready), str(release)]
    )
    try:
        wait_for(ready, process)
        with pytest.raises(TimeoutError, match="owner:"):
            with publication_lock(output, timeout=0.03):
                pytest.fail("Python ignored the Node lock")
        release.touch()
        with publication_lock(output, timeout=5):
            assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            release.touch()
            process.wait(timeout=5)


@pytest.mark.skipif(not shutil.which("node"), reason="Node is optional for Python tests")
def test_python_directory_lock_blocks_node_until_released(tmp_path):
    output, ready, acquired = tmp_path / "output", tmp_path / "ready", tmp_path / "acquired"
    code = """
      import fs from 'node:fs';
      import { acquirePublicationLock } from './scripts/data-integrity.mjs';
      const [output, ready, acquired] = process.argv.slice(1);
      fs.writeFileSync(ready, '');
      const unlock = await acquirePublicationLock(output, {timeoutMs: 5000, pollMs: 10});
      fs.writeFileSync(acquired, '');
      unlock();
    """
    with publication_lock(output):
        process = subprocess.Popen(
            ["node", "--input-type=module", "-e", code, str(output), str(ready), str(acquired)]
        )
        try:
            wait_for(ready, process)
            time.sleep(0.05)
            assert not acquired.exists()
        except BaseException:
            process.kill()
            process.wait()
            raise
    assert process.wait(timeout=10) == 0
    assert acquired.exists()


def test_python_lock_wait_is_bounded_across_processes(tmp_path):
    output = tmp_path / "output"
    code = (
        "from pathlib import Path\nfrom training_assets import publication_lock\n"
        f"with publication_lock(Path({str(output)!r}), timeout=0.02): pass\n"
    )
    with publication_lock(output):
        process = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert process.returncode != 0
    assert "Timed out waiting for publication lock" in process.stderr
    assert "owner:" in process.stderr


def _fork_lock_attempt(output, result):
    try:
        with publication_lock(output, timeout=0.01):
            result.write_text("acquired")
    except TimeoutError:
        result.write_text("blocked")


@pytest.mark.skipif(
    "fork" not in multiprocessing.get_all_start_methods(), reason="fork unavailable"
)
def test_forked_child_does_not_inherit_parent_lock_reentrancy(tmp_path):
    output, result = tmp_path / "output", tmp_path / "result"
    with publication_lock(output):
        process = multiprocessing.get_context("fork").Process(
            target=_fork_lock_attempt, args=(output, result)
        )
        process.start()
        process.join(timeout=5)
        assert process.exitcode == 0
        assert result.read_text() == "blocked"


def test_manifest_is_the_last_publication_write(tmp_path, monkeypatch):
    export_assets(tmp_path, [puzzle()], [{"id": "old"}], {})
    previous = (tmp_path / "manifest.json").read_bytes()
    original = assets.atomic_bytes
    seen = []

    def verify_last(path, raw):
        if path.name == "manifest.json":
            assert path.read_bytes() == previous
            manifest = json.loads(raw)
            for kind in assets.KINDS:
                records = list(read_group(tmp_path, manifest[kind], kind))
                assert len(records) == manifest[kind]["count"]
            seen.append(path)
        original(path, raw)

    monkeypatch.setattr(assets, "atomic_bytes", verify_last)
    export_assets(tmp_path, [puzzle("new")], [{"id": "new"}], {})
    assert seen == [tmp_path / "manifest.json"]


def test_symlink_input_and_unsafe_paths_are_rejected(tmp_path):
    for unsafe in ("../outside", "/absolute", "ordinary//x", "a\\\\b", "a/./b", "a/../b", "a\0b"):
        with pytest.raises(ValueError, match="path"):
            assets.relative_path(unsafe)
    manifest = export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    inventory = read_inventory(tmp_path, manifest["puzzles"])
    path = tmp_path / inventory_path(manifest["puzzles"]).parent / inventory["shards"][0]["path"]
    actual = path.with_suffix(".original")
    path.rename(actual)
    path.symlink_to(actual)
    with pytest.raises(ValueError, match="regular training asset"):
        list(read_group(tmp_path, manifest["puzzles"]))


def test_inflated_shard_limit_is_checked_without_unbounded_allocation(tmp_path, monkeypatch):
    manifest = export_assets(tmp_path, [puzzle(note="x" * 10000)], [{"id": "a"}], {})
    monkeypatch.setattr(assets, "MAX_INFLATED_SHARD_BYTES", 5000)
    with pytest.raises(ValueError, match="Inflated shard"):
        list(read_group(tmp_path, manifest["puzzles"]))


def test_reused_puzzle_group_must_authenticate_every_shard_before_publication(tmp_path):
    manifest = export_assets(tmp_path, [puzzle()], [{"id": "old"}], {})
    previous = (tmp_path / "manifest.json").read_bytes()
    inventory = read_inventory(tmp_path, manifest["puzzles"])
    path = tmp_path / inventory_path(manifest["puzzles"]).parent / inventory["shards"][0]["path"]
    path.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="SHA-256"):
        export_assets(tmp_path, None, [{"id": "new"}], {}, puzzle_group=manifest["puzzles"])
    assert (tmp_path / "manifest.json").read_bytes() == previous
    assert list(read_group(tmp_path, manifest["ordinary"])) == [{"id": "old"}]


def test_writer_rejects_compressible_oversized_shards_before_publication(tmp_path, monkeypatch):
    export_assets(tmp_path, [puzzle()], [{"id": "old"}], {})
    previous = (tmp_path / "manifest.json").read_bytes()
    monkeypatch.setattr(assets, "MAX_INFLATED_SHARD_BYTES", 5000)
    with pytest.raises(ValueError, match="inflated limit"):
        export_assets(tmp_path, [puzzle(note="x" * 6000)], [{"id": "new"}], {})
    assert (tmp_path / "manifest.json").read_bytes() == previous


@pytest.mark.parametrize("kind", ["puzzles", "ordinary"])
def test_declared_huge_counts_are_rejected_before_allocating_expected_shards(tmp_path, kind):
    inventory = {
        "format": 1,
        "kind": kind,
        "count": 10**12,
        "shard_size": 256 if kind == "puzzles" else 64,
        "provenance": {},
        "logical_sha256": "0" * 64,
        "shards": [],
        **({"rating_counts": [[1400, 10**12]]} if kind == "puzzles" else {}),
    }
    raw = encoded(inventory)
    version = hashlib.sha256(raw).hexdigest()
    group = {
        "version": version,
        "count": inventory["count"],
        "shard_size": inventory["shard_size"],
        **({"rating_counts": inventory["rating_counts"]} if kind == "puzzles" else {}),
    }
    path = tmp_path / inventory_path(group, kind)
    path.parent.mkdir(parents=True)
    path.write_bytes(raw)
    with pytest.raises(ValueError, match="Inventory shard count mismatch"):
        read_inventory(tmp_path, group, kind)


@pytest.mark.parametrize("kind", ["puzzles", "ordinary"])
def test_regenerated_existing_version_rejects_unlisted_files_before_publication(tmp_path, kind):
    manifest = export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    previous = (tmp_path / "manifest.json").read_bytes()
    unexpected = tmp_path / inventory_path(manifest[kind], kind).parent / "unlisted.txt"
    unexpected.write_text("not in the inventory")
    with pytest.raises(ValueError, match="Unlisted/special file"):
        export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    assert (tmp_path / "manifest.json").read_bytes() == previous
    assert unexpected.read_text() == "not in the inventory"


def install_inventory(directory, inventory):
    raw = encoded(inventory)
    group = {
        "version": hashlib.sha256(raw).hexdigest(),
        "count": inventory["count"],
        "shard_size": inventory["shard_size"],
        **({"rating_counts": inventory["rating_counts"]} if inventory["kind"] == "puzzles" else {}),
    }
    path = directory / inventory_path(group, inventory["kind"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return group


def test_rating_array_contract_covers_negative_and_all_safe_integer_ratings(tmp_path):
    ratings = [MAX_SAFE_INTEGER, -1, -MAX_SAFE_INTEGER, 0, 4001, -2000]
    records = [puzzle(f"p{index}", rating) for index, rating in enumerate(ratings)]
    records.append(puzzle("another-negative", -1))
    manifest = export_assets(tmp_path, records, [], {})
    expected = [[rating, 2 if rating == -1 else 1] for rating in sorted(ratings)]
    assert manifest["puzzles"]["rating_counts"] == expected
    inventory = read_inventory(tmp_path, manifest["puzzles"], "puzzles")
    assert inventory["rating_counts"] == expected
    assert [shard["path"] for shard in inventory["shards"]] == [
        f"{rating}/0.json.gz" for rating in sorted(ratings)
    ]
    actual = list(read_group(tmp_path, manifest["puzzles"], "puzzles"))
    assert [record["rating"] for record in actual] == sorted([*ratings, -1])


@pytest.mark.parametrize(
    "rating", [True, 1.0, "1", None, MAX_SAFE_INTEGER + 1, -MAX_SAFE_INTEGER - 1]
)
def test_writer_rejects_noninteger_and_unsafe_ratings_without_changing_publication(
    tmp_path, rating
):
    export_assets(tmp_path, [puzzle()], [{"id": "old"}], {})
    previous = (tmp_path / "manifest.json").read_bytes()
    with pytest.raises(ValueError, match="rating must be a safe integer"):
        export_assets(tmp_path, [puzzle(rating=rating)], [{"id": "new"}], {})
    assert (tmp_path / "manifest.json").read_bytes() == previous


@pytest.mark.parametrize("where", ["manifest", "inventory"])
@pytest.mark.parametrize(
    "ratings",
    [
        {"1400": 1},
        [[1400, 1], [1400, 1]],
        [[1401, 1], [1400, 1]],
        [["1400", 1]],
        [[1400.0, 1]],
        [[True, 1]],
        [[MAX_SAFE_INTEGER + 1, 1]],
        [[-MAX_SAFE_INTEGER - 1, 1]],
        [[1400, 0]],
        [[1400, -1]],
        [[1400, 1.0]],
        [[1400, True]],
        [[1400, MAX_SAFE_INTEGER + 1]],
        [[1400]],
        [[1400, 1, 9]],
        [1400],
        None,
        [],
    ],
)
def test_both_manifest_and_inventory_require_exact_sorted_unique_rating_arrays(
    tmp_path, where, ratings
):
    manifest = export_assets(tmp_path, [puzzle()], [], {})
    inventory = read_inventory(tmp_path, manifest["puzzles"])
    if where == "inventory":
        inventory["rating_counts"] = ratings
    group = install_inventory(tmp_path, inventory)
    group["rating_counts"] = ratings if where == "manifest" else [[1400, 1]]
    with pytest.raises(ValueError, match="(?i)rating counts"):
        read_inventory(tmp_path, group, "puzzles")


def test_rating_count_sum_must_be_safe_before_declared_shards_are_enumerated(tmp_path):
    manifest = export_assets(tmp_path, [], [], {})
    inventory = read_inventory(tmp_path, manifest["puzzles"])
    inventory.update(count=MAX_SAFE_INTEGER, rating_counts=[[-1, MAX_SAFE_INTEGER], [0, 1]])
    group = install_inventory(tmp_path, inventory)
    with pytest.raises(ValueError, match="count sum exceeds the safe integer limit"):
        read_inventory(tmp_path, group, "puzzles")


@pytest.mark.parametrize("kind", ["puzzles", "ordinary"])
@pytest.mark.parametrize("where", ["manifest", "inventory", "shard"])
@pytest.mark.parametrize("count", [True, 1.0, -1, MAX_SAFE_INTEGER + 1])
def test_group_and_shard_counts_require_safe_nonnegative_integers(tmp_path, kind, where, count):
    manifest = export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    inventory = read_inventory(tmp_path, manifest[kind], kind)
    if where == "inventory":
        inventory["count"] = count
    elif where == "shard":
        inventory["shards"][0]["count"] = count
    group = install_inventory(tmp_path, inventory)
    group["count"] = count if where == "manifest" else 1
    with pytest.raises(ValueError, match="count|group fields"):
        read_inventory(tmp_path, group, kind)


@pytest.mark.parametrize("kind", ["puzzles", "ordinary"])
@pytest.mark.parametrize("field", ["format", "shard_size", "bytes"])
def test_inventory_integer_fields_do_not_accept_equivalent_floats(tmp_path, kind, field):
    manifest = export_assets(tmp_path, [puzzle()], [{"id": "a"}], {})
    inventory = read_inventory(tmp_path, manifest[kind], kind)
    if field == "bytes":
        inventory["shards"][0][field] = float(inventory["shards"][0][field])
    else:
        inventory[field] = float(inventory[field])
    group = install_inventory(tmp_path, inventory)
    if field == "shard_size":
        group[field] = manifest[kind][field]
    with pytest.raises(ValueError):
        read_inventory(tmp_path, group, kind)


@pytest.mark.parametrize(
    "name",
    [
        "1400/00.json.gz",
        "01400/0.json.gz",
        "+1400/0.json.gz",
        "1400/0.0.json.gz",
        "1400/-1.json.gz",
        "1400/9007199254740992.json.gz",
        "9007199254740992/0.json.gz",
        "-9007199254740992/0.json.gz",
    ],
)
def test_inventory_rating_and_part_paths_are_canonical_safe_integers(tmp_path, name):
    manifest = export_assets(tmp_path, [puzzle()], [], {})
    inventory = read_inventory(tmp_path, manifest["puzzles"])
    inventory["shards"][0]["path"] = name
    group = install_inventory(tmp_path, inventory)
    with pytest.raises(ValueError, match="Inventory shard path/count mismatch"):
        read_inventory(tmp_path, group, "puzzles")


@pytest.mark.parametrize("rating", [True, 1400.0, MAX_SAFE_INTEGER + 1, -MAX_SAFE_INTEGER - 1])
def test_authenticated_shard_reader_still_requires_safe_integer_record_ratings(tmp_path, rating):
    manifest = export_assets(tmp_path, [puzzle()], [], {})
    records = list(read_group(tmp_path, manifest["puzzles"], "puzzles"))
    records[0]["rating"] = rating
    content = assets.deterministic_gzip(encoded(records))
    inventory = read_inventory(tmp_path, manifest["puzzles"])
    inventory["shards"][0].update(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
    inventory["logical_sha256"] = hashlib.sha256(encoded(records[0]) + b"\n").hexdigest()
    group = install_inventory(tmp_path, inventory)
    path = tmp_path / inventory_path(group).parent / inventory["shards"][0]["path"]
    path.parent.mkdir(parents=True)
    path.write_bytes(content)
    with pytest.raises(ValueError, match="rating must be a safe integer"):
        list(read_group(tmp_path, group, "puzzles"))


@pytest.mark.parametrize("reuse_puzzles", [False, True])
def test_post_prepare_can_authenticate_complete_catalog_before_any_promotion(
    tmp_path, reuse_puzzles
):
    previous = export_assets(tmp_path, [puzzle()], [{"id": "old"}], {})
    before = {path: path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    observed = []

    def verify_staged(directory, proposed):
        assert directory != tmp_path
        assert json.loads((tmp_path / "manifest.json").read_bytes()) == previous
        for kind in assets.KINDS:
            actual = list(read_group(directory, proposed[kind], kind))
            assert len(actual) == proposed[kind]["count"]
        assert list(read_group(directory, proposed["ordinary"], "ordinary")) == [{"id": "new"}]
        observed.append(proposed)
        raise ValueError("verification failed before promotion")

    with pytest.raises(ValueError, match="verification failed before promotion"):
        export_assets(
            tmp_path,
            None if reuse_puzzles else [puzzle("new")],
            [{"id": "new"}],
            {},
            puzzle_group=previous["puzzles"] if reuse_puzzles else None,
            post_prepare=verify_staged,
        )
    assert len(observed) == 1
    assert {path: path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()} == before

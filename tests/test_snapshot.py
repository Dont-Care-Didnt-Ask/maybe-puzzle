import json
import subprocess
import sys
import time

import chess
import pytest

from export_static import VERSION, digest, export_assets, grade_position, publication_lock
from import_puzzles import build_index, publish, read_group
from prepare import save_json
from snapshot_corpus import snapshot_corpus
from tests.test_export import FakeEngine
from tests.test_full_corpus import ordinary_record, puzzle_archive
from training_assets import group_files


def fixture(tmp_path):
    source, index = tmp_path / "puzzles.csv", tmp_path / "index.sqlite3"
    output, directory = tmp_path / "live", tmp_path / "data"
    puzzle_archive(source)
    stats = build_index(source, index)
    baseline = ordinary_record()
    metadata = {
        "engine": "Fixture",
        "nodes": 100000,
        "sampled_games": 1000,
        "exporter_version": VERSION,
        "source_puzzles": "fixture.csv",
    }
    export_assets(output, [], [baseline], metadata)
    publish(index, output, "fixture.csv", stats)
    directory.mkdir()
    (directory / "static-checkpoints").mkdir()
    save_json(
        directory / "manifest.json",
        {
            "nodes": 100000,
            "seed": 2026,
            "sampled_games": 2000,
            "games_source": "fixture.pgn",
            "prepared_at": "fixture",
            "min_rating": 1800,
            "min_ply": 20,
            "max_ply": 160,
        },
    )
    config = {"engine": "Fixture", "nodes": 100000, "version": VERSION, "tolerance_cp": 50}
    return directory, output, index, config, baseline


def checkpoint(directory, config, setup, game, *, prefilter=True):
    source = {
        "id": f"{setup}-{game}",
        "fen": chess.STARTING_FEN,
        "moves": [setup],
        "url": f"https://lichess.org/{game}#1",
    }
    record = grade_position(source, FakeEngine())
    if prefilter:
        source["prefilter"] = True
    fingerprint = digest({"config": config, "source": source})
    path = directory / "static-checkpoints" / f"{fingerprint}.json"
    save_json(path, {"fingerprint": fingerprint, "record": record})
    return path


def test_snapshot_reuses_only_matching_complete_nonoverlapping_distinct_game_grades(
    tmp_path, monkeypatch
):
    directory, output, index, config, baseline = fixture(tmp_path)
    checkpoint(directory, config, "c2c4", "new")
    checkpoint(directory, config, "f2f4", "new")  # Same game: only one may survive.
    checkpoint(directory, config, "e2e4", "puzzle-overlap")
    checkpoint(directory, {**config, "nodes": 1}, "g2g3", "wrong-budget")
    checkpoint(directory, config, "d2d4", "existing", prefilter=False)
    (directory / "static-checkpoints" / "unfinished.json.tmp").write_text("incomplete")
    previous = (output / "manifest.json").read_bytes()
    root = tmp_path / "snapshot"
    checkpoint_bytes = {path: path.read_bytes() for path in directory.rglob("*") if path.is_file()}

    def forbidden(*args, **kwargs):
        pytest.fail("Snapshot invoked an engine")

    monkeypatch.setattr("engine.Engine.__init__", forbidden)
    manifest = snapshot_corpus(directory, output, index, root)
    assert all(path.read_bytes() == raw for path, raw in checkpoint_bytes.items())
    assert manifest["ordinary"]["count"] == 2
    assert manifest["checkpoint_snapshot"] == {"qualified": 2, "target": 30000, "complete": False}
    assert (output / "manifest.json").read_bytes() == previous
    records = list(read_group(root / "public/training", manifest["ordinary"]))
    assert baseline in records
    assert all("wrong-budget" not in p["url"] and "puzzle-overlap" not in p["url"] for p in records)
    assert len(list((directory / "static-checkpoints").glob("*.json"))) == 5


def test_published_snapshot_remains_stable_after_another_publication(tmp_path):
    directory, output, index, config, baseline = fixture(tmp_path)
    checkpoint(directory, config, "c2c4", "new")
    root = tmp_path / "snapshot"
    manifest = snapshot_corpus(directory, output, index, root, publish=True)
    assert json.loads((output / "manifest.json").read_text())["ordinary"]["count"] == 2
    # A later publication retains old groups; the snapshot still has its own links.
    export_assets(
        output, None, [baseline], {}, compact_ratings=True, puzzle_group=manifest["puzzles"]
    )
    assert len(list(read_group(root / "public/training", manifest["ordinary"]))) == 2
    assert (root / "public/training/manifest.json").read_text() != (
        output / "manifest.json"
    ).read_text()


def test_snapshot_freezes_both_inventories_and_shards_and_only_regenerates_ordinary(tmp_path):
    directory, output, index, config, _ = fixture(tmp_path)
    previous = json.loads((output / "manifest.json").read_bytes())
    checkpoint(directory, config, "c2c4", "new")
    root = tmp_path / "snapshot"
    manifest = snapshot_corpus(directory, output, index, root)
    destination = root / "public/training"
    assert manifest["puzzles"] == previous["puzzles"]
    assert manifest["ordinary"]["version"] != previous["ordinary"]["version"]
    assert json.loads((destination / "manifest.json").read_bytes()) == manifest
    for kind in ("puzzles", "ordinary"):
        files = list(group_files(destination, manifest[kind], kind))
        assert any(path.name == "inventory.json" for path in files)
        assert all((destination / path).is_file() for path in files)
        assert len(list(read_group(destination, manifest[kind], kind))) == manifest[kind]["count"]
    assert json.loads((output / "manifest.json").read_bytes()) == previous


def test_invalid_checkpoint_cannot_replace_public_assets(tmp_path):
    directory, output, index, config, _ = fixture(tmp_path)
    path = checkpoint(directory, config, "c2c4", "new")
    value = json.loads(path.read_text())
    value["record"]["scores"].pop("e7e5")
    save_json(path, value)
    previous = (output / "manifest.json").read_bytes()
    with pytest.raises(ValueError, match="Incomplete"):
        snapshot_corpus(directory, output, index, tmp_path / "snapshot", publish=True)
    assert (output / "manifest.json").read_bytes() == previous


def test_publication_lock_is_reentrant_and_serializes_other_processes(tmp_path):
    output, ready, acquired = tmp_path / "live", tmp_path / "ready", tmp_path / "acquired"
    code = (
        "from pathlib import Path\nfrom export_static import publication_lock\n"
        f"Path({str(ready)!r}).touch()\n"
        f"with publication_lock(Path({str(output)!r})):\n"
        f" Path({str(acquired)!r}).touch()\n"
    )
    with publication_lock(output), publication_lock(output):
        process = subprocess.Popen([sys.executable, "-c", code])
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            assert ready.exists()
            assert not acquired.exists()
        except BaseException:
            process.kill()
            process.wait()
            raise
    assert process.wait(timeout=10) == 0
    assert acquired.exists()


def test_changed_authoring_inputs_abort_snapshot_before_publication(tmp_path, monkeypatch):
    import snapshot_corpus as snapshots

    directory, output, index, config, _ = fixture(tmp_path)
    checkpoint(directory, config, "c2c4", "new")
    previous = (output / "manifest.json").read_bytes()
    original = snapshots.completed_records

    def changed(*args):
        yield from original(*args)
        source_path = directory / "manifest.json"
        source = json.loads(source_path.read_bytes())
        save_json(source_path, {**source, "seed": 123})

    monkeypatch.setattr(snapshots, "completed_records", changed)
    with pytest.raises(ValueError, match="Authoring input manifest changed"):
        snapshot_corpus(directory, output, index, tmp_path / "snapshot", publish=True)
    assert (output / "manifest.json").read_bytes() == previous

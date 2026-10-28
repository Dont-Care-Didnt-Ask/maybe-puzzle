import json
import sqlite3
from types import SimpleNamespace

import pytest

import expand_corpus
from expand_corpus import puzzles_ready
from training_assets import encoded

STATS = {"source_sha256": "a" * 64, "retained": 2, "validation": "full legal replay"}


def manifest(output, *, schema=3, stats=STATS):
    output.mkdir(parents=True, exist_ok=True)
    payload = {"schema": schema}
    if stats is not None:
        payload["puzzle_import"] = stats
    (output / "manifest.json").write_bytes(encoded(payload))


def metadata(index, stats=STATS):
    with sqlite3.connect(index) as database:
        database.execute("CREATE TABLE metadata (value TEXT)")
        database.execute("INSERT INTO metadata VALUES (?)", (json.dumps(stats),))


def test_matching_index_readiness_is_read_only_and_checks_all_import_provenance(tmp_path):
    output, index = tmp_path / "output", tmp_path / "index with ? spaces.sqlite3"
    manifest(output)
    assert not puzzles_ready(output, index)
    assert not index.exists(), "Polling must not create an empty index"
    metadata(index)
    before, modified = index.read_bytes(), index.stat().st_mtime_ns
    index.chmod(0o444)
    try:
        assert puzzles_ready(output, index)
        assert index.read_bytes() == before
        assert index.stat().st_mtime_ns == modified
        assert not list(tmp_path.glob("*.sqlite3-*"))
        # A matching archive digest alone is insufficient: every metadata field
        # must match the manifest published by the importer.
        manifest(output, stats={**STATS, "retained": STATS["retained"] + 1})
        assert not puzzles_ready(output, index)
        manifest(output, stats={**STATS, "source_sha256": "b" * 64})
        assert not puzzles_ready(output, index)
    finally:
        index.chmod(0o644)


@pytest.mark.parametrize(
    "state", ["absent", "empty", "no-table", "no-rows", "bad-json", "null", "extra-row", "corrupt"]
)
def test_incomplete_or_invalid_concurrent_indexes_are_not_ready(tmp_path, state):
    output, index = tmp_path / "output", tmp_path / "index.sqlite3"
    manifest(output)
    if state == "empty":
        index.touch()
    elif state == "corrupt":
        index.write_bytes(b"not sqlite")
    elif state not in ("absent", "empty"):
        with sqlite3.connect(index) as database:
            if state == "no-table":
                database.execute("CREATE TABLE puzzles (id TEXT)")
            else:
                database.execute("CREATE TABLE metadata (value TEXT)")
                if state != "no-rows":
                    value = {"bad-json": "{", "null": None}.get(state, json.dumps(STATS))
                    database.execute("INSERT INTO metadata VALUES (?)", (value,))
                    if state == "extra-row":
                        database.execute("INSERT INTO metadata VALUES (?)", (value,))
    assert not puzzles_ready(output, index)
    if state == "absent":
        assert not index.exists()


def test_uncommitted_completion_marker_does_not_make_index_ready(tmp_path):
    output, index = tmp_path / "output", tmp_path / "index.sqlite3"
    manifest(output)
    with sqlite3.connect(index) as writer:
        writer.execute("CREATE TABLE metadata (value TEXT)")
        writer.commit()
        writer.execute("INSERT INTO metadata VALUES (?)", (json.dumps(STATS),))
        assert not puzzles_ready(output, index)
        writer.commit()
        assert puzzles_ready(output, index)


@pytest.mark.parametrize(
    "schema,stats", [(1, STATS), (2, STATS), (4, STATS), (3, None), (3, {}), (3, [])]
)
def test_only_schema3_catalogs_with_import_metadata_are_ready(tmp_path, schema, stats):
    output, index = tmp_path / "output", tmp_path / "index.sqlite3"
    manifest(output, schema=schema, stats=stats)
    metadata(index, stats)
    assert not puzzles_ready(output, index)


def test_missing_or_temporarily_unreadable_manifest_keeps_waiting(tmp_path):
    output, index = tmp_path / "output", tmp_path / "index.sqlite3"
    metadata(index)
    assert not puzzles_ready(output, index)
    assert not output.exists()
    output.mkdir()
    assert not puzzles_ready(output, index)
    (output / "manifest.json").write_bytes(b"{")
    assert not puzzles_ready(output, index)
    manifest(output)
    assert puzzles_ready(output, index)
    (output / "manifest.json").unlink()
    assert not puzzles_ready(output, index)


def test_wait_for_puzzles_launches_grading_only_after_matching_committed_index(
    tmp_path, monkeypatch
):
    source, output, index = tmp_path / "source.pgn", tmp_path / "output", tmp_path / "index.sqlite3"
    source.write_text("")
    monkeypatch.setattr(expand_corpus, "ROOT", tmp_path)
    monkeypatch.setattr(expand_corpus, "download", lambda *_: source)
    monkeypatch.setattr(expand_corpus, "unpack_pgn", lambda *_: source)
    monkeypatch.setattr(expand_corpus, "prepare_games", lambda *_: None)
    sleeps, commands = [], []

    def advance(seconds):
        assert seconds == 5
        assert not commands
        sleeps.append(seconds)
        if len(sleeps) == 1:
            manifest(output)
        elif len(sleeps) == 2:
            index.touch()
        elif len(sleeps) == 3:
            with sqlite3.connect(index) as database:
                database.execute("CREATE TABLE metadata (value TEXT)")
        elif len(sleeps) == 4:
            with sqlite3.connect(index) as database:
                database.execute(
                    "INSERT INTO metadata VALUES (?)", (json.dumps({**STATS, "retained": 1}),)
                )
        elif len(sleeps) == 5:
            with sqlite3.connect(index) as database:
                database.execute("UPDATE metadata SET value=?", (json.dumps(STATS),))
        else:
            pytest.fail("The matching committed index should have ended the wait")

    class CompletedProcess:
        def __enter__(self):
            return SimpleNamespace(wait=lambda: 0, poll=lambda: 0)

        def __exit__(self, *args):
            return False

    def start(command):
        assert puzzles_ready(output, index)
        commands.append(command)
        return CompletedProcess()

    monkeypatch.setattr(expand_corpus.time, "sleep", advance)
    monkeypatch.setattr(expand_corpus.subprocess, "Popen", start)
    monkeypatch.setattr(
        "sys.argv",
        [
            "expand_corpus.py",
            "--games-source",
            str(source),
            "--output",
            str(output),
            "--puzzle-index",
            str(index),
            "--games",
            "1",
            "--positions",
            "1",
            "--workers",
            "1",
            "--wait-for-puzzles",
        ],
    )
    expand_corpus.main()
    assert len(sleeps) == 5
    assert len(commands) == 1
    assert "--resume" not in commands[0]
    assert commands[0][-4:] == ["--puzzle-catalog", str(output), "--puzzle-index", str(index)]

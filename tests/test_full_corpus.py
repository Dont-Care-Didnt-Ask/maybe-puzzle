import csv
import gzip
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import chess
import chess.pgn
import pytest

import export_static
from expand_corpus import prepare_games
from export_static import evaluate, export_assets, grade_position, seed_published_grades
from import_puzzles import build_index, publish, read_group
from tests.test_export import FakeEngine
from training_assets import MAX_SAFE_INTEGER, read_inventory


def puzzle_archive(path):
    with path.open("w") as out:
        writer = csv.DictWriter(
            out, fieldnames=["PuzzleId", "FEN", "Moves", "Rating", "Popularity", "NbPlays"]
        )
        writer.writeheader()
        for index, rating in enumerate([399, 2400, 3323, 1700]):
            writer.writerow(
                {
                    "PuzzleId": str(index),
                    "FEN": chess.STARTING_FEN,
                    "Moves": "e2e4 e7e5" if index != 3 else "e2e4 e7e4",
                    "Rating": rating,
                    "Popularity": -10,
                    "NbPlays": 0,
                }
            )


def ordinary_record():
    return grade_position(
        {
            "id": "ordinary",
            "fen": chess.STARTING_FEN,
            "moves": ["d2d4"],
            "url": "https://lichess.org/existing#1",
        },
        FakeEngine(),
    )


def test_full_archive_import_has_no_quality_or_rating_cutoff_and_reuses_verified_index(tmp_path):
    source, index = tmp_path / "puzzles.csv", tmp_path / "index.sqlite3"
    puzzle_archive(source)
    stats = build_index(source, index)
    assert stats["source_rows"] == 4
    assert stats["retained"] == 3
    assert stats["invalid"] == 1
    assert stats["around_2400"] == 1
    assert (stats["min_rating"], stats["max_rating"]) == (399, 3323)
    assert build_index(source, index) == stats
    with sqlite3.connect(index) as database:
        assert database.execute("SELECT COUNT(*) FROM puzzles").fetchone()[0] == 3


def test_full_puzzle_publication_preserves_grades_and_adds_compact_exact_rating_shards(tmp_path):
    source, index, output = (
        tmp_path / "puzzles.csv",
        tmp_path / "index.sqlite3",
        tmp_path / "public",
    )
    puzzle_archive(source)
    stats = build_index(source, index)
    position = ordinary_record()
    metadata = {
        "engine": "Fixture",
        "nodes": 100000,
        "sampled_games": 1000,
        "source_puzzles": "fixture.csv",
    }
    export_assets(output, [], [position], metadata)
    manifest = publish(index, output, "fixture.csv", stats, shard_size=128)
    assert manifest["schema"] == 3
    assert manifest["puzzles"]["count"] == 3
    inventory = read_inventory(output, manifest["puzzles"], "puzzles")
    assert [s["path"] for s in inventory["shards"]] == [
        "399/0.json.gz",
        "2400/0.json.gz",
        "3323/0.json.gz",
    ]
    assert list(read_group(output, manifest["ordinary"])) == [position]
    base = output / "puzzles" / manifest["puzzles"]["version"]
    for shard in inventory["shards"]:
        records = json.loads(gzip.decompress((base / shard["path"]).read_bytes()))
        assert all(p["rating"] == int(shard["path"].split("/")[0]) for p in records)
        assert all("position_key" in p for p in records)


def test_published_complete_grades_are_reused_only_at_identical_configuration(
    tmp_path, monkeypatch
):
    record = ordinary_record()
    config = {"engine": "Fixture", "nodes": 100000, "version": 1, "tolerance_cp": 50}
    assert seed_published_grades([record], config, {**config, "nodes": 200000}, tmp_path) == 0
    assert list(tmp_path.iterdir()) == []
    assert seed_published_grades([record], config, config, tmp_path) == 1
    assert seed_published_grades([record], config, config, tmp_path) == 0
    monkeypatch.setattr(export_static, "_WORKER_ENGINE", None)
    source = {key: record[key] for key in ("id", "fen", "moves", "url")}
    assert evaluate(source, config, str(tmp_path))["record"] == record
    assert evaluate(source, config, str(tmp_path))["cached"] is True


def test_streamed_game_sample_retains_real_games_and_resumes_without_replacing_inputs(tmp_path):
    source, output, data = tmp_path / "source.pgn", tmp_path / "public", tmp_path / "expanded"
    with source.open("w") as stream:
        for i in range(12):
            game = chess.pgn.Game()
            game.headers.update(
                Event="Rated Blitz game",
                WhiteElo="2500",
                BlackElo="2400",
                LichessURL=f"https://lichess.org/{'existing' if i == 0 else i}",
            )
            game.add_line([chess.Move.from_uci("e2e4"), chess.Move.from_uci("e7e5")])
            print(game, file=stream, end="\n\n")
    export_assets(output, [], [ordinary_record()], {"source_puzzles": "fixture.csv"})
    prepare_games(source, data, output, count=5, seed=42)
    headers = []
    with (data / "games.pgn").open() as stream:
        while (item := chess.pgn.read_headers(stream)) is not None:
            headers.append(item)
    urls = {h["LichessURL"] for h in headers}
    assert len(urls) == len(headers)
    assert "https://lichess.org/existing" in urls
    metadata = json.loads((data / "manifest.json").read_text())
    assert metadata["sampled_games"] == len(headers)
    assert metadata["eligible_games"] == 12
    assert metadata["nodes"] == 100000
    modified = (data / "games.pgn").stat().st_mtime_ns
    prepare_games(source, data, output, count=5, seed=42)
    assert (data / "games.pgn").stat().st_mtime_ns == modified


@pytest.mark.parametrize("relative", [False, True])
def test_expand_build_passes_isolated_training_directory_and_local_mode(
    tmp_path, monkeypatch, relative
):
    import expand_corpus

    caller = tmp_path / "caller"
    caller.mkdir()
    monkeypatch.chdir(caller)
    source = tmp_path / "source.pgn"
    output = Path("isolated") if relative else tmp_path / "isolated"
    source.write_text("")
    monkeypatch.setattr(expand_corpus, "ROOT", tmp_path)
    monkeypatch.setattr(expand_corpus, "download", lambda *_: source)
    monkeypatch.setattr(expand_corpus, "unpack_pgn", lambda *_: source)
    monkeypatch.setattr(expand_corpus, "prepare_games", lambda *_: None)
    process = SimpleNamespace(wait=lambda: 0, poll=lambda: 0)

    class CompletedProcess:
        def __enter__(self):
            return process

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(expand_corpus.subprocess, "Popen", lambda *_: CompletedProcess())
    calls = []
    monkeypatch.setattr(
        expand_corpus.subprocess, "run", lambda command, **kwargs: calls.append((command, kwargs))
    )
    monkeypatch.setattr(
        "sys.argv",
        [
            "expand_corpus.py",
            "--games-source",
            str(source),
            "--output",
            str(output),
            "--positions",
            "1",
            "--games",
            "1",
            "--workers",
            "1",
            "--build",
        ],
    )
    expand_corpus.main()
    assert calls == [
        (
            ["npm", "run", "build", "--", "--training-dir", str(output.resolve()), "--local"],
            {"cwd": tmp_path, "check": True},
        )
    ]


def test_importer_fails_before_publication_when_index_metadata_does_not_match(tmp_path):
    source, index, output = tmp_path / "source.csv", tmp_path / "index", tmp_path / "output"
    puzzle_archive(source)
    stats = build_index(source, index)
    export_assets(output, [], [ordinary_record()], {})
    previous = (output / "manifest.json").read_bytes()
    with pytest.raises(ValueError, match="Puzzle index changed"):
        publish(index, output, "fixture.csv", {**stats, "retained": stats["retained"] + 1})
    assert (output / "manifest.json").read_bytes() == previous


def test_expansion_refuses_source_truncation_during_copy_without_replacing_inputs(
    tmp_path, monkeypatch
):
    source, output, directory = tmp_path / "source.pgn", tmp_path / "output", tmp_path / "authoring"
    with source.open("w") as stream:
        for index in range(3):
            game = chess.pgn.Game()
            game.headers.update(
                Event="Rated Blitz game",
                WhiteElo="2400",
                BlackElo="2500",
                LichessURL=f"https://lichess.org/{index}",
            )
            game.add_line([chess.Move.from_uci("e2e4"), chess.Move.from_uci("e7e5")])
            print(game, file=stream, end="\n\n")
    export_assets(output, [], [ordinary_record()], {"source_puzzles": "fixture.csv"})
    directory.mkdir()
    (directory / "manifest.json").write_text("{}")
    (directory / "games.pgn").write_bytes(b"previous games")
    (directory / "positions.json").write_bytes(b"previous positions")
    previous = {path: path.read_bytes() for path in directory.iterdir()}
    original_open, binary_opens = Path.open, 0

    class ChangingStream:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.stream.close()

        def seek(self, *args):
            return self.stream.seek(*args)

        def read(self, *args):
            content = self.stream.read(*args)
            source.write_bytes(b"")
            return content

    def changed_open(path, mode="r", *args, **kwargs):
        nonlocal binary_opens
        stream = original_open(path, mode, *args, **kwargs)
        if path == source and mode == "rb":
            binary_opens += 1
            if binary_opens == 2:  # First read hashes; second copies sampled spans.
                return ChangingStream(stream)
        return stream

    monkeypatch.setattr(Path, "open", changed_open)
    with pytest.raises(ValueError, match="PGN (changed|truncated)"):
        prepare_games(source, directory, output, count=2)
    assert all(path.read_bytes() == raw for path, raw in previous.items())
    assert not list(directory.glob(".games-*.pgn.tmp"))


def test_full_import_accepts_every_safe_integer_rating_including_negative_values(tmp_path):
    source, index, output = tmp_path / "source.csv", tmp_path / "index", tmp_path / "output"
    ratings = [-MAX_SAFE_INTEGER, -1400, -1, 0, 4001, MAX_SAFE_INTEGER]
    with source.open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=["PuzzleId", "FEN", "Moves", "Rating"])
        writer.writeheader()
        for number, rating in enumerate([*ratings, MAX_SAFE_INTEGER + 1]):
            writer.writerow(
                {
                    "PuzzleId": f"p{number}",
                    "FEN": chess.STARTING_FEN,
                    "Moves": "e2e4 e7e5",
                    "Rating": rating,
                }
            )
    stats = build_index(source, index)
    assert stats["retained"] == len(ratings)
    assert stats["invalid"] == 1
    assert stats["min_rating"] == -MAX_SAFE_INTEGER
    assert stats["max_rating"] == MAX_SAFE_INTEGER
    with sqlite3.connect(index) as database:
        actual = [row[0] for row in database.execute("SELECT rating FROM puzzles ORDER BY rating")]
        assert actual == ratings
    export_assets(output, [], [ordinary_record()], {})
    manifest = publish(index, output, "fixture.csv", stats)
    assert manifest["puzzles"]["rating_counts"] == [[rating, 1] for rating in ratings]
    assert [record["rating"] for record in read_group(output, manifest["puzzles"])] == ratings

import csv
import gzip
import json
import sqlite3

import chess
import chess.pgn

import export_static
from expand_corpus import prepare_games
from export_static import evaluate, export_assets, grade_position, seed_published_grades
from import_puzzles import build_index, publish, read_group
from tests.test_export import FakeEngine


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
    manifest = publish(index, output, "fixture.csv", stats, shard_size=2)
    assert manifest["schema"] == 2
    assert manifest["puzzles"]["count"] == 3
    assert [s["rating"] for s in manifest["puzzles"]["shards"]] == [399, 2400, 3323]
    assert list(read_group(output, manifest["ordinary"])) == [position]
    for shard in manifest["puzzles"]["shards"]:
        records = json.loads(gzip.decompress((output / shard["file"]).read_bytes()))
        assert all(p["rating"] == shard["rating"] for p in records)
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

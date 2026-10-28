import gzip
import json
from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import MagicMock

import chess
import pytest

import export_static
from engine import Line
from export_static import candidates, evaluate, export_assets, grade_position
from training_assets import read_inventory


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.scores = {"e7e5": 20, "c7c5": -30}

    def analyse(self, board, *, move=None):
        self.calls.append(move.uci())
        score = self.scores.get(move.uci(), -200)
        return [
            Line(
                (move.uci(),),
                score if isinstance(score, int) else None,
                int(score[1:]) if isinstance(score, str) else None,
            )
        ]

    def ordinary(self, board):
        return None


@pytest.fixture
def source():
    return {
        "id": "fixture",
        "fen": chess.STARTING_FEN,
        "moves": ["e2e4"],
        "url": "https://lichess.org/fixture#1",
    }


def test_searches_every_legal_root_independently_and_ignores_old_multipv(source):
    engine = FakeEngine()
    source["lines"] = [{"moves": ["b8c6"], "cp": 500}]
    record = grade_position(source, engine)
    board = chess.Board(source["fen"])
    board.push_uci("e2e4")
    assert set(record["scores"]) == {move.uci() for move in board.legal_moves}
    assert len(engine.calls) == board.legal_moves.count()
    assert record["best_cp"] == 20
    assert record["line"] == ["e7e5"]
    assert record["scores"]["c7c5"] == -30  # Exactly 50 CP is accepted.


@pytest.mark.parametrize(
    "changes",
    [
        {"c7c5": -31},
        {"f7f6": "M3"},
        {"e7e5": 501, "c7c5": 500},
    ],
)
def test_refilters_against_finished_table(source, changes):
    engine = FakeEngine()
    engine.scores.update(changes)
    assert grade_position(source, engine) is None


def test_new_best_move_updates_baseline_and_review(source):
    engine = FakeEngine()
    engine.scores.update({"f7f6": 60, "e7e5": 20})
    record = grade_position(source, engine)
    assert record["best_cp"] == 60
    assert record["line"] == ["f7f6"]
    engine.scores["f7f6"] = 100
    assert grade_position(source, engine) is None  # Only one move now lies within 50 CP.


def test_losing_mate_is_a_bad_move_not_a_cp_score(source):
    engine = FakeEngine()
    engine.scores["f7f6"] = "M-3"
    assert grade_position(source, engine)["scores"]["f7f6"] == "M-3"


def test_checkpoints_resume_and_invalidate_on_engine_budget_or_input_change(
    source, tmp_path, monkeypatch
):
    engine = FakeEngine()
    monkeypatch.setattr(export_static, "_WORKER_ENGINE", engine)
    config = {"engine": "Fixture", "nodes": 100000, "version": 1}
    first = evaluate(source, config, str(tmp_path))
    assert first["cached"] is False
    engine.calls.clear()
    second = evaluate(source, config, str(tmp_path))
    assert second["cached"] is True
    assert second["record"] == first["record"]
    assert engine.calls == []
    assert evaluate(source, {**config, "nodes": 200000}, str(tmp_path))["cached"] is False
    assert (
        evaluate({**source, "url": "https://lichess.org/new#1"}, config, str(tmp_path))["cached"]
        is False
    )
    assert len(list(tmp_path.glob("*.json"))) == 3


def test_corrupt_checkpoint_is_recomputed(source, tmp_path, monkeypatch):
    engine = FakeEngine()
    monkeypatch.setattr(export_static, "_WORKER_ENGINE", engine)
    evaluate(source, {}, str(tmp_path))
    path = next(tmp_path.glob("*.json"))
    path.write_text("truncated JSON")
    engine.calls.clear()
    assert evaluate(source, {}, str(tmp_path))["cached"] is False
    assert len(engine.calls) == 20
    assert json.loads(path.read_text())["record"] is not None


def test_rejected_candidates_are_also_checkpointed(source, tmp_path, monkeypatch):
    engine = FakeEngine()
    engine.scores["c7c5"] = -31
    monkeypatch.setattr(export_static, "_WORKER_ENGINE", engine)
    assert evaluate(source, {}, str(tmp_path))["record"] is None
    engine.calls.clear()
    assert evaluate(source, {}, str(tmp_path))["cached"] is True
    assert not engine.calls


def test_shards_are_deterministic_hashed_and_exactly_indexed(source, tmp_path):
    puzzles = [
        {**source, "id": str(rating), "moves": ["e2e4", "e7e5"], "rating": rating}
        for rating in (1400, 1700, 2000)
    ]
    positions = [grade_position(source, FakeEngine())]
    metadata = {"engine": "Fixture", "nodes": 100000, "sampled_games": 2000}
    first = export_assets(tmp_path, puzzles, positions, metadata)
    assert first["schema"] == 3
    assert first["puzzles"]["count"] == 3
    assert first["puzzles"]["rating_counts"] == [[1400, 1], [1700, 1], [2000, 1]]
    inventory = read_inventory(tmp_path, first["puzzles"], "puzzles")
    base = tmp_path / "puzzles" / first["puzzles"]["version"]
    for shard in inventory["shards"]:
        records = json.loads(gzip.decompress((base / shard["path"]).read_bytes()))
        assert len(records) == shard["count"]
    assert first == export_assets(tmp_path, puzzles, positions, metadata)
    orphan = tmp_path / "old.json.gz"
    orphan.write_bytes(b"old")
    export_assets(tmp_path, puzzles, positions, metadata)
    assert orphan.read_bytes() == b"old"  # Published files are never garbage-collected.
    assert json.loads((tmp_path / "manifest.json").read_text()) == first


def test_backup_candidates_use_unused_real_games_only(source, tmp_path):
    game = chess.pgn.Game()
    game.headers.update(
        Event="Rated Blitz game",
        LichessURL="https://lichess.org/backup",
        WhiteElo="2400",
        BlackElo="2500",
    )
    board = game.board()
    # Repeat a legal knight cycle to supply enough plies for the sampling window.
    moves = []
    for uci in ["g1f3", "g8f6", "f3g1", "f6g8"] * 6:
        move = board.parse_uci(uci)
        board.push(move)
        moves.append(move)
    game.add_line(moves)
    (tmp_path / "games.pgn").write_text(str(game) + "\n\n")
    output = list(candidates(tmp_path, [source], 42))
    assert output[0] == source
    assert len(output) == 5
    assert all(item["url"].startswith("https://lichess.org/backup#") for item in output[1:])
    assert list(candidates(tmp_path, [{**source, "url": "https://lichess.org/backup#1"}], 42)) == [
        {**source, "url": "https://lichess.org/backup#1"}
    ]
    first_game = str(game)
    game.headers["LichessURL"] = "https://lichess.org/backup2"
    (tmp_path / "games.pgn").write_text(first_game + "\n\n" + str(game) + "\n\n")
    output = list(candidates(tmp_path, [source], 42))
    assert len(output) == 9
    assert output[1]["url"].split("#")[0] == "https://lichess.org/backup"
    assert output[2]["url"].split("#")[0] == "https://lichess.org/backup2"


def test_insufficient_qualified_pool_keeps_previous_public_assets(source, tmp_path, monkeypatch):
    output = tmp_path / "public"
    output.mkdir()
    marker = output / "manifest.json"
    marker.write_text('"previous dataset"')
    for name, value in {
        "manifest": {"nodes": 100000, "seed": 42, "min_rating": 1800},
        "positions": [source],
        "puzzles": [{**source, "moves": ["d2d4", "d7d5"], "rating": 1700}],
    }.items():
        (tmp_path / f"{name}.json").write_text(json.dumps(value))
    result = Future()
    result.set_result({"record": grade_position(source, FakeEngine()), "cached": False})
    pool = MagicMock()
    pool.__enter__.return_value = pool
    pool.submit.return_value = result
    monkeypatch.setattr(export_static, "ProcessPoolExecutor", lambda *args, **kwargs: pool)
    monkeypatch.setattr(
        export_static, "Engine", lambda _: SimpleNamespace(name="Fixture", close=lambda: None)
    )
    monkeypatch.setattr(
        "sys.argv",
        [
            "export_static.py",
            "--data-dir",
            str(tmp_path),
            "--output",
            str(output),
            "--positions",
            "2",
            "--workers",
            "1",
        ],
    )
    with pytest.raises(ValueError, match="Only 1/2"):
        export_static.main()
    assert marker.read_text() == '"previous dataset"'
    assert list(output.iterdir()) == [marker]


def test_failed_export_does_not_replace_public_assets(tmp_path, monkeypatch):
    # Configuration errors fail before any output files are written.
    output = tmp_path / "public"
    output.mkdir()
    marker = output / "manifest.json"
    marker.write_text('"previous dataset"')
    monkeypatch.setattr(
        "sys.argv", ["export_static.py", "--data-dir", str(tmp_path), "--output", str(output)]
    )
    with pytest.raises(FileNotFoundError):
        export_static.main()
    assert marker.read_text() == '"previous dataset"'

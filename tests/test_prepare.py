import csv
import json
import random
from pathlib import Path
from types import SimpleNamespace

import chess
import chess.pgn
import pytest

from engine import Line
from prepare import position_key, reservoir_add, sample_games, sample_positions, sample_puzzles


def test_reservoir_is_reproducible_and_not_a_prefix():
    def sample(seed):
        result = []
        rng = random.Random(seed)
        for index in range(10_000):
            reservoir_add(result, index, index + 1, 20, rng)
        return result

    assert sample(42) == sample(42)
    assert len(sample(42)) == 20
    assert max(sample(42)) > 9000
    assert sample(42) != sample(43)


def test_game_sampling_requires_both_ratings(tmp_path):
    path = tmp_path / "games.pgn"
    with path.open("w") as out:
        for white, black in [(1799, 2500), (2500, 1799), (1800, 2000), (2200, 2400)]:
            game = chess.pgn.Game()
            game.headers.update(Event="Rated Blitz game", WhiteElo=str(white), BlackElo=str(black))
            game.add_line([chess.Move.from_uci("e2e4"), chess.Move.from_uci("e7e5")])
            print(game, file=out, end="\n\n")
    games, eligible = sample_games(path, 2, 1800, random.Random(1))
    assert eligible == 2
    assert len(games) == 2
    assert all(min(int(g.headers["WhiteElo"]), int(g.headers["BlackElo"])) >= 1800 for g in games)
    with pytest.raises(ValueError, match="qualifying games"):
        sample_games(path, 3, 1800, random.Random(1))


def test_puzzle_import_and_quality_filter(tmp_path):
    path = tmp_path / "puzzles.csv"
    fields = ["PuzzleId", "FEN", "Moves", "Rating", "Popularity", "NbPlays", "GameUrl", "Themes"]
    with path.open("w") as out:
        writer = csv.DictWriter(out, fieldnames=fields)
        writer.writeheader()
        for index in range(20):
            writer.writerow(
                {
                    "PuzzleId": str(index),
                    "FEN": chess.STARTING_FEN,
                    "Moves": "e2e4 e7e5",
                    "Rating": 1500 + index,
                    "Popularity": -1 if index < 10 else 90,
                    "NbPlays": 200,
                    "GameUrl": "https://lichess.org/example#1",
                    "Themes": "test",
                }
            )
    puzzles, eligible = sample_puzzles(path, 5, random.Random(1))
    assert eligible == 10
    assert len(puzzles) == 5
    assert all(int(puzzle["id"]) >= 10 for puzzle in puzzles)


def test_elite_lichess_url_is_not_shadowed_by_default_site_header():
    game = chess.pgn.Game()
    game.headers.update(LichessURL="https://lichess.org/testgame", WhiteElo="2400", BlackElo="2500")
    assert game.headers["Site"] == "?"
    game.add_line([chess.Move.from_uci("e2e4")])
    engine = SimpleNamespace(
        ordinary=lambda board: [Line(("e7e5",), 0, None), Line(("c7c5",), -10, None)]
    )
    args = SimpleNamespace(min_ply=1, max_ply=1, positions=1)
    positions = sample_positions([game], [], args, random.Random(1), engine)
    assert positions[0]["url"] == "https://lichess.org/testgame#1"


def test_prepared_real_data_integrity():
    data = Path(__file__).resolve().parents[1] / "data"
    if not (data / "manifest.json").exists():
        pytest.skip("Run prepare.py for real-data integration checks")
    manifest = json.loads((data / "manifest.json").read_text())
    puzzles = json.loads((data / "puzzles.json").read_text())
    positions = json.loads((data / "positions.json").read_text())
    # Default MVP dataset, not the small artificial fixtures used by mechanics tests.
    assert manifest["sampled_games"] >= 1000
    assert len(positions) >= 1000
    assert len(puzzles) >= 1000
    game_count = 0
    with (data / "games.pgn").open() as source:
        while (headers := chess.pgn.read_headers(source)) is not None:
            assert min(int(headers["WhiteElo"]), int(headers["BlackElo"])) >= 1800
            game_count += 1
    assert game_count == manifest["sampled_games"]
    keys = set()
    games = set()
    for position in positions:
        assert min(position["white_rating"], position["black_rating"]) >= 1800
        board = chess.Board(position["fen"])
        board.push_uci(position["moves"][0])
        assert position_key(board) not in keys
        keys.add(position_key(board))
        games.add(position["url"].split("#")[0])
        first, second = position["lines"]
        assert first["cp"] is not None and second["cp"] is not None
        assert 0 <= first["cp"] - second["cp"] <= 50
        assert abs(first["cp"]) <= 500
        assert first["moves"][0] != second["moves"][0]
        for line in position["lines"]:
            variation = board.copy()
            for move in line["moves"]:
                variation.push_uci(move)
    assert len(games) == len(positions)  # At most one ordinary position per game.
    for puzzle in puzzles:
        board = chess.Board(puzzle["fen"])
        board.push_uci(puzzle["moves"][0])
        assert position_key(board) not in keys
        for move in puzzle["moves"][1:]:
            board.push_uci(move)

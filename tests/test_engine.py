import shutil

import chess
import pytest

from engine import Engine, Line, find_stockfish


@pytest.mark.parametrize(
    "cp1,cp2,expected",
    [
        (0, -50, True),
        (0, -51, False),
        (501, 500, False),
        (-501, -510, False),
        (0, 50, True),
        (0, 51, False),
        (0, 216, False),
    ],
)
def test_ordinary_filter_boundary(cp1, cp2, expected):
    engine = object.__new__(Engine)
    engine.analyse = lambda *args, **kwargs: [
        Line(("e2e4",), cp1, None),
        Line(("d2d4",), cp2, None),
    ]
    lines = engine.ordinary(chess.Board())
    assert bool(lines) is expected
    if lines:
        assert lines[0].cp >= lines[1].cp


def test_ordinary_rejects_mate_and_terminal_positions():
    engine = object.__new__(Engine)
    engine.analyse = lambda *args, **kwargs: [
        Line(("e2e4",), None, 4),
        Line(("d2d4",), 0, None),
    ]
    assert engine.ordinary(chess.Board()) is None
    assert engine.ordinary(chess.Board("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1")) is None


def test_real_stockfish_root_restricted_analysis():
    try:
        find_stockfish()
    except RuntimeError:
        pytest.skip("Stockfish not installed")
    engine = Engine()
    try:
        board = chess.Board()
        board.push_uci("e2e4")
        lines = engine.ordinary(board)
        assert lines is not None
        assert len(lines) == 2
        bad = engine.analyse(board, move=chess.Move.from_uci("f7f6"))[0]
        assert bad.moves[0] == "f7f6"
        assert bad.cp is not None and bad.cp < lines[0].cp - 50
    finally:
        engine.close()


def test_bad_stockfish_configuration(monkeypatch):
    monkeypatch.setenv("STOCKFISH", "/definitely/missing/stockfish")
    with pytest.raises(RuntimeError, match="STOCKFISH"):
        find_stockfish()
    monkeypatch.delenv("STOCKFISH")
    monkeypatch.setattr(shutil, "which", lambda _: None)
    with pytest.raises(RuntimeError, match="Install Stockfish"):
        find_stockfish()

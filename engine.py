"""Small Stockfish adapter for offline sampling, full grading, and benchmarking."""

import os
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path

import chess
import chess.engine

DEFAULT_NODES = 100_000
TOLERANCE_CP = 50


def find_stockfish() -> str:
    configured = os.environ.get("STOCKFISH")
    if configured:
        path = shutil.which(configured) or str(Path(configured).expanduser())
        if Path(path).is_file():
            return path
        raise RuntimeError(f"STOCKFISH does not point to an executable: {configured}")
    for candidate in ("stockfish", "/opt/homebrew/bin/stockfish", "/usr/games/stockfish"):
        path = shutil.which(candidate)
        if path:
            return path
    raise RuntimeError(
        "Install Stockfish (brew/apt install stockfish), or set STOCKFISH=/path/to/it."
    )


@dataclass(frozen=True)
class Line:
    moves: tuple[str, ...]
    cp: int | None
    mate: int | None

    def json(self) -> dict:
        return {"moves": list(self.moves), "cp": self.cp, "mate": self.mate}


class Engine:
    def __init__(self, nodes: int = DEFAULT_NODES):
        self.nodes = nodes
        self.lock = threading.Lock()
        self.process = chess.engine.SimpleEngine.popen_uci(find_stockfish(), timeout=20)
        self.process.configure({"Threads": 1, "Hash": 64})
        self.name = self.process.id.get("name", "Stockfish")

    def close(self) -> None:
        with self.lock:
            self.process.quit()

    def analyse(
        self, board: chess.Board, *, multipv: int = 1, move: chess.Move | None = None
    ) -> list[Line]:
        with self.lock:
            # New game + cleared hash make an item's grading independent of previous users/searches.
            self.process.configure({"Clear Hash": None})
            result = self.process.analyse(
                board,
                chess.engine.Limit(nodes=self.nodes),
                multipv=multipv,
                root_moves=[move] if move else None,
                game=object(),
            )
        lines = []
        for info in result:
            score = info["score"].pov(board.turn)
            lines.append(
                Line(tuple(m.uci() for m in info.get("pv", [])), score.score(), score.mate())
            )
        return lines

    def ordinary(self, board: chess.Board) -> list[Line] | None:
        if board.is_game_over(claim_draw=True) or board.legal_moves.count() < 2:
            return None
        lines = self.analyse(board, multipv=2)
        if len(lines) < 2 or any(line.cp is None or not line.moves for line in lines):
            return None
        # A node cutoff can leave different PVs at different iterative-deepening depths.
        lines.sort(key=lambda line: line.cp, reverse=True)
        best, second = lines
        if abs(best.cp) > 500 or best.cp - second.cp > TOLERANCE_CP:
            return None
        return lines

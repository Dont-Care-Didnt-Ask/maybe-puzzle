"""Measure filtering and full move grading, without changing prepared training data.

Run: uv run python benchmark.py --games 50 --grade-positions 8
Reports one-thread, warm-engine throughput; excludes archive download/scanning.
"""

import argparse
import gzip
import json
import random
import statistics
import time
from pathlib import Path

import chess
import chess.pgn

from engine import DEFAULT_NODES, Engine


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games-pgn", type=Path, default=Path(__file__).parent / "data/games.pgn")
    parser.add_argument("--games", type=int, default=50)
    parser.add_argument("--grade-positions", type=int, default=8)
    parser.add_argument("--nodes", type=int, default=DEFAULT_NODES)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if min(args.games, args.grade_positions, args.nodes) <= 0:
        parser.error("Counts and node budget must be positive.")
    rng = random.Random(args.seed)
    games = []
    with args.games_pgn.open(encoding="utf-8-sig") as source:
        while len(games) < args.games and (game := chess.pgn.read_game(source)) is not None:
            games.append(game)
    if len(games) < args.games:
        parser.error(f"Only {len(games)} games in {args.games_pgn}.")

    engine = Engine(args.nodes)
    try:
        # These are already shuffled games from prepare.py's random source-game sample.
        accepted = []
        searches = 0
        started = time.perf_counter()
        for game in games:
            moves = list(game.mainline_moves())
            plies = list(range(20, min(len(moves), 160) + 1))
            rng.shuffle(plies)
            for ply in plies[:4]:
                board = game.board()
                for move in moves[: ply - 1]:
                    board.push(move)
                before = board.fen()
                setup = moves[ply - 1].uci()
                board.push_uci(setup)
                board = chess.Board(board.fen())
                searches += 1
                lines = engine.ordinary(board)
                if lines:
                    accepted.append((before, setup, board, lines))
                    break
        filter_seconds = time.perf_counter() - started
        if not accepted:
            raise RuntimeError("No ordinary positions retained in benchmark sample.")

        records, durations, move_counts = [], [], []
        for before, setup, board, lines in accepted[: args.grade_positions]:
            started = time.perf_counter()
            scores = {}
            for move in board.legal_moves:
                cached = next((line for line in lines if line.moves[0] == move.uci()), None)
                line = cached or engine.analyse(board, move=move)[0]
                scores[move.uci()] = line.cp if line.cp is not None else f"M{line.mate}"
            durations.append(time.perf_counter() - started)
            move_counts.append(len(scores))
            # Prototype payload for a static export; not a new training-data schema.
            records.append(
                {
                    "fen": before,
                    "moves": [setup],
                    "scores": scores,
                    "line": list(lines[0].moves[:12]),
                    "url": "https://lichess.org/example0#40",
                }
            )
        raw = json.dumps(records, separators=(",", ":")).encode()
        grade_seconds = sum(durations)
        per_position = filter_seconds / len(accepted) + statistics.mean(durations)
        report = {
            "engine": engine.name,
            "nodes_per_search": engine.nodes,
            "threads": 1,
            "sample_games": len(games),
            "filter_search_attempts": searches,
            "retained_positions": len(accepted),
            "filter_seconds": round(filter_seconds, 3),
            "filter_games_per_hour": round(len(games) * 3600 / filter_seconds),
            "filter_retained_positions_per_hour": round(len(accepted) * 3600 / filter_seconds),
            "fully_graded_positions": len(records),
            "mean_legal_moves": round(statistics.mean(move_counts), 1),
            "full_grade_seconds": round(grade_seconds, 3),
            "full_grade_seconds_per_position": round(statistics.mean(durations), 3),
            "full_grade_positions_per_hour": round(len(records) * 3600 / grade_seconds),
            "combined_retained_and_fully_graded_positions_per_hour": round(3600 / per_position),
            "prototype_json_bytes_per_position": round(len(raw) / len(records)),
            "prototype_gzip_bytes_per_position": round(
                len(gzip.compress(raw, mtime=0)) / len(records)
            ),
            "notes": (
                "Small warm-engine sample, one position/game, not every ply; "
                "excludes I/O scanning. Two prepared move scores reused; "
                "all other legal moves searched independently. "
                "Payload is a size estimate, not a production schema or an export."
            ),
        }
        print(json.dumps(report, indent=2))
    finally:
        engine.close()


if __name__ == "__main__":
    main()

"""Grade every legal move offline and publish small static training shards.

uv run python export_static.py --workers 3 --positions 1000
Safe to interrupt: successful evaluations and rejections are checkpointed per candidate.
"""

import argparse
import gzip
import hashlib
import json
import os
import random
import signal
import sys
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import UTC, datetime
from pathlib import Path

import chess
import chess.pgn

from engine import Engine
from prepare import ROOT, position_key, save_json

VERSION = 1
_WORKER_ENGINE = None


def encoded(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def digest(value) -> str:
    return hashlib.sha256(encoded(value)).hexdigest()


def init_worker(nodes: int):
    global _WORKER_ENGINE
    _WORKER_ENGINE = Engine(nodes)
    # multiprocessing workers exit without ordinary atexit handlers; use its finalizer.
    from multiprocessing.util import Finalize

    Finalize(_WORKER_ENGINE, _WORKER_ENGINE.close, exitpriority=10)


def grade_position(source: dict, engine: Engine) -> dict | None:
    before = chess.Board(source["fen"])
    if not before.is_valid():
        raise ValueError("Invalid candidate FEN")
    before.push_uci(source["moves"][0])
    board = chess.Board(before.fen())
    if board.is_game_over(claim_draw=True) or board.legal_moves.count() < 2:
        return None
    if source.get("prefilter") and engine.ordinary(board) is None:
        return None
    scores, variations = {}, {}
    for move in sorted(board.legal_moves, key=lambda candidate: candidate.uci()):
        line = engine.analyse(board, move=move)[0]
        if line.cp is None and line.mate is None:
            raise ValueError("Engine did not report a score")
        scores[move.uci()] = line.cp if line.cp is not None else f"M{line.mate}"
        variations[move.uci()] = list(line.moves) or [move.uci()]
    # Positive mates are forced wins, negative mates are losing choices, not CP values.
    if any(isinstance(score, str) and int(score[1:]) > 0 for score in scores.values()):
        return None
    ranked = sorted(
        ((score, move) for move, score in scores.items() if isinstance(score, int)),
        reverse=True,
    )
    if len(ranked) < 2:
        return None
    best, best_move = ranked[0]
    if abs(best) > 500 or best - ranked[1][0] > 50:
        return None
    line = variations[best_move][:12]
    if line[0] != best_move:
        raise ValueError("Engine PV does not start with its root move")
    variation = board.copy()
    for uci in line:
        variation.push_uci(uci)
    return {
        "id": source["id"],
        "fen": source["fen"],
        "moves": source["moves"],
        "scores": scores,
        "best_cp": best,
        "line": line,
        "url": source.get("url", ""),
    }


def evaluate(source: dict, config: dict, checkpoint_dir: str) -> dict:
    fingerprint = digest({"config": config, "source": source})
    path = Path(checkpoint_dir) / f"{fingerprint}.json"
    if path.exists():
        try:
            cached = json.loads(path.read_text())
        except ValueError:
            cached = {}  # Repair a corrupt local checkpoint by recomputing this candidate.
        if (
            isinstance(cached, dict)
            and cached.get("fingerprint") == fingerprint
            and "record" in cached
        ):
            return {**cached, "cached": True}
    record = grade_position(source, _WORKER_ENGINE)
    result = {"fingerprint": fingerprint, "record": record}
    save_json(path, result)
    return {**result, "cached": False}


def candidates(
    directory: Path, positions: list, seed: int, min_rating=1800, min_ply=20, max_ply=160
):
    used_games = {p.get("url", "").split("#")[0] for p in positions}
    for position in positions:
        yield {key: position[key] for key in ("id", "fen", "moves", "url")}
    # Final all-move scoring rejects some previously ordinary positions. Refill from
    # unused games in the original sampled corpus, not invented or repeated games.
    rng = random.Random(seed)
    path = directory / "games.pgn"
    if not path.exists():
        return
    deferred = []
    with path.open(encoding="utf-8-sig") as stream:
        while (game := chess.pgn.read_game(stream)) is not None:
            url = game.headers.get("LichessURL") or game.headers.get("Site", "")
            try:
                rating = min(int(game.headers["WhiteElo"]), int(game.headers["BlackElo"]))
            except (KeyError, ValueError):
                continue
            if (
                game.errors
                or rating < min_rating
                or game.headers.get("Variant", "Standard") != "Standard"
            ):
                continue
            if "Rated" not in game.headers.get("Event", ""):
                continue
            if not url.startswith("https://lichess.org/") or url in used_games:
                continue
            moves = list(game.mainline_moves())
            plies = list(range(min_ply, min(len(moves), max_ply) + 1))
            rng.shuffle(plies)
            for index, ply in enumerate(plies[:4]):
                board = game.board()
                for move in moves[: ply - 1]:
                    board.push(move)
                fen = board.fen()
                board.push(moves[ply - 1])
                candidate = {
                    "id": hashlib.sha256(position_key(board).encode()).hexdigest()[:16],
                    "fen": fen,
                    "moves": [moves[ply - 1].uci()],
                    "url": f"{url.split('#')[0]}#{ply}",
                    "prefilter": True,
                }
                if index:
                    deferred.append(candidate)
                else:
                    yield candidate
    yield from deferred


def export_assets(output: Path, puzzles: list, positions: list, metadata: dict, shard_size=64):
    """Write hashed shards before the manifest. Old versions are safe to clean afterward."""
    output.mkdir(parents=True, exist_ok=True)
    referenced = set()

    def shards(records, prefix, ratings=False):
        result = []
        for offset in range(0, len(records), shard_size):
            batch = records[offset : offset + shard_size]
            content = gzip.compress(encoded(batch), mtime=0)
            name = f"{prefix}-{hashlib.sha256(content).hexdigest()[:20]}.json.gz"
            path = output / name
            if not path.exists():
                temporary = path.with_suffix(".tmp")
                temporary.write_bytes(content)
                temporary.replace(path)
            referenced.add(name)
            entry = {"file": name, "count": len(batch)}
            if ratings:
                entry["ratings"] = [p["rating"] for p in batch]
            result.append(entry)
        return {"count": len(records), "shards": result}

    manifest = {
        "schema": 1,
        "tolerance_cp": 50,
        **metadata,
        "puzzles": shards(puzzles, "p", ratings=True),
        "ordinary": shards(positions, "n"),
    }
    manifest["dataset_id"] = digest(manifest)[:20]
    save_json(output / "manifest.json", manifest)
    for path in output.glob("*.json.gz"):
        if path.name not in referenced:
            path.unlink()
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--output", type=Path, default=ROOT / "public/training")
    parser.add_argument("--workers", type=int, default=min(3, os.cpu_count() or 1))
    parser.add_argument("--positions", type=int, default=1000)
    parser.add_argument("--nodes", type=int, help="Default: source preparation budget")
    parser.add_argument("--shard-size", type=int, default=64)
    args = parser.parse_args()
    if min(args.workers, args.positions, args.shard_size) <= 0:
        parser.error("workers, positions, and shard-size must be positive")
    directory = args.data_dir.resolve()
    metadata = json.loads((directory / "manifest.json").read_text())
    source_positions = json.loads((directory / "positions.json").read_text())
    source_puzzles = json.loads((directory / "puzzles.json").read_text())
    puzzles = [
        {key: p[key] for key in ("id", "fen", "moves", "rating", "url")} for p in source_puzzles
    ]
    puzzle_keys = set()
    for puzzle in puzzles:
        board = chess.Board(puzzle["fen"])
        board.push_uci(puzzle["moves"][0])
        puzzle_keys.add(position_key(board))
        for uci in puzzle["moves"][1:]:
            board.push_uci(uci)
    nodes = args.nodes if args.nodes is not None else metadata["nodes"]
    if nodes <= 0:
        parser.error("nodes must be positive")
    probe = Engine(nodes)
    engine_name = probe.name
    probe.close()
    config = {"version": VERSION, "nodes": nodes, "engine": engine_name, "tolerance_cp": 50}
    checkpoints = directory / "static-checkpoints"
    checkpoints.mkdir(exist_ok=True)
    accepted, used_games, used_keys = [], set(), set(puzzle_keys)
    source = iter(
        candidates(
            directory,
            source_positions,
            metadata["seed"],
            metadata["min_rating"],
            metadata.get("min_ply", 20),
            metadata.get("max_ply", 160),
        )
    )
    pending, exhausted, checked, cached_count = {}, False, 0, 0
    print(
        f"Grading for {args.positions} ordinary positions; {args.workers} workers, "
        f"{nodes:,} nodes/root, {engine_name}. Checkpoints: {checkpoints}",
        flush=True,
    )
    with ProcessPoolExecutor(args.workers, initializer=init_worker, initargs=(nodes,)) as pool:
        while len(accepted) < args.positions:
            while len(pending) < args.workers and not exhausted:
                item = next(source, None)
                if item is None:
                    exhausted = True
                    break
                game_id = item.get("url", "").split("#")[0]
                if game_id and game_id in used_games:
                    continue
                future = pool.submit(evaluate, item, config, str(checkpoints))
                pending[future] = item
            if not pending:
                break
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                item = pending.pop(future)
                result = future.result()  # Do not publish an incomplete/failed run.
                checked += 1
                cached_count += int(result["cached"])
                record = result["record"]
                if record and len(accepted) < args.positions:
                    board = chess.Board(record["fen"])
                    board.push_uci(record["moves"][0])
                    key = position_key(board)
                    game_id = record["url"].split("#")[0]
                    if key not in used_keys and (not game_id or game_id not in used_games):
                        accepted.append(record)
                        used_keys.add(key)
                        if game_id:
                            used_games.add(game_id)
                if checked % 20 == 0 or len(accepted) == args.positions:
                    print(
                        f"Checked {checked}, cached {cached_count}; "
                        f"accepted {len(accepted)}/{args.positions}",
                        flush=True,
                    )
        for future in pending:
            future.cancel()
    if len(accepted) < args.positions:
        raise ValueError(
            f"Only {len(accepted)}/{args.positions} fully qualified ordinary positions. "
            "Prepare more source games/positions or lower --positions. "
            "Checkpoints were saved; public assets were not changed."
        )
    accepted.sort(key=lambda record: record["id"])
    manifest = export_assets(
        args.output.resolve(),
        puzzles,
        accepted,
        {
            "engine": engine_name,
            "nodes": nodes,
            "sampled_games": metadata["sampled_games"],
            "min_rating": metadata["min_rating"],
            "prepared_at": datetime.now(UTC).isoformat(),
            "exporter_version": VERSION,
            "source_games": metadata["games_source"],
            "source_puzzles": metadata["puzzles_source"],
            "source_seed": metadata["seed"],
            "source_prepared_at": metadata["prepared_at"],
            "min_ply": metadata.get("min_ply", 20),
            "max_ply": metadata.get("max_ply", 160),
        },
        args.shard_size,
    )
    print(
        f"Published {manifest['puzzles']['count']} puzzles and "
        f"{manifest['ordinary']['count']} ordinary positions to {args.output}",
        flush=True,
    )


if __name__ == "__main__":
    # Background shells can inherit SIGINT=ignored; retain checkpoint-safe shutdown.
    for stop_signal in (signal.SIGINT, signal.SIGTERM):
        signal.signal(stop_signal, signal.default_int_handler)
    try:
        main()
    except KeyboardInterrupt:
        print("Interrupted. Re-run the same command to resume checkpoints.", file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Export failed: {exc}", file=sys.stderr)
        sys.exit(1)

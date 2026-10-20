"""Download/sample real Lichess data, then filter ordinary positions with Stockfish.

uv run python prepare.py
uv run python prepare.py --games-source my-games.pgn --puzzles-source puzzles.csv.zst
"""

import argparse
import bz2
import csv
import gzip
import hashlib
import io
import json
import random
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import chess
import chess.pgn
import zstandard

from engine import DEFAULT_NODES, Engine

ROOT = Path(__file__).resolve().parent
GAMES_URL = "https://database.nikonoel.fr/lichess_elite_2025-08.zip"
PUZZLES_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"


def save_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    temporary.replace(path)


def download(source: str, cache: Path) -> Path:
    if not source.startswith(("https://", "http://")):
        path = Path(source).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"Source not found: {path}")
        return path
    name = Path(urllib.parse.urlparse(source).path).name
    destination = cache / name
    if destination.is_file():
        print(f"Using cached {destination}", flush=True)
        return destination
    print(f"Downloading {source} → {destination}", flush=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(source, headers={"User-Agent": "chess-puzzle-not-puzzle/0.1"})
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as out:
        shutil.copyfileobj(response, out)
    temporary.replace(destination)
    return destination


@contextmanager
def text_source(path: Path):
    if path.suffix == ".zst":
        with path.open("rb") as raw:
            with zstandard.ZstdDecompressor().stream_reader(raw) as reader:
                with io.TextIOWrapper(reader, encoding="utf-8-sig") as text:
                    yield text
    else:
        opener = {".bz2": bz2.open, ".gz": gzip.open}.get(path.suffix, open)
        with opener(path, "rt", encoding="utf-8-sig") as text:
            yield text


def unpack_pgn(path: Path, cache: Path) -> Path:
    if path.suffix == ".pgn":
        return path
    output = cache / (path.stem + ".pgn")
    if output.exists() and output.stat().st_mtime >= path.stat().st_mtime:
        return output
    temporary = output.with_suffix(".pgn.part")
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            names = [name for name in archive.namelist() if name.lower().endswith(".pgn")]
            if len(names) != 1:
                raise ValueError("Expected exactly one PGN in the ZIP archive.")
            with archive.open(names[0]) as source, temporary.open("wb") as destination:
                shutil.copyfileobj(source, destination)
    else:
        with text_source(path) as source, temporary.open("w", encoding="utf-8") as destination:
            shutil.copyfileobj(source, destination)
    temporary.replace(output)
    return output


def reservoir_add(sample: list, item, seen: int, size: int, rng: random.Random) -> None:
    if len(sample) < size:
        sample.append(item)
    elif (index := rng.randrange(seen)) < size:
        sample[index] = item


def sample_puzzles(path: Path, count: int, rng: random.Random) -> tuple[list, int]:
    sample, seen = [], 0
    with text_source(path) as source:
        for row in csv.DictReader(source):
            try:
                # Use the archive's broad distribution, not a particular rating-band prefix.
                if int(row["Popularity"]) < 0 or int(row["NbPlays"]) < 100:
                    continue
                rating = int(row["Rating"])
                moves = row["Moves"].split()
                if len(moves) < 2:
                    continue
                item = {
                    "id": row["PuzzleId"],
                    "fen": row["FEN"],
                    "moves": moves,
                    "rating": rating,
                    "url": f"https://lichess.org/training/{row['PuzzleId']}",
                    "game_url": row["GameUrl"],
                    "themes": row["Themes"].split(),
                }
            except (KeyError, ValueError) as exc:
                raise ValueError("Unexpected Lichess puzzle CSV format.") from exc
            seen += 1
            reservoir_add(sample, item, seen, count, rng)
    valid = []
    for item in sample:
        try:
            board = chess.Board(item["fen"])
            if not board.is_valid():
                continue
            for uci in item["moves"]:
                board.push_uci(uci)
            valid.append(item)
        except ValueError:
            continue
    if len(valid) < count:
        raise ValueError(f"Only {len(valid)} valid sampled puzzles; requested {count}.")
    return valid, seen


def sample_games(path: Path, count: int, min_rating: int, rng: random.Random) -> tuple[list, int]:
    offsets, seen = [], 0
    with path.open(encoding="utf-8-sig") as source:
        while True:
            offset = source.tell()
            headers = chess.pgn.read_headers(source)
            if headers is None:
                break
            try:
                rating = min(int(headers.get("WhiteElo", "0")), int(headers.get("BlackElo", "0")))
            except ValueError:
                continue
            if rating < min_rating or headers.get("Variant", "Standard") != "Standard":
                continue
            if "Rated" not in headers.get("Event", ""):
                continue
            seen += 1
            reservoir_add(offsets, offset, seen, count, rng)
        if len(offsets) < count:
            raise ValueError(f"Only {len(offsets)} qualifying games; requested {count}.")
        games = []
        for offset in offsets:
            source.seek(offset)
            game = chess.pgn.read_game(source)
            if game is not None and not game.errors and not game.headers.is_chess960():
                games.append(game)
    if len(games) < count:
        raise ValueError(f"Only {len(games)} valid sampled standard games; requested {count}.")
    rng.shuffle(games)
    return games, seen


def position_key(board: chess.Board) -> str:
    return " ".join(board.fen().split()[:4])


def sample_positions(games: list, puzzles: list, args, rng: random.Random, engine: Engine) -> list:
    seen = set()
    for puzzle in puzzles:
        board = chess.Board(puzzle["fen"])
        board.push_uci(puzzle["moves"][0])
        seen.add(position_key(board))
    positions = []
    for index, game in enumerate(games):
        moves = list(game.mainline_moves())
        plies = list(range(args.min_ply, min(len(moves), args.max_ply) + 1))
        rng.shuffle(plies)
        for ply in plies[:4]:
            board = game.board()
            for move in moves[: ply - 1]:
                board.push(move)
            before = board.fen()
            setup = moves[ply - 1].uci()
            board.push(moves[ply - 1])
            key = position_key(board)
            if key in seen:
                continue
            # Store/grade a FEN, not hidden game history that the browser cannot reconstruct.
            lines = engine.ordinary(chess.Board(board.fen()))
            if lines is None:
                continue
            seen.add(key)
            site = game.headers.get("LichessURL") or game.headers.get("Site", "")
            positions.append(
                {
                    "id": hashlib.sha256(key.encode()).hexdigest()[:16],
                    "fen": before,
                    "moves": [setup],
                    "lines": [line.json() for line in lines],
                    "url": f"{site.split('#')[0]}#{ply}"
                    if site.startswith("https://lichess.org/")
                    else "",
                    "white_rating": int(game.headers["WhiteElo"]),
                    "black_rating": int(game.headers["BlackElo"]),
                    "ply": ply,
                }
            )
            break
        if (index + 1) % 50 == 0 or len(positions) == args.positions:
            print(
                f"Checked {index + 1}/{len(games)} sampled games; "
                f"retained {len(positions)}/{args.positions} ordinary positions",
                flush=True,
            )
        if len(positions) >= args.positions:
            return positions
    raise ValueError(
        f"Only {len(positions)} ordinary positions from {len(games)} games. "
        "Increase --games or lower --positions. Existing prepared data has not been replaced."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument(
        "--games-source", default=GAMES_URL, help="URL or local PGN/ZIP/PGN.zst path"
    )
    parser.add_argument(
        "--puzzles-source", default=PUZZLES_URL, help="URL or local CSV/CSV.zst path"
    )
    parser.add_argument("--games", type=int, default=2000)
    parser.add_argument("--positions", type=int, default=1000)
    parser.add_argument("--puzzles", type=int, default=10_000)
    parser.add_argument("--min-rating", type=int, default=1800)
    parser.add_argument("--min-ply", type=int, default=20)
    parser.add_argument("--max-ply", type=int, default=160)
    parser.add_argument("--nodes", type=int, default=DEFAULT_NODES)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()
    if not (0 < args.positions <= args.games and args.puzzles > 0 and args.nodes > 0):
        parser.error("Require 0 < positions <= games, puzzles > 0, and nodes > 0.")
    if not (1 <= args.min_ply <= args.max_ply):
        parser.error("Require 1 <= min-ply <= max-ply.")
    args.data_dir = args.data_dir.resolve()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    cache = args.data_dir / "cache"
    cache.mkdir(exist_ok=True)
    rng = random.Random(args.seed)
    engine = Engine(args.nodes)  # Fail before downloading if the engine is missing.
    try:
        puzzle_path = download(args.puzzles_source, cache)
        puzzles, eligible_puzzles = sample_puzzles(puzzle_path, args.puzzles, rng)
        print(f"Sampled {len(puzzles):,} of {eligible_puzzles:,} eligible puzzles", flush=True)
        game_path = unpack_pgn(download(args.games_source, cache), cache)
        games, eligible_games = sample_games(game_path, args.games, args.min_rating, rng)
        print(f"Sampled {len(games):,} of {eligible_games:,} qualifying games", flush=True)
        positions = sample_positions(games, puzzles, args, rng, engine)
        manifest = {
            "schema": 1,
            "prepared_at": datetime.now(UTC).isoformat(),
            "seed": args.seed,
            "games_source": args.games_source,
            "puzzles_source": args.puzzles_source,
            "eligible_games": eligible_games,
            "sampled_games": len(games),
            "eligible_puzzles": eligible_puzzles,
            "puzzles": len(puzzles),
            "ordinary_positions": len(positions),
            "min_rating": args.min_rating,
            "min_ply": args.min_ply,
            "max_ply": args.max_ply,
            "engine": engine.name,
            "nodes": args.nodes,
            "tolerance_cp": 50,
        }
        # Prepare off-line with the server stopped. Write the manifest last as the readiness marker.
        save_json(args.data_dir / "puzzles.json", puzzles)
        save_json(args.data_dir / "positions.json", positions)
        with (args.data_dir / "games.pgn.tmp").open("w", encoding="utf-8") as out:
            for game in games:
                print(game, file=out, end="\n\n")
        (args.data_dir / "games.pgn.tmp").replace(args.data_dir / "games.pgn")
        save_json(args.data_dir / "manifest.json", manifest)
        print(
            f"Ready: {len(puzzles):,} puzzles, {len(positions):,} ordinary positions.", flush=True
        )
    finally:
        engine.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, chess.engine.EngineError) as exc:
        print(f"Preparation failed: {exc}", file=sys.stderr)
        sys.exit(1)

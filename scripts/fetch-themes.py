"""Refresh vendored, freely redistributable Lichess piece assets (not a build step)."""

import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "public/themes"
REVISION = "aa97d4e2b760d0e74b1337a1fae9076e68830768"
SOURCE = f"https://raw.githubusercontent.com/lichess-org/lila/{REVISION}"


def fetch(item):
    source, name = item
    destination = ROOT / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["curl", "-fsSL", "--retry", "3", "--max-time", "45", source, "-o", str(destination)],
        check=True,
    )
    if destination.suffix == ".svg" and "<svg" not in destination.read_text():
        raise ValueError(f"Not an SVG: {destination}")
    print(destination.relative_to(ROOT), flush=True)


def main():
    assets = [
        (f"{SOURCE}/public/piece/{theme}/{color}{piece}.svg", f"pieces/{theme}/{color}{piece}.svg")
        for theme in ("merida", "chessnut")
        for color in "wb"
        for piece in "KQRBNP"
    ]
    assets += [
        (f"{SOURCE}/COPYING.md", "LICHESS-COPYING.md"),
        (
            "https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-2.0-or-later.txt",
            "GPL-2.0-or-later.txt",
        ),
        (
            "https://raw.githubusercontent.com/LexLuengas/chessnut-pieces/master/LICENSE.txt",
            "Apache-2.0.txt",
        ),
    ]
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(fetch, assets))


if __name__ == "__main__":
    main()

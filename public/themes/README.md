# Locally bundled board and piece themes

The default Brown board and Cburnett pieces remain the existing Chessground styles.
Blue, Green, and Grey are simple checkerboard color palettes implemented by this
application, not copies of Lichess's separately licensed board-image textures.

Additional piece SVGs are unmodified files from the public Lichess repository:

https://github.com/lichess-org/lila/tree/aa97d4e2b760d0e74b1337a1fae9076e68830768/public/piece

- `pieces/merida/`: Armando Hernandez Marroquin, **GPL-2.0-or-later**.
- `pieces/chessnut/`: Alexis Luengas, **Apache-2.0**.
  Upstream: https://github.com/LexLuengas/chessnut-pieces
- Existing Cburnett design: Colin M. L. Burnett, **GPL-2.0-or-later**;
  distributed via the GPL Chessground dependency.

See `LICHESS-COPYING.md` for the pinned upstream attribution/license table and
`GPL-2.0-or-later.txt` / `Apache-2.0.txt` for the full additional license texts.
Only the two additional freely redistributable piece sets above are vendored;
noncommercial/restricted sets in Lichess's catalog are intentionally not bundled.

To refresh reproducibly, run `uv run python scripts/fetch-themes.py` from the repo.
It is an optional author-side downloader, never part of build or runtime. Assets
are served from this site, including on repository subpaths, with no hotlinks.

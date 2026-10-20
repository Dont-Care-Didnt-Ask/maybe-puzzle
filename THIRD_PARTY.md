# Reused components and data

## Browser components

- **[Chessground](https://github.com/lichess-org/chessground)**, © Lichess contributors, GPL-3.0-or-later. Board interaction, brown board theme, and the bundled Cburnett piece stylesheet come from `@lichess-org/chessground`. Piece designs are by Colin M. L. Burnett.
- **[chess.js](https://github.com/jhlywa/chess.js)**, © 2025 Jeff Hlywa and contributors, BSD-2-Clause. Legal moves, FEN, notation, castling, en passant, promotions, and review-line playback.
- **[fflate](https://github.com/101arrowz/fflate)**, © 2026 Arjun Barrett, MIT. Portable gzip shard decoding in the browser and static source-ZIP generation during builds.

Exact versions are locked in `package-lock.json`. The build publishes `licenses.txt` with the project/component notices and full license texts. `source.zip` includes the application sources and these dependencies' available source/license files. Keep corresponding source available when distributing the GPL frontend.

## Offline authoring tools

- **[python-chess](https://github.com/niklasf/python-chess)**, © Niklas Fiekas and contributors, GPL-3.0-or-later. PGN sampling, legal-move enumeration, and UCI communication. Locked in `uv.lock`.
- **[Stockfish](https://stockfishchess.org/)**, © the Stockfish developers, GPL-3.0. Installed separately for local preparation. No native or WASM engine binary is bundled with the website. [Engine source](https://github.com/official-stockfish/Stockfish).
- **Vite, Playwright, pytest, Ruff, zstandard**, and transitive dependencies retain their respective licenses.

## Training data

[Lichess game and puzzle databases](https://database.lichess.org/) are released under **CC0**. The default game archive is the [Lichess Elite database maintained by Nikonoel and contributors](https://database.nikonoel.fr/), derived from the Lichess database and linked from its official downloads page. Its stronger rating/time-control prefilter is disclosed in the README and dataset provenance. Source links are shown after attempts.

The published static shards and offline engine evaluations contain no private/user-session information. The source ZIP includes published training assets, never raw archives or local grading checkpoints.

This is an independent project, not an official Lichess product. No Lichess accounts, credentials, private APIs, or hotlinked board assets are used.

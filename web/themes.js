import { Chessground } from '@lichess-org/chessground';

export const BOARD_THEMES = {
  brown: null, // Keep the existing Chessground brown board unchanged.
  blue: ['#dee3e6', '#8ca2ad'],
  green: ['#ffffdd', '#86a666'],
  grey: ['#d8d8d8', '#a0a0a0'],
};
export const PIECE_THEMES = ['cburnett', 'merida', 'chessnut'];

export function applyThemes(board, pieces, root = document.documentElement, base = document.baseURI) {
  if (!Object.hasOwn(BOARD_THEMES, board) || !PIECE_THEMES.includes(pieces)) throw new Error('Unknown board or piece theme');
  root.dataset.boardTheme = board;
  root.dataset.pieceTheme = pieces;
  const colors = BOARD_THEMES[board];
  if (colors) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path fill="${colors[0]}" d="M0 0h2v2H0z"/><path fill="${colors[1]}" d="M1 0h1v1H1zM0 1h1v1H0z"/></svg>`;
    root.style.setProperty('--board-image', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
  } else root.style.removeProperty('--board-image');
  for (const color of 'wb') for (const role of 'KQRBNP') {
    const variable = `--piece-${color}${role}`;
    if (pieces === 'cburnett') root.style.removeProperty(variable);
    else root.style.setProperty(variable, `url("${new URL(`themes/pieces/${pieces}/${color}${role}.svg`, base).href}")`);
  }
}

export function initThemes() {
  const selected = { board: 'brown', pieces: 'cburnett' };
  const preview = document.getElementById('theme-preview');
  const update = (themes = selected) => {
    applyThemes(themes.board, themes.pieces);
    preview.setAttribute('aria-label', `${themes.board} board with ${themes.pieces} pieces preview`);
  };
  for (const [kind, id, variants] of [
    ['board', 'board-theme', Object.keys(BOARD_THEMES)],
    ['pieces', 'piece-theme', PIECE_THEMES],
  ]) {
    const group = document.getElementById(id);
    for (const variant of variants) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = variant[0].toUpperCase() + variant.slice(1);
      button.dataset.theme = variant;
      button.setAttribute('aria-pressed', String(selected[kind] === variant));
      const show = () => update({ ...selected, [kind]: variant });
      button.addEventListener('pointerenter', show);
      button.addEventListener('focus', show);
      button.addEventListener('pointerleave', () => update());
      button.addEventListener('blur', () => update());
      button.addEventListener('click', () => {
        selected[kind] = variant;
        for (const option of group.querySelectorAll('button')) {
          option.setAttribute('aria-pressed', String(option === button));
        }
        update();
      });
      group.append(button);
    }
  }
  // Create only when visible so Chessground measures the preview correctly.
  let ground;
  document.getElementById('appearance').addEventListener('toggle', (event) => {
    update();
    if (event.target.open && !ground) ground = Chessground(preview, {
      fen: 'start', viewOnly: true, coordinates: false,
      drawable: { enabled: false, visible: false },
    });
  });
  update();
}

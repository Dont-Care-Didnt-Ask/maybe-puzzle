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
  const board = document.getElementById('board-theme');
  const pieces = document.getElementById('piece-theme');
  const update = () => applyThemes(board.value, pieces.value);
  board.addEventListener('change', update);
  pieces.addEventListener('change', update);
  update();
}

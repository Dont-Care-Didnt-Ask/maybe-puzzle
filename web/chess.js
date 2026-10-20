import { Chess } from 'chess.js';

export { Chess };
export const uciOf = (move) => move.from + move.to + (move.promotion || '');

export function play(board, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Invalid UCI move.');
  return board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

export function reviewLine(fen, moves) {
  const board = new Chess(fen);
  const san = [], frames = [];
  for (const uci of moves) {
    san.push(play(board, uci).san);
    frames.push(board.fen());
  }
  return { moves, san, frames, initial_fen: fen };
}

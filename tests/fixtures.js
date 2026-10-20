// Synthetic positions test mechanics; the published dataset contains only real games/puzzles.
import { Chess, play, uciOf } from '../web/chess.js';

export const START = new Chess().fen();
export const puzzle = { id: 'line', fen: START, moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6'], rating: 1700, url: '' };

export function ordinary(fen = START, setup = 'e2e4', best = ['e7e5', 'c7c5']) {
  const board = new Chess(fen);
  play(board, setup);
  const scores = Object.fromEntries(board.moves({ verbose: true }).map((move) => [uciOf(move), -200]));
  scores[best[0]] = 20;
  scores[best[1]] = -30;
  return { id: 'ordinary', fen, moves: [setup], scores, best_cp: 20, line: [best[0]], url: '' };
}

export class FakeCatalog {
  constructor(puzzles = [puzzle], positions = [ordinary()]) {
    this.puzzles = puzzles.map((source) => ({ kind: 'puzzle', source }));
    this.positions = positions.map((source) => ({ kind: 'ordinary', source }));
    this.manifest = { engine: 'Fixture', nodes: 100000, sampled_games: 2000,
      puzzles: { count: puzzles.length }, ordinary: { count: positions.length } };
  }
  refs(kind, settings) {
    return kind === 'ordinary' ? this.positions
      : this.puzzles.filter((ref) => Math.abs(ref.source.rating - settings.anchor_rating) <= settings.rating_margin);
  }
  async get(ref) { return ref.source; }
}

export const settings = (fraction = 1) => ({ ratio_mode: 'fixed', puzzle_fraction: fraction, anchor_rating: 1700, rating_margin: 0 });

import { createHash } from 'node:crypto';
import { gzipSync } from 'fflate';
import { ordinary, puzzle, START } from './fixtures.js';
import { Chess, play } from '../web/chess.js';

export function makeAssets(puzzles = [puzzle], positions = [ordinary(START, 'd2d4', ['d7d5', 'g8f6'])], size = 2, compact = false) {
  const files = new Map();
  function shards(records, prefix, ratings) {
    const output = [];
    if (ratings && compact) records = [...records].sort((a, b) => a.rating - b.rating);
    for (let offset = 0; offset < records.length;) {
      let end = Math.min(offset + size, records.length);
      if (ratings && compact) {
        const different = records.findIndex((record, i) => i > offset && i < end && record.rating !== records[offset].rating);
        if (different !== -1) end = different;
      }
      const batch = records.slice(offset, end).map((record) => {
        if (!ratings || !compact) return record;
        const board = new Chess(record.fen);
        play(board, record.moves[0]);
        return { ...record, position_key: board.fen().split(' ').slice(0, 4).join(' ') };
      });
      offset = end;
      const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(batch)));
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
      const file = `${prefix}-${hash}.json.gz`;
      files.set(file, bytes);
      const shard = { file, count: batch.length };
      if (ratings) {
        if (compact) shard.rating = batch[0].rating;
        else shard.ratings = batch.map((record) => record.rating);
      }
      output.push(shard);
    }
    return { count: records.length, shards: output };
  }
  const manifest = { schema: compact ? 2 : 1, tolerance_cp: 50, dataset_id: 'fixture', engine: 'Fixture', nodes: 100000,
    sampled_games: 2000, puzzles: shards(puzzles, 'p', true), ordinary: shards(positions, 'n', false) };
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  return { manifest, files };
}

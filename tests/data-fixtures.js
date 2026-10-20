import { createHash } from 'node:crypto';
import { gzipSync } from 'fflate';
import { ordinary, puzzle, START } from './fixtures.js';

export function makeAssets(puzzles = [puzzle], positions = [ordinary(START, 'd2d4', ['d7d5', 'g8f6'])], size = 2) {
  const files = new Map();
  function shards(records, prefix, ratings) {
    const output = [];
    for (let offset = 0; offset < records.length; offset += size) {
      const batch = records.slice(offset, offset + size);
      const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(batch)));
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
      const file = `${prefix}-${hash}.json.gz`;
      files.set(file, bytes);
      const shard = { file, count: batch.length };
      if (ratings) shard.ratings = batch.map((record) => record.rating);
      output.push(shard);
    }
    return { count: records.length, shards: output };
  }
  const manifest = { schema: 1, tolerance_cp: 50, dataset_id: 'fixture', engine: 'Fixture', nodes: 100000,
    sampled_games: 2000, puzzles: shards(puzzles, 'p', true), ordinary: shards(positions, 'n', false) };
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  return { manifest, files };
}

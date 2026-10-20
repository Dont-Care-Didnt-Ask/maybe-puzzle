import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'fflate';
import { Chess, play } from '../web/chess.js';
import { assert, validateManifest, validateRecord } from '../web/format.js';

export function validateData(directory) {
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))));
  const puzzleKeys = new Set(), ordinaryKeys = new Set(), games = new Set();
  const keyOf = (record) => {
    const board = new Chess(record.fen);
    play(board, record.moves[0]);
    return board.fen().split(' ').slice(0, 4).join(' ');
  };
  let bytes = 0;
  for (const [group, kind] of [['puzzles', 'puzzle'], ['ordinary', 'ordinary']]) {
    const ids = new Set();
    for (const shard of manifest[group].shards) {
      const data = fs.readFileSync(path.join(directory, shard.file));
      const hash = createHash('sha256').update(data).digest('hex').slice(0, 20);
      assert(shard.file.includes(hash), `hash mismatch: ${shard.file}`);
      bytes += data.length;
      const records = JSON.parse(new TextDecoder().decode(gunzipSync(data)));
      assert(Array.isArray(records) && records.length === shard.count, 'shard length mismatch');
      records.forEach((record, index) => {
        validateRecord(record, kind);
        assert(!ids.has(record.id), `duplicate ${kind} ID`);
        ids.add(record.id);
        const key = keyOf(record);
        if (kind === 'puzzle') {
          assert(record.rating === shard.ratings[index], 'rating index mismatch');
          puzzleKeys.add(key);
        } else {
          assert(!puzzleKeys.has(key) && !ordinaryKeys.has(key), 'duplicate/overlapping ordinary position');
          ordinaryKeys.add(key);
          if (record.url) {
            const game = record.url.split('#')[0];
            assert(!games.has(game), 'multiple ordinary positions from one game');
            games.add(game);
          }
        }
      });
    }
  }
  return { manifest, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = process.argv[2] || 'public/training';
    const { manifest, bytes } = validateData(directory);
    console.log(`Validated ${manifest.puzzles.count} puzzles, ${manifest.ordinary.count} fully graded ordinary positions (${(bytes / 1e6).toFixed(2)} MB compressed).`);
  } catch (error) {
    console.error(`${error.message}\nRun: uv run python export_static.py --positions 1000`);
    process.exitCode = 1;
  }
}

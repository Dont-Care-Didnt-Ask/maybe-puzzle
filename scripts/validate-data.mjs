import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'fflate';
import { Chess, play } from '../web/chess.js';
import { assert, validateManifest, validatePuzzleShape, validateRecord } from '../web/format.js';

export function validateData(directory, { deep = false } = {}) {
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))));
  const ordinaryKeys = new Set(), games = new Set();
  const keyOf = (record) => {
    const board = new Chess(record.fen);
    play(board, record.moves[0]);
    return board.fen().split(' ').slice(0, 4).join(' ');
  };
  let bytes = 0;
  // Ordinary positions first: compare millions of puzzle keys against the much
  // smaller ordinary set instead of retaining every puzzle FEN in memory.
  for (const [group, kind] of [['ordinary', 'ordinary'], ['puzzles', 'puzzle']]) {
    const ids = new Set();
    for (const shard of manifest[group].shards) {
      const data = fs.readFileSync(path.join(directory, shard.file));
      const hash = createHash('sha256').update(data).digest('hex').slice(0, 20);
      assert(shard.file.includes(hash), `hash mismatch: ${shard.file}`);
      bytes += data.length;
      const records = JSON.parse(new TextDecoder().decode(gunzipSync(data)));
      assert(Array.isArray(records) && records.length === shard.count, 'shard length mismatch');
      records.forEach((record, index) => {
        const replay = kind === 'ordinary' || manifest.schema === 1 || deep;
        if (replay) validateRecord(record, kind);
        else validatePuzzleShape(record, true);
        assert(!ids.has(record.id), `duplicate ${kind} ID`);
        ids.add(record.id);
        const key = replay ? keyOf(record) : record.position_key;
        if (kind === 'puzzle') {
          assert(record.rating === (manifest.schema === 2 ? shard.rating : shard.ratings[index]), 'rating index mismatch');
          assert(!ordinaryKeys.has(key), 'overlapping puzzle/ordinary position');
        } else {
          assert(!ordinaryKeys.has(key), 'duplicate/overlapping ordinary position');
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
    const directory = process.argv.slice(2).find((arg) => arg !== '--deep') || 'public/training';
    const deep = process.argv.includes('--deep');
    const { manifest, bytes } = validateData(directory, { deep });
    console.log(`Validated ${manifest.puzzles.count} puzzles, ${manifest.ordinary.count} fully graded ordinary positions (${(bytes / 1e6).toFixed(2)} MB compressed).`);
  } catch (error) {
    console.error(`${error.message}\nSee README.md for puzzle import and resumable ordinary-position expansion.`);
    process.exitCode = 1;
  }
}

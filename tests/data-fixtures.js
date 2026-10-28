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
      const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(batch)), { mtime: 0 });
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

// Keep the legacy formats explicit in compatibility tests. makeAssets retains
// its original schema-1/boolean-schema-2 API for existing browser fixtures.
export const makeSchema1Assets = (puzzles, positions, size) => makeAssets(puzzles, positions, size, false);
export const makeSchema2Assets = (puzzles, positions, size) => makeAssets(puzzles, positions, size, true);

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const encode = (value) => new TextEncoder().encode(canonicalJSON(value));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function makeSchema3Assets(puzzles = [puzzle], positions = [ordinary(START, 'd2d4', ['d7d5', 'g8f6'])],
  { puzzleSize = 128, ordinarySize = 64, puzzleProvenance = {}, ordinaryProvenance = {}, metadata = {} } = {}) {
  const files = new Map();
  const inventories = {};
  function group(source, kind, size, provenance) {
    const records = source.map((record) => {
      if (kind !== 'puzzles') return record;
      const board = new Chess(record.fen);
      play(board, record.moves[0]);
      return { ...record, position_key: board.fen().split(' ').slice(0, 4).join(' ') };
    }).sort((a, b) => (kind === 'puzzles' ? a.rating - b.rating : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ratingCounts = [];
    if (kind === 'puzzles') for (const record of records) {
      const previous = ratingCounts.at(-1);
      if (previous && previous[0] === record.rating) previous[1]++;
      else ratingCounts.push([record.rating, 1]);
    }
    const shards = [], compressed = new Map();
    for (let offset = 0, part = 0; offset < records.length;) {
      if (kind === 'puzzles' && (offset === 0 || records[offset].rating !== records[offset - 1].rating)) part = 0;
      let end = Math.min(offset + size, records.length);
      if (kind === 'puzzles') {
        const different = records.findIndex((record, index) => index > offset && index < end && record.rating !== records[offset].rating);
        if (different !== -1) end = different;
      }
      const batch = records.slice(offset, end);
      const bytes = gzipSync(encode(batch), { mtime: 0 });
      const relative = `${kind === 'puzzles' ? `${batch[0].rating}/` : ''}${part++}.json.gz`;
      compressed.set(relative, bytes);
      shards.push({ path: relative, count: batch.length, bytes: bytes.length, sha256: sha256(bytes) });
      offset = end;
    }
    const inventory = { format: 1, kind, count: records.length, shard_size: size, provenance: { fixture: true, ...provenance },
      logical_sha256: sha256(records.map((record) => `${canonicalJSON(record)}\n`).join('')), shards,
      ...(kind === 'puzzles' ? { rating_counts: ratingCounts } : {}) };
    const inventoryBytes = encode(inventory);
    const version = sha256(inventoryBytes);
    const prefix = `${kind}/${version}/`;
    files.set(`${prefix}inventory.json`, inventoryBytes);
    for (const [relative, bytes] of compressed) files.set(prefix + relative, bytes);
    inventories[kind] = inventory;
    return { version, count: records.length, shard_size: size, ...(kind === 'puzzles' ? { rating_counts: ratingCounts } : {}) };
  }
  const manifest = { schema: 3, tolerance_cp: 50, engine: 'Fixture', nodes: 100000, sampled_games: Math.max(2000, positions.length),
    ...metadata, puzzles: group(puzzles, 'puzzles', puzzleSize, puzzleProvenance), ordinary: group(positions, 'ordinary', ordinarySize, ordinaryProvenance) };
  manifest.dataset_id = sha256(encode(manifest)).slice(0, 20);
  files.set('manifest.json', encode(manifest));
  return { manifest, files, inventories };
}

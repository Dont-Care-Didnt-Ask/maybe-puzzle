import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Chess, play } from '../web/chess.js';
import { validateManifest, validatePuzzleShape, validateRecord } from '../web/format.js';
import {
  LIMITS, invariant, sha256, canonicalJSONFromBytes, compareCanonicalStrings, parseJSON, manifestBudget,
  readDataFile, readManifestBytes, readInventory, inventoryFiles, assertGroupTree,
} from './data-integrity.mjs';

const keyOf = (record) => {
  const board = new Chess(record.fen);
  play(board, record.moves[0]);
  return board.fen().split(' ').slice(0, 4).join(' ');
};

function decodeShard(data, file, count, canonical = false) {
  let decoded;
  try {
    const inflated = gunzipSync(data, { maxOutputLength: LIMITS.inflatedShard });
    decoded = canonical ? canonicalJSONFromBytes(inflated, { arrayItems: true }) : { value: parseJSON(inflated, file) };
  } catch (error) { throw new Error(`Invalid training data: invalid gzip/JSON shard ${file}: ${error.message}`); }
  invariant(Array.isArray(decoded.value) && decoded.value.length === count, `shard length mismatch: ${file}`);
  return { records: decoded.value, canonicalRecords: decoded.items };
}

function checkRecord(record, kind, { deep, requireKey, keys, ids, games }) {
  if (kind === 'ordinary' || deep || !requireKey) validateRecord(record, kind === 'puzzles' ? 'puzzle' : kind);
  else validatePuzzleShape(record, true);
  invariant(!ids.has(record.id), `duplicate ${kind} ID`);
  ids.add(record.id);
  const key = kind === 'puzzles' && requireKey && !deep ? record.position_key : keyOf(record);
  if (kind === 'puzzles') invariant(!keys.has(key), 'overlapping puzzle/ordinary position');
  else {
    invariant(!keys.has(key), 'duplicate/overlapping ordinary position');
    keys.add(key);
    if (record.url) {
      const game = record.url.split('#')[0];
      invariant(!games.has(game), 'multiple ordinary positions from one game');
      games.add(game);
    }
  }
}

// Validate every record, not a sample. Ordinary positions always get legal-move
// coverage and review-line checks; --deep additionally replays every puzzle.
export function validateGroup(directory, kind, version, { group, deep = false, ordinaryKeys = new Set() } = {}) {
  const loaded = readInventory(directory, kind, version, group);
  const { inventory } = loaded;
  assertGroupTree(directory, kind, version, inventory);
  const logical = createHash('sha256');
  const ids = new Set(), games = new Set();
  let bytes = 0, lastID, lastRating;
  for (const shard of inventory.shards) {
    const file = `${kind}/${version}/${shard.path}`;
    const data = readDataFile(directory, file, LIMITS.shard);
    invariant(data.length === shard.bytes && sha256(data) === shard.sha256, `shard bytes/hash mismatch: ${file}`);
    bytes += data.length;
    const { records, canonicalRecords } = decodeShard(data, file, shard.count, true);
    const rating = kind === 'puzzles' ? Number(shard.path.split('/')[0]) : undefined;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      checkRecord(record, kind, { deep, requireKey: true, keys: ordinaryKeys, ids, games });
      if (kind === 'puzzles') invariant(record.rating === rating, `rating index mismatch: ${file}`);
      invariant(lastID === undefined || (kind === 'puzzles' && rating > lastRating)
        || ((kind !== 'puzzles' || rating === lastRating) && compareCanonicalStrings(record.id, lastID) > 0), `${kind} records are not in canonical ID/rating order`);
      lastID = record.id;
      lastRating = rating;
      logical.update(canonicalRecords[index]).update('\n');
    }
  }
  invariant(logical.digest('hex') === inventory.logical_sha256, `${kind} logical SHA-256 mismatch`);
  return { ...loaded, inventoryBytes: loaded.bytes, bytes, files: inventoryFiles(inventory, version), ordinaryKeys };
}

export function validateData(directory, { deep = false, enforceBudgets = false } = {}) {
  const manifestBytes = readManifestBytes(directory);
  const manifest = validateManifest(parseJSON(manifestBytes, 'manifest'));
  // Legacy manifests had a per-shard index, and may be larger than the compact
  // schema-3 budget. Keep them inspectable, but never bypass deployment budgets.
  const budget = manifest.schema === 3 || enforceBudgets ? manifestBudget(manifestBytes) : null;
  const ordinaryKeys = new Set(), games = new Set();
  const files = ['manifest.json'];
  const groups = {};
  let bytes = 0, materializedBytes = manifestBytes.length;
  for (const kind of ['ordinary', 'puzzles']) {
    if (manifest.schema === 3) {
      const result = validateGroup(directory, kind, manifest[kind].version, { group: manifest[kind], deep, ordinaryKeys });
      files.push(...result.files);
      groups[kind] = result;
      bytes += result.bytes;
      materializedBytes += result.bytes + result.inventoryBytes.length;
      invariant(materializedBytes <= LIMITS.site, 'training data exceeds site byte budget');
      continue;
    }
    const ids = new Set();
    for (const shard of manifest[kind].shards) {
      const data = readDataFile(directory, shard.file, enforceBudgets ? LIMITS.shard : LIMITS.inflatedShard);
      // Schemas 1/2 commit the compressed bytes in the *filename*, not an inventory.
      const hash = sha256(data).slice(0, 20);
      invariant(shard.file === `${kind === 'puzzles' ? 'p' : 'n'}-${hash}.json.gz`, `hash mismatch: ${shard.file}`);
      bytes += data.length;
      materializedBytes += data.length;
      if (enforceBudgets) invariant(materializedBytes <= LIMITS.site, 'training data exceeds site byte budget');
      files.push(shard.file);
      const { records } = decodeShard(data, shard.file, shard.count);
      records.forEach((record, index) => {
        checkRecord(record, kind, { deep, requireKey: manifest.schema === 2, keys: ordinaryKeys, ids, games });
        if (kind === 'puzzles') invariant(record.rating === (manifest.schema === 2 ? shard.rating : shard.ratings[index]), 'rating index mismatch');
      });
    }
  }
  return { manifest, manifestBytes, bytes, files, groups, budget };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    invariant(args.filter((arg) => !arg.startsWith('--')).length <= 1 && args.every((arg) => !arg.startsWith('--') || arg === '--deep'), 'usage: node scripts/validate-data.mjs [directory] [--deep]');
    const directory = args.find((arg) => arg !== '--deep') || 'public/training';
    const { manifest, bytes, budget } = validateData(directory, { deep: args.includes('--deep') });
    console.log(`Validated ${manifest.puzzles.count} puzzles, ${manifest.ordinary.count} fully graded ordinary positions (${(bytes / 1e6).toFixed(2)} MB compressed).${budget ? ` Manifest: ${budget.raw} raw / ${budget.gzip} gzip bytes.` : ''}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

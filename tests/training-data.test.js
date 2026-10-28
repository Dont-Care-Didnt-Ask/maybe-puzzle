// All release/build tests use synthetic data in isolated temporary directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { zipSync, Zip, ZipPassThrough, ZipDeflate } from 'fflate';
import { Chess, play } from '../web/chess.js';
import { puzzle, ordinary, START } from './fixtures.js';
import { makeAssets } from './data-fixtures.js';
import {
  LIMITS, DEFAULT_LOCK, DEFAULT_CACHE, sha256, canonicalJSON, canonicalBytes, canonicalJSONFromBytes, manifestBudget, groupFromInventory,
  validateInventory, validateLock, validateReleaseCandidate, acquirePublicationLock, withPublicationLock, readManifestBytes,
  safeRelative, physicalPath,
} from '../scripts/data-integrity.mjs';
import { validateData } from '../scripts/validate-data.mjs';
import {
  cachedArchive, extractArchive, inspectArchive, hydrateTrainingData, fetchTrainingData, checkTrainingData,
  pinRelease, publishStagedData, validateCandidateData,
} from '../scripts/training-data.mjs';
import { snapshotTrainingData, buildSite, measureSite, copyPublicAssets } from '../scripts/build.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpnp-tooling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeFiles(directory, files) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  }
}
function positionKey(record) {
  const board = new Chess(record.fen);
  play(board, record.moves[0]);
  return board.fen().split(' ').slice(0, 4).join(' ');
}
function fixture({ puzzles = [puzzle], positions = [ordinary(START, 'd2d4', ['d7d5', 'g8f6'])], provenance = {},
  streaming = false, mutateInventory, zipTransform } = {}) {
  const files = new Map(), artifacts = new Map(), archives = {}, inventories = {}, groups = {};
  for (const kind of ['puzzles', 'ordinary']) {
    const records = (kind === 'puzzles' ? puzzles.map((record) => ({ ...record, position_key: record.position_key ?? positionKey(record) })) : positions)
      .toSorted((a, b) => (kind === 'puzzles' ? a.rating - b.rating : 0) || a.id.localeCompare(b.id));
    const size = kind === 'puzzles' ? 256 : 64;
    const batches = new Map();
    if (kind === 'puzzles') for (const record of records) {
      if (!batches.has(record.rating)) batches.set(record.rating, []);
      batches.get(record.rating).push(record);
    }
    else batches.set('', records);
    const groupFiles = new Map(), shards = [];
    for (const [rating, batch] of batches) {
      for (let offset = 0, index = 0; offset < batch.length; offset += size, index++) {
        const chunk = batch.slice(offset, offset + size), data = gzipSync(canonicalBytes(chunk));
        const name = `${kind === 'puzzles' ? `${rating}/` : ''}${index}.json.gz`;
        groupFiles.set(name, data);
        shards.push({ path: name, count: chunk.length, bytes: data.length, sha256: sha256(data) });
      }
    }
    const inventory = { format: 1, kind, count: records.length, shard_size: size,
      ...(kind === 'puzzles' ? { rating_counts: [...batches].map(([rating, rows]) => [rating, rows.length]) } : {}),
      provenance, logical_sha256: sha256(records.map((record) => `${canonicalJSON(record)}\n`).join('')), shards };
    if (mutateInventory) mutateInventory(inventory);
    const bytes = canonicalBytes(inventory), version = sha256(bytes), prefix = `${kind}/${version}/`;
    groupFiles.set('inventory.json', bytes);
    const entries = [...groupFiles].map(([name, data]) => [prefix + name, data]);
    for (const [name, data] of entries) files.set(name, data);
    let archive;
    if (streaming) {
      const chunks = [];
      const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
      for (const [name, data] of entries) {
        const entry = name.endsWith('.gz') ? new ZipPassThrough(name) : new ZipDeflate(name);
        zip.add(entry);
        entry.push(data, true);
      }
      zip.end();
      archive = Buffer.concat(chunks);
    } else {
      const input = Object.fromEntries(entries.map(([name, data]) => [name, [data, { level: name.endsWith('.gz') ? 0 : 6, mtime: new Date('2020-01-01') }]]));
      archive = Buffer.from(zipSync(zipTransform ? zipTransform(input, kind, prefix) : input));
    }
    const descriptor = { kind, version, file: `${kind}-${version}.zip`, sha256: sha256(archive), bytes: archive.length,
      file_count: entries.length, extracted_bytes: entries.reduce((sum, [, data]) => sum + data.length, 0), count: records.length, provenance };
    archives[kind] = descriptor;
    artifacts.set(descriptor.file, archive);
    inventories[kind] = inventory;
    groups[kind] = groupFromInventory(inventory);
  }
  const manifest = { schema: 3, tolerance_cp: 50, dataset_id: 'isolated-synthetic-fixture', engine: 'Fixture', nodes: 100000,
    sampled_games: Math.max(2000, positions.length), ...groups };
  files.set('manifest.json', canonicalBytes(manifest));
  const lock = { format: 1, manifest, archives: Object.fromEntries(Object.entries(archives).map(([kind, descriptor]) =>
    [kind, { current: { ...descriptor, url: `https://fixtures.invalid/releases/test/${descriptor.file}` } }])) };
  return { files, artifacts, archives, inventories, manifest, lock, candidate: { format: 1, manifest, archives } };
}
function releaseOnDisk(root, data) {
  writeFiles(root, data.artifacts);
  const candidateFile = path.join(root, 'release-candidate.json');
  fs.writeFileSync(candidateFile, canonicalBytes(data.candidate));
  return candidateFile;
}
function artifactFetch(data, calls = []) {
  return async (url) => {
    calls.push(url);
    const filename = new URL(url).pathname.split('/').at(-1);
    const body = data.artifacts.get(filename);
    return body ? new Response(body, { headers: { 'content-length': String(body.length) } }) : new Response('missing', { status: 404 });
  };
}

// Recompute the pinned archive digest after intentionally corrupting a ZIP so
// extraction tests exercise validation beyond the outer download hash.
function repin(descriptor, bytes) { return { ...descriptor, bytes: bytes.length, sha256: sha256(bytes) }; }

test('canonical inventories match Python sorted compact JSON/ASCII escaping without newline', (t) => {
  temporary(t);
  assert.equal(canonicalJSON({ z: 2, '2': 'two', '10': 'ten', a: { '\u{10000}': 1, '\ue000': 2 }, text: 'é' }),
    '{"10":"ten","2":"two","a":{"\\ue000":2,"\\ud800\\udc00":1},"text":"\\u00e9","z":2}');
  const data = fixture();
  const inventory = data.inventories.puzzles, version = data.manifest.puzzles.version;
  validateInventory(inventory, 'puzzles', version);
  assert.throws(() => validateInventory(inventory, 'puzzles', version, Buffer.concat([canonicalBytes(inventory), Buffer.from('\n')])), /canonical/);
  assert.throws(() => validateInventory(inventory, 'puzzles', '0'.repeat(64)), /version\/hash/);
  for (const mutate of [
    (value) => { value.shards[0].path = '../escape'; },
    (value) => { value.shards[0].bytes = LIMITS.shard + 1; },
    (value) => { value.count++; },
    (value) => { value.logical_sha256 = 'short'; },
    (value) => { value.count = Number.MAX_SAFE_INTEGER; value.rating_counts = [[1700, value.count]]; },
    (value) => { value.rating_counts = { 1700: 1 }; },
    (value) => { value.rating_counts = [[1700, 1], [1700, 1]]; value.count = 2; },
    (value) => { value.rating_counts = [[1701, 1], [1700, 1]]; value.count = 2; },
    (value) => { value.rating_counts = [[Number.MIN_SAFE_INTEGER - 1, 1]]; },
  ]) {
    const changed = structuredClone(inventory);
    mutate(changed);
    assert.throws(() => validateInventory(changed, 'puzzles', sha256(canonicalBytes(changed))), /Invalid training data/);
  }
});

test('canonical byte validation preserves Python float tokens in provenance and record hashes', (t) => {
  const raw = Buffer.from(' {"b":[1.0,1e-7,-0.0],"a":"é"} ');
  assert.equal(canonicalJSONFromBytes(raw).canonical, '{"a":"\\u00e9","b":[1.0,1e-07,-0.0]}');
  const data = fixture({ puzzles: [{ ...puzzle, extra: 1 }] });
  const inventory = structuredClone(data.inventories.puzzles);
  const inventoryBytes = Buffer.from(canonicalJSON(inventory).replace('"provenance":{}', '"provenance":{"fraction":1e-07,"whole":1.0}'));
  validateInventory(JSON.parse(inventoryBytes), 'puzzles', sha256(inventoryBytes), inventoryBytes);
  const noncanonical = Buffer.from(inventoryBytes.toString().replace('1e-07', '1e-7'));
  assert.throws(() => validateInventory(JSON.parse(noncanonical), 'puzzles', sha256(noncanonical), noncanonical), /canonical/);
  const root = temporary(t), directory = path.join(root, 'training');
  const oldVersion = data.manifest.puzzles.version;
  const oldShard = `puzzles/${oldVersion}/${inventory.shards[0].path}`;
  const json = gunzipSync(data.files.get(oldShard)).toString().replace('"extra":1,', '"extra":1.0,');
  const compressed = gzipSync(Buffer.from(json));
  inventory.logical_sha256 = sha256(`${json.slice(1, -1)}\n`);
  inventory.shards[0].bytes = compressed.length; inventory.shards[0].sha256 = sha256(compressed);
  const version = sha256(canonicalBytes(inventory));
  for (const name of [...data.files.keys()]) if (name.startsWith(`puzzles/${oldVersion}/`)) data.files.delete(name);
  data.files.set(`puzzles/${version}/inventory.json`, canonicalBytes(inventory));
  data.files.set(`puzzles/${version}/${inventory.shards[0].path}`, compressed);
  data.manifest.puzzles = groupFromInventory(inventory); data.files.set('manifest.json', canonicalBytes(data.manifest));
  writeFiles(directory, data.files);
  assert.equal(validateData(directory, { deep: true }).manifest.puzzles.version, version);
});

test('schema 3 validation checks every shard, logical identity, exact ratings, and overlap', (t) => {
  const root = temporary(t), directory = path.join(root, 'training');
  const data = fixture();
  writeFiles(directory, data.files);
  assert.equal(validateData(directory).manifest.schema, 3);
  assert.equal(validateData(directory, { deep: true }).manifest.puzzles.count, 1);
  const shard = [...data.files.keys()].find((name) => name.endsWith('.gz'));
  fs.appendFileSync(path.join(directory, shard), '!');
  assert.throws(() => validateData(directory), /hash mismatch/);
  const overlap = fixture({ positions: [ordinary()] });
  fs.rmSync(directory, { recursive: true });
  writeFiles(directory, overlap.files);
  assert.throws(() => validateData(directory), /overlapping/);
  fs.rmSync(directory, { recursive: true });
  writeFiles(directory, fixture({ mutateInventory: (inventory) => { inventory.logical_sha256 = '0'.repeat(64); } }).files);
  assert.throws(() => validateData(directory), /logical SHA-256/);
});

test('structural checks are complete, while deep validation replays puzzle legality/position keys', (t) => {
  const root = temporary(t), directory = path.join(root, 'training');
  const bad = fixture({ puzzles: [{ ...puzzle, moves: ['e2e4', 'e7e4'], position_key: positionKey(puzzle) }] });
  writeFiles(directory, bad.files);
  assert.equal(validateData(directory).manifest.puzzles.count, 1);
  assert.throws(() => validateData(directory, { deep: true }), /illegal|invalid/i);
  const missing = fixture({ positions: [{ ...ordinary(START, 'd2d4', ['d7d5', 'g8f6']), scores: {} }] });
  fs.rmSync(directory, { recursive: true });
  writeFiles(directory, missing.files);
  assert.throws(() => validateData(directory), /scores must cover/);
});

test('legacy schema 1/2 compressed filename hashes remain mandatory', (t) => {
  const root = temporary(t);
  for (const compact of [false, true]) {
    const directory = path.join(root, String(compact));
    const data = makeAssets([puzzle], undefined, 2, compact);
    writeFiles(directory, data.files);
    assert.equal(validateData(directory).manifest.schema, compact ? 2 : 1);
    const shard = data.manifest.puzzles.shards[0].file;
    fs.appendFileSync(path.join(directory, shard), 'corrupt');
    assert.throws(() => validateData(directory), /hash mismatch/);
  }
});

test('group trees reject unlisted files, missing files and symlinked shard parents', (t) => {
  const root = temporary(t), directory = path.join(root, 'training'), data = fixture();
  writeFiles(directory, data.files);
  const group = path.join(directory, 'puzzles', data.manifest.puzzles.version);
  fs.writeFileSync(path.join(group, 'extra'), 'unlisted');
  assert.throws(() => validateData(directory), /unlisted/);
  fs.rmSync(path.join(group, 'extra'));
  const shard = path.join(group, '1700', '0.json.gz');
  const original = fs.readFileSync(shard);
  fs.rmSync(shard);
  assert.throws(() => validateData(directory), /missing inventory/);
  fs.writeFileSync(shard, original);
  fs.renameSync(path.join(group, '1700'), path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(group, '1700'), 'dir');
  assert.throws(() => validateData(directory), /symlink/);
});

test('raw/gzip manifest budgets and lock limits fail closed', () => {
  assert.equal(manifestBudget(Buffer.from('{}')).raw, 2);
  assert.throws(() => manifestBudget(Buffer.alloc(LIMITS.manifest + 1)), /raw budget/);
  const random = Array.from({ length: 6000 }, (_, index) => sha256(String(index)).slice(0, 8)).join('');
  assert(random.length < LIMITS.manifest);
  assert.throws(() => manifestBudget(Buffer.from(random)), /gzip budget/);
  const data = fixture();
  for (const mutate of [
    (lock) => { lock.archives.puzzles.current.url = 'http://fixtures.invalid/archive.zip'; },
    (lock) => { lock.archives.puzzles.current.url = lock.archives.puzzles.current.url.replace('/test/', '/latest/'); },
    (lock) => { lock.archives.puzzles.previous = lock.archives.puzzles.current; },
    (lock) => { lock.archives.puzzles.current.count++; },
    (lock) => { lock.archives.puzzles.current.file = 'unversioned.zip'; },
  ]) {
    const lock = structuredClone(data.lock); mutate(lock);
    assert.throws(() => validateLock(lock), /Invalid training data/);
  }
});

test('publication lock has interoperable directory/owner diagnostics, bounded wait, never steals', async (t) => {
  const root = temporary(t), output = path.join(root, 'training');
  const release = await acquirePublicationLock(output);
  const directory = `${path.resolve(output)}.publication-lock`;
  const owner = fs.readFileSync(path.join(directory, 'owner.json'));
  assert.equal(JSON.parse(owner).pid, process.pid);
  await assert.rejects(acquirePublicationLock(output, { timeoutMs: 20, pollMs: 2 }), /never stealing.*Owner/s);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'owner.json')), owner);
  release(); release();
  await assert.rejects(withPublicationLock(output, () => { throw new Error('failure'); }), /failure/);
  assert(!fs.existsSync(directory));
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: 1, hostname: 'python-fixture' }));
  await assert.rejects(acquirePublicationLock(output, { timeoutMs: 0 }), /python-fixture/);
  assert(fs.existsSync(directory));
});

test('downloads stream pinned bytes, retry boundedly, reverify cache hits, and remove partial files', async (t) => {
  const root = temporary(t), data = fixture(), descriptor = data.lock.archives.puzzles.current;
  const cacheDir = path.join(root, 'cache');
  let calls = 0;
  const fetchImpl = async (url) => ++calls === 1 ? new Response('retry', { status: 503 }) : artifactFetch(data)(url);
  const filename = await cachedArchive(descriptor, { cacheDir, fetchImpl, attempts: 2, retryDelayMs: 0 });
  assert.equal(filename, path.join(cacheDir, `${descriptor.sha256}.zip`));
  assert.equal(calls, 2);
  await cachedArchive(descriptor, { cacheDir, fetchImpl: () => { throw new Error('must not download'); } });
  fs.appendFileSync(filename, 'corrupt');
  await cachedArchive(descriptor, { cacheDir, fetchImpl, retryDelayMs: 0 });
  assert.equal(calls, 3);
  assert.equal(sha256(fs.readFileSync(filename)), descriptor.sha256);
  fs.rmSync(filename);
  calls = 0;
  await assert.rejects(cachedArchive(descriptor, { cacheDir, attempts: 2, retryDelayMs: 0,
    fetchImpl: async () => { calls++; return new Response(new Uint8Array(descriptor.bytes + 1)); } }), /byte limit/);
  assert.equal(calls, 2);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('download deadline includes a stalled body even if the transport ignores abort', async (t) => {
  const root = temporary(t), descriptor = fixture().lock.archives.puzzles.current;
  const cacheDir = path.join(root, 'cache');
  await assert.rejects(cachedArchive(descriptor, { cacheDir, attempts: 1, deadlineMs: 20,
    fetchImpl: async () => ({ ok: true, headers: new Headers(), body: new ReadableStream({ start() {} }) }) }), /timed out/);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
  await assert.rejects(cachedArchive(descriptor, { cacheDir, attempts: 1, deadlineMs: 20,
    fetchImpl: async () => new Promise(() => {}) }), /timed out/);
  let resolveHeaders, canceled = false;
  const pending = cachedArchive(descriptor, { cacheDir, attempts: 1, deadlineMs: 20,
    fetchImpl: () => new Promise((resolve) => { resolveHeaders = resolve; }) });
  await assert.rejects(pending, /timed out/);
  resolveHeaders({ ok: true, body: new ReadableStream({ cancel() { canceled = true; } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(canceled, 'late response bodies must be canceled even when the transport ignored abort');
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('download verifies exact length/hash and rejects insecure redirects without publishing cache', async (t) => {
  const root = temporary(t), descriptor = fixture().lock.archives.puzzles.current;
  const cacheDir = path.join(root, 'cache');
  for (const response of [
    () => new Response('short'),
    () => new Response(new Uint8Array(descriptor.bytes)),
    () => new Response('wrong', { headers: { 'content-length': '5' } }),
    () => ({ ok: true, url: 'http://fixtures.invalid/redirect', headers: new Headers() }),
  ]) await assert.rejects(cachedArchive(descriptor, { cacheDir, attempts: 1, fetchImpl: async () => response() }), /mismatch|HTTPS/);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('stored gzip ZIPs and streaming ZIP data descriptors extract safely', async (t) => {
  const root = temporary(t);
  for (const streaming of [false, true]) {
    const data = fixture({ streaming }), directory = path.join(root, String(streaming));
    fs.mkdirSync(directory);
    releaseOnDisk(path.join(root, `release-${streaming}`), data);
    for (const descriptor of Object.values(data.archives)) {
      const filename = path.join(root, `release-${streaming}`, descriptor.file);
      assert.equal(inspectArchive(filename, descriptor).length, descriptor.file_count);
      await extractArchive(filename, directory, descriptor);
    }
    fs.writeFileSync(path.join(directory, 'manifest.json'), canonicalBytes(data.manifest));
    assert.equal(validateData(directory).manifest.puzzles.count, 1);
  }
});

test('ZIP extraction rejects traversal, symlinks, compressed gzip shards, limits and invalid headers', async (t) => {
  const root = temporary(t);
  for (const [label, transform, pattern] of [
    ['traversal', (input) => Object.fromEntries(Object.entries(input).map(([name, value], index) => [index ? name : '../escape', value])), /unsafe/],
    ['symlink', (input) => Object.fromEntries(Object.entries(input).map(([name, [bytes, options]], index) => [name, [bytes, index ? options : { ...options, os: 3, attrs: 0xa1ff0000 }]])), /links/],
    ['compressed', (input) => Object.fromEntries(Object.entries(input).map(([name, [bytes, options]]) => [name, [bytes, { ...options, level: 6 }]])), /compression/],
  ]) {
    const data = fixture({ zipTransform: transform }), descriptor = data.archives.puzzles;
    const directory = path.join(root, label); fs.mkdirSync(directory);
    const filename = path.join(root, `${label}.zip`); fs.writeFileSync(filename, data.artifacts.get(descriptor.file));
    await assert.rejects(extractArchive(filename, directory, descriptor), pattern);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  const data = fixture(), descriptor = data.archives.puzzles;
  const original = data.artifacts.get(descriptor.file), filename = path.join(root, 'bad.zip');
  for (const mutate of [
    (bytes) => { bytes.writeUInt16LE(1, 6); }, // encrypted local header / mismatch
    (bytes) => { bytes.writeUInt32LE(0, 0); },
    (bytes) => { bytes[30] ^= 1; }, // local and central path disagree
    (bytes) => { bytes[bytes.length - 22] ^= 1; },
  ]) {
    const bytes = Buffer.from(original); mutate(bytes); fs.writeFileSync(filename, bytes);
    assert.throws(() => inspectArchive(filename, repin(descriptor, bytes)), /Invalid training data/);
  }
  fs.writeFileSync(filename, original);
  assert.throws(() => inspectArchive(filename, { ...descriptor, file_count: descriptor.file_count + 1 }), /file count/);
  assert.throws(() => inspectArchive(filename, { ...descriptor, extracted_bytes: descriptor.extracted_bytes - 1 }), /byte limit/);
});

test('ZIP CRC, duplicate entry names, trailing junk and existing extraction links are rejected', async (t) => {
  const root = temporary(t), data = fixture({ streaming: true }), descriptor = data.archives.puzzles;
  const original = data.artifacts.get(descriptor.file), filename = path.join(root, 'archive.zip');
  fs.writeFileSync(filename, original);
  const entries = inspectArchive(filename, descriptor);
  const bad = Buffer.from(original); bad[entries.find((entry) => entry.method === 0).start + 10] ^= 1;
  fs.writeFileSync(filename, bad);
  const target = path.join(root, 'bad-crc'); fs.mkdirSync(target);
  await assert.rejects(extractArchive(filename, target, repin(descriptor, bad)), /CRC/);
  const trailing = Buffer.concat([original, Buffer.from('junk')]); fs.writeFileSync(filename, trailing);
  assert.throws(() => inspectArchive(filename, repin(descriptor, trailing)), /end header/);
  // Two streaming entries with exactly the same allowed name.
  const chunks = [], zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  const name = entries[0].name;
  for (let i = 0; i < 2; i++) { const entry = new ZipPassThrough(name); zip.add(entry); entry.push(Buffer.from('x'), true); }
  zip.end(); const duplicate = Buffer.concat(chunks); fs.writeFileSync(filename, duplicate);
  assert.throws(() => inspectArchive(filename, { ...repin(descriptor, duplicate), file_count: 2, extracted_bytes: 2 }), /duplicate/);
  fs.writeFileSync(filename, original);
  const linked = path.join(root, 'linked'); fs.mkdirSync(linked);
  fs.symlinkSync(target, path.join(linked, 'puzzles'), 'dir');
  await assert.rejects(extractArchive(filename, linked, descriptor), /unsafe extraction parent/);
});

test('pin requires explicit immutable HTTPS URLs and verifies candidate archive/manifest', async (t) => {
  const root = temporary(t), data = fixture(), release = path.join(root, 'release');
  const candidateFile = releaseOnDisk(release, data), lockFile = path.join(root, 'lock.json'), trainingDir = path.join(root, 'training');
  await assert.rejects(pinRelease({ candidateFile, lockFile, trainingDir }), /requires.*urls|requires.*url/i);
  assert(!fs.existsSync(lockFile));
  const options = { candidateFile, lockFile, trainingDir, puzzlesURL: data.lock.archives.puzzles.current.url, ordinaryURL: data.lock.archives.ordinary.current.url };
  const lock = await pinRelease(options);
  assert.deepEqual(lock, data.lock);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile)), lock);
  assert(!fs.existsSync(trainingDir));
  const archive = path.join(release, data.archives.puzzles.file);
  fs.appendFileSync(archive, 'bad');
  const previousLock = fs.readFileSync(lockFile);
  await assert.rejects(pinRelease(options), /byte|SHA|oversized/);
  assert.deepEqual(fs.readFileSync(lockFile), previousLock);
});

test('pin retains distinct previous versions independently for each group', async (t) => {
  const root = temporary(t), lockFile = path.join(root, 'lock.json'), trainingDir = path.join(root, 'training');
  const pin = async (data, name) => pinRelease({ candidateFile: releaseOnDisk(path.join(root, name), data), lockFile, trainingDir,
    puzzlesURL: data.lock.archives.puzzles.current.url, ordinaryURL: data.lock.archives.ordinary.current.url });
  const first = fixture(), second = fixture({ puzzles: [{ ...puzzle, id: 'new-puzzle' }] });
  await pin(first, 'first');
  const lock = await pin(second, 'second');
  assert.deepEqual(lock.archives.puzzles.previous, first.lock.archives.puzzles.current);
  assert(!lock.archives.ordinary.previous);
  const third = await pin(second, 'third');
  assert.deepEqual(third, lock);
});

test('cross-process pins serialize by physical lock identity and reject stale captures without losing retention', { timeout: 30_000 }, async (t) => {
  for (const scenario of ['same lock path', 'symlinked lock parent', 'changed candidate']) await t.test(scenario, async (t) => {
    const root = temporary(t), prior = fixture();
    const first = fixture({ puzzles: [{ ...puzzle, id: 'first-puzzle' }],
      positions: [{ ...ordinary(START, 'd2d4', ['d7d5', 'g8f6']), id: 'first-ordinary' }] });
    const second = fixture({ puzzles: [{ ...puzzle, id: 'second-puzzle' }],
      positions: [{ ...ordinary(START, 'd2d4', ['d7d5', 'g8f6']), id: 'second-ordinary' }] });
    const lockDir = path.join(root, 'locks'); fs.mkdirSync(lockDir);
    const lockFile = path.join(lockDir, 'lock.json'); fs.writeFileSync(lockFile, canonicalBytes(prior.lock));
    let secondLockFile = lockFile;
    if (scenario === 'symlinked lock parent') {
      fs.symlinkSync(root, path.join(root, 'alias'), 'dir');
      secondLockFile = path.join(root, 'alias', 'locks', 'lock.json');
    }
    const preload = path.join(root, 'pin-race.mjs');
    // Pause the first CLI at its atomic rename, after its captured-byte checks.
    // The second CLI must either contend on that same lock (fixed behavior), or
    // reach its own rename with the stale capture (the former lost-update bug).
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      import { physicalPath } from ${JSON.stringify(new URL('../scripts/data-integrity.mjs', import.meta.url).href)};
      const lockFile = physicalPath(process.env.CPNP_TEST_PIN_LOCK);
      const gate = process.env.CPNP_TEST_PIN_GATE;
      const mkdir = fs.mkdirSync, rename = fs.renameSync;
      let waiting = false;
      fs.mkdirSync = (directory, ...options) => {
        try { return mkdir(directory, ...options); }
        catch (error) {
          if (!waiting && error.code === 'EEXIST' && directory === lockFile + '.publication-lock') {
            fs.writeFileSync(gate + '.waiting', ''); waiting = true;
          }
          throw error;
        }
      };
      fs.renameSync = (source, target) => {
        if (physicalPath(target) === lockFile) {
          fs.writeFileSync(gate + '.ready', '');
          const deadline = Date.now() + 10_000, sleep = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(gate + '.allow')) {
            if (Date.now() >= deadline) throw new Error('Timed out at fixture pin rename gate');
            Atomics.wait(sleep, 0, 0, 5);
          }
        }
        return rename(source, target);
      };
    `);
    const startPin = (data, name, selectedLock) => {
      const candidateFile = releaseOnDisk(path.join(root, name), data), trainingDir = path.join(root, `${name}-training`);
      const gate = path.join(root, `${name}-commit`);
      const child = spawn(process.execPath, ['--import', preload, path.resolve('scripts/training-data.mjs'), 'pin',
        '--candidate', candidateFile, '--lock', selectedLock, '--training-dir', trainingDir,
        '--puzzles-url', data.lock.archives.puzzles.current.url, '--ordinary-url', data.lock.archives.ordinary.current.url],
      { cwd: root, env: { ...process.env, CPNP_TEST_PIN_LOCK: selectedLock, CPNP_TEST_PIN_GATE: gate }, timeout: 15_000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', (bytes) => { stdout += bytes; });
      child.stderr.on('data', (bytes) => { stderr += bytes; });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
      });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      return { child, candidateFile, trainingDir, gate, done };
    };
    const waitForGate = async ({ child, gate, done }) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        for (const phase of ['ready', 'waiting']) if (fs.existsSync(`${gate}.${phase}`)) return phase;
        if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Pin exited before race gate: ${JSON.stringify(await done)}`);
        assert(Date.now() < deadline, `Timed out waiting for pin race gate: ${gate}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const firstPin = startPin(first, 'first', lockFile);
    assert.equal(await waitForGate(firstPin), 'ready');
    const secondPin = startPin(second, 'second', secondLockFile);
    await waitForGate(secondPin);
    if (scenario === 'changed candidate') fs.appendFileSync(secondPin.candidateFile, '\n');
    fs.writeFileSync(`${firstPin.gate}.allow`, '');
    const committed = await firstPin.done;
    assert.equal(committed.status, 0, committed.stderr);
    const committedBytes = fs.readFileSync(lockFile);
    fs.writeFileSync(`${secondPin.gate}.allow`, '');
    const stale = await secondPin.done;
    assert.equal(stale.status, 1, `Stale pin must fail instead of overwriting the intervening selection: ${JSON.stringify(stale)}`);
    assert.match(stale.stderr, scenario === 'changed candidate' ? /release candidate changed while pinning/ : /production lock changed while pinning/);
    const expected = structuredClone(first.lock);
    for (const kind of ['puzzles', 'ordinary']) expected.archives[kind].previous = prior.lock.archives[kind].current;
    assert.deepEqual(JSON.parse(committedBytes), expected);
    assert.deepEqual(fs.readFileSync(lockFile), committedBytes, 'the successful selection and both previous versions survive the stale pin');
    for (const pin of [firstPin, secondPin]) assert(!fs.existsSync(pin.trainingDir), 'pinning must not mutate either training tree');
    assert(!fs.existsSync(`${physicalPath(lockFile)}.publication-lock`));
    for (const directory of [root, lockDir]) assert(!fs.readdirSync(directory).some((name) => name.includes('.tmp-') || name.endsWith('.publication-lock')));
  });
});

test('hydrate stages/validates before manifest-last publication; existing corrupt immutable groups fail closed', async (t) => {
  const root = temporary(t), data = fixture(), trainingDir = path.join(root, 'training'), cacheDir = path.join(root, 'cache');
  const lockFile = path.join(root, 'lock.json'); fs.writeFileSync(lockFile, canonicalBytes(data.lock));
  const calls = [];
  await fetchTrainingData({ trainingDir, cacheDir, lockFile, fetchImpl: artifactFetch(data, calls) });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(trainingDir, 'manifest.json'))), data.manifest);
  await checkTrainingData({ trainingDir, lockFile, deep: true });
  await fetchTrainingData({ trainingDir, cacheDir, lockFile, fetchImpl: () => { throw new Error('offline cache'); } });
  const groupPath = path.join(trainingDir, 'puzzles', data.manifest.puzzles.version);
  const inode = fs.statSync(groupPath).ino;
  await fetchTrainingData({ trainingDir, cacheDir, lockFile, fetchImpl: () => { throw new Error('offline cache'); } });
  assert.equal(fs.statSync(groupPath).ino, inode, 'valid immutable directories must not be renamed away/replaced');
  const manifestBefore = readManifestBytes(trainingDir), shard = [...data.files.keys()].find((name) => name.endsWith('.gz'));
  fs.appendFileSync(path.join(trainingDir, shard), '!');
  await assert.rejects(checkTrainingData({ trainingDir, lockFile }), /hash mismatch/);
  const corruptBytes = fs.readFileSync(path.join(trainingDir, shard));
  // Never repair a versioned directory in place, even with a verified archive.
  await assert.rejects(hydrateTrainingData({ trainingDir, cacheDir, lockFile, offline: true,
    fetchImpl: () => { throw new Error('must not download'); } }), /immutable version.*refusing to replace/);
  assert.deepEqual(readManifestBytes(trainingDir), manifestBefore);
  assert.deepEqual(fs.readFileSync(path.join(trainingDir, shard)), corruptBytes);
  assert.equal(fs.statSync(groupPath).ino, inode);
  assert(!fs.readdirSync(path.join(trainingDir, 'puzzles')).some((name) => name.includes('.old-')));
});

test('hydration holds the input lock through the manifest commit, not merely its stale-input check', async (t) => {
  const root = temporary(t), data = fixture();
  for (const local of [false, true]) {
    const base = path.join(root, local ? 'local' : 'production');
    fs.mkdirSync(base);
    const trainingDir = path.join(base, 'training'), lockFile = path.join(base, 'lock.json');
    const release = path.join(base, 'release');
    if (local) releaseOnDisk(release, data);
    else fs.writeFileSync(lockFile, canonicalBytes(data.lock));
    const inputKey = local ? release : lockFile;
    const rename = fs.renameSync;
    let checked = false;
    fs.renameSync = (from, to) => {
      if (physicalPath(to) === physicalPath(path.join(trainingDir, 'manifest.json'))) {
        checked = true;
        assert(fs.existsSync(`${physicalPath(inputKey)}.publication-lock/owner.json`));
        const contender = spawnSync(process.execPath, ['--input-type=module', '-e',
          `import { acquirePublicationLock } from './scripts/data-integrity.mjs'; const release = await acquirePublicationLock(${JSON.stringify(inputKey)}, {timeoutMs:0}); release();`], { encoding: 'utf8' });
        assert.notEqual(contender.status, 0, 'a pin/pack must not change the selected input between check and commit');
        assert.match(contender.stderr, /never stealing/);
      }
      return rename(from, to);
    };
    try {
      await hydrateTrainingData({ trainingDir, ...(local ? { localReleaseDir: release, offline: true }
        : { lockFile, cacheDir: path.join(base, 'cache'), fetchImpl: artifactFetch(data) }) });
    } finally { fs.renameSync = rename; }
    assert(checked);
    assert.deepEqual(JSON.parse(readManifestBytes(trainingDir)), data.manifest);
    assert(!fs.existsSync(`${physicalPath(inputKey)}.publication-lock`));
  }
});

test('failed hydration and stale publishers leave a previously published manifest intact', async (t) => {
  const root = temporary(t), live = fixture(), bad = fixture({ positions: [ordinary()] });
  const trainingDir = path.join(root, 'training'), lockFile = path.join(root, 'lock.json');
  writeFiles(trainingDir, live.files);
  const before = readManifestBytes(trainingDir);
  fs.writeFileSync(lockFile, canonicalBytes(bad.lock));
  await assert.rejects(fetchTrainingData({ trainingDir, lockFile, cacheDir: path.join(root, 'cache'), fetchImpl: artifactFetch(bad) }), /overlapping/);
  assert.deepEqual(readManifestBytes(trainingDir), before);
  assert.equal(validateData(trainingDir).manifest.puzzles.count, 1);
  const stageDir = path.join(root, 'stage'); writeFiles(stageDir, live.files);
  fs.appendFileSync(path.join(trainingDir, 'manifest.json'), '\n');
  await assert.rejects(publishStagedData({ stageDir, trainingDir, lock: live.lock, capturedManifest: before }), /live manifest changed/);
  assert.deepEqual(readManifestBytes(trainingDir), Buffer.concat([before, Buffer.from('\n')]));
  assert(!fs.readdirSync(root).some((name) => name.endsWith('publication-lock') || name.includes('hydrate-')));
});

test('build snapshots are frozen under publication lock and contain only current/previous allowlist', async (t) => {
  const root = temporary(t), first = fixture(), current = fixture({ puzzles: [{ ...puzzle, id: 'new' }] });
  current.lock.archives.puzzles.previous = first.lock.archives.puzzles.current;
  const trainingDir = path.join(root, 'training'), destination = path.join(root, 'snapshot'), lockFile = path.join(root, 'lock.json');
  writeFiles(trainingDir, first.files); writeFiles(trainingDir, current.files);
  fs.writeFileSync(path.join(trainingDir, 'stale.zip'), 'must not copy');
  fs.mkdirSync(path.join(trainingDir, 'puzzles', 'a'.repeat(64)));
  fs.writeFileSync(path.join(trainingDir, 'puzzles', 'a'.repeat(64), 'stale'), 'unlisted');
  fs.writeFileSync(lockFile, canonicalBytes(current.lock));
  const result = await snapshotTrainingData({ trainingDir, destination, lockFile });
  assert(result.files.some((name) => name.includes(first.manifest.puzzles.version)));
  assert(result.files.every((name) => !name.includes('stale')));
  assert(!fs.existsSync(path.join(destination, 'stale.zip')));
  assert(!fs.existsSync(path.join(destination, 'puzzles', 'a'.repeat(64))));
  const original = [...current.files.keys()].find((name) => name.endsWith('.gz'));
  fs.appendFileSync(path.join(trainingDir, original), 'changed after snapshot');
  assert.equal(validateData(destination).manifest.puzzles.count, 1);
  fs.appendFileSync(path.join(trainingDir, 'manifest.json'), 'bad');
  assert.equal(validateData(destination).manifest.schema, 3);
});

test('build requires a production lock/match, and local mode requires explicit input plus complete validation', async (t) => {
  const root = temporary(t), data = fixture(), trainingDir = path.join(root, 'training'); writeFiles(trainingDir, data.files);
  await assert.rejects(snapshotTrainingData({ trainingDir, destination: path.join(root, 'a'), lockFile: path.join(root, 'absent') }), /owner must bootstrap.*never download/s);
  await assert.rejects(snapshotTrainingData({ trainingDir, destination: path.join(root, 'b'), local: true }), /explicit --training-dir/);
  const mismatch = fixture({ puzzles: [{ ...puzzle, id: 'other' }] }), lockFile = path.join(root, 'lock.json');
  fs.writeFileSync(lockFile, canonicalBytes(mismatch.lock));
  await assert.rejects(snapshotTrainingData({ trainingDir, destination: path.join(root, 'c'), lockFile }), /does not match production lock/);
  const result = await snapshotTrainingData({ trainingDir, destination: path.join(root, 'd'), local: true, explicitTrainingDir: true });
  assert.equal(result.manifest.schema, 3);
});

test('production build and source recipe use frozen bytes even if live data/lock change during Vite', async (t) => {
  const root = temporary(t), first = fixture(), second = fixture({ puzzles: [{ ...puzzle, id: 'later' }] });
  const trainingDir = path.join(root, 'input'), lockFile = path.join(root, 'lock.json');
  writeFiles(trainingDir, first.files); fs.writeFileSync(lockFile, canonicalBytes(first.lock));
  const result = await buildSite({ projectRoot: root, trainingDir, outDir: 'site', lockFile,
    viteBuild: async (config) => {
      fs.writeFileSync(path.join(config.build.outDir, 'index.html'), 'synthetic production build');
      writeFiles(trainingDir, second.files); fs.writeFileSync(lockFile, canonicalBytes(second.lock));
    }, runSources: async ({ outDir, local, lockFile: frozenLock }) => {
      assert(!local); assert.notEqual(frozenLock, lockFile);
      assert.deepEqual(JSON.parse(fs.readFileSync(frozenLock)), first.lock);
      fs.writeFileSync(path.join(outDir, 'source.zip'), 'synthetic frozen source recipe');
    } });
  assert.equal(validateData(path.join(result.outDir, 'training')).manifest.puzzles.version, first.manifest.puzzles.version);
  assert(!fs.existsSync(path.join(result.outDir, 'local-preview.json')));
  assert.doesNotMatch(fs.readFileSync(path.join(result.outDir, 'index.html'), 'utf8'), /UNPINNED LOCAL PREVIEW/);
  assert.equal(JSON.parse(fs.readFileSync(lockFile)).manifest.puzzles.version, second.manifest.puzzles.version);
});

test('build never lets Vite copy public/training and preserves old output on validation/budget failure', async (t) => {
  const root = temporary(t), data = fixture(), trainingDir = path.join(root, 'input'), outDir = path.join(root, 'site');
  writeFiles(trainingDir, data.files);
  fs.mkdirSync(path.join(root, 'public', 'training'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'training', 'stale.zip'), 'excluded');
  fs.writeFileSync(path.join(root, 'public', 'theme.txt'), 'non-training asset');
  for (const name of ['.training-hydrate-concurrent', '.training-stage-python', 'training.publication-lock']) {
    fs.mkdirSync(path.join(root, 'public', name));
    fs.writeFileSync(path.join(root, 'public', name, 'unpinned'), 'must never be copied');
  }
  fs.mkdirSync(outDir); fs.writeFileSync(path.join(outDir, 'old'), 'previous build');
  const options = { projectRoot: root, trainingDir, outDir, local: true, explicitTrainingDir: true,
    viteBuild: async (config) => {
      assert.equal(config.build.copyPublicDir, false); assert.equal(config.publicDir, false);
      fs.writeFileSync(path.join(config.build.outDir, 'index.html'), 'fixture');
    }, runSources: async ({ outDir: output }) => fs.writeFileSync(path.join(output, 'source.zip'), 'synthetic source archive') };
  const result = await buildSite(options);
  assert(result.files > 1);
  assert(result.local);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'local-preview.json'))).production_pinned, false);
  assert.match(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), /local-preview-banner.*UNPINNED LOCAL PREVIEW/);
  assert.doesNotMatch(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), /local-preview-banner[^>]*position:(?:fixed|absolute)/, 'preview notices must not cover the board or intercept moves');
  assert(!fs.existsSync(path.join(outDir, 'training', 'stale.zip')));
  assert(fs.existsSync(path.join(outDir, 'theme.txt')));
  assert(!fs.readdirSync(outDir).some((name) => name.includes('training-') || name.endsWith('publication-lock')));
  assert(!fs.existsSync(path.join(outDir, 'old')));
  const before = fs.readFileSync(path.join(outDir, 'index.html'));
  await assert.rejects(buildSite({ ...options, runSources: async ({ outDir: output }) => {
    const fd = fs.openSync(path.join(output, 'source.zip'), 'w'); fs.ftruncateSync(fd, LIMITS.source + 1); fs.closeSync(fd);
  } }), /source.zip exceeds/);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'index.html')), before);
  assert(!fs.readdirSync(root).some((name) => name.startsWith('.site-build-')));
});

test('unsafe build output roots are rejected even with external training and trailing project slash', async (t) => {
  const root = temporary(t), external = temporary(t), data = fixture(); writeFiles(external, data.files);
  fs.writeFileSync(path.join(root, 'sentinel'), 'must survive');
  for (const outDir of ['.', '..', 'web', 'public/nested', 'scripts', 'data', 'node_modules/subdirectory']) {
    await assert.rejects(buildSite({ projectRoot: `${root}${path.sep}`, trainingDir: external, outDir,
      local: true, explicitTrainingDir: true, viteBuild: () => { throw new Error('must not reach Vite'); } }), /unsafe build output/);
    assert.equal(fs.readFileSync(path.join(root, 'sentinel'), 'utf8'), 'must survive');
  }
  const sharedWeb = temporary(t); fs.mkdirSync(path.join(sharedWeb, 'components'));
  fs.writeFileSync(path.join(sharedWeb, 'components', 'sentinel'), 'source must survive');
  fs.symlinkSync(sharedWeb, path.join(root, 'web'), 'dir');
  await assert.rejects(buildSite({ projectRoot: root, trainingDir: external, outDir: 'web/components', local: true,
    explicitTrainingDir: true, viteBuild: () => { throw new Error('must not reach Vite'); } }), /unsafe build output/);
  assert.equal(fs.readFileSync(path.join(sharedWeb, 'components', 'sentinel'), 'utf8'), 'source must survive');
});

test('malformed descriptor kinds cannot escape extraction root', async (t) => {
  const root = temporary(t), data = fixture(), filename = path.join(root, 'archive.zip'), destination = path.join(root, 'destination');
  fs.writeFileSync(filename, data.artifacts.get(data.archives.puzzles.file)); fs.mkdirSync(destination);
  for (const kind of ['../escape', 'puzzles/../../escape', '/absolute', 'unrecognized']) {
    const descriptor = { ...data.archives.puzzles, kind, file: `${kind}-${data.archives.puzzles.version}.zip` };
    await assert.rejects(extractArchive(filename, destination, descriptor), /invalid archive kind/);
  }
  assert.deepEqual(fs.readdirSync(destination), []);
  assert(!fs.existsSync(path.join(root, 'escape')));
});

test('snapshot waits for publisher and freezes the manifest/lock actually protected by that lock', async (t) => {
  const root = temporary(t), first = fixture(), second = fixture({ puzzles: [{ ...puzzle, id: 'after-lock' }] });
  const trainingDir = path.join(root, 'training'), destination = path.join(root, 'snapshot'), lockFile = path.join(root, 'lock.json');
  writeFiles(trainingDir, first.files); fs.writeFileSync(lockFile, canonicalBytes(first.lock));
  const release = await acquirePublicationLock(trainingDir);
  const pending = snapshotTrainingData({ trainingDir, destination, lockFile, lockOptions: { timeoutMs: 1000, pollMs: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert(!fs.existsSync(destination));
  writeFiles(trainingDir, second.files); fs.writeFileSync(lockFile, canonicalBytes(second.lock)); release();
  const result = await pending;
  assert.equal(result.manifest.puzzles.version, second.manifest.puzzles.version);
  assert.deepEqual(JSON.parse(result.lockBytes), second.lock);
  fs.writeFileSync(lockFile, canonicalBytes(first.lock));
  assert.deepEqual(JSON.parse(result.lockBytes), second.lock, 'source recipes get frozen lock bytes, not the later live lock');
});

test('changed manifest or production lock during downloads cannot be overwritten', async (t) => {
  const root = temporary(t), data = fixture();
  for (const changed of ['manifest', 'lock']) {
    const directory = path.join(root, changed), trainingDir = path.join(directory, 'training'), lockFile = path.join(directory, 'lock.json');
    writeFiles(trainingDir, data.files); fs.writeFileSync(lockFile, canonicalBytes(data.lock));
    let mutated = false;
    const target = changed === 'manifest' ? path.join(trainingDir, 'manifest.json') : lockFile;
    const original = fs.readFileSync(target);
    await assert.rejects(fetchTrainingData({ trainingDir, lockFile, cacheDir: path.join(directory, 'cache'), fetchImpl: async (url) => {
      if (!mutated) { mutated = true; fs.appendFileSync(target, '\n'); }
      return artifactFetch(data)(url);
    } }), changed === 'manifest' ? /live manifest changed/ : /production lock changed/);
    assert.deepEqual(fs.readFileSync(target), Buffer.concat([original, Buffer.from('\n')]));
    assert.equal(validateData(trainingDir).manifest.schema, 3);
  }
});

test('publication move failure rolls new groups back without changing the live manifest', async (t) => {
  const root = temporary(t), first = fixture(), second = fixture({ puzzles: [{ ...puzzle, id: 'next' }],
    positions: [{ ...ordinary(START, 'd2d4', ['d7d5', 'g8f6']), id: 'next-ordinary' }] });
  const trainingDir = path.join(root, 'training'), stageDir = path.join(root, 'stage');
  writeFiles(trainingDir, first.files); writeFiles(stageDir, second.files);
  const before = readManifestBytes(trainingDir);
  const blocked = path.join(trainingDir, 'ordinary', second.manifest.ordinary.version); fs.writeFileSync(blocked, 'not a directory');
  await assert.rejects(publishStagedData({ stageDir, trainingDir, lock: second.lock, capturedManifest: before }), /unsafe live version directory/);
  assert.deepEqual(readManifestBytes(trainingDir), before);
  assert(!fs.existsSync(path.join(trainingDir, 'puzzles', second.manifest.puzzles.version)));
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'not a directory');
  assert.equal(validateData(trainingDir).manifest.puzzles.version, first.manifest.puzzles.version);
});

test('promotion rollback touches only newly installed versions when a group move or manifest commit fails', async (t) => {
  const root = temporary(t), previous = fixture(), next = fixture({ puzzles: [{ ...puzzle, id: 'next' }],
    positions: [{ ...ordinary(START, 'd2d4', ['d7d5', 'g8f6']), id: 'next-ordinary' }] });
  for (const failure of ['group', 'manifest']) {
    const trainingDir = path.join(root, failure, 'training'), stageDir = path.join(root, failure, 'stage');
    writeFiles(trainingDir, previous.files); writeFiles(stageDir, next.files);
    const before = readManifestBytes(trainingDir), rename = fs.renameSync, moves = [];
    const oldGroup = path.join(trainingDir, 'puzzles', previous.manifest.puzzles.version), inode = fs.statSync(oldGroup).ino;
    const failTarget = physicalPath(failure === 'group' ? path.join(trainingDir, 'ordinary', next.manifest.ordinary.version) : path.join(trainingDir, 'manifest.json'));
    fs.renameSync = (source, target) => {
      assert.deepEqual(readManifestBytes(trainingDir), before, 'the manifest remains unchanged until the last move');
      if (target === failTarget) throw new Error(`simulated ${failure} rename failure`);
      moves.push(target);
      return rename(source, target);
    };
    try {
      await assert.rejects(publishStagedData({ stageDir, trainingDir, candidate: next.candidate, capturedManifest: before }), /simulated.*rename failure/);
    } finally { fs.renameSync = rename; }
    assert.equal(moves.length, failure === 'group' ? 1 : 2);
    assert.deepEqual(readManifestBytes(trainingDir), before);
    for (const [name, bytes] of previous.files) assert.deepEqual(fs.readFileSync(path.join(trainingDir, name)), bytes);
    for (const kind of ['puzzles', 'ordinary']) assert(!fs.existsSync(path.join(trainingDir, kind, next.manifest[kind].version)));
    assert.equal(fs.statSync(oldGroup).ino, inode);
    assert(!fs.existsSync(`${physicalPath(trainingDir)}.publication-lock`));
    assert(!fs.readdirSync(trainingDir).some((name) => name.includes('.tmp-')));
  }
});

test('real Vite local build uses synthetic input and excludes unpinned public data', async (t) => {
  const root = temporary(t), data = fixture(); writeFiles(path.join(root, 'public', 'export'), data.files);
  fs.writeFileSync(path.join(root, 'public', 'export', 'stale.zip'), 'not allowlisted');
  fs.mkdirSync(path.join(root, 'public', '.export-hydrate-concurrent'));
  fs.writeFileSync(path.join(root, 'public', '.export-hydrate-concurrent', 'unlisted'), 'not allowlisted');
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><script type="module" src="/entry.js"></script>');
  fs.writeFileSync(path.join(root, 'entry.js'), 'document.body.textContent = "synthetic";');
  fs.writeFileSync(path.join(root, 'vite.config.js'), 'export default { base: "./" };');
  fs.mkdirSync(path.join(root, 'public', 'training'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'training', 'unlisted.zip'), 'never copied');
  const result = await buildSite({ projectRoot: root, trainingDir: 'public/export', outDir: 'site', local: true, explicitTrainingDir: true,
    runSources: async ({ outDir, local, lockFile }) => {
      assert(local); assert.equal(lockFile, null); fs.writeFileSync(path.join(outDir, 'source.zip'), 'synthetic source');
    } });
  assert(fs.existsSync(path.join(result.outDir, 'index.html')));
  assert(!fs.existsSync(path.join(result.outDir, 'training', 'unlisted.zip')));
  assert(!fs.existsSync(path.join(result.outDir, 'export')));
  assert(!fs.existsSync(path.join(result.outDir, '.export-hydrate-concurrent')));
  assert.equal(validateData(path.join(result.outDir, 'training')).manifest.schema, 3);
});

test('a training directory equal to public itself is never copied as ordinary public assets', (t) => {
  const root = temporary(t), source = path.join(root, 'public'), destination = path.join(root, 'copied');
  writeFiles(source, fixture().files); fs.writeFileSync(path.join(source, 'stale.zip'), 'unlisted');
  copyPublicAssets(source, destination, { trainingDir: source });
  assert(!fs.existsSync(destination));
});

test('site size includes all deployable bytes; CLI fails clearly without owner lock', (t) => {
  const root = temporary(t), site = path.join(root, 'site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'source.zip'), 'source');
  const fd = fs.openSync(path.join(site, 'oversize'), 'w'); fs.ftruncateSync(fd, LIMITS.site); fs.closeSync(fd);
  assert.throws(() => measureSite(site), /site exceeds/);
  const result = spawnSync(process.execPath, ['scripts/build.mjs', '--lock', path.join(root, 'missing'), '--out-dir', path.join(root, 'out')], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /repository owner must bootstrap/);
  assert(!fs.existsSync(path.join(root, 'out')));
});

test('default lock is tracked at repository root, cache is content-addressed, npm hydration interface is explicit', () => {
  assert.equal(DEFAULT_LOCK, 'training-data.lock.json');
  assert.equal(DEFAULT_CACHE, 'data/training/archives');
  const { scripts } = JSON.parse(fs.readFileSync('package.json'));
  assert.equal(scripts['data:hydrate'], 'node scripts/training-data.mjs hydrate');
  assert.equal(scripts['data:check'], 'node scripts/training-data.mjs check');
  assert.equal(scripts['data:pin'], 'node scripts/training-data.mjs pin');
  for (const filename of ['C:escape', 'C:/escape', 'z:relative', '/absolute', '../escape', 'a/../escape', 'a\\escape']) {
    assert.throws(() => safeRelative(filename), /unsafe path/);
  }
  assert.equal(safeRelative('puzzles/version/-9007199254740991/0.json.gz'), 'puzzles/version/-9007199254740991/0.json.gz');
});

test('rating inventories and ZIP extraction accept sorted unique pairs for every safe integer, including negative ratings', async (t) => {
  const root = temporary(t), directory = path.join(root, 'training'), release = path.join(root, 'release');
  const ratings = [Number.MIN_SAFE_INTEGER, -1700, 0, 1700, Number.MAX_SAFE_INTEGER];
  const data = fixture({ puzzles: ratings.map((rating, index) => ({ ...puzzle, id: `p${index}`, rating })) });
  assert.deepEqual(data.manifest.puzzles.rating_counts, ratings.map((rating) => [rating, 1]));
  releaseOnDisk(release, data);
  const result = await hydrateTrainingData({ trainingDir: directory, localReleaseDir: release, offline: true,
    lockFile: path.join(root, 'must-not-be-read'), fetchImpl: () => { throw new Error('must never download'); } });
  assert(result.local);
  assert.deepEqual(result.manifest, data.manifest);
  assert.equal(validateCandidateData(directory, data.candidate, { deep: true }).manifest.puzzles.count, ratings.length);
  for (const rating of ratings) assert(fs.existsSync(path.join(directory, 'puzzles', data.manifest.puzzles.version, String(rating), '0.json.gz')));
  assert(!fs.existsSync(path.join(root, 'must-not-be-read')));
});

test('offline cache misses/corruption never use network or alter current/previous publication', async (t) => {
  const root = temporary(t), previous = fixture(), next = fixture({ puzzles: [{ ...puzzle, id: 'next' }] });
  next.lock.archives.puzzles.previous = previous.lock.archives.puzzles.current;
  for (const slot of ['current', 'previous']) for (const problem of ['miss', 'corruption']) {
    const base = path.join(root, `${slot}-${problem}`), trainingDir = path.join(base, 'training'), cacheDir = path.join(base, 'cache');
    writeFiles(trainingDir, previous.files);
    const lockFile = path.join(base, 'lock.json'); fs.writeFileSync(lockFile, canonicalBytes(next.lock));
    fs.mkdirSync(cacheDir);
    for (const data of [previous, next]) for (const descriptor of Object.values(data.archives)) {
      fs.writeFileSync(path.join(cacheDir, `${descriptor.sha256}.zip`), data.artifacts.get(descriptor.file));
    }
    const descriptor = next.lock.archives.puzzles[slot], cacheFile = path.join(cacheDir, `${descriptor.sha256}.zip`);
    if (problem === 'miss') fs.rmSync(cacheFile); else fs.appendFileSync(cacheFile, 'corrupt');
    const cacheBefore = problem === 'corruption' ? fs.readFileSync(cacheFile) : null;
    const before = readManifestBytes(trainingDir), lockBefore = fs.readFileSync(lockFile);
    const group = path.join(trainingDir, 'puzzles', previous.manifest.puzzles.version), inode = fs.statSync(group).ino;
    let networkCalls = 0;
    await assert.rejects(hydrateTrainingData({ trainingDir, lockFile, cacheDir, offline: true,
      fetchImpl: () => { networkCalls++; throw new Error('must not download'); } }), new RegExp(`offline archive cache ${problem}`));
    assert.equal(networkCalls, 0);
    assert.deepEqual(readManifestBytes(trainingDir), before);
    assert.deepEqual(fs.readFileSync(lockFile), lockBefore);
    for (const [name, bytes] of previous.files) assert.deepEqual(fs.readFileSync(path.join(trainingDir, name)), bytes);
    assert.equal(fs.statSync(group).ino, inode);
    assert(!fs.existsSync(path.join(trainingDir, 'puzzles', next.manifest.puzzles.version)));
    if (cacheBefore) assert.deepEqual(fs.readFileSync(cacheFile), cacheBefore);
    assert(!fs.readdirSync(base).some((name) => name.includes('hydrate-') || name.endsWith('publication-lock')));
  }
});

test('offline hydration reuses verified cache, retains previous groups, and never writes the production lock', async (t) => {
  const root = temporary(t), previous = fixture(), next = fixture({ puzzles: [{ ...puzzle, id: 'next' }] });
  const trainingDir = path.join(root, 'training'), cacheDir = path.join(root, 'cache'), lockFile = path.join(root, 'lock.json');
  writeFiles(trainingDir, previous.files);
  next.lock.archives.puzzles.previous = previous.lock.archives.puzzles.current;
  fs.writeFileSync(lockFile, canonicalBytes(next.lock)); fs.mkdirSync(cacheDir);
  const oldGroup = path.join(trainingDir, 'puzzles', previous.manifest.puzzles.version), inode = fs.statSync(oldGroup).ino;
  for (const data of [previous, next]) for (const descriptor of Object.values(data.archives)) {
    fs.writeFileSync(path.join(cacheDir, `${descriptor.sha256}.zip`), data.artifacts.get(descriptor.file));
  }
  const before = fs.readFileSync(lockFile);
  await hydrateTrainingData({ trainingDir, cacheDir, lockFile, offline: true,
    fetchImpl: () => { throw new Error('must never download'); } });
  assert.deepEqual((await checkTrainingData({ trainingDir, lockFile, deep: true })).manifest, next.manifest);
  assert.equal(fs.statSync(oldGroup).ino, inode);
  for (const [name, bytes] of previous.files) if (name !== 'manifest.json') assert.deepEqual(fs.readFileSync(path.join(trainingDir, name)), bytes);
  assert.deepEqual(fs.readFileSync(lockFile), before);
});

test('hydrate --local-release --output --offline and check --local need no production lock or invented URL', (t) => {
  const root = temporary(t), data = fixture({ puzzles: [{ ...puzzle, rating: -100 }] });
  const release = path.join(root, 'release'), trainingDir = path.join(root, 'training'); releaseOnDisk(release, data);
  const sentinel = path.join(root, DEFAULT_LOCK); fs.writeFileSync(sentinel, 'invalid lock: local mode must not read or write me');
  const script = path.resolve('scripts/training-data.mjs');
  const hydrate = spawnSync(process.execPath, [script, 'hydrate', '--local-release', release, '--output', trainingDir, '--offline'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(hydrate.status, 0, hydrate.stderr);
  assert.match(hydrate.stdout, /UNPINNED LOCAL PREVIEW/);
  const check = spawnSync(process.execPath, [script, 'check', '--local', '--training-dir', trainingDir], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /1 puzzles.*no production lock read or written/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'invalid lock: local mode must not read or write me');
  assert(!fs.existsSync(path.join(root, 'data')));
  const refused = spawnSync(process.execPath, [script, 'hydrate', '--local-release', release, '--offline'], { cwd: root, encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.match(refused.stderr, /explicit --output or --training-dir/);
});

test('local candidate validation fails closed for malformed metadata, corrupt archives, and stale candidate publication', async (t) => {
  const root = temporary(t), previous = fixture(), next = fixture({ puzzles: [{ ...puzzle, id: 'next' }] });
  const trainingDir = path.join(root, 'training'), release = path.join(root, 'release');
  writeFiles(trainingDir, previous.files); const candidateFile = releaseOnDisk(release, next);
  const before = readManifestBytes(trainingDir);
  for (const mutate of [
    (candidate) => { candidate.format = 2; },
    (candidate) => { candidate.manifest.schema = 2; },
    (candidate) => { candidate.archives.puzzles.version = 'a'.repeat(64); candidate.archives.puzzles.file = `puzzles-${'a'.repeat(64)}.zip`; },
    (candidate) => { candidate.archives.puzzles.count++; },
    (candidate) => { candidate.archives.puzzles.url = 'https://not-a-production-release.invalid/puzzles.zip'; },
    (candidate) => { candidate.archives.ordinary.extracted_bytes = LIMITS.site; },
  ]) {
    const candidate = structuredClone(next.candidate); mutate(candidate);
    assert.throws(() => validateReleaseCandidate(candidate), /Invalid training data/);
    fs.writeFileSync(candidateFile, canonicalBytes(candidate));
    await assert.rejects(hydrateTrainingData({ trainingDir, localReleaseDir: release, offline: true }), /Invalid training data/);
    assert.deepEqual(readManifestBytes(trainingDir), before);
  }
  fs.writeFileSync(candidateFile, canonicalBytes(next.candidate));
  fs.appendFileSync(path.join(release, next.archives.ordinary.file), 'corruption');
  await assert.rejects(hydrateTrainingData({ trainingDir, localReleaseDir: release, offline: true }), /archive|oversized/);
  assert.deepEqual(readManifestBytes(trainingDir), before);
  assert(!fs.existsSync(path.join(trainingDir, 'puzzles', next.manifest.puzzles.version)));
  const stageDir = path.join(root, 'stage'); writeFiles(stageDir, next.files);
  const capturedCandidate = fs.readFileSync(candidateFile); fs.appendFileSync(candidateFile, '\n');
  await assert.rejects(publishStagedData({ trainingDir, stageDir, candidate: next.candidate, candidateFile, capturedCandidate,
    capturedManifest: before }), /local release candidate changed/);
  assert.deepEqual(readManifestBytes(trainingDir), before);
  assert(!fs.readdirSync(root).some((name) => name.includes('hydrate-') || name.endsWith('publication-lock')));
});

test('publication locks resolve symlink parents before dot-dot like Python Path.resolve, including missing descendants', async (t) => {
  const root = temporary(t); fs.mkdirSync(path.join(root, 'physical', 'nested'), { recursive: true });
  fs.symlinkSync(path.join(root, 'physical', 'nested'), path.join(root, 'alias'), 'dir');
  const output = `${root}/alias/../not-created/training`;
  const resolved = `${fs.realpathSync(root)}/physical/not-created/training`;
  assert.equal(physicalPath(output), resolved);
  const release = await acquirePublicationLock(output);
  assert(fs.existsSync(`${resolved}.publication-lock/owner.json`));
  await assert.rejects(acquirePublicationLock(resolved, { timeoutMs: 0 }), /never stealing/);
  const python = process.env.PYTHON || path.resolve('.venv/bin/python');
  if (fs.existsSync(python)) {
    const result = spawnSync(python, ['-c',
      'import sys; from pathlib import Path; from training_assets import publication_lock; output = Path(sys.argv[1]); print(output.resolve(), flush=True)\nwith publication_lock(output, timeout=0.01): pass', output], { encoding: 'utf8' });
    assert.equal(result.stdout.trim(), resolved);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Timed out waiting for publication lock/);
  }
  release();
  assert(!fs.existsSync(`${resolved}.publication-lock`));
});

test('Python-packaged local release archives hydrate through the actual offline CLI with negative safe ratings', (t) => {
  const python = process.env.PYTHON || path.resolve('.venv/bin/python');
  if (!fs.existsSync(python)) { t.skip('Python with python-chess is optional for Node-only installs'); return; }
  const root = temporary(t), source = path.join(root, 'python-training'), release = path.join(root, 'release'), output = path.join(root, 'hydrated');
  const input = path.join(root, 'records.json');
  const ratings = [Number.MIN_SAFE_INTEGER, -1, 0, Number.MAX_SAFE_INTEGER];
  fs.writeFileSync(input, canonicalBytes({ puzzles: ratings.map((rating, index) => ({ ...puzzle, id: `p${index}`, rating })),
    ordinary: [ordinary(START, 'd2d4', ['d7d5', 'g8f6'])] }));
  const generated = spawnSync(python, ['-c', [
    'import json, sys', 'from pathlib import Path', 'from training_assets import export_assets', 'from package_corpus import pack_corpus',
    'records = json.loads(Path(sys.argv[1]).read_bytes())',
    'export_assets(Path(sys.argv[2]), records["puzzles"], records["ordinary"], {"engine":"Fixture","nodes":100000,"sampled_games":1}, puzzle_shard_size=128)',
    'pack_corpus(Path(sys.argv[2]), Path(sys.argv[3]))',
  ].join('\n'), input, source, release], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const hydrated = spawnSync(process.execPath, [path.resolve('scripts/training-data.mjs'), 'hydrate', '--local-release', release,
    '--output', output, '--offline'], { encoding: 'utf8', cwd: root });
  assert.equal(hydrated.status, 0, hydrated.stderr);
  assert.match(hydrated.stdout, /UNPINNED LOCAL PREVIEW/);
  assert.deepEqual(validateData(output, { deep: true, enforceBudgets: true }).manifest.puzzles.rating_counts, ratings.map((rating) => [rating, 1]));
  const verified = spawnSync(python, ['-c', [
    'import json, sys', 'from pathlib import Path', 'from training_assets import read_group',
    'directory = Path(sys.argv[1]); manifest = json.loads((directory / "manifest.json").read_bytes())',
    'print(json.dumps([record["rating"] for record in read_group(directory, manifest["puzzles"], "puzzles")]))',
  ].join('\n'), output], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr); assert.deepEqual(JSON.parse(verified.stdout), ratings);
  assert(!fs.existsSync(path.join(root, DEFAULT_LOCK)));
});

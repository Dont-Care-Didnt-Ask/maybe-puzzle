import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'fflate';
import { Catalog, ReferencePool } from '../web/catalog.js';
import { Deck } from '../web/session.js';
import { validateManifest, validateRecord } from '../web/format.js';
import { ordinaryShardPath, puzzleShardPath, resolveSchema3Reference } from '../web/data-layout.js';
import { validateData } from '../scripts/validate-data.mjs';
import { makeSchema1Assets as makeAssets, makeSchema2Assets, makeSchema3Assets } from './data-fixtures.js';
import { ordinary, puzzle } from './fixtures.js';

const base = new URL('https://example.test/chess-puzzle-not-puzzle/training/');
function fetchAssets(files, calls = []) {
  return async (url) => {
    calls.push(String(url));
    const bytes = files.get(new URL(url).pathname.slice(base.pathname.length));
    return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
  };
}

test('only manifest on startup; exact anchor ± margin without downloading records', async () => {
  const { files } = makeAssets([1400, 1700, 1701, 2000].map((rating) => ({ ...puzzle, id: String(rating), rating })));
  const calls = [];
  const catalog = await Catalog.load(base, fetchAssets(files, calls));
  assert.deepEqual(calls, [String(new URL('manifest.json', base))]);
  const refs = catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 });
  assert.equal(refs.length, 1);
  assert.equal(calls.length, 1);
  assert.equal((await catalog.get(refs[0])).rating, 1700);
  assert.equal(calls.length, 2);
  assert(calls.every((url) => url.startsWith(String(base))));
  assert.equal(catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 300 }).length, 4);
});

test('missing local data explains explicit hydration and prepared-data builds, without fallback', async () => {
  const calls = [];
  await assert.rejects(Catalog.load(base, async (url) => {
    calls.push(String(url));
    return new Response('missing', { status: 404 });
  }), /npm run data:hydrate.*--training-dir <prepared-directory> --local/);
  assert.deepEqual(calls, [String(new URL('manifest.json', base))]);
});

test('fetch is called without a Catalog receiver for every schema, as required by Window.fetch', async () => {
  for (const make of [makeAssets, makeSchema2Assets, makeSchema3Assets]) {
    const { files } = make();
    const fetcher = function (url) {
      assert.equal(this, undefined);
      return fetchAssets(files)(url);
    };
    const catalog = await Catalog.load(base, fetcher);
    await catalog.get(catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 }).at(0));
  }
});

test('concurrent shard requests share a fetch and the cache stays bounded', async () => {
  const puzzles = [1, 2, 3].map((id) => ({ ...puzzle, id: String(id) }));
  const { manifest, files } = makeAssets(puzzles, [ordinary()], 1);
  const calls = [];
  const catalog = new Catalog(manifest, base, fetchAssets(files, calls), 1);
  const refs = catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 });
  await Promise.all([catalog.get(refs[0]), catalog.get(refs[0])]);
  assert.equal(calls.length, 1);
  await catalog.get(refs[1]);
  assert.equal(catalog.cache.size, 1);
  await catalog.get(refs[0]);
  assert.equal(calls.length, 3);
});

test('failed or corrupt shard can be retried, not permanently cached', async () => {
  const { manifest, files } = makeAssets();
  let fail = true;
  const catalog = new Catalog(manifest, base, async (url) => fail
    ? new Response('not gzip') : fetchAssets(files)(url));
  const ref = catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 })[0];
  await assert.rejects(catalog.get(ref));
  assert.equal(catalog.cache.size, 0);
  fail = false;
  assert.equal((await catalog.get(ref)).id, puzzle.id);
});

test('shards also work if the static host already decoded HTTP gzip', async () => {
  const { manifest, files } = makeAssets();
  files.set(manifest.puzzles.shards[0].file, new TextEncoder().encode(JSON.stringify([puzzle])));
  const catalog = new Catalog(manifest, base, fetchAssets(files));
  const ref = catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 })[0];
  assert.equal((await catalog.get(ref)).id, puzzle.id);
});

test('decoded but invalid records also evict the failed cache entry', async () => {
  const { manifest, files } = makeAssets();
  const bad = makeAssets([{ ...puzzle, moves: ['e2e4', 'e7e4'] }]);
  const filename = manifest.puzzles.shards[0].file;
  const original = files.get(filename);
  files.set(filename, bad.files.get(bad.manifest.puzzles.shards[0].file));
  const catalog = new Catalog(manifest, base, fetchAssets(files));
  const ref = catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 })[0];
  await assert.rejects(catalog.get(ref));
  assert.equal(catalog.cache.size, 0);
  files.set(filename, original);
  assert.equal((await catalog.get(ref)).id, puzzle.id);
});

test('network deadlines cover response bodies and allow retrying the same shard', async () => {
  const { manifest, files } = makeAssets();
  let stalled = true;
  const fetcher = async (url, { signal }) => {
    if (!stalled) return fetchAssets(files)(url);
    const body = () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { ok: true, json: body, arrayBuffer: body };
  };
  await assert.rejects(Catalog.load(base, fetcher, 10), /timed out/);
  const catalog = new Catalog(manifest, base, fetcher, 8, 10);
  const ref = catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 })[0];
  await assert.rejects(catalog.get(ref), /timed out/);
  assert.equal(catalog.cache.size, 0);
  stalled = false;
  assert.equal((await catalog.get(ref)).id, puzzle.id);
});

test('manifest rejects unsafe paths, count mismatches, missing rating metadata', () => {
  for (const mutate of [
    (m) => { m.schema = 9; },
    (m) => { delete m.sampled_games; },
    (m) => { m.nodes = 0; },
    (m) => { m.engine = null; },
    (m) => { m.puzzles.shards[0].file = '../secret.json.gz'; },
    (m) => { m.puzzles.count++; },
    (m) => { m.puzzles.shards[0].ratings = []; },
    (m) => { m.ordinary.count = 0; },
  ]) {
    const { manifest } = makeAssets();
    mutate(manifest);
    assert.throws(() => validateManifest(manifest), /Invalid training data/);
  }
});

test('record validation requires every legal move and two genuinely acceptable choices', () => {
  const source = ordinary();
  validateRecord(source, 'ordinary');
  for (const mutate of [
    (p) => { delete p.scores.f7f6; },
    (p) => { p.scores.e2e4 = 0; },
    (p) => { p.scores.c7c5 = -31; },
    (p) => { p.scores.f7f6 = 'M3'; },
    (p) => { p.best_cp = 500; },
    (p) => { p.line = ['e2e4']; },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() => validateRecord(changed, 'ordinary'));
  }
});

test('build validator verifies gzip hashes, legality, rating index, and overlaps', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpnp-data-'));
  try {
    const { files } = makeAssets();
    for (const [name, bytes] of files) fs.writeFileSync(path.join(directory, name), bytes);
    assert.equal(validateData(directory).manifest.puzzles.count, 1);
    const shard = [...files.keys()].find((name) => name.endsWith('.gz'));
    fs.appendFileSync(path.join(directory, shard), 'corruption');
    assert.throws(() => validateData(directory), /hash mismatch/);
    const overlapping = makeAssets([puzzle], [ordinary()]);
    for (const [name, bytes] of overlapping.files) fs.writeFileSync(path.join(directory, name), bytes);
    assert.throws(() => validateData(directory), /overlapping/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('schema 2 exact rating ranges stay compact and fetch only the selected shard', async () => {
  const puzzles = [2099, 2100, 2400, 2400, 2700, 2701].map((rating, id) => ({ ...puzzle, id: String(id), rating }));
  const { manifest, files } = makeSchema2Assets(puzzles, [ordinary()], 2);
  const calls = [];
  const catalog = new Catalog(manifest, base, fetchAssets(files, calls));
  const refs = catalog.refs('puzzle', { anchor_rating: 2400, rating_margin: 300 });
  assert(refs instanceof ReferencePool);
  assert.equal(refs.length, 4);
  assert.equal(refs.ranges.length, 3);
  assert.deepEqual(refs.at(0), { kind: 'puzzle', shard: 1, row: 0 });
  assert.equal((await catalog.get(refs.at(1))).rating, 2400);
  assert.equal(calls.length, 1);
  assert.equal(catalog.refs('puzzle', { anchor_rating: 2400, rating_margin: 0 }).length, 2);
  assert.equal(catalog.refs('puzzle', { anchor_rating: 3500, rating_margin: 0 }).length, 0);
  assert.throws(() => refs.at(4), /invalid pool index/);
  delete manifest.puzzles.shards[0].rating;
  assert.throws(() => validateManifest(manifest), /exact shard rating/);
});

test('a multi-million-puzzle pool and deck allocate only ranges and drawn swaps', () => {
  const pool = new ReferencePool('puzzle', [{ rating: 2400, count: 6_000_000 }], { anchor_rating: 2400, rating_margin: 0 });
  const deck = new Deck(pool, () => 0.4);
  const drawn = new Set(Array.from({ length: 1000 }, () => deck.draw().row));
  assert.equal(drawn.size, 1000);
  assert.equal(pool.ranges.length, 1);
  assert(deck.swaps.size <= 1000);
  assert.equal(deck.remaining, pool.length - 1000);
});

test('schema 2 build checks cover hashes, exact ratings, overlaps, and optional deep replay', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpnp-full-'));
  try {
    const { files } = makeSchema2Assets([puzzle], undefined, 2);
    for (const [name, bytes] of files) fs.writeFileSync(path.join(directory, name), bytes);
    assert.equal(validateData(directory).manifest.schema, 2);
    assert.equal(validateData(directory, { deep: true }).manifest.puzzles.count, 1);
    const bad = makeSchema2Assets([puzzle], [ordinary()], 2);
    for (const [name, bytes] of bad.files) fs.writeFileSync(path.join(directory, name), bytes);
    assert.throws(() => validateData(directory), /overlapping/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

const realTrainingDirectory = process.env.TRAINING_DIR || 'public/training';
test('real training corpus validates when present (mandatory with REQUIRE_TRAINING_DATA=1)', {
  skip: !fs.existsSync(path.join(realTrainingDirectory, 'manifest.json')) && process.env.REQUIRE_TRAINING_DATA !== '1',
}, () => {
  assert(fs.existsSync(path.join(realTrainingDirectory, 'manifest.json')), `REQUIRE_TRAINING_DATA=1 requires ${realTrainingDirectory}; run npm run data:hydrate or select explicit local prepared data with TRAINING_DIR.`);
  const { manifest } = validateData(realTrainingDirectory);
  assert(manifest.puzzles.count > 0);
  assert(manifest.ordinary.count > 0);
});

const interval = (anchor_rating = 1700, rating_margin = 0) => ({ anchor_rating, rating_margin });
const manyPuzzles = (count, rating = 1700) => Array.from({ length: count }, (_, index) =>
  ({ ...puzzle, id: `p-${String(index).padStart(6, '0')}`, rating }));
const compressed = (value) => gzipSync(new TextEncoder().encode(JSON.stringify(value)), { mtime: 0 });

function writeAssets(directory, files) {
  for (const [relative, bytes] of files) {
    const filename = path.join(directory, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  }
}

test('all three fixture producers preserve arbitrary safe integer ratings and schema 3 emits exact sorted pairs', async () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const ratings = [maximum, -1, 3501, -maximum, 0, -1, maximum];
  const expected = [[-maximum, 1], [-1, 2], [0, 1], [3501, 1], [maximum, 2]];
  const records = ratings.map((rating, index) => ({ ...puzzle, id: `rating-${index}`, rating }));
  for (const make of [makeAssets, makeSchema2Assets, makeSchema3Assets]) {
    const { manifest, files, inventories } = make(records);
    if (manifest.schema === 3) {
      assert.deepEqual(manifest.puzzles.rating_counts, expected);
      assert.deepEqual(inventories.puzzles.rating_counts, expected);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))).puzzles.rating_counts, expected);
    } else assert.equal('rating_counts' in manifest.puzzles, false);
    const calls = [];
    const catalog = await Catalog.load(base, fetchAssets(files, calls));
    const refs = catalog.refs('puzzle', interval(0, maximum));
    assert.equal(refs.length, records.length);
    assert.equal(catalog.refs('puzzle', interval(-maximum)).length, 1);
    assert.equal(catalog.refs('puzzle', interval(-1)).length, 2);
    assert.equal(catalog.refs('puzzle', interval(maximum)).length, 2);
    assert.deepEqual(calls, [String(new URL('manifest.json', base))]);
    const loaded = await Promise.all(Array.from({ length: refs.length }, (_, index) => catalog.get(refs.at(index))));
    assert.deepEqual(loaded.map(({ rating }) => rating).sort((a, b) => a - b), [...ratings].sort((a, b) => a - b));
    assert(calls.every((url) => url.startsWith(String(base)) && !url.endsWith('/inventory.json')));
    if (manifest.schema === 3) {
      assert.equal(refs.ranges.length, expected.length);
      assert(calls.includes(String(new URL(puzzleShardPath(manifest.puzzles.version, -maximum, 0), base))));
      assert(calls.includes(String(new URL(puzzleShardPath(manifest.puzzles.version, -1, 0), base))));
    }
  }
});

test('schema 3 startup requests only the manifest and filters exact inclusive ratings without inventories', async () => {
  const ratings = [1399, 1400, 1700, 2000, 2001, 3501];
  const { manifest, files } = makeSchema3Assets(ratings.map((rating) => ({ ...puzzle, id: String(rating), rating })));
  const calls = [];
  const catalog = await Catalog.load(base, fetchAssets(files, calls));
  const refs = catalog.refs('puzzle', interval(1700, 300));
  assert(refs instanceof ReferencePool);
  assert.equal(refs.length, 3);
  assert.equal(refs.ranges.length, 3);
  assert.deepEqual(Array.from({ length: refs.length }, (_, i) => refs.at(i).rating), [1400, 1700, 2000]);
  assert.equal(catalog.refs('puzzle', interval()).length, 1);
  assert.equal(catalog.refs('puzzle', interval(1701)).length, 0);
  assert.equal(catalog.refs('puzzle', interval(3501)).length, 1);
  assert.equal(catalog.refs('ordinary').length, manifest.ordinary.count);
  assert.deepEqual(calls, [String(new URL('manifest.json', base))]);
  assert.equal(catalog.cache.size, 0);
  assert.equal((await catalog.get(refs.at(1))).rating, 1700);
  assert.deepEqual(calls, [String(new URL('manifest.json', base)),
    String(new URL(puzzleShardPath(manifest.puzzles.version, 1700, 0), base))]);
  assert(calls.every((url) => url.startsWith(String(base)) && !url.endsWith('/inventory.json')));
  assert.equal('shards' in manifest.puzzles, false);
  assert.equal('shards' in manifest.ordinary, false);
});

test('schema 3 versions are group-specific, independent of dataset identity, and reject foreign group references', async () => {
  const original = makeSchema3Assets();
  const differentOrdinary = makeSchema3Assets(undefined, [{ ...ordinary(), id: 'changed-ordinary' }]);
  const differentPuzzle = makeSchema3Assets([{ ...puzzle, id: 'changed-puzzle' }]);
  assert.equal(original.manifest.puzzles.version, differentOrdinary.manifest.puzzles.version);
  assert.notEqual(original.manifest.ordinary.version, differentOrdinary.manifest.ordinary.version);
  assert.notEqual(original.manifest.dataset_id, differentOrdinary.manifest.dataset_id);
  assert.equal(original.manifest.ordinary.version, differentPuzzle.manifest.ordinary.version);
  assert.notEqual(original.manifest.puzzles.version, differentPuzzle.manifest.puzzles.version);
  const first = new Catalog(original.manifest, base, fetchAssets(original.files));
  const puzzleRef = first.refs('puzzle', interval()).at(0);
  const ordinaryRef = first.refs('ordinary').at(0);
  const calls = [];
  const second = new Catalog(differentOrdinary.manifest, base, fetchAssets(differentOrdinary.files, calls));
  assert.equal((await second.get(puzzleRef)).id, puzzle.id);
  await assert.rejects(second.get(ordinaryRef), /version mismatch/);
  assert.equal(calls.length, 1);
  const third = new Catalog(differentPuzzle.manifest, base, fetchAssets(differentPuzzle.files, calls));
  await assert.rejects(third.get(puzzleRef), /version mismatch/);
  assert.equal(calls.length, 1);
  assert.equal((await third.get(ordinaryRef)).id, 'ordinary');
  assert.equal(calls.length, 2);
});

test('schema 3 uses complete paths as cache keys even when kind, rating, or part basenames collide', async () => {
  const { manifest, files } = makeSchema3Assets([puzzle, { ...puzzle, id: 'other-rating', rating: 1800 }]);
  const oldPrefix = `ordinary/${manifest.ordinary.version}/`;
  manifest.ordinary.version = manifest.puzzles.version;
  for (const [file, bytes] of [...files]) {
    if (file.startsWith(oldPrefix)) files.set(`ordinary/${manifest.ordinary.version}/${file.slice(oldPrefix.length)}`, bytes);
  }
  const calls = [];
  const catalog = new Catalog(manifest, base, fetchAssets(files, calls));
  const puzzles = catalog.refs('puzzle', interval(1750, 50));
  assert.equal((await catalog.get(puzzles.at(0))).rating, 1700);
  assert.equal((await catalog.get(puzzles.at(1))).rating, 1800);
  assert.equal((await catalog.get(catalog.refs('ordinary').at(0))).id, 'ordinary');
  assert.equal(calls.length, 3);
  assert.deepEqual([...catalog.cache.keys()], [puzzleShardPath(manifest.puzzles.version, 1700, 0),
    puzzleShardPath(manifest.puzzles.version, 1800, 0), ordinaryShardPath(manifest.ordinary.version, 0)]);
});

test('schema 3 concurrent loads share promises and both kinds share a single eight-shard LRU', async () => {
  const { manifest, files } = makeSchema3Assets(Array.from({ length: 8 }, (_, i) => ({ ...puzzle, id: String(i), rating: 1700 + i })),
    Array.from({ length: 65 }, (_, i) => ({ ...ordinary(), id: `ordinary-${String(i).padStart(3, '0')}` })));
  const calls = [];
  const catalog = new Catalog(manifest, base, fetchAssets(files, calls));
  const puzzles = catalog.refs('puzzle', interval(1700, 7));
  const positions = catalog.refs('ordinary');
  await Promise.all([catalog.get(puzzles.at(0)), catalog.get(puzzles.at(0))]);
  assert.equal(calls.length, 1);
  for (let i = 1; i < puzzles.length; i++) await catalog.get(puzzles.at(i));
  assert.equal(catalog.cache.size, 8);
  await catalog.get(puzzles.at(0)); // Refresh the oldest puzzle before ordinary evicts one.
  await catalog.get(positions.at(0));
  assert.equal(calls.length, 9);
  assert.equal(catalog.cache.size, 8);
  assert(catalog.cache.has(puzzleShardPath(manifest.puzzles.version, 1700, 0)));
  assert(!catalog.cache.has(puzzleShardPath(manifest.puzzles.version, 1701, 0)));
  await catalog.get(puzzles.at(0));
  assert.equal(calls.length, 9);
  await catalog.get(puzzles.at(1));
  await catalog.get(positions.at(64));
  assert.equal(calls.length, 11);
  assert.equal(catalog.cache.size, 8);
  assert(catalog.cache.has(ordinaryShardPath(manifest.ordinary.version, 1)));
});

test('invalid schema 3 and legacy references fail before any network request', async () => {
  for (const make of [makeAssets, makeSchema2Assets, makeSchema3Assets]) {
    const { manifest, files } = make();
    const calls = [];
    const catalog = new Catalog(manifest, base, fetchAssets(files, calls));
    const ref = catalog.refs('puzzle', interval()).at(0);
    for (const invalid of [null, [], {}, { ...ref, kind: 'puzzles' }, { ...ref, kind: '__proto__' },
      { ...ref, row: -1 }, { ...ref, row: 1 }, { ...ref, row: 0.5 }, { ...ref, row: Number.MAX_SAFE_INTEGER + 1 },
      { ...ref, file: '../secret.json.gz' }, { ...ref, path: 'https://evil.test/file' }]) {
      await assert.rejects(catalog.get(invalid), /Invalid training data/);
    }
    if (manifest.schema === 3) {
      for (const invalid of [{ ...ref, version: 'c'.repeat(64) }, { ...ref, rating: 1701 }, { ...ref, rating: '1700' },
        { ...ref, part: 1 }, { ...ref, part: -1 }, { ...ref, part: NaN }, { ...ref, part: Number.MAX_SAFE_INTEGER + 1 },
        { ...ref, shard: 0 }, { kind: 'ordinary', version: manifest.ordinary.version, part: 0, row: 1 }]) {
        await assert.rejects(catalog.get(invalid), /Invalid training data/);
      }
    } else {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
        await assert.rejects(catalog.get({ ...ref, shard: value }), /Invalid training data/);
      }
    }
    assert.deepEqual(calls, []);
    assert.equal(catalog.cache.size, 0);
  }
});

test('schema 3 enforces exact full/final lengths and selected ratings, then retries the same references', async () => {
  const { manifest, files } = makeSchema3Assets(manyPuzzles(129),
    Array.from({ length: 65 }, (_, i) => ({ ...ordinary(), id: `ordinary-${String(i).padStart(3, '0')}` })));
  const catalog = new Catalog(manifest, base, fetchAssets(files));
  const puzzles = catalog.refs('puzzle', interval());
  const positions = catalog.refs('ordinary');
  for (const ref of [puzzles.at(0), puzzles.at(128), positions.at(0), positions.at(64)]) {
    const { file, count } = resolveSchema3Reference(manifest, ref);
    const good = files.get(file);
    const records = JSON.parse(new TextDecoder().decode(gunzipSync(good)));
    for (const wrong of [records.slice(0, count - 1), [...records, records[0]]]) {
      files.set(file, compressed(wrong));
      await assert.rejects(catalog.get(ref), /shard size mismatch/);
      assert(!catalog.cache.has(file));
    }
    if (ref.kind === 'puzzle') {
      files.set(file, compressed(records.map((record) => ({ ...record, rating: 1701 }))));
      await assert.rejects(catalog.get(ref), /rating index mismatch/);
      assert(!catalog.cache.has(file));
    }
    files.set(file, good);
    assert.equal((await catalog.get(ref)).id, records[ref.row].id);
  }
});

test('schema 3 corruption, invalid records, decoded HTTP gzip, and HTTP errors preserve retryability', async () => {
  const assets = makeSchema3Assets();
  const ref = { kind: 'puzzle', version: assets.manifest.puzzles.version, rating: 1700, part: 0, row: 0 };
  const file = puzzleShardPath(ref.version, ref.rating, ref.part);
  const good = assets.files.get(file);
  for (const bytes of [new Uint8Array([0x1f, 0x8b, 0x08]), new TextEncoder().encode('broken JSON'), compressed({}),
    gzipSync(new TextEncoder().encode('[')), new Uint8Array([0xff]), compressed([{ ...puzzle, moves: ['e2e4', 'e7e4'] }])]) {
    const files = new Map(assets.files);
    files.set(file, bytes);
    const calls = [];
    const catalog = new Catalog(assets.manifest, base, fetchAssets(files, calls));
    await assert.rejects(catalog.get(ref));
    assert.equal(catalog.cache.size, 0);
    files.set(file, good);
    assert.equal((await catalog.get(ref)).id, puzzle.id);
    assert.equal(calls.length, 2);
  }
  const decodedFiles = new Map(assets.files);
  decodedFiles.set(file, gunzipSync(good));
  const decoded = new Catalog(assets.manifest, base, fetchAssets(decodedFiles));
  assert.equal((await decoded.get(ref)).id, puzzle.id);
  for (const status of [404, 503]) {
    let fail = true;
    const catalog = new Catalog(assets.manifest, base, (url) => fail
      ? Promise.resolve(new Response('missing', { status })) : fetchAssets(assets.files)(url));
    await assert.rejects(catalog.get(ref), status === 404 ? /updated/ : /not been skipped/);
    assert.equal(catalog.cache.size, 0);
    fail = false;
    assert.equal((await catalog.get(ref)).id, puzzle.id);
  }
});

test('schema 3 deadlines bound fetch and response bodies even if a custom fetcher ignores abort', async () => {
  const { manifest, files } = makeSchema3Assets();
  const never = () => new Promise(() => {});
  let stalled = true;
  const fetcher = (url) => stalled ? Promise.resolve({ ok: true, json: never, arrayBuffer: never }) : fetchAssets(files)(url);
  await assert.rejects(Catalog.load(base, never, 10), /timed out/);
  await assert.rejects(Catalog.load(base, fetcher, 10), /timed out/);
  const catalog = new Catalog(manifest, base, fetcher, 8, 10);
  const ref = catalog.refs('puzzle', interval()).at(0);
  await assert.rejects(catalog.get(ref), /timed out/);
  assert.equal(catalog.cache.size, 0);
  stalled = false;
  assert.equal((await catalog.get(ref)).id, puzzle.id);
});

test('a schema 3 multi-million pool and deck allocate ratings and drawn swaps, not shards', () => {
  const { manifest } = makeSchema3Assets();
  manifest.puzzles.count = 6_000_001;
  manifest.puzzles.rating_counts = [[1700, 6_000_001]];
  const catalog = new Catalog(manifest, base, () => { assert.fail('virtual pool fetched a shard'); });
  const pool = catalog.refs('puzzle', interval());
  const deck = new Deck(pool, () => 0.4);
  const drawn = new Set(Array.from({ length: 1000 }, () => JSON.stringify(deck.draw())));
  assert.equal(drawn.size, 1000);
  assert.equal(pool.ranges.length, 1);
  assert.equal('shards' in pool, false);
  assert.equal(catalog.cache.size, 0);
  assert(deck.swaps.size <= 1000);
  assert.equal(deck.remaining, pool.length - 1000);
});

test('schema 3 synthetic inventory fixtures interoperate with the offline validator', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpnp-schema3-'));
  try {
    const ratings = [-Number.MAX_SAFE_INTEGER, -1, 0, 1700, Number.MAX_SAFE_INTEGER];
    const { manifest, files } = makeSchema3Assets(ratings.map((rating) => ({ ...puzzle, id: String(rating), rating })));
    writeAssets(directory, files);
    assert.equal(validateData(directory).manifest.schema, 3);
    assert.deepEqual(validateData(directory).manifest.puzzles.rating_counts, ratings.map((rating) => [rating, 1]));
    assert.equal(validateData(directory, { deep: true }).manifest.puzzles.version, manifest.puzzles.version);
    const shard = puzzleShardPath(manifest.puzzles.version, 1700, 0);
    fs.appendFileSync(path.join(directory, shard), 'corruption');
    assert.throws(() => validateData(directory), /hash mismatch/);
    const overlapping = makeSchema3Assets([puzzle], [ordinary()]);
    writeAssets(directory, overlapping.files);
    assert.throws(() => validateData(directory), /overlapping/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

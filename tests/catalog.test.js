import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Catalog, ReferencePool } from '../web/catalog.js';
import { Deck } from '../web/session.js';
import { validateManifest, validateRecord } from '../web/format.js';
import { validateData } from '../scripts/validate-data.mjs';
import { makeAssets } from './data-fixtures.js';
import { ordinary, puzzle } from './fixtures.js';

const base = new URL('https://example.test/chess-puzzle-not-puzzle/training/');
function fetchAssets(files, calls = []) {
  return async (url) => {
    calls.push(String(url));
    const bytes = files.get(new URL(url).pathname.split('/').at(-1));
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

test('fetch is called without a Catalog receiver, as required by Window.fetch', async () => {
  const { files } = makeAssets();
  const fetcher = function (url) {
    assert.equal(this, undefined);
    return fetchAssets(files)(url);
  };
  const catalog = await Catalog.load(base, fetcher);
  await catalog.get(catalog.refs('puzzle', { anchor_rating: 1700, rating_margin: 0 })[0]);
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
  const { manifest, files } = makeAssets(puzzles, [ordinary()], 2, true);
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
    const { files } = makeAssets([puzzle], undefined, 2, true);
    for (const [name, bytes] of files) fs.writeFileSync(path.join(directory, name), bytes);
    assert.equal(validateData(directory).manifest.schema, 2);
    assert.equal(validateData(directory, { deep: true }).manifest.puzzles.count, 1);
    const bad = makeAssets([puzzle], [ordinary()], 2, true);
    for (const [name, bytes] of bad.files) fs.writeFileSync(path.join(directory, name), bytes);
    assert.throws(() => validateData(directory), /overlapping/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('fresh-clone public dataset validates without Python or Stockfish', { skip: !fs.existsSync('public/training/manifest.json') }, () => {
  const { manifest } = validateData('public/training');
  assert(manifest.puzzles.count > 0);
  assert(manifest.ordinary.count > 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDINARY_SHARD_SIZE, PUZZLE_SHARD_SIZE, ordinaryShardPath, puzzleShardPath,
  resolveSchema3Reference, schema3Shards, shardCount, shardLength, validateCompactGroup,
} from '../web/data-layout.js';
import { ReferencePool } from '../web/catalog.js';
import { validateManifest } from '../web/format.js';
import { makeSchema1Assets, makeSchema2Assets } from './data-fixtures.js';

const puzzleVersion = 'a'.repeat(64), ordinaryVersion = 'b'.repeat(64);
const MAX = Number.MAX_SAFE_INTEGER, MIN = -MAX;
function manifest(counts = [[1700, 259], [1901, 1]], ordinaryCount = 130, size = 128) {
  return { schema: 3, tolerance_cp: 50, dataset_id: 'fixture', engine: 'Fixture', nodes: 100000,
    sampled_games: Math.max(2000, ordinaryCount),
    puzzles: { version: puzzleVersion, count: counts.reduce((total, [, count]) => total + count, 0), shard_size: size, rating_counts: counts },
    ordinary: { version: ordinaryVersion, count: ordinaryCount, shard_size: 64 } };
}
const settings = (anchor_rating = 1700, rating_margin = 0) => ({ anchor_rating, rating_margin });

function expandedReferences(group, kind, interval) {
  const result = [];
  for (const [rating, count] of kind === 'puzzle' ? group.rating_counts : [[undefined, group.count]]) {
    if (kind === 'puzzle') {
      // An independent exact oracle, including intervals spanning both safe-integer endpoints.
      const distance = BigInt(rating) - BigInt(interval.anchor_rating), margin = BigInt(interval.rating_margin);
      if (distance < -margin || distance > margin) continue;
    }
    for (let offset = 0; offset < count; offset++) {
      result.push({ kind, version: group.version, ...(kind === 'puzzle' ? { rating } : {}),
        part: Math.floor(offset / group.shard_size), row: offset % group.shard_size });
    }
  }
  return result;
}

test('schema 3 derives canonical safe-integer paths, including negative ratings but never serialized -0', () => {
  assert.equal(PUZZLE_SHARD_SIZE, 256);
  assert.equal(ORDINARY_SHARD_SIZE, 64);
  for (const rating of [MIN, -3501, -1, -0, 0, 399, 3501, MAX]) {
    const file = puzzleShardPath(puzzleVersion, rating, MAX);
    assert.equal(file, `puzzles/${puzzleVersion}/${String(rating)}/${MAX}.json.gz`);
    const segment = file.split('/')[2];
    assert.match(segment, /^-?(0|[1-9]\d*)$/);
    assert.notEqual(segment, '-0');
    assert.equal(String(Number(segment)), segment);
  }
  assert.equal(puzzleShardPath(puzzleVersion, -0, -0), `puzzles/${puzzleVersion}/0/0.json.gz`);
  assert.equal(ordinaryShardPath(ordinaryVersion, -0), `ordinary/${ordinaryVersion}/0.json.gz`);
  assert.equal(ordinaryShardPath(ordinaryVersion, 12), `ordinary/${ordinaryVersion}/12.json.gz`);
  for (const version of [null, 3, [], 'a'.repeat(20), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65),
    '../secret', `${puzzleVersion}/..`, `${puzzleVersion}?x`, `${puzzleVersion}#x`, `${puzzleVersion}\n`, `${puzzleVersion}\r\n`]) {
    assert.throws(() => puzzleShardPath(version, 1700, 0), /Invalid training data/);
    assert.throws(() => ordinaryShardPath(version, 0), /Invalid training data/);
  }
  const invalidIntegers = [undefined, null, NaN, Infinity, -Infinity, 0.5, MAX + 1, MIN - 1,
    '1', '-1', '-0', '01', '1.0', '1e3', '../1', '1\n', {}, [], true, 1n];
  for (const value of invalidIntegers) {
    assert.throws(() => puzzleShardPath(puzzleVersion, value, 0), /Invalid training data/);
  }
  for (const value of [-1, MIN, ...invalidIntegers]) {
    assert.throws(() => puzzleShardPath(puzzleVersion, 1700, value), /Invalid training data/);
    assert.throws(() => ordinaryShardPath(ordinaryVersion, value), /Invalid training data/);
  }
});

test('part counts and exact final lengths match BigInt at every supported size and safe-integer boundary', () => {
  const sizes = [1, 2, 3, 7, 63, 64, ...Array.from({ length: 129 }, (_, index) => 128 + index),
    257, 2 ** 32 - 1, 2 ** 32, Math.floor(MAX / 2), Math.floor(MAX / 2) + 1, MAX - 1, MAX];
  for (const size of sizes) {
    const counts = new Set([1, size - 1, size, size + 1, size * 2, size * 2 + 3,
      ...Array.from({ length: 257 }, (_, index) => MAX - index)]
      .filter((count) => Number.isSafeInteger(count) && count > 0));
    for (const count of counts) {
      const parts = Number((BigInt(count) + BigInt(size) - 1n) / BigInt(size));
      assert.equal(shardCount(count, size), parts, `parts for ${count}/${size}`);
      assert.equal(shardLength(count, size, 0), Math.min(count, size));
      assert.equal(shardLength(count, size, parts - 1), Number((BigInt(count) - 1n) % BigInt(size) + 1n),
        `final length for ${count}/${size}`);
    }
    assert.throws(() => shardLength(MAX, size, shardCount(MAX, size)), /invalid shard part/);
  }
  assert.equal(shardCount(MAX, 1), MAX);
  assert.equal(shardLength(MAX, 1, MAX - 1), 1);
  for (const value of [0, -1, 0.5, NaN, Infinity, MAX + 1, '128', null, undefined, true, 1n]) {
    assert.throws(() => shardCount(value, 128), /Invalid training data/);
    assert.throws(() => shardCount(129, value), /Invalid training data/);
  }
  for (const part of [-1, 0.5, NaN, Infinity, MAX + 1, '0', null, undefined, true, 1n]) {
    assert.throws(() => shardLength(129, 128, part), /Invalid training data/);
  }
});

test('compact groups accept sorted integer pairs with imported gaps, negative ratings, and no UI bounds', () => {
  const counts = [[MIN, 1], [-100000, 2], [-1, 3], [0, 4], [399, 5], [3501, 6], [100000, 7], [MAX, 8]];
  for (const size of [128, 129, 255, 256]) {
    const source = manifest(counts, 64, size);
    assert.equal(validateManifest(source), source);
    for (const [rating, count] of counts) {
      const pool = new ReferencePool('puzzle', source.puzzles, settings(rating));
      assert.equal(pool.length, count);
      assert.equal(pool.ranges.length, 1);
      assert.equal(pool.at(0).rating, rating);
    }
    const all = new ReferencePool('puzzle', source.puzzles, settings(0, MAX));
    assert.equal(all.ranges.length, counts.length);
    assert.deepEqual(all.ranges.map(({ rating }) => rating), counts.map(([rating]) => rating));
  }
  const source = manifest([[MIN, MAX - 1], [MAX, 1]]);
  assert.equal(validateManifest(source).puzzles.count, MAX);
  assert.equal(validateCompactGroup(source.ordinary, 'ordinary'), source.ordinary);
  assert.throws(() => validateCompactGroup(source.puzzles, 'puzzle'), /invalid group kind/);
  assert.equal(validateManifest(manifest([[-0, 1]])).puzzles.count, 1);
});

test('the rating-count array must already be strictly ascending and unique, without implicit sorting', () => {
  const ordered = [[MIN, 1], [-1, 2], [0, 3], [MAX, 4]];
  function* permutations(pairs) {
    if (!pairs.length) { yield []; return; }
    for (let index = 0; index < pairs.length; index++) {
      for (const rest of permutations(pairs.filter((_, other) => other !== index))) yield [pairs[index], ...rest];
    }
  }
  for (const pairs of permutations(ordered)) {
    const source = manifest(pairs), before = structuredClone(pairs);
    if (pairs.every(([rating], index) => index === 0 || rating > pairs[index - 1][0])) {
      assert.equal(validateManifest(source), source);
    } else assert.throws(() => validateManifest(source), /sorted and unique/);
    assert.deepEqual(source.puzzles.rating_counts, before);
  }
  for (const rating of [MIN, -1, -0, 0, MAX]) {
    assert.throws(() => validateManifest(manifest([[rating, 1], [rating, 2]])), /sorted and unique/);
  }
  assert.throws(() => validateManifest(manifest([[-0, 1], [0, 1]])), /sorted and unique/);
});

test('schema 3 rejects malformed pair arrays, unsafe integers, count overflow, sizes, and arbitrary paths', () => {
  const mutations = [
    (m) => { m.puzzles = null; },
    (m) => { m.ordinary = []; },
    (m) => { m.puzzles.version = 'a'.repeat(20); },
    (m) => { m.ordinary.version = '../secret'; },
    (m) => { m.puzzles.shard_size = 127; },
    (m) => { m.puzzles.shard_size = 257; },
    (m) => { m.puzzles.shard_size = 128.5; },
    (m) => { m.ordinary.shard_size = 63; },
    (m) => { m.ordinary.shard_size = 65; },
    (m) => { m.puzzles.count++; },
    (m) => { m.puzzles.rating_counts = []; },
    (m) => { m.puzzles.rating_counts = {}; },
    (m) => { m.puzzles.rating_counts = { 1700: 259, 1901: 1 }; },
    (m) => { m.puzzles.rating_counts = null; },
    (m) => { m.puzzles.rating_counts = [1700, 260]; },
    (m) => { m.puzzles.rating_counts = [[1700]]; },
    (m) => { m.puzzles.rating_counts = [[1700, 260, 1]]; },
    (m) => { m.puzzles.rating_counts = [[1700, 260], []]; },
    (m) => { m.puzzles.rating_counts = [{ 0: 1700, 1: 260, length: 2 }]; },
    (m) => { m.puzzles.shards = []; },
    (m) => { m.ordinary.shards = [{ file: '../secret' }]; },
    (m) => { m.puzzles.file = 'puzzles/somewhere'; },
    (m) => { m.ordinary.path = '../secret'; },
    (m) => { m.puzzles.template = 'https://evil.test/{rating}'; },
    (m) => { m.puzzles.rating_counts = [[MIN, MAX], [MAX, 1]]; m.puzzles.count = MAX; },
  ];
  for (const rating of [undefined, null, NaN, Infinity, -Infinity, MIN - 1, MAX + 1, 1.5,
    '1700', '-1', '-0', '01', '1.0', '1e3', '../1700', '__proto__', '1700\n', {}, [], true, 1700n]) {
    mutations.push((m) => { m.puzzles.rating_counts = [[rating, 260]]; });
  }
  for (const value of [0, -1, 1.5, MAX + 1, NaN, Infinity, -Infinity, '1', null, undefined, true, 1n, {}, []]) {
    mutations.push((m) => { m.puzzles.rating_counts[0][1] = value; });
    for (const key of ['nodes', 'sampled_games']) mutations.push((m) => { m[key] = value; });
    for (const kind of ['puzzles', 'ordinary']) {
      mutations.push((m) => { m[kind].count = value; });
      mutations.push((m) => { m[kind].shard_size = value; });
    }
  }
  for (const mutate of mutations) {
    const source = manifest();
    mutate(source);
    assert.throws(() => validateManifest(source), /Invalid training data/);
  }
  for (const source of [null, [], {}, { ...manifest(), sampled_games: 1 }]) {
    assert.throws(() => validateManifest(source), /Invalid training data/);
  }
});

test('references require their own group version, exact rating, part, and final row', () => {
  const source = validateManifest(manifest());
  const puzzle = { kind: 'puzzle', version: puzzleVersion, rating: 1700, part: 2, row: 2 };
  const ordinary = { kind: 'ordinary', version: ordinaryVersion, part: 2, row: 1 };
  assert.deepEqual(resolveSchema3Reference(source, puzzle), { file: `puzzles/${puzzleVersion}/1700/2.json.gz`, count: 3, rating: 1700 });
  assert.deepEqual(resolveSchema3Reference(source, ordinary), { file: `ordinary/${ordinaryVersion}/2.json.gz`, count: 2 });
  assert.equal(resolveSchema3Reference(source, { ...puzzle, part: 0, row: 127 }).count, 128);
  assert.equal(resolveSchema3Reference(source, { ...puzzle, rating: 1901, part: 0, row: 0 }).count, 1);
  for (const ref of [null, [], {}, { ...puzzle, kind: 'puzzles' }, { ...ordinary, kind: 'unknown' },
    { ...puzzle, version: ordinaryVersion }, { ...ordinary, version: puzzleVersion },
    { ...puzzle, rating: 1701 }, { ...puzzle, rating: '1700' }, { ...puzzle, rating: -1 },
    { ...puzzle, part: 3, row: 0 }, { ...puzzle, row: 3 }, { ...ordinary, part: 3 }, { ...ordinary, row: 2 },
    { ...puzzle, path: '../secret' }, { ...ordinary, file: 'https://evil.test/data' },
    { ...puzzle, shard: 0 }, { ...ordinary, rating: 1700 }]) {
    assert.throws(() => resolveSchema3Reference(source, ref), /Invalid training data/);
  }
  for (const rating of [undefined, null, NaN, Infinity, -Infinity, MAX + 1, MIN - 1, 0.5, '1700', true, 1700n]) {
    assert.throws(() => resolveSchema3Reference(source, { ...puzzle, rating }), /Invalid training data/);
  }
  for (const original of [puzzle, ordinary]) {
    for (const field of Object.keys(original)) {
      const ref = { ...original };
      delete ref[field];
      assert.throws(() => resolveSchema3Reference(source, ref), /Invalid training data/);
    }
    for (const field of ['row', 'part']) {
      for (const value of [-1, 0.5, NaN, Infinity, MAX + 1, '0', null, undefined, true, 1n]) {
        assert.throws(() => resolveSchema3Reference(source, { ...original, [field]: value }), /Invalid training data/);
      }
    }
  }
});

test('reference resolution binary-searches sorted rating counts without scanning, sorting, or building a lookup', () => {
  const counts = Array.from({ length: 65_537 }, (_, index) => [index * 2 - 65_536, 1]);
  const source = validateManifest(manifest(counts));
  let reads = 0;
  source.puzzles.rating_counts = new Proxy(counts, {
    get(target, key, receiver) {
      if (key === Symbol.iterator || ['sort', 'map', 'find', 'findIndex', 'reduce', 'forEach'].includes(key)) {
        assert.fail('reference resolution must not scan the rating-count array');
      }
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const ref = (rating) => ({ kind: 'puzzle', version: puzzleVersion, rating, part: 0, row: 0 });
  for (const rating of [-65_536, -32_768, -2, 0, 2, 32_768, 65_536]) {
    reads = 0;
    assert.deepEqual(resolveSchema3Reference(source, ref(rating)), {
      file: `puzzles/${puzzleVersion}/${rating}/0.json.gz`, count: 1, rating,
    });
    assert(reads > 0 && reads <= Math.ceil(Math.log2(counts.length)) + 1);
  }
  for (const rating of [MIN, -65_537, -65_535, -1, 1, 65_535, 65_537, MAX]) {
    reads = 0;
    assert.throws(() => resolveSchema3Reference(source, ref(rating)), /invalid item reference rating/);
    assert(reads > 0 && reads <= Math.ceil(Math.log2(counts.length)) + 1);
  }
});

test('lazy shard derivation covers signed rating gaps and ordinary/puzzle final parts exactly', () => {
  const source = manifest([[MIN, 1], [-1, 129], [0, 1], [1700, 259], [1901, 1], [MAX, 1]]);
  const iterator = schema3Shards(source, 'puzzle');
  assert.equal(iterator[Symbol.iterator](), iterator);
  assert.deepEqual([...iterator], [
    { file: `puzzles/${puzzleVersion}/${MIN}/0.json.gz`, count: 1, rating: MIN },
    { file: `puzzles/${puzzleVersion}/-1/0.json.gz`, count: 128, rating: -1 },
    { file: `puzzles/${puzzleVersion}/-1/1.json.gz`, count: 1, rating: -1 },
    { file: `puzzles/${puzzleVersion}/0/0.json.gz`, count: 1, rating: 0 },
    { file: `puzzles/${puzzleVersion}/1700/0.json.gz`, count: 128, rating: 1700 },
    { file: `puzzles/${puzzleVersion}/1700/1.json.gz`, count: 128, rating: 1700 },
    { file: `puzzles/${puzzleVersion}/1700/2.json.gz`, count: 3, rating: 1700 },
    { file: `puzzles/${puzzleVersion}/1901/0.json.gz`, count: 1, rating: 1901 },
    { file: `puzzles/${puzzleVersion}/${MAX}/0.json.gz`, count: 1, rating: MAX },
  ]);
  assert.deepEqual([...schema3Shards(source, 'ordinary')], [
    { file: `ordinary/${ordinaryVersion}/0.json.gz`, count: 64 },
    { file: `ordinary/${ordinaryVersion}/1.json.gz`, count: 64 },
    { file: `ordinary/${ordinaryVersion}/2.json.gz`, count: 2 },
  ]);
  assert.throws(() => [...schema3Shards(source, 'puzzles')], /Invalid training data/);
});

test('counts-based pools exhaustively match every reference with uneven finals, signed gaps, and inclusive bounds', () => {
  for (const size of [128, 129, 256]) {
    const source = manifest([[MIN, 1], [-3501, 2], [-1000, 129], [-1, 257], [0, 1], [399, 1],
      [1000, 257], [1700, 259], [1702, 1], [1900, 129], [3501, 2], [MAX, 1]], 130, size);
    for (const interval of [settings(-1), settings(-2), settings(0), settings(-1700, 300), settings(-1001, 1),
      settings(1700), settings(1701), settings(1700, 1), settings(1700, 300), settings(1600, 100), settings(2000, 100),
      settings(1700, 2000), settings(0, MAX), settings(MIN), settings(MAX), settings(MIN, MAX), settings(MAX, MAX),
      settings(MIN + 1, MAX), settings(MAX - 1, MAX)]) {
      const pool = new ReferencePool('puzzle', source.puzzles, interval);
      const expected = expandedReferences(source.puzzles, 'puzzle', interval);
      assert.equal(pool.length, expected.length);
      assert.equal(pool.ranges.length, new Set(expected.map((ref) => ref.rating)).size);
      assert.equal('shards' in pool, false);
      assert.deepEqual(Array.from({ length: pool.length }, (_, index) => pool.at(index)), expected);
      if (pool.length) assert.notEqual(pool.at(0), pool.at(0));
    }
    const ordinary = new ReferencePool('ordinary', source.ordinary);
    assert.equal(ordinary.ranges.length, 1);
    assert.deepEqual(Array.from({ length: ordinary.length }, (_, index) => ordinary.at(index)), expandedReferences(source.ordinary, 'ordinary'));
  }
});

test('multi-million pools retain one range per matching rating, not one per shard', () => {
  const source = manifest([[399, 31], [1700, 6_000_001], [1701, 1], [2400, 12_000_007], [3501, 4]]);
  const pool = new ReferencePool('puzzle', source.puzzles, settings(1700, 1000));
  assert.equal(pool.length, 18_000_009);
  assert.equal(pool.ranges.length, 3);
  assert.equal('shards' in pool, false);
  const indexes = [0, 127, 128, 6_000_000, 6_000_001, 6_000_002, pool.length - 1];
  let seed = 7;
  for (let i = 0; i < 1000; i++) { seed = (1664525 * seed + 1013904223) >>> 0; indexes.push(seed % pool.length); }
  for (const index of indexes) {
    const rating = index < 6_000_001 ? 1700 : index === 6_000_001 ? 1701 : 2400;
    const offset = index - (rating === 1700 ? 0 : rating === 1701 ? 6_000_001 : 6_000_002);
    assert.deepEqual(pool.at(index), { kind: 'puzzle', version: puzzleVersion, rating, part: Math.floor(offset / 128), row: offset % 128 });
  }
  const empty = new ReferencePool('puzzle', source.puzzles, settings(1703));
  assert.equal(empty.length, 0);
  assert.equal(empty.ranges.length, 0);
  assert.throws(() => empty.at(0), /invalid pool index/);
});

test('safe-integer pool endpoints and reference lengths stay exact at every supported puzzle shard size', () => {
  for (let size = 128; size <= 256; size++) {
    const source = manifest([[MIN, MAX]], MAX, size);
    const largest = new ReferencePool('puzzle', source.puzzles, settings(MIN));
    assert.equal(largest.length, MAX);
    assert.equal(largest.ranges.length, 1);
    for (const index of [0, size - 1, size, size + 1, ...Array.from({ length: 257 }, (_, offset) => MAX - 1 - offset)]) {
      const part = Number(BigInt(index) / BigInt(size)), row = Number(BigInt(index) % BigInt(size));
      const ref = largest.at(index);
      assert.deepEqual(ref, { kind: 'puzzle', version: puzzleVersion, rating: MIN, part, row });
      const remaining = BigInt(MAX) - BigInt(part) * BigInt(size);
      assert.deepEqual(resolveSchema3Reference(source, ref), {
        file: `puzzles/${puzzleVersion}/${MIN}/${part}.json.gz`, count: Number(remaining < BigInt(size) ? remaining : BigInt(size)), rating: MIN,
      });
    }
    for (const index of [-1, 0.5, NaN, Infinity, MAX, MAX + 1, '0', null]) {
      assert.throws(() => largest.at(index), /invalid pool index/);
    }
  }
  const source = manifest([[MIN, 1], [-1, MAX - 2], [MAX, 1]], MAX);
  const split = new ReferencePool('puzzle', source.puzzles, settings(0, MAX));
  assert.equal(split.length, MAX);
  assert.equal(split.ranges.length, 3);
  for (const [index, rating, offset] of [[0, MIN, 0], [1, -1, 0], [MAX - 2, -1, MAX - 3], [MAX - 1, MAX, 0]]) {
    assert.deepEqual(split.at(index), { kind: 'puzzle', version: puzzleVersion, rating,
      part: Number(BigInt(offset) / 128n), row: Number(BigInt(offset) % 128n) });
  }
  const ordinary = new ReferencePool('ordinary', source.ordinary);
  assert.equal(ordinary.length, MAX);
  assert.equal(ordinary.ranges.length, 1);
  const ref = ordinary.at(MAX - 1);
  assert.deepEqual(ref, { kind: 'ordinary', version: ordinaryVersion,
    part: Number(BigInt(MAX - 1) / 64n), row: Number(BigInt(MAX - 1) % 64n) });
  assert.equal(resolveSchema3Reference(source, ref).count, Number((BigInt(MAX) - 1n) % 64n + 1n));
});

test('pool intervals accept all safe integer anchors but require safe nonnegative integer margins', () => {
  const group = manifest().puzzles;
  const invalid = [undefined, null, NaN, Infinity, -Infinity, MAX + 1, MIN - 1, 0.5, '0', true, 1n];
  for (const anchor_rating of invalid) {
    assert.throws(() => new ReferencePool('puzzle', group, { anchor_rating, rating_margin: 0 }), /invalid rating interval/);
  }
  for (const rating_margin of [-1, MIN, ...invalid]) {
    assert.throws(() => new ReferencePool('puzzle', group, { anchor_rating: 0, rating_margin }), /invalid rating interval/);
  }
  for (const interval of [undefined, null, {}, []]) {
    assert.throws(() => new ReferencePool('puzzle', group, interval), /invalid rating interval/);
  }
});

test('schema 1 and 2 remain explicit, safe-integer-validated compatibility formats', () => {
  for (const make of [makeSchema1Assets, makeSchema2Assets]) {
    const source = make().manifest;
    assert.equal(validateManifest(source), source);
    for (const mutate of [
      (m) => { m.nodes = MAX + 1; },
      (m) => { m.sampled_games = MAX + 1; },
      (m) => { m.puzzles.shards[0].count = MAX + 1; },
      (m) => { m.puzzles.shards[0].file = '../secret.json.gz'; },
      (m) => { m.puzzles.shards[0].file += '\n'; },
      (m) => { m.puzzles.shards[0] = null; },
      (m) => { m.sampled_games = MAX; m.ordinary.count = MAX; m.ordinary.shards[0].count = MAX;
        m.ordinary.shards.push({ count: 1, file: `n-${'c'.repeat(20)}.json.gz` }); },
      (m) => { m.puzzles.count = MAX; m.puzzles.shards[0].count = MAX;
        m.puzzles.shards.push({ ...m.puzzles.shards[0], count: 1, file: `p-${'c'.repeat(20)}.json.gz` });
        if (m.schema === 1) m.puzzles.shards[0].ratings = []; },
    ]) {
      const changed = structuredClone(source);
      mutate(changed);
      assert.throws(() => validateManifest(changed), /Invalid training data/);
    }
    const changed = structuredClone(source);
    if (source.schema === 1) changed.puzzles.shards[0].ratings[0] = MAX + 1;
    else changed.puzzles.shards[0].rating = MAX + 1;
    assert.throws(() => validateManifest(changed), /Invalid training data/);
  }
});

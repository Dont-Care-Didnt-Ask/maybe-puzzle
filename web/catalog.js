import { gunzipSync } from 'fflate';
import { assert, validateManifest, validateRecord } from './format.js';
import { resolveSchema3Reference, validateCompactGroup } from './data-layout.js';

const timeoutMessage = 'Training data request timed out. Check your connection and retry; no position was skipped.';
async function readResource(fetcher, url, read, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  try {
    // The deadline includes the body, not just receipt of response headers. The
    // race also bounds custom fetch implementations that do not honor abort.
    return await Promise.race([
      Promise.resolve().then(async () => read(await fetcher(url, { ...options, signal: controller.signal }))),
      deadline,
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw error;
  } finally { clearTimeout(timer); }
}

function itemKind(kind) {
  assert(kind === 'puzzle' || kind === 'ordinary', 'invalid item kind');
}

function ratingSettings(settings) {
  assert(settings && Number.isSafeInteger(settings.anchor_rating)
    && Number.isSafeInteger(settings.rating_margin) && settings.rating_margin >= 0, 'invalid rating interval');
}

// Schema 3 stores one range per matching exact rating (one for ordinary), never
// one per shard or puzzle. The array form retains schema-2 shard compatibility.
export class ReferencePool {
  constructor(kind, group, settings) {
    itemKind(kind);
    if (kind === 'puzzle') ratingSettings(settings);
    this.kind = kind;
    this.ranges = [];
    this.length = 0;
    const append = (count, identity) => {
      assert(Number.isSafeInteger(count) && count > 0 && this.length <= Number.MAX_SAFE_INTEGER - count, 'invalid pool size');
      this.ranges.push({ ...identity, start: this.length, end: this.length + count });
      this.length += count;
    };
    if (Array.isArray(group)) {
      group.forEach((shard, index) => {
        if (kind === 'puzzle' && Math.abs(shard.rating - settings.anchor_rating) > settings.rating_margin) return;
        append(shard.count, { shard: index });
      });
    } else {
      validateCompactGroup(group, kind === 'puzzle' ? 'puzzles' : 'ordinary');
      this.version = group.version;
      this.shardSize = group.shard_size;
      if (kind === 'ordinary') append(group.count, {});
      else {
        for (const [rating, count] of group.rating_counts) {
          if (Math.abs(rating - settings.anchor_rating) <= settings.rating_margin) append(count, { rating });
        }
      }
    }
  }

  at(index) {
    assert(Number.isSafeInteger(index) && index >= 0 && index < this.length, 'invalid pool index');
    let low = 0, high = this.ranges.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (index < this.ranges[middle].end) high = middle;
      else low = middle + 1;
    }
    const range = this.ranges[low];
    const offset = index - range.start;
    if (this.version === undefined) return { kind: this.kind, shard: range.shard, row: offset };
    const row = offset % this.shardSize;
    return { kind: this.kind, version: this.version, ...(this.kind === 'puzzle' ? { rating: range.rating } : {}),
      part: (offset - row) / this.shardSize, row };
  }
}

export class Catalog {
  constructor(manifest, base, fetcher = fetch, cacheSize = 8, timeoutMs = 10_000) {
    this.manifest = validateManifest(manifest);
    assert(Number.isSafeInteger(cacheSize) && cacheSize > 0, 'invalid cache size');
    assert(Number.isFinite(timeoutMs) && timeoutMs >= 0, 'invalid request timeout');
    this.base = base;
    // Window.fetch is receiver-sensitive; never call it with Catalog as `this`.
    this.fetcher = (...args) => fetcher(...args);
    this.cacheSize = cacheSize;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  static async load(base = new URL('training/', document.baseURI), fetcher = fetch, timeoutMs = 10_000) {
    const manifest = await readResource(fetcher, new URL('manifest.json', base), (response) => {
      if (!response.ok) throw new Error('Cannot load training data. Check your connection. For local development, run npm run data:hydrate, or build with --training-dir <prepared-directory> --local (see README.md).');
      return response.json();
    }, { cache: 'no-cache' }, timeoutMs);
    return new Catalog(manifest, base, fetcher, 8, timeoutMs);
  }

  refs(kind, settings) {
    itemKind(kind);
    if (kind === 'puzzle') ratingSettings(settings);
    const group = this.manifest[kind === 'puzzle' ? 'puzzles' : 'ordinary'];
    if (this.manifest.schema === 3) return new ReferencePool(kind, group, settings);
    if (this.manifest.schema === 2) return new ReferencePool(kind, group.shards, settings);
    const result = [];
    group.shards.forEach((shard, index) => {
      for (let row = 0; row < shard.count; row++) {
        if (kind === 'ordinary' || Math.abs(shard.ratings[row] - settings.anchor_rating) <= settings.rating_margin) {
          result.push({ kind, shard: index, row });
        }
      }
    });
    return result;
  }

  async get(ref) {
    assert(ref && typeof ref === 'object' && !Array.isArray(ref), 'invalid item reference');
    itemKind(ref.kind);
    let shard;
    if (this.manifest.schema === 3) shard = resolveSchema3Reference(this.manifest, ref);
    else {
      const group = this.manifest[ref.kind === 'puzzle' ? 'puzzles' : 'ordinary'];
      assert(Object.keys(ref).length === 3 && Number.isSafeInteger(ref.shard) && ref.shard >= 0, 'invalid item reference');
      shard = group.shards[ref.shard];
      assert(shard && Number.isSafeInteger(ref.row) && ref.row >= 0 && ref.row < shard.count, 'invalid item reference');
    }
    const file = shard.file;
    let pending = this.cache.get(file);
    if (!pending) {
      pending = readResource(this.fetcher, new URL(file, this.base), async (response) => {
        if (!response.ok) throw new Error(response.status === 404
          ? 'Training data may have been updated. If a session is active, finish it; then reload and try again.'
          : 'Could not load the next position. Check your connection and retry; this position has not been skipped.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        // Also tolerate hosts that transparently decode gzip through Content-Encoding.
        const content = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
        const records = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
        assert(Array.isArray(records) && records.length === shard.count, 'shard size mismatch');
        return records;
      }, {}, this.timeoutMs);
      this.cache.set(file, pending);
    } else {
      this.cache.delete(file);
      this.cache.set(file, pending);
    }
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    try {
      const record = (await pending)[ref.row];
      validateRecord(record, ref.kind);
      if (ref.kind === 'puzzle') assert(record.rating === (this.manifest.schema === 1 ? shard.ratings[ref.row] : shard.rating), 'rating index mismatch');
      return record;
    } catch (error) {
      if (this.cache.get(file) === pending) this.cache.delete(file);
      throw error;
    }
  }
}

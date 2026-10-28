import { gunzipSync } from 'fflate';
import { assert, validateManifest, validateRecord } from './format.js';

async function readResource(fetcher, url, read, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await read(await fetcher(url, { ...options, signal: controller.signal }));
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Training data request timed out. Check your connection and retry; no position was skipped.');
    throw error;
  } finally { clearTimeout(timer); }
}

// A virtual pool: one range per matching shard, not one object per puzzle.
export class ReferencePool {
  constructor(kind, shards, settings) {
    this.kind = kind;
    this.ranges = [];
    this.length = 0;
    shards.forEach((shard, index) => {
      if (kind === 'puzzle' && Math.abs(shard.rating - settings.anchor_rating) > settings.rating_margin) return;
      this.ranges.push({ shard: index, start: this.length, end: this.length + shard.count });
      this.length += shard.count;
    });
  }

  at(index) {
    assert(Number.isInteger(index) && index >= 0 && index < this.length, 'invalid pool index');
    let low = 0, high = this.ranges.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (index < this.ranges[middle].end) high = middle;
      else low = middle + 1;
    }
    const range = this.ranges[low];
    return { kind: this.kind, shard: range.shard, row: index - range.start };
  }
}

export class Catalog {
  constructor(manifest, base, fetcher = fetch, cacheSize = 8, timeoutMs = 10_000) {
    this.manifest = validateManifest(manifest);
    this.base = base;
    // Window.fetch is receiver-sensitive; never call it with Catalog as `this`.
    this.fetcher = (...args) => fetcher(...args);
    this.cacheSize = cacheSize;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  static async load(base = new URL('training/', document.baseURI), fetcher = fetch, timeoutMs = 10_000) {
    const manifest = await readResource(fetcher, new URL('manifest.json', base), (response) => {
      if (!response.ok) throw new Error('Cannot load training data. Check your connection, or export the static dataset first.');
      return response.json();
    }, { cache: 'no-cache' }, timeoutMs);
    return new Catalog(manifest, base, fetcher, 8, timeoutMs);
  }

  refs(kind, settings) {
    const group = this.manifest[kind === 'puzzle' ? 'puzzles' : 'ordinary'];
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
    const group = this.manifest[ref.kind === 'puzzle' ? 'puzzles' : 'ordinary'];
    const shard = group.shards[ref.shard];
    assert(shard && Number.isInteger(ref.row) && ref.row >= 0 && ref.row < shard.count, 'invalid item reference');
    let pending = this.cache.get(shard.file);
    if (!pending) {
      pending = readResource(this.fetcher, new URL(shard.file, this.base), async (response) => {
        if (!response.ok) throw new Error(response.status === 404
          ? 'Training data may have been updated. If a session is active, finish it; then reload and try again.'
          : 'Could not load the next position. Check your connection and retry; this position has not been skipped.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        // Also tolerate hosts that transparently decode gzip through Content-Encoding.
        const content = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
        const records = JSON.parse(new TextDecoder().decode(content));
        assert(Array.isArray(records) && records.length === shard.count, 'shard size mismatch');
        return records;
      }, {}, this.timeoutMs);
      this.cache.set(shard.file, pending);
    } else {
      this.cache.delete(shard.file);
      this.cache.set(shard.file, pending);
    }
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    try {
      const record = (await pending)[ref.row];
      validateRecord(record, ref.kind);
      if (ref.kind === 'puzzle') assert(record.rating === (this.manifest.schema === 2 ? shard.rating : shard.ratings[ref.row]), 'rating index mismatch');
      return record;
    } catch (error) {
      if (this.cache.get(shard.file) === pending) this.cache.delete(shard.file);
      throw error;
    }
  }
}

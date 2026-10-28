// Shared, Node-only integrity and publication primitives. Nothing here downloads data.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { validateCompactGroup as validateLayoutGroup, shardCount as countShards } from '../web/data-layout.js';
import { validateManifest } from '../web/format.js';

export const LIMITS = Object.freeze({
  manifest: 64 * 1024,
  manifestGzip: 24 * 1024,
  shard: 64 * 1024,
  inflatedShard: 16 * 1024 * 1024,
  inventory: 32 * 1024 * 1024,
  source: 10 * 1024 * 1024,
  site: 900 * 1024 * 1024,
  archiveFiles: 200_000,
});
export const DEFAULT_LOCK = 'training-data.lock.json';
export const DEFAULT_CACHE = 'data/training/archives';
export const KINDS = Object.freeze(['puzzles', 'ordinary']);
export const HASH = /^[a-f0-9]{64}$/;

export function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid training data: ${message}`);
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function compareCanonicalStrings(a, b) {
  for (let left = 0, right = 0; left < a.length && right < b.length;) {
    const x = a.codePointAt(left), y = b.codePointAt(right);
    if (x !== y) return x - y;
    left += x > 0xffff ? 2 : 1;
    right += y > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

// Python's existing json.dumps(sort_keys=True, separators=(',', ':')) uses
// ensure_ascii=True, including surrogate-pair escapes for astral characters.
const jsonString = (value) => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

function pythonFloat(value) {
  invariant(Number.isFinite(value), 'non-finite JSON number');
  if (Object.is(value, -0)) return '-0.0';
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e16)) {
    const [mantissa, exponent] = value.toExponential().split('e');
    const number = Number(exponent);
    return `${mantissa}e${number < 0 ? '-' : '+'}${String(Math.abs(number)).padStart(2, '0')}`;
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

// Serialize keys ourselves: JSON.stringify reorders integer-looking keys, unlike
// Python's sort_keys=True. Compact separators and no trailing newline.
export function canonicalJSON(value) {
  if (typeof value === 'string') return jsonString(value);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'non-finite JSON number');
    return Number.isInteger(value) ? BigInt(value).toString() : pythonFloat(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  invariant(isObject(value), 'non-JSON value');
  return `{${Object.keys(value).sort(compareCanonicalStrings)
    .map((key) => `${jsonString(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}
export const canonicalBytes = (value) => Buffer.from(canonicalJSON(value), 'utf8');
export const sameJSON = (a, b) => canonicalJSON(a) === canonicalJSON(b);

export function parseJSON(bytes, description = 'JSON') {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error) {
    throw new Error(`Invalid training data: invalid ${description}: ${error.message}`);
  }
}

// JSON.parse erases Python's distinction between 1 and 1.0. Preserve numeric
// tokens when authenticating inventories/record hashes, while still sorting keys
// and normalizing strings. This also handles finite floating-point provenance.
export function canonicalJSONFromBytes(bytes, { parsed, arrayItems = false } = {}) {
  const value = parsed === undefined ? parseJSON(bytes) : parsed;
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const string = () => {
    const start = at++;
    while (at < text.length && text[at] !== '"') { if (text[at] === '\\') at++; at++; }
    invariant(at < text.length, 'unterminated JSON string');
    const raw = text.slice(start, ++at);
    // Published FENs, URLs, IDs, and move strings normally take this fast path.
    if (!/[^\x20-\x7e]|\\/.test(raw)) return { key: raw.slice(1, -1), canonical: raw };
    const decoded = JSON.parse(raw);
    return { key: decoded, canonical: jsonString(decoded) };
  };
  const read = (depth) => {
    invariant(depth <= 128, 'JSON nesting exceeds integrity limit');
    whitespace();
    const first = text[at];
    if (first === '"') return { canonical: string().canonical };
    if (first === '{' || first === '[') {
      at++;
      const object = first === '{', end = object ? '}' : ']', members = new Map(), items = [];
      whitespace();
      while (text[at] !== end) {
        let key;
        if (object) {
          invariant(text[at] === '"', 'invalid JSON object key');
          key = string(); whitespace(); invariant(text[at++] === ':', 'invalid JSON object separator');
        }
        const child = read(depth + 1).canonical;
        if (object) members.set(key.key, [key.canonical, child]); else items.push(child);
        whitespace();
        if (text[at] === end) break;
        invariant(text[at++] === ',', 'invalid JSON separator'); whitespace();
      }
      invariant(text[at++] === end, 'unterminated JSON container');
      return object ? { canonical: `{${[...members.keys()].sort(compareCanonicalStrings)
        .map((key) => members.get(key).join(':')).join(',')}}` }
        : { canonical: `[${items.join(',')}]`, items };
    }
    for (const literal of ['true', 'false', 'null']) if (text.startsWith(literal, at)) { at += literal.length; return { canonical: literal }; }
    number.lastIndex = at;
    const match = number.exec(text);
    invariant(match, 'invalid JSON number');
    at = number.lastIndex;
    return { canonical: /[.eE]/.test(match[0]) ? pythonFloat(Number(match[0])) : match[0] === '-0' ? '0' : match[0] };
  };
  const result = read(0);
  whitespace(); invariant(at === text.length, 'trailing JSON content');
  if (arrayItems) invariant(Array.isArray(value), 'expected JSON record array');
  return { value, canonical: result.canonical, ...(arrayItems ? { items: result.items } : {}) };
}

export function safeRelative(relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\')
    && !relative.includes('\0') && !/^[a-zA-Z]:/.test(relative) && !path.posix.isAbsolute(relative)
    && relative.split('/').every((part) => part && part !== '.' && part !== '..'), `unsafe path: ${relative}`);
  return relative;
}

// Check every component *inside* the supplied root, not just the leaf. In
// particular a version directory must not be a symlink to an untracked corpus.
export function regularPath(root, relative) {
  safeRelative(relative);
  const rootStat = fs.lstatSync(root);
  invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink(), `unsafe directory: ${root}`);
  let current = physicalPath(root);
  const parts = relative.split('/');
  parts.forEach((part, index) => {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    invariant(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()), `not a regular data path: ${relative}`);
  });
  return current;
}

export function readDataFile(root, relative, maxBytes = LIMITS.site) {
  const filename = regularPath(root, relative);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    invariant(stat.isFile() && stat.size <= maxBytes, `file exceeds ${maxBytes}-byte budget: ${relative}`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      invariant(length > 0, `file changed while reading: ${relative}`);
      offset += length;
    }
    invariant(fs.readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, `file changed while reading: ${relative}`);
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function readManifestBytes(directory, { optional = false } = {}) {
  try { return readDataFile(directory, 'manifest.json', LIMITS.inventory); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function assertManifestUnchanged(directory, captured) {
  const live = readManifestBytes(directory, { optional: true });
  invariant(live === null ? captured === null : captured !== null && live.equals(captured),
    'live manifest changed while preparing publication; retry rather than overwrite another publisher');
}

export function manifestBudget(bytes) {
  invariant(bytes.length <= LIMITS.manifest, `manifest exceeds ${LIMITS.manifest}-byte raw budget`);
  const compressed = gzipSync(bytes, { level: 9 }).length;
  invariant(compressed <= LIMITS.manifestGzip, `manifest exceeds ${LIMITS.manifestGzip}-byte gzip budget`);
  return { raw: bytes.length, gzip: compressed };
}

function exactKeys(value, keys, description) {
  invariant(isObject(value) && sameJSON(Object.keys(value).sort(), keys.sort()), `invalid ${description} fields`);
}

export function validateCompactGroup(group, kind) {
  return validateLayoutGroup(group, kind);
}

export function groupFromInventory(inventory, version = sha256(canonicalBytes(inventory))) {
  const group = { version, count: inventory.count, shard_size: inventory.shard_size };
  if (inventory.kind === 'puzzles') group.rating_counts = inventory.rating_counts;
  return group;
}

export function validateInventory(inventory, kind, version, bytes = canonicalBytes(inventory)) {
  invariant(KINDS.includes(kind) && HASH.test(version), 'invalid inventory identity');
  exactKeys(inventory, ['format', 'kind', 'count', 'shard_size', 'provenance', 'logical_sha256', 'shards',
    ...(kind === 'puzzles' ? ['rating_counts'] : [])], 'inventory');
  invariant(inventory.format === 1 && inventory.kind === kind && isObject(inventory.provenance)
    && HASH.test(inventory.logical_sha256), 'invalid inventory metadata');
  invariant(bytes.length <= LIMITS.inventory && bytes.equals(Buffer.from(canonicalJSONFromBytes(bytes, { parsed: inventory }).canonical)), 'inventory must be canonical compact sorted JSON without a newline');
  invariant(sha256(bytes) === version, `inventory version/hash mismatch: ${kind}/${version}`);
  validateCompactGroup({ version, count: inventory.count, shard_size: inventory.shard_size,
    ...(kind === 'puzzles' ? { rating_counts: inventory.rating_counts } : {}) }, kind);
  invariant(Array.isArray(inventory.shards) && inventory.shards.length > 0
    && inventory.shards.length < LIMITS.archiveFiles, 'invalid inventory shard list');
  const shardCount = kind === 'puzzles'
    ? inventory.rating_counts.reduce((sum, [, count]) => sum + countShards(count, inventory.shard_size), 0)
    : countShards(inventory.count, inventory.shard_size);
  invariant(shardCount === inventory.shards.length && shardCount < LIMITS.archiveFiles, 'inventory shard count mismatch');
  const expected = [];
  if (kind === 'puzzles') {
    for (const [rating, count] of inventory.rating_counts) {
      for (let offset = 0, index = 0; offset < count; offset += inventory.shard_size, index++) {
        expected.push({ path: `${rating}/${index}.json.gz`, count: Math.min(inventory.shard_size, count - offset) });
      }
    }
  } else {
    for (let offset = 0, index = 0; offset < inventory.count; offset += inventory.shard_size, index++) {
      expected.push({ path: `${index}.json.gz`, count: Math.min(inventory.shard_size, inventory.count - offset) });
    }
  }
  invariant(expected.length === inventory.shards.length, 'inventory shard count mismatch');
  let total = 0;
  inventory.shards.forEach((shard, index) => {
    exactKeys(shard, ['path', 'count', 'bytes', 'sha256'], 'inventory shard');
    invariant(shard.path === expected[index].path && shard.count === expected[index].count,
      'inventory shard path/order/count mismatch');
    invariant(positiveInteger(shard.bytes) && shard.bytes <= LIMITS.shard && HASH.test(shard.sha256), 'invalid shard bytes/hash or shard budget exceeded');
    total += shard.bytes;
  });
  invariant(total + bytes.length <= LIMITS.site, 'group exceeds site byte budget');
  return inventory;
}

export function readInventory(directory, kind, version, group) {
  const relative = `${kind}/${version}/inventory.json`;
  const bytes = readDataFile(directory, relative, LIMITS.inventory);
  const inventory = validateInventory(parseJSON(bytes, relative), kind, version, bytes);
  if (group) {
    validateCompactGroup(group, kind);
    invariant(sameJSON(groupFromInventory(inventory, version), {
      version: group.version, count: group.count, shard_size: group.shard_size,
      ...(kind === 'puzzles' ? { rating_counts: group.rating_counts } : {}),
    }), `${kind} manifest/inventory mismatch`);
  }
  return { inventory, bytes, relative };
}

// A prepared, validated release may reuse an existing immutable directory only
// after checking every byte. This avoids a rename gap for non-locking readers.
export function assertMaterializedGroup(directory, descriptor) {
  const loaded = readInventory(directory, descriptor.kind, descriptor.version);
  assertDescriptorInventory(descriptor, loaded.inventory, loaded.bytes);
  assertGroupTree(directory, descriptor.kind, descriptor.version, loaded.inventory);
  for (const shard of loaded.inventory.shards) {
    const relative = `${descriptor.kind}/${descriptor.version}/${shard.path}`;
    const bytes = readDataFile(directory, relative, LIMITS.shard);
    invariant(bytes.length === shard.bytes && sha256(bytes) === shard.sha256, `shard bytes/hash mismatch: ${relative}`);
  }
  return loaded;
}

export function inventoryFiles(inventory, version) {
  const prefix = `${inventory.kind}/${version}/`;
  return [`${prefix}inventory.json`, ...inventory.shards.map((shard) => prefix + shard.path)];
}

export function assertGroupTree(directory, kind, version, inventory) {
  const root = `${kind}/${version}`;
  regularPath(directory, `${root}/inventory.json`);
  directory = physicalPath(directory);
  const expected = new Set(inventoryFiles(inventory, version));
  const directories = new Set([...expected].flatMap((file) => {
    const parts = file.split('/');
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  }));
  const visit = (relative) => {
    for (const name of fs.readdirSync(path.join(directory, relative))) {
      const child = `${relative}/${name}`;
      const stat = fs.lstatSync(path.join(directory, child));
      invariant(!stat.isSymbolicLink(), `symlink in group: ${child}`);
      if (stat.isDirectory()) {
        invariant(directories.has(child), `unlisted group directory: ${child}`);
        visit(child);
      } else invariant(stat.isFile() && expected.delete(child), `unlisted group file: ${child}`);
    }
  };
  visit(root);
  invariant(expected.size === 0, 'missing inventory files');
}

export function validateDescriptor(descriptor, kind, { url = false } = {}) {
  invariant(KINDS.includes(kind), 'invalid archive kind');
  exactKeys(descriptor, ['kind', 'version', 'file', 'sha256', 'bytes', 'file_count', 'extracted_bytes', 'count', 'provenance',
    ...(url ? ['url'] : [])], 'archive descriptor');
  invariant(descriptor.kind === kind && typeof descriptor.version === 'string' && HASH.test(descriptor.version)
    && typeof descriptor.sha256 === 'string' && HASH.test(descriptor.sha256)
    && descriptor.file === `${kind}-${descriptor.version}.zip`, 'invalid archive identity');
  invariant(positiveInteger(descriptor.bytes) && descriptor.bytes <= LIMITS.site
    && positiveInteger(descriptor.file_count) && descriptor.file_count <= LIMITS.archiveFiles
    && positiveInteger(descriptor.extracted_bytes) && descriptor.extracted_bytes <= LIMITS.site
    && positiveInteger(descriptor.count) && isObject(descriptor.provenance), 'invalid archive limits or provenance');
  if (url) validateArtifactURL(descriptor.url, descriptor.file);
  return descriptor;
}

export function validateArtifactURL(value, filename) {
  let url;
  try { url = new URL(value); } catch { invariant(false, 'archive URL must be an explicit immutable HTTPS URL'); }
  invariant(typeof value === 'string' && url.protocol === 'https:' && !url.username && !url.password
    && !url.hash && !url.search && url.pathname.endsWith(`/${filename}`)
    && !url.pathname.split('/').some((part) => part.toLowerCase() === 'latest'),
  'archive URL must be an explicit immutable HTTPS URL ending in the versioned archive filename (no latest/query/fragment)');
  return url;
}

export function assertDescriptorInventory(descriptor, inventory, bytes) {
  invariant(descriptor.version === sha256(bytes) && descriptor.kind === inventory.kind
    && descriptor.count === inventory.count && sameJSON(descriptor.provenance, inventory.provenance)
    && descriptor.file_count === inventory.shards.length + 1
    && descriptor.extracted_bytes === bytes.length + inventory.shards.reduce((sum, shard) => sum + shard.bytes, 0),
  'archive descriptor/inventory mismatch');
}

// A local release has authenticated archive metadata, but deliberately has no
// production URLs or current/previous lock slots. Never manufacture a lock for it.
export function validateReleaseCandidate(candidate) {
  exactKeys(candidate, ['format', 'manifest', 'archives'], 'release candidate');
  invariant(candidate.format === 1 && isObject(candidate.manifest) && candidate.manifest.schema === 3,
    'release candidate requires schema 3');
  validateManifest(candidate.manifest);
  exactKeys(candidate.archives, [...KINDS], 'candidate archive groups');
  const manifestBytes = canonicalBytes(candidate.manifest);
  manifestBudget(manifestBytes);
  for (const kind of KINDS) {
    const descriptor = validateDescriptor(candidate.archives[kind], kind);
    invariant(descriptor.version === candidate.manifest[kind].version && descriptor.count === candidate.manifest[kind].count,
      `${kind} candidate/manifest mismatch`);
  }
  invariant(KINDS.reduce((sum, kind) => sum + candidate.archives[kind].extracted_bytes, 0)
    + manifestBytes.length <= LIMITS.site, 'candidate groups exceed site byte budget');
  return candidate;
}

export function readReleaseCandidate(filename) {
  const bytes = readDataFile(path.dirname(filename), path.basename(filename), LIMITS.inventory);
  return { candidate: validateReleaseCandidate(parseJSON(bytes, 'release candidate')), bytes };
}

export function validateLock(lock) {
  exactKeys(lock, ['format', 'manifest', 'archives'], 'training lock');
  invariant(lock.format === 1 && isObject(lock.manifest) && lock.manifest.schema === 3, 'production lock requires schema 3');
  validateManifest(lock.manifest);
  exactKeys(lock.archives, [...KINDS], 'lock archive groups');
  manifestBudget(canonicalBytes(lock.manifest));
  for (const kind of KINDS) {
    validateCompactGroup(lock.manifest[kind], kind);
    const versions = lock.archives[kind];
    invariant(isObject(versions) && Object.keys(versions).every((key) => ['current', 'previous'].includes(key)), 'invalid lock version slots');
    validateDescriptor(versions.current, kind, { url: true });
    invariant(versions.current.version === lock.manifest[kind].version && versions.current.count === lock.manifest[kind].count,
      `${kind} lock/manifest mismatch`);
    if (versions.previous !== undefined) {
      validateDescriptor(versions.previous, kind, { url: true });
      invariant(versions.previous.version !== versions.current.version, 'current and previous versions must be distinct');
    }
  }
  invariant(lockedDescriptors(lock).reduce((sum, descriptor) => sum + descriptor.extracted_bytes, 0)
    + canonicalBytes(lock.manifest).length <= LIMITS.site, 'locked current/previous groups exceed site byte budget');
  return lock;
}

export function bootstrapMessage(filename = DEFAULT_LOCK) {
  return `Missing production training-data lock: ${filename}. The repository owner must bootstrap a release: export release-candidate.json, upload its versioned archives to immutable HTTPS URLs, then run npm run data:pin -- --candidate <release-candidate.json> --puzzles-url <immutable-puzzles-url> --ordinary-url <immutable-ordinary-url>. Run npm run data:hydrate explicitly after pinning; builds never download data. Without a production lock, use npm run data:hydrate -- --local-release <release-directory> --output <training-directory> --offline, then npm run build -- --local --training-dir <training-directory> for an unpinned local preview.`;
}

export function readLock(filename = DEFAULT_LOCK) {
  let bytes;
  try { bytes = readDataFile(path.dirname(filename), path.basename(filename), LIMITS.inventory); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(bootstrapMessage(filename));
    throw error;
  }
  invariant(bytes.length <= LIMITS.inventory, 'lock file too large');
  return { lock: validateLock(parseJSON(bytes, 'training lock')), bytes };
}

export function lockedDescriptors(lock) {
  return KINDS.flatMap((kind) => ['current', 'previous'].flatMap((slot) => lock.archives[kind][slot] ? [lock.archives[kind][slot]] : []));
}

export function atomicWrite(filename, bytes) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

// Match Python Path.resolve(strict=False), even for a missing output beneath a
// symlinked parent. Resolve components before '..'; path.resolve() alone loses
// the physical meaning of paths such as 'alias/../training'.
export function physicalPath(filename) {
  invariant(typeof filename === 'string' && filename.length > 0 && !filename.includes('\0'), 'invalid filesystem path');
  const absolute = path.isAbsolute(filename) ? filename : `${process.cwd()}${path.sep}${filename}`;
  let root = path.parse(absolute).root, resolved = root, links = 0;
  const pending = absolute.slice(root.length).split(path.sep);
  while (pending.length) {
    const component = pending.shift();
    if (!component || component === '.') continue;
    if (component === '..') { resolved = path.dirname(resolved); continue; }
    const next = path.join(resolved, component);
    let stat;
    try { stat = fs.lstatSync(next); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (stat?.isSymbolicLink()) {
      invariant(++links <= 128, `symlink loop/excessive indirection: ${filename}`);
      const target = fs.readlinkSync(next);
      if (path.isAbsolute(target)) {
        root = path.parse(target).root;
        resolved = root;
        pending.unshift(...target.slice(root.length).split(path.sep));
      } else pending.unshift(...target.split(path.sep));
    } else resolved = next;
  }
  return resolved;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function acquirePublicationLock(output, { timeoutMs = 30_000, pollMs = 50 } = {}) {
  invariant(Number.isFinite(timeoutMs) && timeoutMs >= 0 && Number.isFinite(pollMs) && pollMs > 0, 'invalid lock wait');
  const directory = `${physicalPath(output)}.publication-lock`;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const token = randomUUID();
  const owner = { pid: process.pid, hostname: os.hostname(), started: new Date().toISOString(), token };
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      try { fs.writeFileSync(path.join(directory, 'owner.json'), canonicalBytes(owner), { flag: 'wx' }); }
      catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
      let released = false;
      return () => {
        if (released) return;
        invariant(parseJSON(readDataFile(directory, 'owner.json', 4096)).token === token, 'publication lock ownership changed; refusing to remove it');
        fs.rmSync(directory, { recursive: true });
        released = true;
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) {
        let diagnostic = 'owner.json unavailable';
        try { diagnostic = readDataFile(directory, 'owner.json', 4096).toString('utf8'); } catch { /* diagnostic only */ }
        throw new Error(`Timed out waiting for publication lock ${directory}; never stealing a lock. Owner: ${diagnostic}`);
      }
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - started))));
    }
  }
}

export async function withPublicationLock(output, action, options) {
  const release = await acquirePublicationLock(output, options);
  try { return await action(); } finally { release(); }
}

export async function hashFile(filename, maxBytes = LIMITS.site) {
  const stat = fs.lstatSync(filename);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, `unsafe or oversized file: ${filename}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filename, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) {
    bytes += chunk.length;
    invariant(bytes <= maxBytes, `file exceeds byte budget: ${filename}`);
    hash.update(chunk);
  }
  invariant(bytes === stat.size, `file changed while hashing: ${filename}`);
  return { sha256: hash.digest('hex'), bytes };
}

export async function verifyArchive(filename, descriptor) {
  const actual = await hashFile(filename, descriptor.bytes);
  invariant(actual.bytes === descriptor.bytes && actual.sha256 === descriptor.sha256, `archive bytes/SHA-256 mismatch: ${descriptor.file}`);
  return actual;
}

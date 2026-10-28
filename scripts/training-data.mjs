// Explicit release hydration/pinning. Builds never hydrate or download implicitly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createInflateRaw } from 'node:zlib';
import {
  LIMITS, DEFAULT_LOCK, DEFAULT_CACHE, KINDS, invariant, canonicalBytes, sameJSON,
  validateDescriptor, validateLock, readLock, lockedDescriptors, validateReleaseCandidate, readReleaseCandidate,
  validateArtifactURL, verifyArchive, readInventory, assertDescriptorInventory, assertMaterializedGroup, safeRelative,
  readManifestBytes, assertManifestUnchanged, withPublicationLock, atomicWrite, physicalPath,
} from './data-integrity.mjs';
import { validateData, validateGroup } from './validate-data.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pinning serializes by lock-file identity; packaging serializes by release
// directory. Hold those input locks as well as the output lock across the final
// compare-and-swap, so an input cannot change between its check and promotion.
async function withPublicationLocks(paths, action, options) {
  const keys = [...new Set(paths.map(physicalPath))].sort();
  const acquire = (index) => index === keys.length ? action()
    : withPublicationLock(keys[index], () => acquire(index + 1), options);
  return acquire(0);
}

// One deadline covers headers AND the streaming response body. Promise.race is
// deliberate: a custom transport that ignores AbortSignal must not hang us.
async function downloadAttempt(descriptor, destination, { fetchImpl, deadlineMs }) {
  const controller = new AbortController();
  let reader, fd, timer;
  const timedOut = new Error(`Download timed out: ${descriptor.file}`);
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(timedOut); reject(timedOut); }, deadlineMs);
    });
    await Promise.race([(async () => {
      const response = await fetchImpl(descriptor.url, { signal: controller.signal, redirect: 'follow' });
      if (controller.signal.aborted) {
        try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* ignored transport cleanup */ }
        throw timedOut;
      }
      invariant(response.ok, `download HTTP ${response.status}: ${descriptor.file}`);
      if (response.url) invariant(new URL(response.url).protocol === 'https:', 'archive redirected to a non-HTTPS URL');
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined) invariant(/^\d+$/.test(length) && Number(length) === descriptor.bytes, 'download Content-Length mismatch');
      invariant(response.body && typeof response.body.getReader === 'function', 'download has no streaming body');
      if (controller.signal.aborted) throw timedOut;
      reader = response.body.getReader();
      fd = fs.openSync(destination, 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw timedOut;
        if (chunk.done) break;
        invariant(chunk.value instanceof Uint8Array, 'invalid download body chunk');
        bytes += chunk.value.length;
        invariant(bytes <= descriptor.bytes, 'download exceeds declared byte limit');
        hash.update(chunk.value);
        fs.writeFileSync(fd, chunk.value);
      }
      invariant(bytes === descriptor.bytes && hash.digest('hex') === descriptor.sha256, `download bytes/SHA-256 mismatch: ${descriptor.file}`);
      fs.fsyncSync(fd);
    })(), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Do not await cancellation of a transport that already ignored its deadline.
    if (reader) Promise.resolve(reader.cancel()).catch(() => {});
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function cachedArchive(descriptor, {
  cacheDir = DEFAULT_CACHE, offline = false, fetchImpl = globalThis.fetch, attempts = 3,
  deadlineMs = 120_000, retryDelayMs = 200,
} = {}) {
  validateDescriptor(descriptor, descriptor.kind, { url: Object.hasOwn(descriptor, 'url') });
  invariant(typeof offline === 'boolean', 'invalid offline option');
  invariant(Number.isInteger(attempts) && attempts >= 1 && attempts <= 5
    && Number.isFinite(deadlineMs) && deadlineMs > 0 && deadlineMs <= 30 * 60_000
    && Number.isFinite(retryDelayMs) && retryDelayMs >= 0 && retryDelayMs <= 10_000, 'invalid download retry/deadline limits');
  fs.mkdirSync(cacheDir, { recursive: true });
  invariant(fs.lstatSync(cacheDir).isDirectory() && !fs.lstatSync(cacheDir).isSymbolicLink(), 'unsafe archive cache directory');
  const filename = path.join(cacheDir, `${descriptor.sha256}.zip`);
  let cacheFailure;
  try {
    await verifyArchive(filename, descriptor); // Even a content-addressed hit is rehashed.
    return filename;
  } catch (error) {
    cacheFailure = error;
    if (error.code !== 'ENOENT') {
      const stat = fs.lstatSync(filename);
      invariant(stat.isFile() && !stat.isSymbolicLink(), 'unsafe cached archive');
    }
  }
  // Neither remove corrupt cache entries nor invoke the transport in offline mode.
  invariant(!offline, `offline archive cache ${cacheFailure.code === 'ENOENT' ? 'miss' : 'corruption'}: ${filename}. Run npm run data:hydrate without --offline to obtain verified archives; no network was attempted`);
  validateArtifactURL(descriptor.url, descriptor.file);
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const temporary = `${filename}.part-${process.pid}-${randomUUID()}`;
    try {
      await downloadAttempt(descriptor, temporary, { fetchImpl, deadlineMs });
      // A failed repair preserves the old entry until a complete verified download
      // can atomically replace it. This cache is not an immutable version directory.
      fs.renameSync(temporary, filename);
      return filename;
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts) await pause(retryDelayMs * (attempt + 1));
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  throw new Error(`Failed downloading ${descriptor.file} after ${attempts} attempt(s): ${failure.message}`);
}

// The ZIP central directory is small, but shard bodies are streamed. Validate
// both directories/headers rather than trusting an unzipper's path normalization
// or ignoring Unix symlink modes, duplicate names, CRCs, trailing junk, or gaps.
const u16 = (bytes, offset) => bytes.readUInt16LE(offset);
const u32 = (bytes, offset) => bytes.readUInt32LE(offset);
const u64 = (bytes, offset) => {
  const value = bytes.readBigUInt64LE(offset);
  invariant(value <= BigInt(Number.MAX_SAFE_INTEGER), 'ZIP64 value exceeds safe integer');
  return Number(value);
};
function readAt(fd, length, position) {
  invariant(Number.isSafeInteger(length) && length >= 0 && length <= 64 * 1024 * 1024, 'ZIP header exceeds byte limit');
  const bytes = Buffer.alloc(length);
  invariant(fs.readSync(fd, bytes, 0, length, position) === length, 'truncated ZIP header');
  return bytes;
}
function zipExtra(extra) {
  const fields = new Map();
  for (let offset = 0; offset < extra.length;) {
    invariant(offset + 4 <= extra.length, 'invalid ZIP extra header');
    const id = u16(extra, offset), length = u16(extra, offset + 2);
    invariant(offset + 4 + length <= extra.length && !fields.has(id), 'duplicate/truncated ZIP extra field');
    // Unicode path overrides and encrypted metadata have no place in releases.
    invariant(![0x7075, 0x6375, 0x0017, 0x9901].includes(id), 'unsupported ZIP path/encryption extra field');
    fields.set(id, extra.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return fields;
}
function zip64Values(fields, requested) {
  if (!requested.some(Boolean)) return [];
  const bytes = fields.get(1);
  invariant(bytes, 'missing ZIP64 size field');
  const values = [];
  let offset = 0;
  requested.forEach((needed) => {
    if (!needed) { values.push(undefined); return; }
    invariant(offset + 8 <= bytes.length, 'truncated ZIP64 size field');
    values.push(u64(bytes, offset));
    offset += 8;
  });
  return values;
}

export function inspectArchive(filename, descriptor) {
  validateDescriptor(descriptor, descriptor.kind, { url: Object.hasOwn(descriptor, 'url') });
  const stat = fs.lstatSync(filename);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size === descriptor.bytes, 'archive bytes mismatch');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    invariant(stat.size >= 22, 'truncated ZIP');
    const tailStart = Math.max(0, stat.size - 22 - 65535);
    const tail = readAt(fd, stat.size - tailStart, tailStart);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (u32(tail, offset) === 0x06054b50 && offset + 22 + u16(tail, offset + 20) === tail.length) { end = offset; break; }
    }
    invariant(end !== -1, 'invalid ZIP end header/trailing bytes');
    invariant(u16(tail, end + 4) === 0 && u16(tail, end + 6) === 0 && u16(tail, end + 8) === u16(tail, end + 10), 'multi-disk ZIP is forbidden');
    let count = u16(tail, end + 10), centralSize = u32(tail, end + 12), centralOffset = u32(tail, end + 16);
    let centralEnd = tailStart + end;
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      const locator = readAt(fd, 20, centralEnd - 20);
      invariant(u32(locator, 0) === 0x07064b50 && u32(locator, 4) === 0 && u32(locator, 16) === 1, 'invalid ZIP64 locator');
      const zip64Offset = u64(locator, 8), header = readAt(fd, 56, zip64Offset);
      invariant(u32(header, 0) === 0x06064b50 && u64(header, 4) === 44 && zip64Offset + 56 === centralEnd - 20
        && u32(header, 16) === 0 && u32(header, 20) === 0 && u64(header, 24) === u64(header, 32), 'invalid ZIP64 end header');
      count = u64(header, 32);
      centralSize = u64(header, 40);
      centralOffset = u64(header, 48);
      centralEnd = zip64Offset;
    }
    invariant(count === descriptor.file_count && count <= LIMITS.archiveFiles
      && centralOffset >= 0 && centralOffset + centralSize === centralEnd, 'ZIP file count/directory size mismatch');
    const central = readAt(fd, centralSize, centralOffset);
    const entries = [], names = new Set();
    let offset = 0, total = 0;
    for (let index = 0; index < count; index++) {
      invariant(offset + 46 <= central.length && u32(central, offset) === 0x02014b50, 'invalid ZIP central header');
      const needed = u16(central, offset + 6), flags = u16(central, offset + 8), method = u16(central, offset + 10);
      invariant(needed <= 45 && (flags & ~0x080e) === 0 && [0, 8].includes(method)
        && (method === 8 || (flags & 6) === 0), 'unsupported/encrypted ZIP header');
      const nameLength = u16(central, offset + 28), extraLength = u16(central, offset + 30), commentLength = u16(central, offset + 32);
      const endOffset = offset + 46 + nameLength + extraLength + commentLength;
      invariant(endOffset <= central.length && u16(central, offset + 34) === 0, 'invalid ZIP central lengths/disk');
      const nameBytes = central.subarray(offset + 46, offset + 46 + nameLength);
      const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
      const prefix = `${descriptor.kind}/${descriptor.version}/`;
      const pattern = descriptor.kind === 'puzzles' ? /^(?:inventory\.json|(?:0|-?[1-9]\d*)\/(?:0|[1-9]\d*)\.json\.gz)$/ : /^(?:inventory\.json|(?:0|[1-9]\d*)\.json\.gz)$/;
      safeRelative(name);
      invariant(name.startsWith(prefix) && pattern.test(name.slice(prefix.length)) && !names.has(name), `unsafe/duplicate/unexpected ZIP path: ${name}`);
      if (descriptor.kind === 'puzzles' && !name.endsWith('/inventory.json')) {
        const rating = name.slice(prefix.length).split('/')[0];
        invariant(Number.isSafeInteger(Number(rating)) && String(Number(rating)) === rating, `unsafe ZIP rating: ${rating}`);
      }
      names.add(name);
      const attributes = u32(central, offset + 38), mode = attributes >>> 16, type = mode & 0xf000;
      invariant((type === 0 || type === 0x8000) && (attributes & 0x18) === 0, 'ZIP links/directories/special files are forbidden');
      const fields = zipExtra(central.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
      let size = u32(central, offset + 24), compressed = u32(central, offset + 20), localOffset = u32(central, offset + 42);
      const large = zip64Values(fields, [size === 0xffffffff, compressed === 0xffffffff, localOffset === 0xffffffff]);
      size = large[0] ?? size;
      compressed = large[1] ?? compressed;
      localOffset = large[2] ?? localOffset;
      const inventory = name.endsWith('/inventory.json');
      invariant(size > 0 && size <= (inventory ? LIMITS.inventory : LIMITS.shard)
        && compressed > 0 && compressed <= (inventory ? LIMITS.inventory : LIMITS.shard)
        && (inventory || method === 0) && (method !== 0 || compressed === size), 'ZIP entry byte/compression limit exceeded; gzip shards must be stored');
      total += size;
      invariant(total <= descriptor.extracted_bytes && total <= LIMITS.site, 'ZIP extracted byte limit exceeded');
      entries.push({ name, nameBytes, size, compressed, offset: localOffset, method, flags, crc: u32(central, offset + 16) });
      offset = endOffset;
    }
    invariant(offset === central.length && total === descriptor.extracted_bytes, 'ZIP central/extracted byte count mismatch');
    const ordered = [...entries].sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    ordered.forEach((entry, index) => {
      invariant(entry.offset === cursor && entry.offset + 30 <= centralOffset, 'overlapping/gapped ZIP entries');
      const local = readAt(fd, 30, entry.offset);
      invariant(u32(local, 0) === 0x04034b50 && u16(local, 4) <= 45 && u16(local, 6) === entry.flags
        && u16(local, 8) === entry.method, 'ZIP local/central header mismatch');
      const nameLength = u16(local, 26), extraLength = u16(local, 28);
      const variable = readAt(fd, nameLength + extraLength, entry.offset + 30);
      invariant(variable.subarray(0, nameLength).equals(entry.nameBytes), 'ZIP local/central path mismatch');
      const fields = zipExtra(variable.subarray(nameLength));
      let size = u32(local, 22), compressed = u32(local, 18);
      const large = zip64Values(fields, [size === 0xffffffff, compressed === 0xffffffff]);
      size = large[0] ?? size;
      compressed = large[1] ?? compressed;
      const crc = u32(local, 14);
      if (entry.flags & 8) invariant((size === 0 || size === entry.size) && (compressed === 0 || compressed === entry.compressed)
        && (crc === 0 || crc === entry.crc), 'invalid ZIP streaming local sizes');
      else invariant(size === entry.size && compressed === entry.compressed && crc === entry.crc, 'ZIP local/central sizes/CRC mismatch');
      entry.start = entry.offset + 30 + nameLength + extraLength;
      const dataEnd = entry.start + entry.compressed, next = ordered[index + 1]?.offset ?? centralOffset;
      invariant(dataEnd <= next, 'overlapping/truncated ZIP data');
      if (entry.flags & 8) {
        const length = next - dataEnd;
        invariant([12, 16, 20, 24].includes(length), 'invalid ZIP data descriptor length');
        const dd = readAt(fd, length, dataEnd);
        const signature = [16, 24].includes(length);
        if (signature) invariant(u32(dd, 0) === 0x08074b50, 'invalid ZIP data descriptor signature');
        const at = signature ? 4 : 0, wide = length >= 20;
        invariant(u32(dd, at) === entry.crc && (wide ? u64(dd, at + 4) : u32(dd, at + 4)) === entry.compressed
          && (wide ? u64(dd, at + 12) : u32(dd, at + 8)) === entry.size, 'ZIP data descriptor mismatch');
      } else invariant(dataEnd === next, 'ZIP data has unexplained gaps');
      cursor = next;
    });
    invariant(cursor === centralOffset, 'invalid ZIP local directory');
    return entries;
  } finally { fs.closeSync(fd); }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function updateCRC(crc, bytes) {
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return crc;
}
function extractionDestination(root, relative) {
  safeRelative(relative);
  let directory = path.resolve(root);
  invariant(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'unsafe extraction directory');
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    invariant(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'unsafe extraction parent');
  }
  return path.join(directory, parts.at(-1));
}

export async function extractArchive(filename, destination, descriptor) {
  await verifyArchive(filename, descriptor);
  const entries = inspectArchive(filename, descriptor);
  for (const entry of entries) {
    const target = extractionDestination(destination, entry.name);
    const fd = fs.openSync(target, 'wx', 0o600);
    const source = fs.createReadStream(filename, { start: entry.start, end: entry.start + entry.compressed - 1,
      flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
    const inflated = entry.method === 8 ? createInflateRaw() : source;
    if (inflated !== source) {
      source.on('error', (error) => inflated.destroy(error));
      source.pipe(inflated);
    }
    let bytes = 0, crc = 0xffffffff;
    try {
      for await (const chunk of inflated) {
        bytes += chunk.length;
        invariant(bytes <= entry.size, 'ZIP expanded body exceeds declared size');
        crc = updateCRC(crc, chunk);
        fs.writeFileSync(fd, chunk);
      }
      invariant(bytes === entry.size && ((crc ^ 0xffffffff) >>> 0) === entry.crc, 'ZIP extracted size/CRC mismatch');
      if (entry.method === 8) invariant(inflated.bytesWritten === entry.compressed, 'trailing compressed ZIP entry bytes');
    } finally {
      source.destroy();
      if (inflated !== source) inflated.destroy();
      fs.closeSync(fd);
    }
  }
  const loaded = readInventory(destination, descriptor.kind, descriptor.version);
  assertDescriptorInventory(descriptor, loaded.inventory, loaded.bytes);
  return entries.map((entry) => entry.name);
}

export function validateLockedData(trainingDir, lock, { deep = false } = {}) {
  validateLock(lock);
  const result = validateData(trainingDir, { deep, enforceBudgets: true });
  invariant(sameJSON(result.manifest, lock.manifest), 'live manifest does not match production lock; run npm run data:hydrate explicitly');
  const files = [...result.files];
  for (const descriptor of lockedDescriptors(lock)) {
    const current = descriptor.version === lock.manifest[descriptor.kind].version;
    const loaded = current ? result.groups[descriptor.kind]
      : validateGroup(trainingDir, descriptor.kind, descriptor.version, { deep });
    assertDescriptorInventory(descriptor, loaded.inventory, loaded.inventoryBytes);
    if (!current) files.push(...loaded.files);
  }
  return { ...result, files };
}

export function validateCandidateData(trainingDir, candidate, { deep = false } = {}) {
  validateReleaseCandidate(candidate);
  const result = validateData(trainingDir, { deep, enforceBudgets: true });
  invariant(sameJSON(result.manifest, candidate.manifest), 'materialized manifest does not match local release candidate');
  for (const kind of KINDS) {
    const loaded = result.groups[kind];
    assertDescriptorInventory(candidate.archives[kind], loaded.inventory, loaded.inventoryBytes);
  }
  return { ...result, local: true };
}

// All checks are offline; --local intentionally does not read a production lock.
export async function checkTrainingData({ trainingDir = 'public/training', lockFile = DEFAULT_LOCK,
  local = false, deep = false, lockOptions } = {}) {
  return withPublicationLock(trainingDir, () => local
    ? { ...validateData(trainingDir, { deep, enforceBudgets: true }), local: true }
    : validateLockedData(trainingDir, readLock(lockFile).lock, { deep }), lockOptions);
}

// Preparation happens outside the live tree. Existing immutable versions are
// either authenticated and reused, or rejected. Repairs require operator action;
// we never rename, replace, edit, or delete a previously published directory.
export async function publishStagedData({ stageDir, trainingDir, lock, candidate, capturedManifest,
  lockFile, capturedLock, candidateFile, capturedCandidate, lockOptions, deep = false }) {
  invariant(Boolean(lock) !== Boolean(candidate), 'publication requires either a production lock or a local release candidate');
  const stage = physicalPath(stageDir), output = physicalPath(trainingDir);
  invariant(stage !== output && !stage.startsWith(`${output}${path.sep}`) && !output.startsWith(`${stage}${path.sep}`), 'publication staging must be outside the live training tree');
  const result = lock ? validateLockedData(stageDir, lock, { deep }) : validateCandidateData(stageDir, candidate, { deep });
  const descriptors = lock ? lockedDescriptors(lock) : KINDS.map((kind) => candidate.archives[kind]);
  await withPublicationLocks([trainingDir, ...(lockFile ? [lockFile] : []),
    ...(candidateFile ? [path.dirname(candidateFile)] : [])], () => {
    assertManifestUnchanged(trainingDir, capturedManifest);
    if (lockFile) invariant(readLock(lockFile).bytes.equals(capturedLock), 'production lock changed while preparing hydration; retry');
    if (candidateFile) invariant(readReleaseCandidate(candidateFile).bytes.equals(capturedCandidate), 'local release candidate changed while preparing hydration; retry');
    fs.mkdirSync(output, { recursive: true });
    invariant(fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink(), 'unsafe training directory');
    const pending = [];
    // Preflight every destination before moving even one new version.
    for (const descriptor of descriptors) {
      const kindDir = path.join(output, descriptor.kind);
      fs.mkdirSync(kindDir, { recursive: true });
      invariant(fs.lstatSync(kindDir).isDirectory() && !fs.lstatSync(kindDir).isSymbolicLink(), 'unsafe live group directory');
      const target = path.join(kindDir, descriptor.version);
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe live version directory');
        try { assertMaterializedGroup(output, descriptor); }
        catch (error) {
          throw new Error(`Existing immutable version is corrupt or incomplete: ${target}; refusing to replace it. Operator recovery is required outside this transaction. ${error.message}`, { cause: error });
        }
      } else pending.push({ descriptor, target });
    }
    const installed = [];
    let committed = false;
    try {
      for (const { descriptor, target } of pending) {
        fs.renameSync(path.join(stage, descriptor.kind, descriptor.version), target);
        installed.push(target);
      }
      // All immutable groups are present. The only commit point is the manifest.
      atomicWrite(path.join(output, 'manifest.json'), readManifestBytes(stage));
      committed = true;
    } finally {
      // Only unreferenced directories created by this attempt may be rolled back;
      // no preexisting current/previous version is ever touched.
      if (!committed) for (const target of installed.reverse()) fs.rmSync(target, { recursive: true, force: true });
    }
  }, lockOptions);
  return result;
}

export async function hydrateTrainingData({ trainingDir = 'public/training', lockFile = DEFAULT_LOCK,
  cacheDir = DEFAULT_CACHE, localReleaseDir, offline = false, deep = false, lockOptions, ...downloadOptions } = {}) {
  invariant(typeof offline === 'boolean', 'invalid offline option');
  const candidateFile = localReleaseDir ? path.join(localReleaseDir, 'release-candidate.json') : undefined;
  // Local releases are a separate trust mode, not fake remote URLs or fabricated
  // production locks. This branch never reads or writes any production lock.
  const { candidate, bytes: capturedCandidate } = candidateFile ? readReleaseCandidate(candidateFile) : {};
  const { lock, bytes: capturedLock } = candidate ? {} : readLock(lockFile);
  const capturedManifest = readManifestBytes(trainingDir, { optional: true });
  const output = physicalPath(trainingDir), parent = path.dirname(output);
  if (!candidate) {
    const cache = physicalPath(cacheDir);
    invariant(cache !== output && !cache.startsWith(`${output}${path.sep}`), 'archive cache must be outside public training data');
  }
  fs.mkdirSync(parent, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}-hydrate-`));
  try {
    for (const descriptor of candidate ? KINDS.map((kind) => candidate.archives[kind]) : lockedDescriptors(lock)) {
      const archive = candidate ? path.join(localReleaseDir, descriptor.file)
        : await cachedArchive(descriptor, { ...downloadOptions, cacheDir, offline });
      await extractArchive(archive, stageDir, descriptor);
    }
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), canonicalBytes((candidate || lock).manifest));
    return await publishStagedData({ stageDir, trainingDir, lock, candidate, capturedManifest,
      ...(candidate ? { candidateFile, capturedCandidate } : { lockFile, capturedLock }), lockOptions, deep });
  } finally { fs.rmSync(stageDir, { recursive: true, force: true }); }
}

// Compatibility for callers of the original explicit fetch API/command.
export const fetchTrainingData = hydrateTrainingData;

export async function pinRelease({ candidateFile, puzzlesURL, ordinaryURL, lockFile = DEFAULT_LOCK,
  deep = false, lockOptions } = {}) {
  invariant(typeof candidateFile === 'string' && puzzlesURL && ordinaryURL,
    'pin requires --candidate, --puzzles-url, and --ordinary-url; no production URLs are inferred');
  const { candidate, bytes: capturedCandidate } = readReleaseCandidate(candidateFile);
  let prior, priorBytes = null;
  try { ({ lock: prior, bytes: priorBytes } = readLock(lockFile)); }
  catch (error) { if (fs.existsSync(lockFile)) throw error; }
  const archives = {};
  for (const [kind, url] of [['puzzles', puzzlesURL], ['ordinary', ordinaryURL]]) {
    const descriptor = candidate.archives[kind];
    validateArtifactURL(url, descriptor.file);
    const current = { ...descriptor, url };
    const previous = prior?.archives[kind].current.version === current.version
      ? prior.archives[kind].previous : prior?.archives[kind].current;
    if (prior?.archives[kind].current.version === current.version) {
      const { url: oldURL, ...oldDescriptor } = prior.archives[kind].current;
      invariant(sameJSON(oldDescriptor, descriptor), 'same version has different archive metadata');
    }
    archives[kind] = { current, ...(previous ? { previous } : {}) };
  }
  const lock = validateLock({ format: 1, manifest: candidate.manifest, archives });
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpnp-pin-'));
  try {
    for (const kind of KINDS) {
      const descriptor = candidate.archives[kind];
      await extractArchive(path.join(path.dirname(candidateFile), descriptor.file), stageDir, descriptor);
    }
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), canonicalBytes(candidate.manifest));
    validateCandidateData(stageDir, candidate, { deep });
    // Pinning only mutates the lock file, not a training tree. Protect the
    // capture checks and commit by its physical identity, independently of
    // callers' --training-dir choices (including different path aliases).
    await withPublicationLocks([lockFile, path.dirname(candidateFile)], () => {
      invariant(readReleaseCandidate(candidateFile).bytes.equals(capturedCandidate), 'release candidate changed while pinning; retry');
      const live = fs.existsSync(lockFile) ? readLock(lockFile).bytes : null;
      invariant(live === null ? priorBytes === null : priorBytes !== null && live.equals(priorBytes), 'production lock changed while pinning; retry');
      atomicWrite(lockFile, canonicalBytes(lock));
    }, lockOptions);
    return lock;
  } finally { fs.rmSync(stageDir, { recursive: true, force: true }); }
}

function cliOptions(command, args) {
  const output = {};
  const values = { '--training-dir': 'trainingDir', '--output': 'trainingDir', '--lock': 'lockFile', '--cache-dir': 'cacheDir',
    '--local-release': 'localReleaseDir', '--candidate': 'candidateFile', '--puzzles-url': 'puzzlesURL', '--ordinary-url': 'ordinaryURL' };
  const flags = { '--deep': 'deep', '--offline': 'offline', '--local': 'local' };
  const allowed = {
    hydrate: ['trainingDir', 'lockFile', 'cacheDir', 'localReleaseDir', 'deep', 'offline'],
    check: ['trainingDir', 'lockFile', 'deep', 'offline', 'local'],
    pin: ['trainingDir', 'lockFile', 'candidateFile', 'puzzlesURL', 'ordinaryURL', 'deep'],
  }[command === 'fetch' ? 'hydrate' : command];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], key = flags[arg] || values[arg];
    invariant(key && allowed.includes(key) && !Object.hasOwn(output, key), `unknown/duplicate ${command} option: ${arg}`);
    if (flags[arg]) output[key] = true;
    else {
      invariant(args[index + 1] && !args[index + 1].startsWith('--'), `missing CLI option value: ${arg}`);
      output[key] = args[++index];
    }
  }
  if (output.localReleaseDir || output.local) {
    invariant(output.trainingDir, '--local-release/--local requires an explicit --output or --training-dir');
    invariant(!output.lockFile, 'local mode does not use --lock; no production lock is read or written');
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    invariant(['hydrate', 'fetch', 'check', 'pin'].includes(command), 'usage: node scripts/training-data.mjs hydrate|check|pin [--training-dir DIR] [--lock FILE] [--deep]; hydrate --offline uses only verified cache; hydrate --local-release DIR --output DIR --offline needs no production lock; check --local --training-dir DIR validates an unpinned export');
    const options = cliOptions(command, args);
    const result = await ({ hydrate: hydrateTrainingData, fetch: hydrateTrainingData, check: checkTrainingData, pin: pinRelease })[command](options);
    const manifest = result.manifest;
    console.log(`${command}: ${manifest.puzzles.count} puzzles, ${manifest.ordinary.count} ordinary positions; schema ${manifest.schema}.${result.local ? ' UNPINNED LOCAL PREVIEW; no production lock read or written.' : ''}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { makeSchema3Assets } from './data-fixtures.js';
import { canonicalBytes, sha256, LIMITS } from '../scripts/data-integrity.mjs';

function sourceArchive(t, options = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maybe-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/source.mjs', '--out-dir', directory, ...options], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bytes = fs.readFileSync(path.join(directory, 'source.zip'));
  assert(bytes.length <= LIMITS.source);
  return { directory, files: unzipSync(bytes) };
}

function assertCorrespondingSource(files) {
  const prefix = 'chess-puzzle-not-puzzle/';
  for (const required of [
    'web/session.js', 'web/catalog.js', 'web/data-layout.js', 'training_assets.py', 'package_corpus.py',
    'export_static.py', 'import_puzzles.py', 'snapshot_corpus.py', 'expand_corpus.py',
    'scripts/training-data.mjs', 'scripts/data-integrity.mjs', 'scripts/build.mjs', 'scripts/source.mjs',
    'scripts/validate-data.mjs', 'tests/training-data.test.js', 'tests/performance.spec.js',
    'CORPUS.md', 'README.md', 'HOSTING.md', 'THIRD_PARTY.md', 'LICENSE', 'data/README.md',
    'package-lock.json', 'uv.lock', '.github/workflows/pages.yml',
    'public/themes/README.md', 'public/themes/Apache-2.0.txt',
    'node_modules/chess.js/src/chess.ts', 'node_modules/chess.js/LICENSE',
    'node_modules/@lichess-org/chessground/src/board.ts', 'node_modules/@lichess-org/chessground/LICENSE',
    'node_modules/fflate/esm/index.mjs', 'node_modules/fflate/LICENSE',
  ]) assert(Object.hasOwn(files, prefix + required), `missing corresponding source: ${required}`);
  for (const filename of Object.keys(files)) {
    assert(!/\/public\/training\/|\.json\.gz$|\.sqlite3(?:-|$)|\.pgn$|\.csv(?:\.zst)?$|\.zip$|\/cache\/|\/archives\/|\/static-checkpoints\/|__pycache__|commit-session\.sh/.test(filename), `generated/private data in source: ${filename}`);
  }
}

test('local source ZIP supplies complete tools/notices but never generated corpus or authoring state', (t) => {
  // A publisher can prepare a sibling staging tree while the build packages
  // source. Exclude it before traversal, even if it contains links or vanishes.
  const stage = fs.mkdtempSync(path.join('public', '.training-hydrate-source-test-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stage, 'must-not-ship.json.gz'), 'generated data');
  fs.symlinkSync(path.resolve('public/training'), path.join(stage, 'must-not-follow'), 'dir');
  const { files, directory } = sourceArchive(t, ['--local']);
  assert(!Object.keys(files).some((name) => name.includes('.training-hydrate-source-test-')));
  assertCorrespondingSource(files);
  assert.match(new TextDecoder().decode(files['chess-puzzle-not-puzzle/LOCAL-PREVIEW.txt']), /UNPINNED LOCAL PREVIEW/);
  assert(!Object.hasOwn(files, 'chess-puzzle-not-puzzle/training-data.lock.json'));
  assert.match(fs.readFileSync(path.join(directory, 'licenses.txt'), 'utf8'), /Jeff Hlywa/);
});

test('production corresponding source contains the exact frozen retrieval lock', (t) => {
  const { manifest, files } = makeSchema3Assets();
  const archives = {};
  for (const kind of ['puzzles', 'ordinary']) {
    const group = manifest[kind], raw = files.get(`${kind}/${group.version}/inventory.json`);
    const inventory = JSON.parse(new TextDecoder().decode(raw));
    const filename = `${kind}-${group.version}.zip`;
    archives[kind] = { current: { kind, version: group.version, file: filename, sha256: sha256(Buffer.from(kind)),
      bytes: 1024, file_count: inventory.shards.length + 1,
      extracted_bytes: raw.length + inventory.shards.reduce((sum, shard) => sum + shard.bytes, 0),
      count: group.count, provenance: inventory.provenance, url: `https://example.test/releases/fixture/${filename}` } };
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maybe-source-lock-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const lockFile = path.join(temporary, 'frozen-lock.json');
  const lockBytes = canonicalBytes({ format: 1, manifest, archives });
  fs.writeFileSync(lockFile, lockBytes);
  const { files: source } = sourceArchive(t, ['--lock', lockFile]);
  assertCorrespondingSource(source);
  assert.deepEqual(Buffer.from(source['chess-puzzle-not-puzzle/training-data.lock.json']), lockBytes);
  assert(!Object.hasOwn(source, 'chess-puzzle-not-puzzle/LOCAL-PREVIEW.txt'));
});

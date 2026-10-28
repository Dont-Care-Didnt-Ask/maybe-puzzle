// Stream the GPL frontend's corresponding source, not a second CC0 corpus.
import fs from 'node:fs';
import path from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { DEFAULT_LOCK, LIMITS, readLock } from './data-integrity.mjs';

let outDir = 'dist', lockFile = DEFAULT_LOCK, local = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--local') local = true;
  else if (['--out-dir', '--lock'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) {
    if (arg === '--out-dir') outDir = args[++index];
    else lockFile = args[++index];
  } else throw new Error(`Unknown/missing source option: ${arg}`);
}
// A production build passes the lock frozen with its training snapshot. Never
// reread a changing live lock half way through producing corresponding source.
const lockBytes = local ? null : readLock(lockFile).bytes;
fs.mkdirSync(outDir, { recursive: true });
const destination = fs.openSync(path.join(outDir, 'source.zip'), 'w');
let count = 0, written = 0;
const names = new Set();
const zip = new Zip((error, data, final) => {
  if (error) throw error;
  written += data.length;
  if (written > LIMITS.source) throw new Error('source.zip exceeds the 10 MiB budget');
  fs.writeSync(destination, data);
  if (final) fs.closeSync(destination);
});
function addBytes(relative, bytes) {
  const name = `chess-puzzle-not-puzzle/${relative}`;
  if (names.has(name)) throw new Error(`Duplicate source entry: ${name}`);
  names.add(name);
  const entry = new ZipDeflate(name, { level: 6 });
  zip.add(entry);
  entry.push(bytes, true);
  count++;
}
function add(filename) {
  const relative = filename.split(path.sep).join('/');
  // Hydration uses reserved siblings while the live training lock is released
  // during source packaging. They are generated corpus/lock state too, never
  // corresponding application source (and may disappear during traversal).
  const publicName = relative.startsWith('public/') ? relative.split('/')[1] : null;
  if (publicName === 'training' || publicName === 'training.publication-lock'
    || publicName?.startsWith('.training-') || publicName?.startsWith('training.tmp-')) return;
  if (!fs.existsSync(filename)) throw new Error(`Missing corresponding source: ${filename}`);
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw new Error(`Symlink in corresponding source: ${filename}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(filename).sort()) {
      if (!['__pycache__', '.DS_Store', '.pytest_cache'].includes(name)) add(path.join(filename, name));
    }
  } else {
    if (!stat.isFile()) throw new Error(`Not a regular source file: ${filename}`);
    const name = `chess-puzzle-not-puzzle/${relative}`;
    if (names.has(name)) throw new Error(`Duplicate source entry: ${name}`);
    names.add(name);
    const entry = filename.endsWith('.gz') ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    const source = fs.openSync(filename, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let length;
      while ((length = fs.readSync(source, buffer)) > 0) entry.push(buffer.subarray(0, length));
      entry.push(new Uint8Array(0), true);
    } finally { fs.closeSync(source); }
    count++;
  }
}
for (const file of [
  'engine.py', 'prepare.py', 'export_static.py', 'import_puzzles.py', 'expand_corpus.py', 'snapshot_corpus.py',
  'training_assets.py', 'package_corpus.py', 'benchmark.py', 'pyproject.toml', 'uv.lock',
  'package.json', 'package-lock.json', 'vite.config.js', 'playwright.config.js', 'index.html',
  'README.md', 'CORPUS.md', 'DECISIONS.md', 'HOSTING.md', 'LICENSE', 'THIRD_PARTY.md', '.gitignore',
  'web', 'scripts', 'tests', '.github', 'public', 'data/README.md',
]) add(file);
if (lockBytes) addBytes('training-data.lock.json', lockBytes);
else addBytes('LOCAL-PREVIEW.txt', Buffer.from('UNPINNED LOCAL PREVIEW\nNo production release lock was supplied. See CORPUS.md for verified release retrieval and owner bootstrap.\n'));
for (const [name, folders] of [
  ['@lichess-org/chessground', ['src', 'assets', 'LICENSE', 'package.json']],
  ['chess.js', ['src', 'LICENSE', 'package.json']],
  ['fflate', ['esm', 'LICENSE', 'package.json']],
]) {
  for (const folder of folders) add(`node_modules/${name}/${folder}`);
}
zip.end();
fs.writeFileSync(path.join(outDir, 'licenses.txt'), [
  'THIRD_PARTY.md', 'LICENSE', 'node_modules/chess.js/LICENSE', 'node_modules/fflate/LICENSE',
  'public/themes/GPL-2.0-or-later.txt', 'public/themes/Apache-2.0.txt',
].map((filename) => `\n===== ${filename} =====\n\n${fs.readFileSync(filename, 'utf8')}`).join('\n'));
console.log(`Published source.zip (${count} corresponding-source files, ${written} bytes; corpus retrieved separately via CORPUS.md).`);

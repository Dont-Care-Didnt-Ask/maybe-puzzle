// Build-time only: stream corresponding sources, including the full puzzle corpus.
// Already-gzipped shards are stored, not recompressed or buffered all at once.
import fs from 'node:fs';
import path from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const destination = fs.openSync('dist/source.zip', 'w');
let count = 0;
const zip = new Zip((error, data, final) => {
  if (error) throw error;
  fs.writeSync(destination, data);
  if (final) fs.closeSync(destination);
});
function add(filename) {
  if (!fs.existsSync(filename)) return;
  const stat = fs.statSync(filename);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(filename).sort()) {
      if (!['__pycache__', '.DS_Store'].includes(name)) add(path.join(filename, name));
    }
  } else {
    const name = `chess-puzzle-not-puzzle/${filename.split(path.sep).join('/')}`;
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
  'engine.py', 'prepare.py', 'export_static.py', 'import_puzzles.py', 'expand_corpus.py', 'snapshot_corpus.py', 'benchmark.py', 'pyproject.toml', 'uv.lock',
  'package.json', 'package-lock.json', 'vite.config.js', 'playwright.config.js', 'index.html',
  'README.md', 'DECISIONS.md', 'HOSTING.md', 'LICENSE', 'THIRD_PARTY.md', '.gitignore',
  'web', 'scripts', 'tests', '.github', 'public', 'data/README.md',
]) add(file);
for (const [name, folders] of [
  ['@lichess-org/chessground', ['src', 'assets', 'LICENSE', 'package.json']],
  ['chess.js', ['src', 'LICENSE', 'package.json']],
  ['fflate', ['esm', 'LICENSE', 'package.json']],
]) {
  for (const folder of folders) add(`node_modules/${name}/${folder}`);
}
zip.end();
fs.writeFileSync('dist/licenses.txt', [
  'THIRD_PARTY.md', 'LICENSE', 'node_modules/chess.js/LICENSE', 'node_modules/fflate/LICENSE',
  'public/themes/GPL-2.0-or-later.txt', 'public/themes/Apache-2.0.txt',
].map((filename) => `\n===== ${filename} =====\n\n${fs.readFileSync(filename, 'utf8')}`).join('\n'));
console.log(`Published source.zip (${count} source/data files; no raw archives or session state).`);

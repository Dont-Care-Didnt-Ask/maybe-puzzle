// Build-time only: publish corresponding sources without a Python download endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

const files = {};
function add(filename) {
  if (!fs.existsSync(filename)) return;
  const stat = fs.statSync(filename);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(filename)) {
      if (!['__pycache__', '.DS_Store'].includes(name)) add(path.join(filename, name));
    }
  } else {
    files[`chess-puzzle-not-puzzle/${filename.split(path.sep).join('/')}`] = new Uint8Array(fs.readFileSync(filename));
  }
}
for (const file of [
  'engine.py', 'prepare.py', 'export_static.py', 'benchmark.py', 'pyproject.toml', 'uv.lock',
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
fs.writeFileSync('dist/licenses.txt', [
  'THIRD_PARTY.md', 'LICENSE', 'node_modules/chess.js/LICENSE', 'node_modules/fflate/LICENSE',
].map((filename) => `\n===== ${filename} =====\n\n${fs.readFileSync(filename, 'utf8')}`).join('\n'));
fs.writeFileSync('dist/source.zip', zipSync(files, { level: 6 }));
console.log(`Published source.zip (${Object.keys(files).length} source/data files; no raw archives or session state).`);

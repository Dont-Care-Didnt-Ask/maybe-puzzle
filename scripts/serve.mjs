// Deliberately plain static server for Pages-subpath tests (no API or SPA fallback).
// DIST_DIR, BASE_PATH and PORT also allow an isolated historical build to be measured.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.DIST_DIR || 'dist');
const prefix = process.env.BASE_PATH || '/chess-puzzle-not-puzzle/';
const port = Number(process.env.PORT || 8765);
if (!prefix.startsWith('/') || !prefix.endsWith('/') || /[?#\\]|\/\//.test(prefix)
    || prefix.split('/').some((part) => part === '.' || part === '..')) {
  throw new Error('BASE_PATH must be an absolute URL path ending in /');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
if (!fs.statSync(root).isDirectory()) throw new Error(`Not a static directory: ${root}`);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.gz': 'application/gzip', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/' && prefix !== '/') { response.writeHead(302, { Location: prefix }); response.end(); return; }
    if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const filename = path.resolve(root, pathname.slice(prefix.length) || 'index.html');
    if (!filename.startsWith(root + path.sep)) throw new Error('not found');
    const stat = fs.statSync(filename);
    if (!stat.isFile()) throw new Error('not found');
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
      'Content-Length': stat.size, 'Cache-Control': 'no-store' });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Static files from ${root} at http://127.0.0.1:${port}${prefix}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

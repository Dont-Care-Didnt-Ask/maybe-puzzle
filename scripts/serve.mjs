// Deliberately plain static server for Pages-subpath tests (no API or SPA fallback).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const prefix = '/chess-puzzle-not-puzzle/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.gz': 'application/gzip', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { response.writeHead(302, { Location: prefix }); response.end(); return; }
    if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const filename = path.resolve(root, pathname.slice(prefix.length) || 'index.html');
    const stat = fs.statSync(filename);
    if (!filename.startsWith(root + path.sep) || !stat.isFile()) throw new Error('not found');
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': stat.size });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filename).pipe(response);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(Number(process.env.PORT || 8765), '127.0.0.1', () => console.log(`Static files at http://127.0.0.1:${process.env.PORT || 8765}${prefix}`));

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('public');
const basePath = '/tuck/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') { response.writeHead(302, { Location: basePath }).end(); return; }
    if (!url.pathname.startsWith(basePath)) { response.writeHead(404).end(); return; }
    const path = resolve(root, decodeURIComponent(url.pathname.slice(basePath.length)) || 'index.html');
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const content = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log(`Tuck: http://127.0.0.1:4173${basePath}`));

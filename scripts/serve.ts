import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

// Compiled scripts in .build/ take precedence over static files in public/.
const roots = [resolve('.build'), resolve('public')];
const basePath = '/tuck/';
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
createServer((request, response) => void (async () => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') { response.writeHead(302, { Location: basePath }).end(); return; }
  if (!url.pathname.startsWith(basePath)) { response.writeHead(404).end(); return; }
  let relative: string;
  try { relative = decodeURIComponent(url.pathname.slice(basePath.length)) || 'index.html'; }
  catch { response.writeHead(404).end('Not found'); return; }
  for (const root of roots) {
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    try {
      const content = await readFile(path);
      response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(content);
      return;
    } catch { /* try the next root */ }
  }
  response.writeHead(404).end('Not found');
})()).listen(4173, '127.0.0.1', () => console.log(`Tuck: http://127.0.0.1:4173${basePath}`));

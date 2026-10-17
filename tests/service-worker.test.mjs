import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
test('only the same-origin application can activate a waiting update', () => {
  const handlers = {};
  let activations = 0;
  runInNewContext(source, { URL, self: {
    registration: { scope: 'https://example.com/todos/' },
    location: { origin: 'https://example.com' },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    skipWaiting: () => { activations++; }
  } });
  for (const event of [
    { origin: 'https://evil.example', source: { url: 'https://evil.example/todos/' } },
    { origin: 'https://example.com', source: { url: 'https://example.com/another-app/' } },
    { origin: 'https://example.com', source: null }
  ]) handlers.message({ data: 'ACTIVATE_UPDATE', ...event });
  assert.equal(activations, 0);
  handlers.message({ origin: 'https://example.com', source: { url: 'https://example.com/todos/' }, data: 'ACTIVATE_UPDATE' });
  assert.equal(activations, 1);
});

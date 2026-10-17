import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const source = stripTypeScriptTypes(await readFile(new URL('../src/sw.ts', import.meta.url), 'utf8'));
test('only the same-origin application can activate a waiting update', () => {
  const handlers: Record<string, (event: object) => void> = {};
  let activations = 0;
  runInNewContext(source, { URL, self: {
    registration: { scope: 'https://example.com/tuck/' },
    location: { origin: 'https://example.com' },
    addEventListener: (name: string, handler: (event: object) => void) => { handlers[name] = handler; },
    skipWaiting: () => { activations++; }
  } });
  for (const event of [
    { origin: 'https://evil.example', source: { url: 'https://evil.example/tuck/' } },
    { origin: 'https://example.com', source: { url: 'https://example.com/another-app/' } },
    { origin: 'https://example.com', source: null }
  ]) handlers.message!({ data: 'ACTIVATE_UPDATE', ...event });
  assert.equal(activations, 0);
  handlers.message!({ origin: 'https://example.com', source: { url: 'https://example.com/tuck/' }, data: 'ACTIVATE_UPDATE' });
  assert.equal(activations, 1);
});

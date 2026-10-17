import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// TypeScript sources are checked by tsc; this validates the JSON assets.
async function check(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (/\.(json|webmanifest)$/.test(path)) JSON.parse(await readFile(path, 'utf8'));
  }
}
for (const directory of ['public', 'tests']) await check(directory);
console.log('JSON checks passed.');

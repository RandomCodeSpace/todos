import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : join(directory, entry.name)));
  return nested.flat().sort();
}
const hash = createHash('sha256');
for (const file of await files('public')) hash.update(file.replaceAll('\\', '/')).update(await readFile(file));
const version = hash.digest('hex').slice(0, 16);
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await writeFile('dist/sw.js', (await readFile('public/sw.js', 'utf8')).replace('__BUILD_VERSION__', version));
await writeFile('dist/.nojekyll', '');
console.log(`Built offline app ${version} in dist/`);

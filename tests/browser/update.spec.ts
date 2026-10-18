import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import type { AddressInfo } from 'node:net';

test('updates wait for unsaved drafts, then reload automatically and stay offline-ready', async ({ page, context }) => {
  // Compiled scripts from `npm run compile` take precedence over static files.
  const roots = ['../../.build/', '../../public/'].map(path => resolve(fileURLToPath(new URL(path, import.meta.url))));
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  let release = 1;
  const server = createServer((request, response) => void (async () => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/tuck/')) { response.writeHead(404).end(); return; }
      const paths = roots.map(root => resolve(root, pathname.slice('/tuck/'.length) || 'index.html'));
      if (paths.some((path, index) => !path.startsWith(roots[index] + sep))) { response.writeHead(403).end(); return; }
      let path = '';
      let content: Buffer | string | undefined;
      for (const candidate of paths) {
        try { content = await readFile(candidate); path = candidate; break; } catch { /* try the next root */ }
      }
      if (content === undefined) throw new Error('Not found');
      if (path.endsWith('sw.js')) content = content.toString().replace('__BUILD_VERSION__', `release-${release}`);
      const titles: Record<number, string> = { 1: 'Earlier release', 2: 'Middle release' };
      const title = titles[release];
      if (title && path.endsWith('index.html')) content = content.toString().replace('<title>Tuck - A little more headspace</title>', `<title>${title}</title>`);
      response.writeHead(200, {
        'Content-Type': types[extname(path)] || 'application/octet-stream',
        'Cache-Control': path.endsWith('sw.js') ? 'no-store' : 'public, max-age=3600'
      });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  })());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tuck/`);
    await expect(page.locator('#offline-status')).toHaveText('Ready for offline');
    await expect(page).toHaveTitle('Earlier release');
    // Phones open the composer from the dock.
    if (await page.locator('#fab').isVisible()) await page.locator('#fab').click();
    await page.getByLabel('New task').fill('Keep through update');
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(page.getByText('Keep through update', { exact: true })).toBeVisible();

    release = 2;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    await expect(page).toHaveTitle('Middle release');
    await expect(page.getByRole('status')).toContainText('Tuck updated.');

    release = 3;
    if (await page.locator('#fab').isVisible()) await page.locator('#fab').click();
    await page.getByLabel('New task').fill('Unsaved draft');
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    await expect(page.getByRole('button', { name: 'Update available' })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveTitle('Middle release');
    await expect(page.getByLabel('New task')).toHaveValue('Unsaved draft');
    await page.getByLabel('New task').fill('');
    await expect(page).toHaveTitle('Tuck - A little more headspace');
    await expect(page.getByRole('status')).toContainText('Tuck updated.');
    await expect(page.getByText('Keep through update', { exact: true })).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await expect(page).toHaveTitle('Tuck - A little more headspace');
    await expect(page.getByText('Keep through update', { exact: true })).toBeVisible();
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

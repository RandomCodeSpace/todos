/// <reference lib="webworker" />
// Classic service worker script: no imports or exports, so it registers without type: "module".
const worker = self as unknown as ServiceWorkerGlobalScope;
const PREFIX = `tuck:${worker.registration.scope}:`;
const CACHE = `${PREFIX}__BUILD_VERSION__`;
const FILES = ['./', './index.html', './styles.css', './app.js', './model.js', './storage.js', './manifest.webmanifest', './icon.svg', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png'];
const ASSETS = new Set(FILES.map(path => new URL(path, worker.registration.scope).href));

worker.addEventListener('install', event => {
  const requests = FILES.map(path => new Request(new URL(path, worker.registration.scope), { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(requests)));
});
worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await worker.clients.claim();
  })());
});
worker.addEventListener('message', event => {
  const source = event.source as Client | null;
  if (event.origin !== worker.location.origin || !source?.url?.startsWith(worker.registration.scope)) return;
  if (event.data === 'ACTIVATE_UPDATE') void worker.skipWaiting();
});
worker.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.href.startsWith(worker.registration.scope)) return;
  url.search = '';
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match('./index.html')).then(response => response || fetch(event.request)));
  } else if (ASSETS.has(url.href)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.href)).then(response => response || fetch(event.request)));
  }
});

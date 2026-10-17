const PREFIX = `todos:${self.registration.scope}:`;
const CACHE = `${PREFIX}__BUILD_VERSION__`;
const FILES = ['./', './index.html', './styles.css', './app.js', './model.js', './storage.js', './manifest.webmanifest', './icon.svg', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png'];
const ASSETS = new Set(FILES.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.origin !== self.location.origin || !event.source?.url?.startsWith(self.registration.scope)) return;
  if (event.data === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.href.startsWith(self.registration.scope)) return;
  url.search = '';
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match('./index.html')).then(response => response || fetch(event.request)));
  } else if (ASSETS.has(url.href)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.href)).then(response => response || fetch(event.request)));
  }
});

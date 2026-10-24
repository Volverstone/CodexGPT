const CACHE = `classroom-v3-${self.registration.scope}`;
const ASSETS = ['./', './index.html', './icon.svg', './icon-192.png', './icon-512.png', './manifest.webmanifest'].map(file => new URL(file, self.registration.scope).href);
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => (k === 'classroom-v1' || k.endsWith(self.registration.scope)) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  // Never cache authentication or database requests, even when offline.
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && ASSETS.includes(event.request.url)) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || new Response('Нет соединения', { status: 503 }))));
});

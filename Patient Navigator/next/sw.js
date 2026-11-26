const CACHE = 'pn-next-a34e479cc21d';
self.addEventListener('install', event => {
  event.waitUntil(self.clients.matchAll().then(clients => {
    for (const client of clients) {
      client.postMessage({
        type: 'PN_UPDATE_READY'
      });
    }
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pn-next-')
    && key !== CACHE).map(key => caches.delete(key)))));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
self.addEventListener('fetch', event => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/storage/')
    || url.pathname.includes('/rest/') || url.pathname.includes('/auth/') || url.pathname.includes(
    '/functions/')) {
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
      }
      return response;
    }).catch(async () => {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(request, {
        ignoreSearch: true
      });
      return saved || Response.error();
    }));
  } else if (/\/assets\/[^/]+-[\w-]+\.(js|css|woff2)$/.test(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const saved = await cache.match(request);
      if (saved) {
        return saved;
      }
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    }));
  }
});

// Retires the old Patient Navigator: clear its caches, unregister, and send open app tabs to the live app.
// The public help directory (directory.html) keeps working without a service worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const k of await caches.keys()) if (/^jcf-/.test(k)) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) {
    if (!/directory\.html/.test(c.url)) c.navigate('https://navigator.jarurat.care/');
  }
})()));

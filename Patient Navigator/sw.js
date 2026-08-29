// Jarurat Care Patient Navigator - service worker.
// NETWORK-FIRST WITH A SHORT TIMEOUT. Fresh always wins when the network is
// healthy (response beats the timeout), so interns are not served stale JS. But
// on a slow or flaky connection the request no longer hangs for the browser's
// full TCP timeout (which reads as a frozen app): after NET_TIMEOUT_MS we fall
// back to the cached copy instantly, and the real response still updates the
// cache in the background for next time. Cross-origin (Supabase, CDNs, fonts)
// is never touched.
const CACHE = 'jcf-pwa-v3';
const NET_TIMEOUT_MS = 3500;
const SHELL = ['./', './index.html', './icons/icon-192.png', './icons/icon-512.png', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirstWithTimeout(req) {
  const cache = await caches.open(CACHE);
  // Kick off the real fetch; it always updates the cache when it lands.
  const netFetch = fetch(req)
    .then((res) => { cache.put(req, res.clone()).catch(() => {}); return res; });
  const timeout = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), NET_TIMEOUT_MS));
  try {
    const winner = await Promise.race([netFetch.catch(() => '__neterr__'), timeout]);
    if (winner && winner !== '__timeout__' && winner !== '__neterr__') return winner;
    // network was slow or errored -> serve cache if we have it
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('./index.html'); if (idx) return idx; }
    return await netFetch;  // nothing cached: wait for the real network result
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('./index.html'); if (idx) return idx; }
    return Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let Supabase / CDNs / fonts pass straight through
  e.respondWith(networkFirstWithTimeout(req));
});

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

// Jarurat Care Patient Navigator - service worker.
// NETWORK-FIRST WITH A SHORT TIMEOUT. Fresh always wins when the network is
// healthy (response beats the timeout), so interns are not served stale JS. But
// on a slow or flaky connection the request no longer hangs for the browser's
// full TCP timeout (which reads as a frozen app): after NET_TIMEOUT_MS we fall
// back to the cached copy instantly, and the real response still updates the
// cache in the background for next time. Cross-origin (Supabase, CDNs, fonts)
// is never touched.
// Bump this name on any deploy that must reach a device already holding a
// shell. activate() deletes every cache that is not the current one, so a
// rename is the only thing that guarantees a stale index.html - and with it
// the old ?v= asset URLs it points at - is thrown away rather than served on
// the next slow connection. v3 -> v4 on 2026-09-10.
const CACHE = 'jcf-pwa-v45';
// A call recording shared into the app (manifest share_target, Fixboard #22):
// Google's Phone app keeps recordings inside itself, so Share is the only way
// out. Kept in its own cache, which activate() leaves alone; the calling page
// offers it on the next call and drops it after six hours.
const SHARE_CACHE = 'jcf-shared-recording';
const SHARED_KEY = './__shared-recording';
const SHARE_TTL_MS = 6 * 3600 * 1000;
const SHARE_MAX_BYTES = 50 * 1024 * 1024;
const NET_TIMEOUT_MS = 3500;
const SHELL = ['./', './index.html', './icons/icon-192.png', './icons/icon-512.png', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(dropStaleShare)
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

// A shared recording not used within six hours goes, whenever the worker starts.
async function dropStaleShare() {
  try {
    const cache = await caches.open(SHARE_CACHE);
    const hit = await cache.match(SHARED_KEY);
    if (hit && Date.now() - Number(hit.headers.get('X-Shared-At') || 0) > SHARE_TTL_MS) await cache.delete(SHARED_KEY);
  } catch (_) { /* nothing to drop */ }
}

async function receiveSharedRecording(req) {
  // Android's share sheet opens this with no referrer (Sec-Fetch-Site "none").
  // A form posted here by a page on another site is not kept.
  const site = req.headers.get('Sec-Fetch-Site');
  const ref = req.referrer;
  const foreign = (site && site !== 'none' && site !== 'same-origin')
    || (ref && ref !== 'about:client' && new URL(ref).origin !== self.location.origin);
  if (foreign) return Response.redirect('./#calling', 303);
  try {
    const form = await req.formData();
    const file = form.get('recording');
    const audio = file && typeof file === 'object'
      && (/^audio\//i.test(file.type || '') || /\.(m4a|mp3|wav|aac|ogg|opus|oga|webm)$/i.test(file.name || ''));
    if (audio && file.size > 0 && file.size <= SHARE_MAX_BYTES) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARED_KEY, new Response(file, { headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name || 'recording'),
        'X-Last-Modified': String(file.lastModified || Date.now()),
        'X-Shared-At': String(Date.now()),
      } }));
    }
  } catch (_) { /* nothing usable was shared: the page simply opens */ }
  return Response.redirect('./?shared=recording#calling', 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const target = new URL(req.url);
  if (req.method === 'POST' && target.origin === self.location.origin && target.pathname.endsWith('/share-recording')) {
    e.respondWith(receiveSharedRecording(req));
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let Supabase / CDNs / fonts pass straight through
  e.respondWith(networkFirstWithTimeout(req));
});

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

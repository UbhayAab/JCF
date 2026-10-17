// App-owned share copies only. No audio or base64 is placed in localStorage.
export const SHARE_CACHE = 'jcf-shared-recording';
export const SHARE_PREFIX = './__shared-recording/';
export const SHARE_STATE_PREFIX = './__shared-recording-state/';
export const LEGACY_SHARE_KEY = './__shared-recording';
export const SHARE_TTL_MS = 6 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIO = /\.(m4a|mp3|wav|aac|ogg|opus|oga|webm)$/i;

export function createSharedRecordingStore({ cacheStorage = globalThis.caches,
  baseURL = new URL('../../', import.meta.url).href, now = () => Date.now() } = {}) {
  const url = (value) => new URL(value, baseURL).href;
  const legacyKey = url(LEGACY_SHARE_KEY), prefix = url(SHARE_PREFIX);
  const stateKey = (id) => url(SHARE_STATE_PREFIX + id);
  const exact = (ref) => !!ref && !ref.legacy && UUID.test(ref.id || '') && ref.key === url(SHARE_PREFIX + ref.id);
  const open = () => cacheStorage.open(SHARE_CACHE);
  const metadata = async (cache, id) => { try { return await (await cache.match(stateKey(id)))?.json() || {}; } catch { return {}; } };
  const refOf = (share) => ({ id: share.id, key: share.key, legacy: !!share.legacy, sharedAt: share.sharedAt });
  async function discard(ref) {
    if (!exact(ref)) return { cleaned: false, legacy: !!ref?.legacy, reason: 'Legacy shared copies cannot be safely removed automatically.' };
    try {
      const cache = await open();
      await cache.delete(ref.key);
      if (await cache.match(ref.key)) return { cleaned: false, reason: 'The app-held copy is still present.' };
      try { await cache.delete(stateKey(ref.id)); } catch { /* bytes are gone; harmless retry metadata may remain */ }
      return { cleaned: true };
    } catch { return { cleaned: false, reason: 'The app-held copy could not be removed. It remains available within its six-hour limit.' }; }
  }
  async function list() {
    const cache = await open(), out = [];
    for (const request of await cache.keys()) {
      const key = request.url, legacy = key === legacyKey, id = key.startsWith(prefix) ? key.slice(prefix.length) : null;
      if (!legacy && !UUID.test(id || '')) continue;
      const response = await cache.match(key);
      if (!response || (!legacy && response.headers.get('X-Share-ID') !== id)) continue;
      const sharedAt = Number(response.headers.get('X-Shared-At') || 0);
      if (!sharedAt || now() - sharedAt > SHARE_TTL_MS) {
        // The singleton can be overwritten by an old worker between read and
        // delete. It stays read-only, including expiry and invalid-file paths.
        if (!legacy) await discard({ id, key, legacy: false });
        continue;
      }
      const blob = await response.blob();
      let name; try { name = decodeURIComponent(response.headers.get('X-File-Name') || 'recording'); } catch { continue; }
      if (!blob.size || blob.size > 50 * 1024 * 1024 || (!/^audio\//i.test(blob.type) && !AUDIO.test(name))) continue;
      const file = new File([blob], name, { type: blob.type, lastModified: Number(response.headers.get('X-Last-Modified') || sharedAt) });
      out.push({ id, key, legacy, sharedAt, file, binding: legacy ? {} : await metadata(cache, id) });
    }
    return out.sort((a, b) => b.sharedAt - a.sharedAt || a.key.localeCompare(b.key));
  }
  async function bind(ref, patch) {
    if (!exact(ref)) return false;
    const cache = await open();
    const audio = await cache.match(ref.key);
    if (!audio) return false; // expired or explicitly rejected meanwhile
    const sharedAt = Number(audio.headers.get('X-Shared-At') || 0);
    if (!sharedAt || now() - sharedAt > SHARE_TTL_MS) { await discard(ref); return false; }
    const prior = await metadata(cache, ref.id);
    await cache.put(stateKey(ref.id), new Response(JSON.stringify({ ...prior, ...patch, shareId: ref.id,
      sharedAt }), { headers: { 'Content-Type': 'application/json' } }));
    // A simultaneous explicit rejection/expiry may have removed the bytes
    // while this metadata write was pending. Do not recreate orphan state.
    if (!await cache.match(ref.key)) { await cache.delete(stateKey(ref.id)); return false; }
    return true;
  }
  async function find({ recordingId, consentId }) {
    for (const share of await list()) if (!share.legacy && share.binding.recordingId === recordingId && share.binding.consentId === consentId) return share;
    return null;
  }
  async function cleanupAttached(ref, expected, verify) {
    if (!exact(ref)) return { cleaned: false, legacy: !!ref?.legacy, reason: 'An older app-held shared copy remains. Ask your team lead about legacy app-storage cleanup.' };
    if (!expected?.recordingId || !expected.consentId || !expected.path || !expected.patientId || !expected.uploaderId || !expected.callLogId) return { cleaned: false, reason: 'The saved recording could not yet be verified.' };
    try {
      const cache = await open();
      if (!await cache.match(ref.key)) {
        const proof = await verify({ ...expected });
        return proof?.attached && proof.uploaded ? { cleaned: true, alreadyAbsent: true }
          : { cleaned: false, alreadyAbsent: true, reason: 'The selected app-held copy is no longer present. Its saved-call attachment could not be confirmed.' };
      }
      const binding = await metadata(cache, ref.id);
      const fields = ['recordingId','consentId','path','patientId','uploaderId'];
      if (!binding.uploaded || fields.some((key) => binding[key] !== expected[key])) return { cleaned: false,
        reason: 'This shared copy has no matching completed-upload receipt. It is kept for retry within six hours.' };
      // The caller verifies the exact server row AND saved call. A positive RPC
      // count is not enough; idempotent attachment may also return zero.
      const proof = await verify({ ...expected });
      if (!proof?.attached || !proof.uploaded) return { cleaned: false, reason: 'The recording is uploaded, but its saved-call attachment is not confirmed. The app-held copy is kept.' };
      try { await bind(ref, { attachedCallLogId: expected.callLogId }); } catch { /* exact deletion may still succeed */ }
      return await discard(ref);
    } catch { return { cleaned: false, reason: 'The saved call could not be checked. The app-held copy is kept for retry within six hours.' }; }
  }
  return { list, bind, find, discard, cleanupAttached, refOf };
}

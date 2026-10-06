// ============================================================
// Patient Navigator: camera intake (Fixboard #8)
//
// The Ground POC meets families at the hospital, papers in hand. Until now a
// page of those papers meant leaving the app: the phone's camera, save, come
// back, pick the photo, label it. Here it is one loop, for as many families in
// a row as there are:
//   Add patient   the phone number (the key), a name, anything else in one box
//   Camera        page after page without leaving the app
//   Close file    filed under that patient and read by the same document reader
//   New patient   the empty form, for the next family (Fixboard #15)
// Photos upload one at a time as they are taken and keep trying on a weak
// network, so Close file never waits for the hospital's signal. A browser that
// will not lend the app its camera gets the phone's own camera or gallery
// instead, one tap per photo. The Android wrapper app lends neither until its
// next release (no camera permission, and its file chooser ignores `capture`),
// so there the fallback says so and offers the gallery and Chrome.
//
// There is no limit on photos (Fixboard #15). The reader sorts at most 80
// pages per batch, so a long file is filed as several batches of PART_PAGES,
// and a photo's full-size copy is let go once it has uploaded.
//
// Loaded on demand by the Upload page, and it loads the reader the same way, so
// a phone still holding yesterday's modules can start today's app
// (tools/stale_import_check.mjs).
// ============================================================
import { getSupabase } from '../supabase.js';
import { getCurrentUser } from '../auth.js';
import { showToast } from './toast.js';
import { icon } from './icons.js';
import { sanitize } from '../utils/validators.js';

const BUCKET = 'patient-docs';
const PART_PAGES = 60;                       // photos per batch; doc-parse sorts up to 80
const RETRY_DELAYS_S = [2, 4, 8, 15, 30, 30, 60, 60, 120, 120];
const STILL_TIMEOUT_MS = 4000;               // a still that takes longer falls back to a frame
const CONSENT_LINE = 'If you let me photograph your hospital papers, we will read them so that we can help '
  + 'you better, and you will not have to explain everything again on every call. We keep them safely, and '
  + 'you can ask us to delete them at any time. Is that all right?';
// The Android wrapper app names itself in its user agent (MainActivity) and adds a bridge.
const IN_APP = /CarcinomeNavigator/i.test(navigator.userAgent || '') || !!window.CarcinomeNative;

/** Every file opened in this visit, newest first. It outlives the tab view: uploads carry on elsewhere. */
const files = [];
let host = null;
let hospitalOf = () => null;
let pumping = false;
let reading = Promise.resolve();
let seq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The 10 digits of a mobile number, or null: +91, 91 and a leading 0 are dropped. */
export function tenDigits(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : null;
}

function waitOnline() {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('online', () => resolve(), { once: true }));
}

/** A refusal no retry can change: permissions, a family that is not ours. */
class Blocked extends Error {}
const isRefusal = (e) => e instanceof Blocked || e?.code === '42501'
  || /row-level security|permission denied|not allowed/i.test(e?.message || '');

/** Runs fn until it works, waiting longer each time and not at all while the phone is offline. */
async function withRetry(fn, { onWait = () => {}, tries = RETRY_DELAYS_S.length + 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    await waitOnline();
    try {
      return await fn();
    } catch (e) {
      if (isRefusal(e) || attempt + 1 >= tries) throw e;
      onWait(e);
      await sleep(RETRY_DELAYS_S[Math.min(attempt, RETRY_DELAYS_S.length - 1)] * 1000);
    }
  }
}

async function sha256Hex(blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ the patient, the consent, the batch

async function checkPhone(phone) {
  const { data, error } = await getSupabase().rpc('check_phone', { p_phone: phone });
  if (error) throw error;
  return data || {};
}

/** Whether this person may file papers for the family (the same test the Upload documents tab uses). */
async function canFile(patientId) {
  const { loadCallContext } = await import('./callContext.js');
  return (await loadCallContext([patientId])).has(patientId);
}

/** Saves the family as a lead (or fills in what we learnt), then finds their record. */
async function savePatient(file) {
  const sb = getSupabase();
  const h = file.hospital || {};
  const row = { phone: file.phone, name: file.name, notes: file.notes,
                hospital: h.name || '', city: h.city || '', state: h.state || '' };
  const before = await withRetry(() => checkPhone(file.phone), { onWait: () => setState(file, 'waiting') });
  if (before.found && before.patient_id && !(await withRetry(() => canFile(before.patient_id)))) {
    throw new Blocked(`${before.full_name || 'This number'} was registered by someone else, so their papers go `
      + `through ${before.assigned_mentor ? before.assigned_mentor + ', their mentor' : 'their mentor'}.`);
  }
  await withRetry(async () => {
    const { error } = await sb.rpc('bulk_add_leads', { p_rows: [row] });
    if (error) throw error;
  }, { onWait: () => setState(file, 'waiting') });
  const after = await withRetry(() => checkPhone(file.phone), { onWait: () => setState(file, 'waiting') });
  if (!after.found || !after.patient_id) {
    throw new Blocked('The patient was saved, but their record could not be found again. Upload these from the Upload documents tab.');
  }
  return after;
}

async function prepare(file) {
  try {
    setState(file, 'preparing');
    const found = await savePatient(file);
    file.patientId = found.patient_id;
    if (!file.name && found.full_name) file.name = found.full_name;
    const docs = await import('../pages/documents.js');
    const agreed = await withRetry(() => docs.hasDocumentConsent(file.patientId), { onWait: () => setState(file, 'waiting') });
    if (!agreed) await withRetry(() => docs.recordConsent(file.patientId, true, 'in_person'), { onWait: () => setState(file, 'waiting') });
    file.batchId = await withRetry(() => batchFor(file, 0), { onWait: () => setState(file, 'waiting') });
    setState(file, 'uploading');
    pump();
    maybeFinalize(file);
  } catch (e) {
    setState(file, 'blocked', e.message || 'The patient could not be saved.');
  }
}

/**
 * The batch that holds one part of a file, made the first time a photo of that
 * part needs it. Uploads run one at a time (pump), so a part never gets two.
 * The caller retries.
 */
async function batchFor(file, part) {
  if (!file.batches[part]) {
    const { data, error } = await getSupabase().from('document_batches').insert({
      patient_id: file.patientId, uploaded_by: getCurrentUser()?.id, source_files: 0, status: 'uploading',
    }).select('id').single();
    if (error) throw error;
    file.batches[part] = data.id;
  }
  return file.batches[part];
}

// ------------------------------------------------------------------ photos

async function addPhoto(file, blob, name) {
  const n = file.next++;
  const page = { n, part: Math.floor(n / PART_PAGES), name, state: 'rendering', url: URL.createObjectURL(blob) };
  file.pages.push(page);
  paintStrip(file);
  file.render = file.render.then(async () => {
    try {
      const { renderFile } = await import('../pages/docBatch.js');
      const asFile = blob instanceof File ? blob : new File([blob], name, { type: blob.type || 'image/jpeg' });
      const [drawn] = await renderFile(asFile);
      page.full = drawn.full;
      page.thumb = drawn.thumb;
      page.sha256 = await sha256Hex(drawn.full.blob);
      URL.revokeObjectURL(page.url);
      page.url = URL.createObjectURL(drawn.thumb.blob);
      page.state = page.removed ? 'removed' : 'ready';
    } catch (e) {
      page.state = 'unreadable';
      showToast(e.message || 'That photo could not be read. Take it again.', 'warning');
    }
    paintStrip(file);
    renderFiles();
    pump();
  });
}

function removePhoto(file, n) {
  const page = file.pages.find((p) => p.n === n);
  if (!page || page.removed) return;
  page.removed = true;
  if (page.state === 'done') forgetStored(page);
  if (page.state === 'ready' || page.state === 'failed') page.state = 'removed';
  paintStrip(file);
  renderFiles();
  maybeFinalize(file);
}

async function uploadPage(file, page) {
  const sb = getSupabase();
  const batchId = await batchFor(file, page.part);
  const stem = `${file.patientId}/${batchId}/p${String(page.n).padStart(3, '0')}`;
  for (const [path, blob] of [[`${stem}.jpg`, page.full.blob], [`${stem}_t.jpg`, page.thumb.blob]]) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
    // A retry after a reply that never arrived finds its own object already there.
    if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
  }
  page.batchId = batchId;
  page.path = `${stem}.jpg`;
  page.thumbPath = `${stem}_t.jpg`;
  // Stored now: keep what filing needs, and let a long file's photos leave memory.
  page.meta = { width: page.full.width, height: page.full.height, size: page.full.blob.size };
  page.full = null;
  page.thumb = null;
}

async function forgetStored(page) {
  if (!page.path) return;
  try { await getSupabase().storage.from(BUCKET).remove([page.path, page.thumbPath]); } catch { /* left for the sweep */ }
}

/** Oldest family first, its pages in the order they were taken. */
function nextPage() {
  for (const file of [...files].reverse()) {
    if (!file.batchId) continue;
    const page = file.pages.find((p) => p.state === 'ready' && !p.removed);
    if (page) return { file, page };
  }
  return null;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (let next = nextPage(); next; next = nextPage()) {
      const { file, page } = next;
      page.state = 'uploading';
      paintStrip(file);
      renderFiles();
      try {
        await withRetry(() => uploadPage(file, page), { onWait: () => { page.waiting = true; renderFiles(); } });
        page.state = 'done';
        if (page.removed) forgetStored(page);
      } catch (e) {
        page.state = 'failed';
        page.error = e.message;
      }
      page.waiting = false;
      paintStrip(file);
      renderFiles();
      maybeFinalize(file);
    }
  } finally {
    pumping = false;
  }
}

// ------------------------------------------------------------------ closing a file

function busy(file) {
  return file.pages.some((p) => !p.removed && ['rendering', 'ready', 'uploading'].includes(p.state))
    || ['preparing', 'waiting', 'filing'].includes(file.state);
}

function maybeFinalize(file) {
  if (!file.closed || !file.batchId || file.finalizing || file.filed) return;
  const kept = file.pages.filter((p) => !p.removed && p.state !== 'unreadable');
  if (kept.some((p) => ['rendering', 'ready', 'uploading'].includes(p.state))) return;
  if (kept.some((p) => p.state === 'failed')) { setState(file, 'stuck'); return; }
  file.finalizing = true;
  finalize(file, kept).finally(() => { file.finalizing = false; });
}

/** One batch's pages, in the order they were taken, handed over for reading. Safe to run twice. */
async function fileBatch(file, batchId, pages) {
  const sb = getSupabase();
  // One insert, all or nothing: a retry after a lost reply finds the rows there.
  const { data: already } = await sb.from('document_pages').select('id').eq('batch_id', batchId).limit(1);
  if (!already?.length) {
    const rows = pages.map((p, i) => ({
      batch_id: batchId, patient_id: file.patientId, page_index: i,
      source_name: p.name, source_kind: 'image', source_page_no: null,
      storage_path: p.path, thumb_path: p.thumbPath,
      width: p.meta.width, height: p.meta.height, byte_size: p.meta.size, sha256: p.sha256,
    }));
    await withRetry(async () => {
      const { error } = await sb.from('document_pages').insert(rows);
      if (error && error.code !== '23505') throw error;
    });
  }
  // The same page twice (a gallery pick of a photo already taken) is read once.
  const { data: stored } = await sb.from('document_pages').select('id, page_index, sha256')
    .eq('batch_id', batchId).order('page_index');
  const first = {};
  for (const r of stored || []) {
    if (first[r.sha256] === undefined) first[r.sha256] = r.id;
    else await sb.from('document_pages').update({ duplicate_of: first[r.sha256] }).eq('id', r.id);
  }
  await withRetry(async () => {
    const { error } = await sb.from('document_batches')
      .update({ status: 'segmenting', page_count: pages.length, source_files: pages.length }).eq('id', batchId);
    if (error) throw error;
  });
}

async function discardBatch(batchId) {
  await withRetry(async () => {
    const { error } = await getSupabase().from('document_batches')
      .update({ status: 'discarded', note: 'Closed on the camera without photos.' }).eq('id', batchId);
    if (error) throw error;
  });
}

async function finalize(file, kept) {
  try {
    setState(file, 'filing');
    const filed = [];
    // Every batch the file opened; one whose photos were all taken back is discarded.
    for (const batchId of file.batches.filter(Boolean)) {
      const pages = kept.filter((p) => p.batchId === batchId);
      if (pages.length) {
        await fileBatch(file, batchId, pages);
        filed.push(batchId);
      } else {
        await discardBatch(batchId);
      }
    }
    file.filed = true;
    if (!filed.length) { setState(file, 'empty'); return; }
    file.pages.forEach((p) => { if (p.url) URL.revokeObjectURL(p.url); p.full = null; });
    queueRead(file, filed);
  } catch (e) {
    setState(file, 'stuck', e.message);
  }
}

/** One family at a time, so a run of files does not race itself for the reader. */
function queueRead(file, batchIds) {
  setState(file, 'queued');
  reading = reading.then(async () => {
    setState(file, 'reading');
    let ok = true;
    for (const batchId of batchIds) {
      try {
        const mod = await import('../pages/docBatch.js');
        const read = typeof mod.readStoredBatch === 'function' ? await mod.readStoredBatch(batchId) : false;
        ok = ok && !!read;
      } catch { ok = false; }
    }
    setState(file, ok ? 'read' : 'filed');
  });
}

// ------------------------------------------------------------------ the camera

async function startLiveCamera(cam) {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    cam.track = cam.stream.getVideoTracks()[0];
    cam.video.srcObject = cam.stream;
    await cam.video.play().catch(() => {});
    if ('ImageCapture' in window && cam.track) {
      try { cam.still = new window.ImageCapture(cam.track); } catch { cam.still = null; }
    }
    return true;
  } catch (e) {
    console.warn('[camera] no live camera here:', e?.name || e);
    return false;
  }
}

/** A full-resolution still where the browser offers one, otherwise the current frame. */
async function grab(cam) {
  if (cam.still) {
    try {
      const blob = await Promise.race([cam.still.takePhoto(), sleep(STILL_TIMEOUT_MS).then(() => null)]);
      if (blob && blob.size) return blob;
    } catch { /* this camera gives frames only */ }
    cam.still = null;
  }
  const { videoWidth: w, videoHeight: h } = cam.video;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(cam.video, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

/** The address to paste into Chrome, where the page may use the camera. */
async function copyChromeLink() {
  const link = location.origin + location.pathname;
  try {
    await navigator.clipboard.writeText(link);
    showToast('Link copied. Open Chrome, paste it into the address bar and sign in once.', 'success');
  } catch {
    showToast(`Open Chrome and go to ${link}`, 'info');
  }
}

function stopCamera(cam) {
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  try { cam.lock?.release(); } catch { /* already gone */ }
}

function paintStrip(file) {
  const cam = file.cam;
  if (!cam?.overlay?.isConnected) return;
  const live = file.pages.filter((p) => !p.removed);
  cam.overlay.querySelector('.ci-count').textContent = `${live.length} photo${live.length === 1 ? '' : 's'}`;
  cam.overlay.querySelector('.ci-done').textContent = live.length ? `Close file (${live.length})` : 'Close file';
  const strip = cam.overlay.querySelector('.ci-strip');
  strip.innerHTML = live.slice().reverse().map((p) => `
    <div class="ci-thumb" data-state="${p.state}">
      ${p.url ? `<img src="${p.url}" alt="Photo ${p.n + 1}">` : ''}
      <button type="button" class="ci-rm" data-n="${p.n}" aria-label="Remove photo ${p.n + 1}">&times;</button>
    </div>`).join('');
}

function openCamera(file) {
  const cam = { video: null, stream: null, track: null, still: null, lock: null, overlay: null, onPop: null };
  file.cam = cam;
  const overlay = document.createElement('div');
  overlay.className = 'ci-camera';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Camera');
  overlay.innerHTML = `
    <video class="ci-video" playsinline muted autoplay></video>
    <div class="ci-flash"></div>
    <div class="ci-top">
      <div class="ci-who">${sanitize(file.name || 'New patient')} <span>ends ${sanitize(file.phone.slice(-4))}</span></div>
      <button type="button" class="ci-done">Close file</button>
    </div>
    <div class="ci-fallback" hidden>${IN_APP ? `
      <p>The Navigator app cannot open the camera yet. Take the photos with the phone's camera, then tap
        Pick photos and choose them all at once. Or open the Navigator in Chrome: the camera works there.</p>
      <label class="btn btn-primary btn-lg">${icon('upload')}Pick photos
        <input type="file" accept="image/*" multiple class="ci-native" hidden></label>
      <button type="button" class="btn btn-ghost ci-copy">Copy the link for Chrome</button>` : `
      <p>This phone did not let the app use its camera directly. Take each page with the phone's camera instead: every photo comes straight back here.</p>
      <label class="btn btn-primary btn-lg">${icon('camera')}Take a photo
        <input type="file" accept="image/*" capture="environment" class="ci-native" hidden></label>`}
    </div>
    <div class="ci-bottom">
      <div class="ci-strip" aria-label="Photos in this file"></div>
      <div class="ci-controls">
        <label class="ci-side">${icon('upload')}<span>Gallery</span>
          <input type="file" accept="image/*" multiple class="ci-gallery" hidden></label>
        <button type="button" class="ci-shutter" aria-label="Take photo"></button>
        <div class="ci-count">0 photos</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');
  cam.overlay = overlay;
  cam.video = overlay.querySelector('.ci-video');
  paintStrip(file);

  const shutter = overlay.querySelector('.ci-shutter');
  const flash = overlay.querySelector('.ci-flash');
  let taking = false;
  shutter.addEventListener('click', async () => {
    if (taking) return;
    taking = true;
    flash.classList.add('on');
    navigator.vibrate?.(25);
    setTimeout(() => flash.classList.remove('on'), 90);
    try {
      const blob = await grab(cam);
      if (blob) await addPhoto(file, blob, `Camera photo ${file.next + 1}`);
      else showToast('The camera was not ready. Try again.', 'warning');
    } finally {
      taking = false;
    }
  });
  const fromFiles = (e) => {
    [...(e.target.files || [])].forEach((f) => addPhoto(file, f, f.name || `Photo ${file.next + 1}`));
    e.target.value = '';
  };
  overlay.querySelector('.ci-native').addEventListener('change', fromFiles);
  overlay.querySelector('.ci-gallery').addEventListener('change', fromFiles);
  overlay.querySelector('.ci-copy')?.addEventListener('click', copyChromeLink);
  overlay.querySelector('.ci-strip').addEventListener('click', (e) => {
    const rm = e.target.closest('.ci-rm');
    if (rm) removePhoto(file, Number(rm.dataset.n));
  });
  overlay.querySelector('.ci-done').addEventListener('click', () => closeFile(file, { fromBack: false }));

  // The phone's back button closes the file rather than leaving the page.
  history.pushState({ pnCamera: true }, '');
  cam.onPop = () => closeFile(file, { fromBack: true });
  window.addEventListener('popstate', cam.onPop);

  startLiveCamera(cam).then(async (live) => {
    if (!overlay.isConnected) { stopCamera(cam); return; }
    if (!live) {
      overlay.classList.add('ci-nolive');
      overlay.querySelector('.ci-fallback').hidden = false;
      shutter.hidden = true;
      return;
    }
    try { cam.lock = await navigator.wakeLock?.request('screen'); } catch { cam.lock = null; }
  });
}

function closeFile(file, { fromBack }) {
  const cam = file.cam;
  if (!cam?.overlay) return;
  window.removeEventListener('popstate', cam.onPop);
  stopCamera(cam);
  cam.overlay.remove();
  cam.overlay = null;
  document.body.classList.remove('modal-open');
  if (!fromBack && history.state?.pnCamera) history.back();
  file.closed = true;
  const n = file.pages.filter((p) => !p.removed).length;
  const who = file.name || `the number ending ${file.phone.slice(-4)}`;
  resetForm();
  showNext(n ? `Saved: ${n} photo${n === 1 ? '' : 's'} for ${who}. They keep uploading on their own.`
             : `Closed without photos for ${who}.`);
  renderFiles();
  maybeFinalize(file);
}

/** After a file closes: what was saved, and New patient for the next family (Fixboard #15). */
function showNext(text) {
  if (!host?.isConnected) return;
  host.querySelector('#ci-next-text').textContent = text;
  host.querySelector('#ci-form').hidden = true;
  host.querySelector('#ci-next').hidden = false;
}

function showForm() {
  if (!host?.isConnected) return;
  host.querySelector('#ci-next').hidden = true;
  host.querySelector('#ci-form').hidden = false;
}

// ------------------------------------------------------------------ the form and the list

function setState(file, state, detail = '') {
  file.state = state;
  if (detail) file.detail = detail;
  renderFiles();
}

function statusText(f) {
  const kept = f.pages.filter((p) => !p.removed && p.state !== 'unreadable');
  const done = kept.filter((p) => p.state === 'done').length;
  const waiting = kept.some((p) => p.waiting);
  switch (f.state) {
    case 'blocked': return f.detail || 'This file could not be saved.';
    case 'preparing': return 'Saving the patient…';
    case 'waiting': return 'Waiting for the network to save the patient…';
    case 'stuck': return `${kept.filter((p) => p.state === 'failed').length || 'Some'} photo(s) could not upload. Check the network and tap Try again.`;
    case 'filing': return 'Filing the photos…';
    case 'queued': return 'Filed. Waiting its turn to be read…';
    case 'reading': return 'Filed. Being read now…';
    case 'read': return 'Filed and read. A mentor checks what was read.';
    case 'filed': return 'Filed. Reading finishes when someone opens their documents.';
    case 'empty': return 'Closed without photos.';
    default:
      if (!f.closed) return `Camera open, ${done} of ${kept.length} uploaded`;
      return waiting ? `Waiting for the network, ${done} of ${kept.length} uploaded…` : `Uploading ${done} of ${kept.length}…`;
  }
}

function renderFiles() {
  const el = host?.isConnected ? host.querySelector('#ci-files') : null;
  if (!el) return;
  if (!files.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="info-label" style="margin-bottom:8px">Files from this visit</div>
    <div class="due-list" style="padding:0">${files.map((f) => {
      const kept = f.pages.filter((p) => !p.removed && p.state !== 'unreadable').length;
      return `<div class="due-row" style="flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div class="due-name">${sanitize(f.name || 'New patient')} <span class="due-meta">number ending ${sanitize(f.phone.slice(-4))}</span></div>
          <div class="due-meta">${kept} photo${kept === 1 ? '' : 's'} · ${sanitize(statusText(f))}</div>
        </div>
        ${f.state === 'stuck' ? `<div class="row-actions"><button type="button" class="btn btn-primary btn-sm" data-ci-retry="${f.id}">Try again</button></div>` : ''}
      </div>`;
    }).join('')}</div>`;
  el.querySelectorAll('[data-ci-retry]').forEach((b) => b.addEventListener('click', () => {
    const f = files.find((x) => x.id === Number(b.dataset.ciRetry));
    if (!f) return;
    f.pages.forEach((p) => { if (p.state === 'failed' && !p.removed) p.state = 'ready'; });
    setState(f, 'uploading');
    pump();
    maybeFinalize(f);
  }));
}

function resetForm() {
  if (!host?.isConnected) return;
  ['#ci-phone', '#ci-name', '#ci-notes'].forEach((s) => { const el = host.querySelector(s); if (el) el.value = ''; });
  const agree = host.querySelector('#ci-consent');
  if (agree) agree.checked = false;
  const st = host.querySelector('#ci-phone-status');
  if (st) st.innerHTML = '';
  host.querySelector('#ci-open')?.removeAttribute('disabled');
  setTimeout(() => host?.querySelector('#ci-phone')?.focus(), 300);
}

function readForm() {
  const raw = host.querySelector('#ci-phone').value;
  return {
    phone: tenDigits(raw),
    name: host.querySelector('#ci-name').value.trim().slice(0, 120),
    notes: host.querySelector('#ci-notes').value.trim().slice(0, 10000),
    agreed: host.querySelector('#ci-consent').checked,
  };
}

function newFile(form) {
  const file = { id: ++seq, phone: form.phone, name: form.name, notes: form.notes, hospital: hospitalOf(),
                 pages: [], batches: [], next: 0, render: Promise.resolve(), state: 'preparing', closed: false };
  files.unshift(file);
  return file;
}

/**
 * The Camera tab of the Upload page. Safe to call again whenever the page is
 * drawn again: the files of this visit, and their uploads, carry on.
 */
export function mountCameraIntake(el, { hospital } = {}) {
  host = el;
  hospitalOf = typeof hospital === 'function' ? hospital : () => null;
  el.innerHTML = `
    <div class="card" style="max-width:760px">
      <div id="ci-next" class="ci-next" hidden>
        <div class="ci-next-line">${icon('checkCircle')}<span id="ci-next-text"></span></div>
        <button type="button" class="btn btn-primary btn-lg" id="ci-new">${icon('plus')}New patient</button>
      </div>
      <div id="ci-form">
      <h3 style="margin:0 0 4px">Add patient</h3>
      <p class="form-hint" style="margin:0 0 14px">Type the number, the name and anything else you know, then
        photograph every page. Close the file and go straight on to the next family. Photos upload on their own.</p>
      <div class="field"><label for="ci-phone">Phone number <span class="req">*</span></label>
        <input class="input" id="ci-phone" type="tel" inputmode="tel" autocomplete="off" maxlength="16" placeholder="10 digits" /></div>
      <div id="ci-phone-status"></div>
      <div class="field"><label for="ci-name">Name</label>
        <input class="input" id="ci-name" autocomplete="off" maxlength="120" placeholder="Optional" /></div>
      <div class="field"><label for="ci-notes">Anything else</label>
        <textarea class="textarea" id="ci-notes" rows="3" maxlength="10000"
          placeholder="Age, cancer, ward or bed, a family member and their number. Any order, any words."></textarea></div>
      <div class="doc-callout" style="margin-bottom:12px"><strong>Ask first, in their language:</strong>
        <p>"${sanitize(CONSENT_LINE)}"</p></div>
      <label class="ci-agree"><input type="checkbox" id="ci-consent" /> <span>The family agreed</span></label>
      <div class="form-actions" style="justify-content:flex-start;gap:10px;flex-wrap:wrap;margin-top:14px;border:none">
        <button type="button" class="btn btn-primary btn-lg" id="ci-open">${icon('camera')}Open camera</button>
        <button type="button" class="btn btn-ghost" id="ci-refused">They said no</button>
      </div>
      </div>
    </div>
    <div id="ci-files" class="wrap-meta" style="max-width:760px;margin-top:var(--s4)"></div>`;

  el.querySelector('#ci-new').addEventListener('click', () => {
    showForm();
    el.querySelector('#ci-phone').focus();
  });

  const status = el.querySelector('#ci-phone-status');
  const open = el.querySelector('#ci-open');
  let timer = null;
  let checkFor = '';
  el.querySelector('#ci-phone').addEventListener('input', (e) => {
    clearTimeout(timer);
    open.removeAttribute('disabled');
    const phone = tenDigits(e.target.value);
    checkFor = phone || '';
    if (!phone) { status.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      status.innerHTML = '<div class="due-meta" style="margin:-4px 0 10px">Checking the number…</div>';
      try {
        const st = await checkPhone(phone);
        if (checkFor !== phone) return;
        if (!st.found) { status.innerHTML = '<div class="due-meta" style="margin:-4px 0 10px">New patient.</div>'; return; }
        const mine = await canFile(st.patient_id);
        if (checkFor !== phone) return;
        const who = sanitize(st.full_name || st.patient_code || 'A patient');
        if (mine) {
          status.innerHTML = `<div class="due-meta" style="margin:-4px 0 10px">${who} is already registered. These photos go to the same record.</div>`;
          if (!el.querySelector('#ci-name').value && st.full_name) el.querySelector('#ci-name').value = st.full_name;
        } else {
          status.innerHTML = `<div class="due-meta" style="margin:-4px 0 10px;color:var(--danger)">${who} was registered by someone else, so their papers go through ${st.assigned_mentor ? sanitize(st.assigned_mentor) + ', their mentor' : 'their mentor'}.</div>`;
          open.setAttribute('disabled', '');
        }
      } catch {
        if (checkFor === phone) status.innerHTML = '';     // offline: the save checks again
      }
    }, 450);
  });

  open.addEventListener('click', () => {
    const form = readForm();
    if (!form.phone) { showToast('Type the 10 digits of the patient\'s number.', 'warning'); el.querySelector('#ci-phone').focus(); return; }
    if (!form.agreed) { showToast('Ask the family first, then tick that they agreed.', 'warning'); return; }
    const file = newFile(form);
    renderFiles();
    prepare(file);
    openCamera(file);
  });

  el.querySelector('#ci-refused').addEventListener('click', async () => {
    const form = readForm();
    if (!form.phone) { showToast('Type the 10 digits of the patient\'s number first.', 'warning'); return; }
    const btn = el.querySelector('#ci-refused');
    btn.disabled = true;
    try {
      const sb = getSupabase();
      const h = hospitalOf() || {};
      const { error } = await sb.rpc('bulk_add_leads', { p_rows: [{ phone: form.phone, name: form.name, notes: form.notes,
        hospital: h.name || '', city: h.city || '', state: h.state || '' }] });
      if (error) throw error;
      const st = await checkPhone(form.phone);
      if (st.found && st.patient_id && await canFile(st.patient_id)) {
        const { recordConsent } = await import('../pages/documents.js');
        await recordConsent(st.patient_id, false, 'in_person');
      }
      const who = form.name || `the number ending ${form.phone.slice(-4)}`;
      resetForm();
      showNext(`Saved ${who} without photos, and recorded that the family did not agree.`);
    } catch (e) {
      showToast('Could not save: ' + (e.message || 'check the network and try again'), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  renderFiles();
}

/**
 * The form, filled in for a family already on record (the Camera button on
 * Upload documents, Fixboard #15). The number runs the same check as typing it.
 */
export function prefillCameraIntake({ phone = '', name = '' } = {}) {
  if (!host?.isConnected) return false;
  showForm();
  const input = host.querySelector('#ci-phone');
  input.value = tenDigits(phone) || '';
  host.querySelector('#ci-name').value = name;
  host.querySelector('#ci-notes').value = '';
  host.querySelector('#ci-consent').checked = false;
  input.dispatchEvent(new Event('input'));
  host.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

// Leaving the app while photos are still on the phone loses them, so ask first.
window.addEventListener('beforeunload', (e) => {
  if (files.some(busy)) { e.preventDefault(); e.returnValue = ''; }
});
